-- Phase 2, slice 1 (functions, part 2): 18 more SECURITY DEFINER functions
-- found by re-running the pure-table classifier now that slice 1's tables
-- (complaints, blood bank, reminder_queue) are tenant-scoped. Same two bug
-- classes as before:
--   (a) chart-of-account / business-key code lookups with no tenant filter
--       (apply_complaint_waiver_to_bill, disconnect_consumer)
--   (b) bare `WHERE id = $1` lookups/updates on a tenant-scoped table, which
--       would let a cross-tenant id be read or mutated since SECURITY
--       DEFINER bypasses RLS (blood_appeal_text_en/ur, blood_group_counts,
--       eligible_blood_donors, extend_complaint_deadline, search_blood_donors,
--       set_blood_request_paused, set_complaint_waiver, verify_complaint) —
--       several of these (blood_group_counts, eligible_blood_donors,
--       search_blood_donors) had NO tenant filter at all and would have
--       mixed every tenant's blood donors/requests together.
--
-- run_complaint_media_cleanup is also a pg_cron job (0 4 * * *, no auth
-- context) — same no-auth-context DEFAULT bug as run_recurring_schedule
-- (migration 569) and run_nonpayment_flag_sweep (migration 575): it inserted
-- a new complaint_updates row with no tenant_id, which would've silently
-- defaulted to Dhab Pari's tenant regardless of whose complaint it was
-- actually cleaning up. Fixed by carrying tenant_id through from the row
-- being processed.
--
-- trg_donor_clear_reminder and trg_payment_clear_reminder are triggers on
-- donors and payments (both already tenant_id'd since phase 1) — added
-- NEW.tenant_id to their reminder_queue deletes for defense in depth,
-- matching the phase 1 audit-trigger pattern, even though donor_id/
-- consumer_id already scope these correctly on their own.
--
-- Left unchanged (already safely self-scoped, no fix needed):
--   my_blood_requests, portal_dispute_donor_link, respond_to_blood_request
--   (all scoped by current_portal_user_id() or a blood_donor_id tied to it —
--   a single portal user belongs to exactly one tenant, so no cross-tenant
--   path exists regardless of an explicit tenant_id filter)
--   trg_wazifa_repayment_clear_reminder (fires on wazifa_installment_charges
--   / wazifa_repayment_schedule, neither of which has a tenant_id column yet
--   — out of scope for this slice; its reminder_queue delete is already
--   correctly scoped by the globally-unique award_id)

create or replace function public.apply_complaint_waiver_to_bill(p_bill_id uuid, p_complaint_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_bill bills%ROWTYPE;
  v_complaint complaints%ROWTYPE;
  v_net_payable decimal;
  v_remaining decimal;
  v_waiver_amount decimal;
  v_consumer_account_id uuid;
  v_waiver_account_id uuid;
  v_consumer_name varchar;
  v_voucher_id uuid;
BEGIN
  SELECT * INTO v_bill FROM bills WHERE id = p_bill_id;
  IF v_bill.id IS NULL OR v_bill.waiver_voucher_id IS NOT NULL THEN RETURN; END IF;

  SELECT * INTO v_complaint FROM complaints WHERE id = p_complaint_id AND tenant_id = v_bill.tenant_id;
  IF v_complaint.id IS NULL OR v_complaint.waiver_active IS NOT TRUE OR v_complaint.consumer_id IS DISTINCT FROM v_bill.consumer_id THEN
    RETURN;
  END IF;

  v_net_payable := v_bill.amount_pkr - COALESCE(v_bill.discount_amount, 0);
  v_remaining := GREATEST(v_net_payable - COALESCE(v_bill.paid_amount, 0), 0);
  IF v_remaining <= 0 THEN RETURN; END IF;

  v_waiver_amount := CASE WHEN v_complaint.waiver_type = 'full' THEN v_remaining
                          ELSE round(v_net_payable * v_complaint.waiver_percent / 100, 2) END;
  v_waiver_amount := LEAST(v_waiver_amount, v_remaining);
  IF v_waiver_amount <= 0 THEN RETURN; END IF;

  SELECT id, name INTO v_consumer_account_id, v_consumer_name FROM accounts WHERE type = 'consumer' AND consumer_id = v_bill.consumer_id AND tenant_id = v_bill.tenant_id;
  SELECT id INTO v_waiver_account_id FROM accounts WHERE system = 'water_supply' AND code = 'WS-3010' AND tenant_id = v_bill.tenant_id;
  IF v_consumer_account_id IS NULL OR v_waiver_account_id IS NULL THEN RETURN; END IF;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, bill_id, consumer_id, party_name, tenant_id)
  VALUES ('water_supply', 'complaint_waiver', current_date,
    'Complaint waiver (' || CASE WHEN v_complaint.waiver_type = 'full' THEN 'Full' ELSE v_complaint.waiver_percent || '%' END
      || ') — ' || v_complaint.complaint_number || ' — Bill #' || v_bill.bill_number,
    v_waiver_amount, v_consumer_account_id, v_waiver_account_id, p_bill_id, v_bill.consumer_id, v_consumer_name, v_bill.tenant_id)
  RETURNING id INTO v_voucher_id;

  UPDATE bills SET
    waiver_voucher_id = v_voucher_id,
    waiver_type = v_complaint.waiver_type, waiver_percent = v_complaint.waiver_percent, waiver_complaint_id = p_complaint_id
  WHERE id = p_bill_id;
END;
$function$;

create or replace function public.blood_appeal_text_en(p_request_id uuid, p_contact_number character varying DEFAULT NULL::character varying)
 returns text
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  r blood_requests%ROWTYPE;
  v_when text; v_contact text; v_committee text; v_who text;
BEGIN
  SELECT * INTO r FROM blood_requests WHERE id = p_request_id AND tenant_id = my_tenant_id();
  IF r.id IS NULL THEN RETURN NULL; END IF;

  v_who := 'A patient' || COALESCE(' (' || blood_patient_label_en(r.patient_kind) || ')', '')
        || ' from Dhab Pari village';
  v_when := blood_day_en(r.needed_on)
        || COALESCE(' at ' || blood_time_en(r.needed_hour, r.needed_period, r.needed_time), '');
  v_contact := COALESCE(nullif(trim(coalesce(p_contact_number, '')), ''), r.requester_whatsapp);
  v_committee := committee_contact_number();

  RETURN v_who || ' needs ' || r.units_needed::text || ' unit'
      || CASE WHEN r.units_needed = 1 THEN '' ELSE 's' END
      || ' of ' || r.blood_group || ' blood ' || v_when
      || ' at ' || r.hospital || ', ' || r.city || '. '
      || 'Please contact ' || v_contact
      || COALESCE(' or the committee on WhatsApp: ' || v_committee, '');
END;
$function$;

create or replace function public.blood_appeal_text_ur(p_request_id uuid, p_contact_number character varying DEFAULT NULL::character varying)
 returns text
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  r blood_requests%ROWTYPE;
  v_when text; v_contact text; v_committee text; v_who text;
BEGIN
  SELECT * INTO r FROM blood_requests WHERE id = p_request_id AND tenant_id = my_tenant_id();
  IF r.id IS NULL THEN RETURN NULL; END IF;

  v_who := 'ڈھاب پڑی گاؤں کے ایک مریض'
        || COALESCE(' (' || blood_patient_label_ur(r.patient_kind) || ')', '');
  v_when := blood_day_ur(r.needed_on)
        || COALESCE(' ' || blood_time_ur(r.needed_hour, r.needed_period, r.needed_time), '');
  v_contact := COALESCE(nullif(trim(coalesce(p_contact_number, '')), ''), r.requester_whatsapp);
  v_committee := committee_contact_number();

  RETURN v_who || ' کو ' || v_when || ' '
      || r.city || ' کے ' || r.hospital || ' میں '
      || r.blood_group || ' خون کی ' || r.units_needed::text || ' یونٹ کی ضرورت ہے۔ '
      || 'اس کے لیے رابطہ کریں: ' || v_contact
      || COALESCE(' یا کمیٹی واٹس ایپ نمبر: ' || v_committee, '');
END;
$function$;

create or replace function public.blood_group_counts()
 returns TABLE(blood_group text, registered integer, available_now integer)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT g.grp::text,
         COUNT(d.id)::int,
         COUNT(d.id) FILTER (
           WHERE d.is_available
             AND (d.last_donation_date IS NULL
                  OR d.last_donation_date + blood_cooloff_days(d.gender) <= current_date)
         )::int
    FROM (VALUES ('O+'),('O-'),('A+'),('A-'),('B+'),('B-'),('AB+'),('AB-')) AS g(grp)
    LEFT JOIN blood_donors d ON d.blood_group = g.grp AND d.tenant_id = my_tenant_id()
   GROUP BY g.grp
   ORDER BY g.grp;
$function$;

create or replace function public.disconnect_consumer(p_consumer_id character varying)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_consumer_account_id uuid;
  v_deposit_account_id uuid;
  v_cash_account_id uuid;
  v_consumer_name varchar;
  v_deposit_on_hand decimal;
  v_pending_balance decimal;
  v_applied decimal;
  v_refund decimal;
BEGIN
  IF NOT current_admin_permission('manage_parties') THEN
    RAISE EXCEPTION 'Only a user with consumer-management permission can disconnect a consumer';
  END IF;

  SELECT id, name INTO v_consumer_account_id, v_consumer_name FROM accounts WHERE type = 'consumer' AND consumer_id = p_consumer_id AND tenant_id = my_tenant_id();
  IF v_consumer_account_id IS NULL THEN
    RAISE EXCEPTION 'No ledger account found for consumer %', p_consumer_id;
  END IF;

  SELECT id INTO v_deposit_account_id FROM accounts WHERE system = 'water_supply' AND code = 'WS-5002' AND tenant_id = my_tenant_id();
  SELECT id INTO v_cash_account_id FROM accounts WHERE system = 'water_supply' AND code = 'WS-1001' AND tenant_id = my_tenant_id();

  SELECT COALESCE(SUM(v.amount_pkr), 0) INTO v_deposit_on_hand
  FROM vouchers v WHERE v.voucher_type = 'security_deposit' AND v.status = 'posted'
    AND v.bill_id IN (SELECT id FROM bills WHERE consumer_id = p_consumer_id);
  v_deposit_on_hand := v_deposit_on_hand - COALESCE((
    SELECT SUM(v.amount_pkr) FROM vouchers v
    WHERE v.voucher_type = 'security_deposit_refund' AND v.status = 'posted' AND v.consumer_id = p_consumer_id
  ), 0);

  SELECT a.opening_balance + COALESCE((SELECT SUM(l.debit - l.credit) FROM ledger_entries l WHERE l.account_id = a.id), 0)
  INTO v_pending_balance FROM accounts a WHERE a.id = v_consumer_account_id;

  v_applied := LEAST(v_deposit_on_hand, GREATEST(v_pending_balance, 0));
  v_refund := v_deposit_on_hand - v_applied;

  IF v_applied > 0 AND v_deposit_account_id IS NOT NULL THEN
    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, consumer_id, party_name)
    VALUES ('water_supply', 'security_deposit_refund', current_date,
      'Security deposit applied to outstanding balance — ' || v_consumer_name, v_applied,
      v_consumer_account_id, v_deposit_account_id, p_consumer_id, v_consumer_name);
  END IF;

  IF v_refund > 0 AND v_deposit_account_id IS NOT NULL AND v_cash_account_id IS NOT NULL THEN
    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, consumer_id, party_name)
    VALUES ('water_supply', 'security_deposit_refund', current_date,
      'Security deposit refund — ' || v_consumer_name, v_refund,
      v_cash_account_id, v_deposit_account_id, p_consumer_id, v_consumer_name);
  END IF;

  UPDATE consumers SET status = 'disconnected', disconnected_at = now() WHERE consumer_id = p_consumer_id;
  UPDATE accounts SET is_active = false WHERE id = v_consumer_account_id;
  UPDATE recurring_schedules SET is_active = false
    WHERE consumer_id = p_consumer_id AND schedule_type = 'bill' AND is_active = true;
  UPDATE complaints SET waiver_active = false WHERE consumer_id = p_consumer_id AND waiver_active = true;

  RETURN jsonb_build_object(
    'deposit_on_hand', v_deposit_on_hand, 'pending_balance', v_pending_balance,
    'applied', v_applied, 'refund', v_refund
  );
