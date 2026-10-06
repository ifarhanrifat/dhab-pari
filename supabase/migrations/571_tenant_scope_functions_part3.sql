-- Phase 1, function pass 3/3. Two remaining groups from the 113-function
-- review:
--
-- Group D: functions that look up ONE row by a caller-supplied id
-- (p_xxx_id) and then read or mutate it. SECURITY DEFINER means these
-- would happily operate on another tenant's row if called with its id —
-- adding the tenant filter to the lookup makes a cross-tenant id behave
-- exactly like today's existing "not found" error, nothing new to learn.
--
-- Group E: functions that scan or aggregate across many rows with no
-- per-row id at all — these get the tenant filter added directly to
-- their WHERE clause.

create or replace function public.account_fund_type(p_account_id uuid)
 returns character varying
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT fund_type FROM accounts WHERE id = p_account_id AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
$function$;

create or replace function public.account_is_subsidiary(p_account_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(
    (SELECT type IN ('project', 'restricted_fund', 'institution', 'student')
       FROM accounts WHERE id = p_account_id AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)),
    false);
$function$;

create or replace function public.seller_account_balance(p_account_id uuid)
 returns numeric
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT a.opening_balance - (
    COALESCE((SELECT SUM(debit) FROM ledger_entries WHERE account_id = a.id), 0) -
    COALESCE((SELECT SUM(credit) FROM ledger_entries WHERE account_id = a.id), 0)
  ) FROM accounts a WHERE a.id = p_account_id AND a.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
$function$;

create or replace function public.fund_account_id(p_fund_type character varying)
 returns uuid
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT id FROM accounts
   WHERE tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
     AND system = 'donors_projects' AND fund_type = p_fund_type
     AND type = 'restricted_fund' LIMIT 1;
$function$;

create or replace function public.kafalat_expense_account(p_category character varying)
 returns uuid
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT id FROM accounts WHERE tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND system = 'donors_projects' AND code = CASE p_category
    WHEN 'school_fee' THEN 'DP-5030'
    WHEN 'uniform' THEN 'DP-5031'
    WHEN 'books' THEN 'DP-5032'
    WHEN 'stationery' THEN 'DP-5033'
    WHEN 'transport' THEN 'DP-5034'
    WHEN 'pocket_money' THEN 'DP-5035'
    WHEN 'medical' THEN 'DP-5036'
    WHEN 'exam_fee' THEN 'DP-5037'
    WHEN 'tuition' THEN 'DP-5038'
    WHEN 'admission_fee' THEN 'DP-5039'
    ELSE 'DP-5040' END;
$function$;

create or replace function public.project_fund_balance(p_project_id uuid)
 returns numeric
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(SUM(l.credit - l.debit), 0)
    FROM ledger_entries l
    JOIN accounts a ON a.id = l.account_id
   WHERE a.project_id = p_project_id AND a.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
$function$;