END;
$function$;

create or replace function public.eligible_blood_donors(p_request_id uuid)
 returns TABLE(blood_donor_id uuid, full_name text, mobile text, whatsapp_number text, blood_group text, city text, sector text, last_donation_date date, available_from date, already_contacted boolean, response text)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT d.id, pu.full_name::text, pu.mobile::text, pu.whatsapp_number::text,
         d.blood_group::text, d.city::text, d.sector::text,
         d.last_donation_date,
         blood_donor_available_from(d.last_donation_date, d.gender),
         c.id IS NOT NULL,
         c.response::text
    FROM blood_requests r
    JOIN blood_donors d
      ON d.blood_group = ANY (compatible_donor_groups(r.blood_group))
     AND d.is_available
     AND d.tenant_id = r.tenant_id
     AND (d.last_donation_date IS NULL
          OR d.last_donation_date + blood_cooloff_days(d.gender) <= current_date)
    JOIN portal_users pu ON pu.id = d.portal_user_id AND pu.is_active
    LEFT JOIN blood_request_contacts c ON c.request_id = r.id AND c.blood_donor_id = d.id
   WHERE r.id = p_request_id
     AND r.tenant_id = my_tenant_id()
     AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)
   ORDER BY (lower(d.city) IS NOT DISTINCT FROM lower(r.city)) DESC, d.updated_at DESC;
$function$;

create or replace function public.extend_complaint_deadline(p_complaint_id uuid, p_days integer, p_note text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF p_days IS NULL OR p_days <= 0 THEN RAISE EXCEPTION 'Enter a positive number of days.'; END IF;
  UPDATE complaints SET deadline_at = deadline_at + (p_days || ' days')::interval WHERE id = p_complaint_id AND tenant_id = my_tenant_id();
  INSERT INTO complaint_updates (complaint_id, author_id, kind, body)
  VALUES (p_complaint_id, current_admin_user_id(), 'deadline_extended', COALESCE(NULLIF(trim(p_note), ''), 'Deadline extended by ' || p_days || ' day(s).'));
END;
$function$;

create or replace function public.respond_to_blood_request(p_request_id uuid, p_response character varying)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF p_response NOT IN ('yes', 'no') THEN RAISE EXCEPTION 'Answer yes or no'; END IF;
  UPDATE blood_request_contacts
     SET response = p_response, responded_at = now()
   WHERE request_id = p_request_id
     AND blood_donor_id IN (SELECT id FROM blood_donors WHERE portal_user_id = current_portal_user_id());
  IF NOT FOUND THEN RAISE EXCEPTION 'You were not contacted about this request'; END IF;
END;
$function$;

create or replace function public.run_complaint_media_cleanup()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  r record;
  v_removed text[];
BEGIN
  FOR r IN
    SELECT id, complaint_id, photo_url, voice_url, tenant_id FROM complaint_updates
    WHERE created_at < now() - interval '1 month'
      AND (photo_url IS NOT NULL OR voice_url IS NOT NULL)
  LOOP
    v_removed := ARRAY[]::text[];
    IF r.photo_url IS NOT NULL THEN v_removed := array_append(v_removed, 'photo'); END IF;
    IF r.voice_url IS NOT NULL THEN v_removed := array_append(v_removed, 'voice message'); END IF;

    UPDATE complaint_updates SET photo_url = NULL, voice_url = NULL WHERE id = r.id;

    INSERT INTO complaint_updates (complaint_id, kind, body, tenant_id)
    VALUES (r.complaint_id, 'comment', 'Attachment(s) removed automatically — ' || array_to_string(v_removed, ' and ') || ' expired after the 1-month retention period.', r.tenant_id);
  END LOOP;
END;
$function$;

create or replace function public.search_blood_donors()
 returns TABLE(id uuid, blood_group character varying, is_available boolean, sector character varying, full_name character varying, mobile character varying, whatsapp_number character varying, updated_at timestamp with time zone)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT b.id, b.blood_group, b.is_available, b.sector, p.full_name, p.mobile, p.whatsapp_number, b.updated_at
  FROM blood_donors b JOIN portal_users p ON p.id = b.portal_user_id
  WHERE b.tenant_id = my_tenant_id()
    AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)
  ORDER BY b.is_available DESC, b.updated_at DESC;