create or replace function public.activate_connection(p_request_id uuid, p_recurring_schedule_id uuid default null::uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE r connection_requests%ROWTYPE; b bills%ROWTYPE;
BEGIN
  IF NOT COALESCE(can_access_system('water_supply'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO r FROM connection_requests WHERE id = p_request_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found' USING ERRCODE = 'P0001'; END IF;

  IF r.bill_id IS NULL THEN
    RAISE EXCEPTION 'Receive the connection charges first — no bill has been raised yet.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO b FROM bills WHERE id = r.bill_id;
  IF COALESCE(b.paid_amount, 0) < GREATEST(b.amount_pkr - COALESCE(b.discount_amount, 0), 0) THEN
    RAISE EXCEPTION 'The connection charges (Rs %) have not been fully paid yet.', trim(to_char(b.amount_pkr, 'FM999,999,990')) USING ERRCODE = 'P0001';
  END IF;
  IF r.security_deposit_amount > 0 AND b.security_deposit_voucher_id IS NULL THEN
    RAISE EXCEPTION 'The security deposit (Rs %) has not been recorded yet.', trim(to_char(r.security_deposit_amount, 'FM999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  UPDATE connection_requests SET status = 'installed', recurring_schedule_id = p_recurring_schedule_id
   WHERE id = p_request_id;
END;
$function$;

create or replace function public.apply_consumer_advance_to_bill(p_bill_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_bill bills%ROWTYPE;
  v_available numeric;
  v_net_payable numeric;
  v_outstanding numeric;
  v_apply numeric;
  v_new_paid numeric;
  v_new_status varchar;
BEGIN
  IF NOT COALESCE(can_access_system('water_supply'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_bill FROM bills WHERE id = p_bill_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF v_bill.id IS NULL THEN
    RAISE EXCEPTION 'Bill not found' USING ERRCODE = 'P0001';
  END IF;

  SELECT -(a.opening_balance + COALESCE(SUM(le.debit), 0) - COALESCE(SUM(le.credit), 0)) INTO v_available
  FROM accounts a LEFT JOIN ledger_entries le ON le.account_id = a.id
  WHERE a.type = 'consumer' AND a.consumer_id = v_bill.consumer_id
  GROUP BY a.id, a.opening_balance;
  v_available := GREATEST(COALESCE(v_available, 0), 0);

  v_net_payable := v_bill.amount_pkr - COALESCE(v_bill.discount_amount, 0);
  v_outstanding := GREATEST(v_net_payable - COALESCE(v_bill.paid_amount, 0), 0);
  v_apply := LEAST(v_available, v_outstanding);

  IF v_apply <= 0 THEN
    RAISE EXCEPTION 'No advance credit available to apply to this bill' USING ERRCODE = 'P0001';
  END IF;

  v_new_paid := COALESCE(v_bill.paid_amount, 0) + v_apply;
  v_new_status := CASE WHEN v_new_paid >= v_net_payable THEN 'paid'
                        WHEN v_new_paid > 0 THEN 'partial'
                        ELSE v_bill.status END;

  UPDATE bills SET
    paid_amount = v_new_paid,
    status = v_new_status,
    advance_applied_amount = COALESCE(advance_applied_amount, 0) + v_apply,
    advance_applied_at = now(),
    advance_applied_by = current_admin_user_id()
  WHERE id = p_bill_id;

  RETURN jsonb_build_object('applied', v_apply, 'status', v_new_status);
END;
$function$;

create or replace function public.approve_bill_payment_claim(p_claim_id uuid, p_review_note text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  c bill_payment_claims%ROWTYPE;
  v_payment_id uuid;
BEGIN
  IF NOT can_access_system('water_supply') OR NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to approve payment claims';
  END IF;

  SELECT * INTO c FROM bill_payment_claims WHERE id = p_claim_id AND status = 'pending' AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Claim not found or already reviewed'; END IF;

  INSERT INTO payments (bill_id, consumer_id, amount_pkr, method, paid_date, note, tenant_id)
  VALUES (c.bill_id, c.consumer_id, c.amount_pkr, c.payment_method, current_date, COALESCE(c.note, 'Submitted via portal, verified by staff'), c.tenant_id)
  RETURNING id INTO v_payment_id;

  UPDATE bill_payment_claims SET
    status = 'approved', reviewed_by = current_admin_user_id(), reviewed_at = now(),
    review_note = p_review_note, created_payment_id = v_payment_id
  WHERE id = p_claim_id;

  RETURN v_payment_id;
END;
$function$;

create or replace function public.reject_bill_payment_claim(p_claim_id uuid, p_review_note text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT can_access_system('water_supply') OR NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to review payment claims';
  END IF;
  UPDATE bill_payment_claims SET status = 'rejected', reviewed_by = current_admin_user_id(), reviewed_at = now(), review_note = p_review_note
  WHERE id = p_claim_id AND status = 'pending' AND tenant_id = my_tenant_id();
END;
$function$;

create or replace function public.edit_advance(p_voucher_id uuid, p_amount numeric, p_from_account_id uuid, p_particular text, p_voucher_date date, p_party_name character varying)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v vouchers%ROWTYPE;
BEGIN
  IF NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to edit this transaction';
  END IF;

  SELECT * INTO v FROM vouchers WHERE id = p_voucher_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Advance not found'; END IF;
  IF v.voucher_type != 'advance' THEN RAISE EXCEPTION 'Not an advance voucher'; END IF;
  IF v.settled_at IS NOT NULL THEN RAISE EXCEPTION 'This advance has already been settled and cannot be edited'; END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be greater than zero'; END IF;

  DELETE FROM ledger_entries WHERE reference_type = 'voucher' AND reference_id = p_voucher_id;

  UPDATE vouchers SET
    amount_pkr = p_amount, from_account_id = p_from_account_id,
    particular = p_particular, voucher_date = p_voucher_date, party_name = p_party_name
    WHERE id = p_voucher_id
    RETURNING * INTO v;

  IF v.status = 'posted' THEN
    PERFORM post_voucher_ledger_legs(v);
  END IF;
END;
$function$;

create or replace function public.finalize_voucher(p_voucher_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v vouchers%ROWTYPE;
  v_line_total decimal;
  v_new_status varchar;
BEGIN
  IF NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to post this transaction';
  END IF;

  SELECT * INTO v FROM vouchers WHERE id = p_voucher_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Voucher not found'; END IF;
  IF v.status != 'draft' THEN RAISE EXCEPTION 'Voucher is already finalized'; END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_line_total FROM voucher_line_items WHERE voucher_id = p_voucher_id;
  IF v_line_total <= 0 THEN RAISE EXCEPTION 'Add at least one line item first'; END IF;

  v_new_status := CASE WHEN voucher_requires_approval(v.system, v.voucher_type) THEN 'pending' ELSE 'posted' END;

  IF v_new_status = 'posted' THEN
    UPDATE vouchers SET amount_pkr = v_line_total, status = v_new_status,
      voucher_no = COALESCE(voucher_no, next_voucher_no(v.system, CASE WHEN v.voucher_type = 'advance_settlement' THEN 'expense' ELSE v.voucher_type END))
      WHERE id = p_voucher_id;
  ELSE
    UPDATE vouchers SET amount_pkr = v_line_total, status = v_new_status WHERE id = p_voucher_id;
    PERFORM create_approval_request(v.system, 'voucher', v.id, v.particular, v_line_total, current_admin_user_id());
  END IF;

  RETURN jsonb_build_object('status', v_new_status, 'amount', v_line_total);
END;
$function$;

create or replace function public.reverse_voucher(p_voucher_id uuid, p_reason text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v vouchers%ROWTYPE;
  v_new_id uuid;
  v_new_no varchar;
  v_today date;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized to reverse a transaction' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v FROM vouchers WHERE id = p_voucher_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Voucher not found' USING ERRCODE = 'P0001'; END IF;

  IF v.status <> 'posted' THEN
    RAISE EXCEPTION 'Only a posted voucher can be reversed — this one is %.', v.status
      USING ERRCODE = 'P0001';
  END IF;
  IF v.reversed_by_voucher_id IS NOT NULL THEN
    RAISE EXCEPTION 'This voucher has already been reversed.' USING ERRCODE = 'P0001';
  END IF;
  IF v.reverses_voucher_id IS NOT NULL THEN
    RAISE EXCEPTION 'A reversal cannot itself be reversed — re-enter the original instead.'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Give a reason for the reversal — it is the only record of why the books changed.'
      USING ERRCODE = 'P0001';
  END IF;

  v_today := (now() AT TIME ZONE 'Asia/Karachi')::date;

  INSERT INTO vouchers (
    system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, project_id, transfer_to_project_id,
    bill_id, reverses_voucher_id, reversal_reason, tenant_id
  ) VALUES (
    v.system, v.voucher_type, v_today,
    'Reversal of ' || COALESCE(v.voucher_no, 'voucher') || ' — ' || trim(p_reason),
    v.amount_pkr,
    v.to_account_id, v.from_account_id, v.party_name,
    v.transfer_to_project_id, v.project_id,
    v.bill_id, v.id, trim(p_reason), v.tenant_id
  ) RETURNING id, voucher_no INTO v_new_id, v_new_no;

  UPDATE vouchers SET reversed_by_voucher_id = v_new_id WHERE id = p_voucher_id;

  INSERT INTO audit_log (table_name, record_id, action, record_data, related_data, system, summary, actor_id, actor_name, tenant_id)
  VALUES (
    'vouchers', v.id, 'reverse', to_jsonb(v),
    jsonb_build_object('reversal_voucher_id', v_new_id, 'reversal_voucher_no', v_new_no, 'reason', trim(p_reason)),
    v.system,
    COALESCE(v.voucher_no, 'Voucher') || ' (' || to_char(v.voucher_date, 'DD Mon YYYY') || ', Rs. '
      || trim(to_char(v.amount_pkr, 'FM999,999,999,990.00')) || ') reversed by '
      || COALESCE(v_new_no, 'a new voucher') || ' — ' || trim(p_reason),
    current_admin_user_id(), current_admin_name(), v.tenant_id
  );

  RETURN jsonb_build_object('id', v_new_id, 'voucher_no', v_new_no);
END;
$function$;

create or replace function public.reset_recurring_schedule(p_schedule_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  s recurring_schedules%ROWTYPE;
  v_base date;
  v_next_date date;
  v_next timestamptz;
BEGIN
  SELECT * INTO s FROM recurring_schedules WHERE id = p_schedule_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RETURN; END IF;

  IF s.frequency = 'every_minute' THEN
    v_next := now() + INTERVAL '1 minute';
  ELSE
    v_base := (now() AT TIME ZONE 'Asia/Karachi')::date;
    v_next_date := CASE s.frequency
      WHEN 'daily' THEN v_base + 1
      WHEN 'weekly' THEN v_base + 7
      WHEN 'monthly' THEN (v_base + INTERVAL '1 month')::date
      WHEN 'semi_annual' THEN (v_base + INTERVAL '6 months')::date
      WHEN 'yearly' THEN (v_base + INTERVAL '1 year')::date
      ELSE v_base + 1
    END;
    v_next := (v_next_date::timestamp + INTERVAL '1 minute') AT TIME ZONE 'Asia/Karachi';
  END IF;

  UPDATE recurring_schedules SET next_run_date = v_next, is_active = true WHERE id = p_schedule_id;
END;
$function$;

create or replace function public.preview_disconnect_consumer(p_consumer_id character varying)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_consumer_account_id uuid;
  v_deposit_on_hand decimal;
  v_pending_balance decimal;
  v_applied decimal;
  v_refund decimal;
BEGIN
  IF NOT can_access_system('water_supply') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT id INTO v_consumer_account_id FROM accounts WHERE type = 'consumer' AND consumer_id = p_consumer_id AND tenant_id = my_tenant_id();
  IF v_consumer_account_id IS NULL THEN
    RAISE EXCEPTION 'No ledger account found for consumer %', p_consumer_id;
  END IF;

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

  RETURN jsonb_build_object(
    'deposit_on_hand', v_deposit_on_hand, 'pending_balance', v_pending_balance,
    'applied', v_applied, 'refund', v_refund
  );
END;
$function$;

create or replace function public.restore_deleted_record(p_audit_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_row audit_log%ROWTYPE;
BEGIN
  IF NOT (current_admin_is_super_admin() OR (current_admin_has_role('admin') AND current_admin_permission('restore_deleted'))) THEN
    RAISE EXCEPTION 'You do not have permission to restore deleted records';
  END IF;

  SELECT * INTO v_row FROM audit_log WHERE id = p_audit_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Audit log entry not found';
  END IF;
  IF v_row.action != 'delete' THEN
    RAISE EXCEPTION 'Only deleted records can be restored';
  END IF;
  IF v_row.restored_at IS NOT NULL THEN
    RAISE EXCEPTION 'This record has already been restored';
  END IF;

  IF v_row.table_name = 'bills' THEN
    INSERT INTO bills SELECT * FROM jsonb_populate_record(null::bills, v_row.record_data);
  ELSIF v_row.table_name = 'payments' THEN
    INSERT INTO payments SELECT * FROM jsonb_populate_record(null::payments, v_row.record_data);
  ELSIF v_row.table_name = 'donors' THEN
    INSERT INTO donors SELECT * FROM jsonb_populate_record(null::donors, v_row.record_data);
  ELSIF v_row.table_name = 'vouchers' THEN
    INSERT INTO vouchers SELECT * FROM jsonb_populate_record(null::vouchers, v_row.record_data);
    INSERT INTO voucher_approvals SELECT * FROM jsonb_populate_recordset(null::voucher_approvals, COALESCE(v_row.related_data->'voucher_approvals', '[]'::jsonb));
  ELSIF v_row.table_name = 'accounts' THEN
    INSERT INTO accounts SELECT * FROM jsonb_populate_record(null::accounts, v_row.record_data);
  ELSIF v_row.table_name = 'consumers' THEN
    INSERT INTO consumers SELECT * FROM jsonb_populate_record(null::consumers, v_row.record_data);
  END IF;

  UPDATE audit_log SET restored_at = now(), restored_by = current_admin_user_id() WHERE id = p_audit_id;
END;
$function$;

create or replace function public.find_portal_user_by_mobile(p_mobile text)
 returns table(id uuid, full_name text)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT id, full_name::text FROM portal_users WHERE mobile = p_mobile AND is_active AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) LIMIT 1;
$function$;

create or replace function public.set_donor_manual_badge(p_portal_user_id uuid, p_tier character varying)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF current_admin_role() NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Not authorized to grant donor badges';
  END IF;
  IF p_tier IS NOT NULL AND p_tier NOT IN ('spring', 'stream', 'river', 'ocean', 'wellspring') THEN
    RAISE EXCEPTION 'Invalid badge tier';
  END IF;
  UPDATE portal_users SET manual_badge_tier = p_tier WHERE id = p_portal_user_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Donor not found'; END IF;
END;
$function$;