$function$;

create or replace function public.set_blood_request_paused(p_request_id uuid, p_paused boolean)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE r blood_requests%ROWTYPE;
BEGIN
  IF current_admin_permission('manage_blood_requests') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'You do not have permission to change blood requests';
  END IF;
  SELECT * INTO r FROM blood_requests WHERE id = p_request_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status NOT IN ('open', 'paused') THEN
    RAISE EXCEPTION 'Only an open request can be paused — this one is %', r.status;
  END IF;
  UPDATE blood_requests SET status = CASE WHEN p_paused THEN 'paused' ELSE 'open' END
   WHERE id = p_request_id AND tenant_id = my_tenant_id();
END;
$function$;

create or replace function public.set_complaint_waiver(p_complaint_id uuid, p_active boolean, p_waiver_type character varying, p_waiver_percent numeric)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_complaint complaints%ROWTYPE;
  v_note text;
  r record;
BEGIN
  IF current_admin_role() IS DISTINCT FROM 'super_admin'
     AND COALESCE((SELECT can_verify_complaints FROM admin_users WHERE id = current_admin_user_id()), false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'You are not authorized to set a bill waiver on this complaint.';
  END IF;

  SELECT * INTO v_complaint FROM complaints WHERE id = p_complaint_id AND tenant_id = my_tenant_id();
  IF v_complaint.id IS NULL THEN RAISE EXCEPTION 'Complaint not found.'; END IF;
  IF v_complaint.consumer_id IS NULL THEN RAISE EXCEPTION 'Link this complaint to a consumer before setting a waiver.'; END IF;

  IF p_active THEN
    IF p_waiver_type NOT IN ('full', 'percent') THEN RAISE EXCEPTION 'Choose Full or Percent.'; END IF;
    IF p_waiver_type = 'percent' AND (p_waiver_percent IS NULL OR p_waiver_percent <= 0 OR p_waiver_percent > 100) THEN
      RAISE EXCEPTION 'Enter a waiver percentage between 1 and 100.';
    END IF;

    UPDATE complaints SET waiver_active = true, waiver_type = p_waiver_type,
      waiver_percent = CASE WHEN p_waiver_type = 'percent' THEN p_waiver_percent ELSE NULL END,
      waiver_set_by = current_admin_user_id(), waiver_set_at = now()
    WHERE id = p_complaint_id AND tenant_id = my_tenant_id();

    v_note := 'Bill waiver set: ' || CASE WHEN p_waiver_type = 'full' THEN 'Full waiver' ELSE p_waiver_percent || '% waiver' END
      || ' — dues will be waived on the pending bill and every future bill while this complaint remains open.';
    INSERT INTO complaint_updates (complaint_id, author_id, kind, body) VALUES (p_complaint_id, current_admin_user_id(), 'comment', v_note);

    FOR r IN SELECT id FROM bills WHERE consumer_id = v_complaint.consumer_id AND status IN ('unpaid', 'pending', 'late', 'partial') AND waiver_voucher_id IS NULL LOOP
      PERFORM apply_complaint_waiver_to_bill(r.id, p_complaint_id);
    END LOOP;
  ELSE
    UPDATE complaints SET waiver_active = false WHERE id = p_complaint_id AND tenant_id = my_tenant_id();
    INSERT INTO complaint_updates (complaint_id, author_id, kind, body) VALUES (p_complaint_id, current_admin_user_id(), 'comment', 'Bill waiver cleared — future bills will be billed normally.');
  END IF;
END;
$function$;

create or replace function public.verify_complaint(p_complaint_id uuid, p_note text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_complaint complaints%ROWTYPE;
BEGIN
  IF current_admin_role() IS DISTINCT FROM 'super_admin'
     AND COALESCE((SELECT can_verify_complaints FROM admin_users WHERE id = current_admin_user_id()), false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'You are not authorized to verify complaints.';
  END IF;
  SELECT * INTO v_complaint FROM complaints WHERE id = p_complaint_id AND tenant_id = my_tenant_id();
  IF v_complaint.id IS NULL THEN RAISE EXCEPTION 'Complaint not found.'; END IF;
  IF v_complaint.status IS DISTINCT FROM 'awaiting_verification' THEN
    RAISE EXCEPTION 'This complaint is not awaiting verification.';
  END IF;

  UPDATE complaints SET status = 'verified', verified_at = now(), verified_by = current_admin_user_id(), waiver_active = false WHERE id = p_complaint_id AND tenant_id = my_tenant_id();
  INSERT INTO complaint_updates (complaint_id, author_id, kind, body)
  VALUES (p_complaint_id, current_admin_user_id(), 'comment', COALESCE(NULLIF(trim(p_note), ''), 'Verified and closed.'));
END;
$function$;

create or replace function public.trg_donor_clear_reminder()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NEW.payment_status IS DISTINCT FROM 'pledged' OR NEW.is_verified = true THEN
    DELETE FROM reminder_queue
    WHERE donor_id = NEW.id AND status = 'pending' AND reminder_type = 'donor_pledge_unpaid' AND tenant_id = NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$function$;

create or replace function public.trg_payment_clear_reminder()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_still_outstanding decimal;
BEGIN
  SELECT COALESCE(SUM(GREATEST(b.amount_pkr - COALESCE(b.discount_amount, 0) - COALESCE(b.paid_amount, 0), 0)), 0)
    INTO v_still_outstanding FROM bills b WHERE b.consumer_id = NEW.consumer_id AND b.tenant_id = NEW.tenant_id;

  IF v_still_outstanding <= 0 THEN
    DELETE FROM reminder_queue
    WHERE consumer_id = NEW.consumer_id AND status = 'pending'
      AND reminder_type IN ('bill_weekly', 'bill_defaulter') AND tenant_id = NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$function$;
