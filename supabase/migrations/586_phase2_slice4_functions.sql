-- Phase 2, slice 4 (functions): the welfare-programs domain (Kafalat,
-- Wazifa, Sadqa Jariya, Zakat, Chanda, support pools, event Salami) is by
-- far the largest function surface reviewed so far. The same bug classes
-- as every prior slice recur here, at much greater volume:
--
-- (a) pg_cron jobs with no auth context inserting into a tenant-scoped
--     table without an explicit tenant_id, so the column's auth-context
--     DEFAULT silently falls back to Dhab Pari regardless of whose row is
--     actually being processed: kafalat_disbursement_run,
--     pool_announce_recurring_month, wazifa_interim_grant_run,
--     wazifa_repayment_run. pool_close_month is the same bug in a
--     dual-use function (also directly callable by an admin with a
--     specific pool id) -- fixed the same way (thread the pool's own
--     tenant_id through to the INSERT) without adding a tenant filter to
--     its initial lookup, since that would break the legitimate cron path
--     (which has no my_tenant_id() to resolve).
--
-- (b) ensure_X_account functions inserting into accounts without setting
--     tenant_id explicitly (same bug fixed for ensure_vehicle_account in
--     580 and ensure_shop_account in 583): ensure_kafalat_child_account,
--     ensure_sadqa_asset_account, ensure_wazifa_student_account.
--
-- (c) Chart-of-account business-key lookups with no tenant filter --
--     `accounts WHERE code = 'DP-1001'/'DP-1002'` (cash/bank) is the single
--     most repeated instance of this bug in the whole codebase, showing up
--     in nearly every payment-recording function in this domain. Also
--     site_settings key lookups (kafalat_min_class/max_class in
--     kafalat_approve_child).
--
-- (d) Admin-permission-gated (or entirely ungated) ID-lookup functions
--     with no tenant filter on their initial row lookup -- the largest
--     single category here by count. Every kafalat_pay_*, wazifa_pay_*,
--     wazifa_record_*, wazifa_set_*, wazifa_*_award, sadqa_* payment/
--     settlement function, and the kafalat/wazifa/pool/zakat admin-queue
--     listing functions (kafalat_disbursement_queue, kafalat_fee_queue,
--     pool_shortfall_queue, payment_batch_items, etc.) fell into this
--     shape: current_admin_permission() doesn't know which tenant's row
--     is being touched, so any admin with that permission flag could
--     reach across tenants.
--
-- (e) Public, pre-login donor-facing "sponsor a child / name an object"
--     browse functions with zero tenant filter at all (same shape as
--     slice 2/3's public browse functions): kafalat_available_children,
--     kafalat_children_for_naming, kafalat_child_package_breakdown,
--     kafalat_child_public_expense_summary, kafalat_public_dashboard,
--     kafalat_sponsor_breakdown, kafalat_measuring_position,
--     kafalat_total_spent, sadqa_objects_for_naming, sadqa_upkeep_total_required,
--     public_kafalat_summary, public_sadqa_board, public_wazifa_summary,
--     wazifa_students_for_naming, pool_position, pool_public_board -- all
--     fixed with the coalesce(my_tenant_id(), '<dhab-pari-uuid>'::uuid)
--     fallback used throughout for anonymous-reachable functions.
--
-- Left unchanged (secret-token-based authorization, not id-based -- the
-- manage_token itself is the tenant boundary, same reasoning as
-- redeem_customer_link_code in migration 583): chanda_campaign_by_token,
-- chanda_delete_pledge, chanda_manager_pledges, chanda_mark_received,
-- salami_account_by_token, salami_delete_pledge, salami_manager_pledges,
-- salami_mark_received.
--
-- Left unchanged (pure numeric/report helpers keyed by an id the caller
-- already resolved within their own tenant -- same "transitively safe"
-- precedent as vehicle_delivery_eligible, kafalat_committed_percent etc.
-- in prior slices): kafalat_package_total, kafalat_verifier_count,
-- kafalat_this_year_requirement, sadqa_monthly_cost, wazifa_plan_total,
-- wazifa_loan_position, wazifa_monthly_income, wazifa_family_education_cost,
-- wazifa_verification_summary, wazifa_verifier_count, wazifa_app_is_mine,
-- wazifa_app_is_open, wazifa_apply_repayment_to_schedule, trg_kafalat_share_guard,
-- trg_pool_cover_reversed, trg_wazifa_application_copy_identity,
-- trg_wazifa_instalment_route, pool_post_confirmed_payment,
-- kafalat_default_package's callers already validate -- except
-- kafalat_default_package and kafalat_schedule_uniforms themselves ARE
-- fixed below, since they are directly callable with an arbitrary
-- p_child_id and perform real DELETE/INSERT mutations, not just reads.
--
-- Left unchanged (pure ownership via current_portal_user_id(), no
-- admin-bypass branch -- FK-chain safe): announce_chanda, announce_salami,
-- my_pool_*, my_wazifa_*, my_sadqa_*, pool_announce, pool_attach_proof,
-- pool_cancel_announcement, pool_change_my_share, pool_join, pool_leave,
-- pool_submit_pledge_payment, sadqa_agree_bill, sadqa_post_message,
-- sadqa_reject_bill, sadqa_thread, submit_combined_pledge_payment,
-- wazifa_submit_witnessed_agreement.

-- ===== (a) pg_cron jobs with no auth context =====

create or replace function public.kafalat_disbursement_run()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_month date; v_year varchar; v_count int;
BEGIN
  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;
  v_year := kafalat_current_year();

  INSERT INTO kafalat_disbursements (child_id, category, month, amount_pkr, recipient, tenant_id)
  SELECT c.id, l.category, v_month, round(l.annual_amount_pkr / 12.0),
         CASE WHEN l.category = 'transport' THEN 'driver' ELSE 'guardian' END,
         c.tenant_id
    FROM kafalat_children c
    JOIN kafalat_package_lines l ON l.child_id = c.id AND l.academic_year = v_year
   WHERE c.status = 'active'
     AND l.category IN ('transport', 'pocket_money')
     AND l.annual_amount_pkr > 0
     AND NOT EXISTS (SELECT 1 FROM kafalat_disbursements d
                      WHERE d.child_id = c.id AND d.category = l.category AND d.month = v_month);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('created', v_count, 'month', v_month);
END;
$function$;

create or replace function public.pool_announce_recurring_month()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_month date; v_count int;
BEGIN
  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;

  INSERT INTO pool_payments (pool_id, commitment_id, for_month, amount_pkr, is_one_time,
                             status, announced_by_portal_user_id, announced_at,
                             kafalat_child_id, wazifa_student_id, tenant_id)
  SELECT c.pool_id, c.id, v_month, c.monthly_amount_pkr, false,
         'announced', c.portal_user_id, now(), c.kafalat_child_id, c.wazifa_student_id, c.tenant_id
    FROM pool_commitments c
   WHERE c.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM pool_payments p
                      WHERE p.commitment_id = c.id AND p.for_month = v_month AND p.status <> 'cancelled')
  ON CONFLICT (commitment_id, for_month) WHERE status <> 'cancelled' AND commitment_id IS NOT NULL
    DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('announced', v_count, 'month', v_month);
END;
$function$;

create or replace function public.wazifa_interim_grant_run()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_month date; v_count int := 0; r record;
BEGIN
  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;

  FOR r IN
    SELECT g.id AS grant_id, g.award_id, g.monthly_amount_pkr, g.pay_to, g.tenant_id,
           (SELECT count(*) FROM wazifa_instalments i WHERE i.interim_grant_id = g.id
             AND i.status <> 'cancelled') AS raised_so_far,
           g.months_awarded
      FROM wazifa_interim_grant g
     WHERE g.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM wazifa_instalments i WHERE i.interim_grant_id = g.id
                         AND i.due_on >= v_month AND i.due_on < v_month + interval '1 month'
                         AND i.status <> 'cancelled')
  LOOP
    IF r.raised_so_far >= r.months_awarded THEN
      UPDATE wazifa_interim_grant SET status = 'completed' WHERE id = r.grant_id;
      CONTINUE;
    END IF;

    INSERT INTO wazifa_instalments (award_id, purpose, description, due_on, amount_pkr, pay_to, interim_grant_id, tenant_id)
    VALUES (r.award_id, 'stipend', 'Interim support — month ' || (r.raised_so_far + 1) || ' of ' || r.months_awarded,
            v_month, r.monthly_amount_pkr, r.pay_to, r.grant_id, r.tenant_id);
    v_count := v_count + 1;

    IF r.raised_so_far + 1 >= r.months_awarded THEN
      UPDATE wazifa_interim_grant SET status = 'completed' WHERE id = r.grant_id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('raised', v_count, 'month', v_month);
END;
$function$;

create or replace function public.wazifa_repayment_run()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_month date; v_count int := 0; r record; v_next_no int; v_outstanding decimal; v_amount decimal;
BEGIN
  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;

  FOR r IN
    SELECT a.id AS award_id, a.awarded_amount_pkr, a.repaid_pkr, a.written_off_pkr,
           a.repayment_monthly_pkr, a.tenant_id
      FROM wazifa_awards a
      JOIN wazifa_students s ON s.id = a.student_id
     WHERE a.is_loan AND a.status = 'active'
       AND s.employment_status = 'employed'
       AND COALESCE(a.repayment_monthly_pkr, 0) > 0
       AND NOT EXISTS (SELECT 1 FROM wazifa_repayment_schedule rs
                        WHERE rs.award_id = a.id
                          AND rs.due_on >= v_month AND rs.due_on < v_month + interval '1 month')
  LOOP
    v_outstanding := GREATEST(r.awarded_amount_pkr - r.repaid_pkr - r.written_off_pkr, 0);
    IF v_outstanding <= 0 THEN CONTINUE; END IF;

    SELECT COALESCE(MAX(instalment_no), 0) + 1 INTO v_next_no
      FROM wazifa_repayment_schedule WHERE award_id = r.award_id;
    -- The last instalment is whatever is left, never more than the balance —
    -- an open-ended plan still has to stop exactly at zero, not run past it.
    v_amount := LEAST(r.repayment_monthly_pkr, v_outstanding);

    INSERT INTO wazifa_repayment_schedule (award_id, instalment_no, due_on, amount_pkr, tenant_id)
    VALUES (r.award_id, v_next_no, v_month, v_amount, r.tenant_id);
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('instalments_raised', v_count, 'month', v_month);
END;
$function$;

create or replace function public.pool_close_month(p_pool_id uuid, p_month date DEFAULT NULL::date)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  p support_pools%ROWTYPE;
  v_month date; v_target decimal; v_committed decimal; v_received decimal;
  v_short decimal; v_donors int; v_id uuid; v_covered decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO p FROM support_pools WHERE id = p_pool_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pool not found' USING ERRCODE = 'P0001'; END IF;

  v_month := COALESCE(date_trunc('month', p_month)::date,
                      date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date);
  IF v_month > date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date THEN
    RAISE EXCEPTION 'That month has not started yet.' USING ERRCODE = 'P0001';
  END IF;

  v_target := pool_monthly_target(p_pool_id);

  SELECT COALESCE(SUM(monthly_amount_pkr), 0), count(*) INTO v_committed, v_donors
    FROM pool_commitments WHERE pool_id = p_pool_id AND status = 'active';
  -- Real money only — an unconfirmed announcement must not read as paid, or
  -- the month closes as covered when nothing has actually landed.
  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_received
    FROM pool_payments WHERE pool_id = p_pool_id AND for_month = v_month AND status = 'confirmed';
  SELECT COALESCE(committee_covered_pkr, 0) INTO v_covered
    FROM pool_months WHERE pool_id = p_pool_id AND month = v_month;

  -- The gap the donors left, recorded before any committee money is counted.
  -- Netting the cover off here would erase the very thing this row exists to
  -- remember: re-running the close would turn "we were 7,000 short and the
  -- committee paid it" into "we were fine and the committee gave 7,000 anyway".
  -- What is still outstanding is shortfall_pkr - committee_covered_pkr.
  v_short := GREATEST(v_target - v_received, 0);

  -- A commitment with no CONFIRMED payment this month is lapsed. An
  -- announcement sitting unconfirmed is exactly the case this has to catch —
  -- someone who said they would pay and did not is precisely who the
  -- accountant needs to ring, not someone the close should quietly excuse.
  UPDATE pool_commitments c SET status = 'lapsed', lapsed_at = now(), updated_at = now()
   WHERE c.pool_id = p_pool_id AND c.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM pool_payments pp
                      WHERE pp.commitment_id = c.id AND pp.for_month = v_month AND pp.status = 'confirmed');

  INSERT INTO pool_months (pool_id, month, required_pkr, committed_pkr, received_pkr,
                           shortfall_pkr, donors_active, donors_needed, status, tenant_id)
  VALUES (p_pool_id, v_month, v_target, v_committed, v_received, v_short, v_donors,
          CASE WHEN v_target > v_committed
               THEN ceil((v_target - v_committed) / GREATEST(p.suggested_share_pkr, 1))::int
               ELSE 0 END,
          CASE WHEN v_short <= 0 THEN 'closed'
               WHEN COALESCE(v_covered, 0) >= v_short THEN 'covered_by_committee'
               ELSE 'short' END,
          p.tenant_id)
  ON CONFLICT (pool_id, month) DO UPDATE SET
    required_pkr = EXCLUDED.required_pkr, committed_pkr = EXCLUDED.committed_pkr,
    received_pkr = EXCLUDED.received_pkr, shortfall_pkr = EXCLUDED.shortfall_pkr,
    donors_active = EXCLUDED.donors_active, donors_needed = EXCLUDED.donors_needed,
    -- Derived from the money, so re-running the close is idempotent: a covered
    -- month stays covered and cannot be reopened for a second cover, and a
    -- month that a late payment has since filled closes properly.
    status = EXCLUDED.status
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('month', v_month, 'required', v_target, 'received', v_received,
                            'shortfall', v_short, 'pool_month_id', v_id,
                            'donors_lapsed', (SELECT count(*) FROM pool_commitments
                                               WHERE pool_id = p_pool_id AND status = 'lapsed'));
END;
$function$;

-- ===== (b) ensure_X_account tenant-id-on-insert bug =====

create or replace function public.ensure_kafalat_child_account(p_child_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_id uuid; v_code varchar; v_tenant_id uuid;
BEGIN
  SELECT id INTO v_id FROM accounts WHERE kafalat_child_id = p_child_id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  SELECT code, tenant_id INTO v_code, v_tenant_id FROM kafalat_children WHERE id = p_child_id;
  INSERT INTO accounts (code, name, type, system, kafalat_child_id, opening_balance, tenant_id)
  VALUES ('KID-' || COALESCE(v_code, replace(p_child_id::text, '-', '')),
          COALESCE(v_code, 'Child'), 'student', 'donors_projects', p_child_id, 0, v_tenant_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

create or replace function public.ensure_sadqa_asset_account(p_object_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE o sadqa_objects%ROWTYPE; v_id uuid; v_code varchar; v_name varchar;
BEGIN
  SELECT * INTO o FROM sadqa_objects WHERE id = p_object_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF o.asset_account_id IS NOT NULL THEN RETURN o.asset_account_id; END IF;

  v_code := 'SJA-' || o.object_no;
  v_name := o.item_name
    || CASE WHEN COALESCE(o.approved_location, o.proposed_location) IS NOT NULL
            THEN ' — ' || COALESCE(o.approved_location, o.proposed_location) ELSE '' END;

  SELECT id INTO v_id FROM accounts WHERE code = v_code AND system = 'donors_projects' AND tenant_id = o.tenant_id;
  IF v_id IS NULL THEN
    INSERT INTO accounts (code, name, name_ur, type, system, description, is_protected, tenant_id)
    VALUES (v_code, v_name, o.item_name_ur, 'asset', 'donors_projects',
            'Sadqa-e-Jariya, dedicated to ' || o.dedicated_to || '. Waqf — held by the committee as mutawalli.',
            true, o.tenant_id)
    RETURNING id INTO v_id;
  END IF;

  UPDATE sadqa_objects SET asset_account_id = v_id, updated_at = now() WHERE id = p_object_id;
  RETURN v_id;
END;
$function$;

create or replace function public.ensure_wazifa_student_account(p_student_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_id uuid; v_code varchar; v_tenant_id uuid;
BEGIN
  SELECT id INTO v_id FROM accounts WHERE wazifa_student_id = p_student_id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  SELECT code, tenant_id INTO v_code, v_tenant_id FROM wazifa_students WHERE id = p_student_id;
  INSERT INTO accounts (code, name, type, system, wazifa_student_id, opening_balance, tenant_id)
  VALUES ('STU-' || COALESCE(v_code, replace(p_student_id::text, '-', '')),
          COALESCE(v_code, 'Student'), 'student', 'donors_projects', p_student_id, 0, v_tenant_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

-- ===== (c)+(d) chart-of-account lookups and admin-gated ID-lookup mutators =====

create or replace function public.kafalat_approve_child(p_child_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  c kafalat_children%ROWTYPE; v_level int; v_min int; v_max int;
  v_year varchar; v_req jsonb; v_this_year decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM kafalat_children WHERE id = p_child_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Child not found' USING ERRCODE = 'P0001'; END IF;
  IF NOT c.guardian_consent_signed THEN
    RAISE EXCEPTION 'Guardian consent has not been signed yet.' USING ERRCODE = 'P0001';
  END IF;

  v_level := class_to_level(c.current_class);
  SELECT value::int INTO v_min FROM site_settings WHERE key = 'kafalat_min_class' AND tenant_id = my_tenant_id();
  SELECT value::int INTO v_max FROM site_settings WHERE key = 'kafalat_max_class' AND tenant_id = my_tenant_id();
  IF v_level IS NULL OR v_level < COALESCE(v_min, 1) OR v_level > COALESCE(v_max, 10) THEN
    RAISE EXCEPTION
      'Mushtarka Kafalat covers class % to class %. This child''s class (%) is outside that — for a student past class %, Taleemi Wazifa is the right programme.',
      COALESCE(v_min,1), COALESCE(v_max,10), COALESCE(c.current_class, 'not set'), COALESCE(v_max,10)
      USING ERRCODE = 'P0001';
  END IF;

  v_year := kafalat_current_year();

  UPDATE kafalat_children
     SET status = 'active', joined_on = COALESCE(joined_on, (now() AT TIME ZONE 'Asia/Karachi')::date),
         updated_at = now()
   WHERE id = p_child_id;

  -- The child's own subsidiary account, created the day approval happens —
  -- not the day the first payment happens to land.
  PERFORM ensure_kafalat_child_account(p_child_id);

  v_req := kafalat_generate_requirement(p_child_id, v_year);
  v_this_year := (v_req->>'this_year_requirement')::decimal;

  PERFORM kafalat_post_requirement_delta(v_year, v_this_year,
    c.first_name || ' (' || c.code || ') approved — ' || (v_req->>'months_remaining') || ' months left in ' || v_year,
    p_child_id);

  PERFORM kafalat_schedule_uniforms(p_child_id, v_year);

  RETURN v_req || jsonb_build_object('child_code', c.code);
END;
$function$;

create or replace function public.kafalat_issue_uniform(p_issue_id uuid, p_received_by character varying, p_signed_note text DEFAULT NULL::text, p_method character varying DEFAULT 'cash'::character varying)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  u kafalat_uniform_issues%ROWTYPE; c kafalat_children%ROWTYPE;
  v_cash uuid; v_child_account uuid; v_voucher_id uuid; v_voucher_no varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO u FROM kafalat_uniform_issues WHERE id = p_issue_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF u.status <> 'scheduled' THEN
    RAISE EXCEPTION 'This uniform is already %.', u.status USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(trim(p_received_by), '') = '' THEN
    RAISE EXCEPTION 'Name whoever received it — the child, the guardian, or the shop.'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM kafalat_children WHERE id = u.child_id;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = my_tenant_id();

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, kafalat_child_id, fund_type)
  VALUES ('donors_projects', 'kafalat_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    c.first_name || ' (' || c.code || ') — uniform ' || u.issue_no || '/2, ' || u.academic_year
      || CASE WHEN c.uniform_mode = 'cash' THEN ' (cash to guardian)' ELSE '' END,
    u.amount_pkr, v_cash, v_cash, c.first_name, u.child_id, 'kafalat')
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE kafalat_uniform_issues
     SET status = 'issued', issued_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
         received_by = p_received_by, signed_note = p_signed_note, voucher_id = v_voucher_id
   WHERE id = p_issue_id;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', u.amount_pkr);
END;
$function$;

create or replace function public.kafalat_issue_uniform(p_issue_id uuid, p_received_by character varying, p_signed_note text DEFAULT NULL::text, p_method character varying DEFAULT 'cash'::character varying, p_proof_url text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  u kafalat_uniform_issues%ROWTYPE; c kafalat_children%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_particular text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO u FROM kafalat_uniform_issues WHERE id = p_issue_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF u.status <> 'scheduled' THEN
    RAISE EXCEPTION 'This uniform is already %.', u.status USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(trim(p_received_by), '') = '' THEN
    RAISE EXCEPTION 'Name whoever received it — the child, the guardian, or the shop.'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM kafalat_children WHERE id = u.child_id;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = my_tenant_id();
  v_particular := c.first_name || ' (' || c.code || ') — uniform ' || u.issue_no || '/2, ' || u.academic_year
      || CASE WHEN c.uniform_mode = 'cash' THEN ' (cash to guardian)' ELSE '' END;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, party_name, kafalat_child_id, fund_type, status)
  VALUES ('donors_projects', 'kafalat_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    v_particular, u.amount_pkr, v_cash, c.first_name, u.child_id, 'kafalat', 'draft')
  RETURNING id INTO v_voucher_id;

  INSERT INTO voucher_line_items (voucher_id, account_id, amount, description, category, attachment_url)
  VALUES (v_voucher_id, kafalat_expense_account('uniform'), u.amount_pkr, v_particular, 'uniform', p_proof_url);

  UPDATE kafalat_uniform_issues
     SET status = 'issued', issued_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
         received_by = p_received_by, signed_note = p_signed_note, proof_url = p_proof_url,
         voucher_id = v_voucher_id
   WHERE id = p_issue_id;

  PERFORM finalize_voucher(v_voucher_id);
  SELECT voucher_no INTO v_voucher_no FROM vouchers WHERE id = v_voucher_id;
  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', u.amount_pkr);
END;
$function$;

create or replace function public.kafalat_pay_disbursement(p_disbursement_id uuid, p_method character varying, p_signed_by character varying DEFAULT NULL::character varying, p_driver_name character varying DEFAULT NULL::character varying, p_signed_note text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  d kafalat_disbursements%ROWTYPE; c kafalat_children%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO d FROM kafalat_disbursements WHERE id = p_disbursement_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF d.status <> 'scheduled' THEN
    RAISE EXCEPTION 'This is already %.', d.status USING ERRCODE = 'P0001';
  END IF;
  IF d.category = 'transport' AND COALESCE(trim(p_driver_name), '') = '' THEN
    RAISE EXCEPTION 'Name the driver this transport payment is going to.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM kafalat_children WHERE id = d.child_id;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = my_tenant_id();

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, kafalat_child_id, fund_type)
  VALUES ('donors_projects', 'kafalat_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    c.first_name || ' (' || c.code || ') — ' || d.category || ' · ' || to_char(d.month, 'Mon YYYY')
      || CASE WHEN d.category = 'transport' THEN ' · driver ' || p_driver_name ELSE '' END,
    d.amount_pkr, v_cash, v_cash,
    CASE WHEN d.category = 'transport' THEN p_driver_name ELSE c.guardian_name END,
    d.child_id, 'kafalat')
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE kafalat_disbursements
     SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method,
         signed_by = p_signed_by, driver_name = COALESCE(p_driver_name, driver_name),
         signed_note = p_signed_note, voucher_id = v_voucher_id
   WHERE id = p_disbursement_id;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', d.amount_pkr);
END;
$function$;

create or replace function public.kafalat_pay_disbursement(p_disbursement_id uuid, p_method character varying, p_signed_by character varying DEFAULT NULL::character varying, p_driver_name character varying DEFAULT NULL::character varying, p_signed_note text DEFAULT NULL::text, p_proof_url text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  d kafalat_disbursements%ROWTYPE; c kafalat_children%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO d FROM kafalat_disbursements WHERE id = p_disbursement_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF d.status <> 'scheduled' THEN
    RAISE EXCEPTION 'This is already %.', d.status USING ERRCODE = 'P0001';
  END IF;
  IF d.category = 'transport' AND COALESCE(trim(p_driver_name), '') = '' THEN
    RAISE EXCEPTION 'Name the driver — this is a transport payment.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM kafalat_children WHERE id = d.child_id;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = my_tenant_id();

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, kafalat_child_id, fund_type)
  VALUES ('donors_projects', 'kafalat_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    c.first_name || ' (' || c.code || ') — ' || d.category || ', ' || to_char(d.month, 'Mon YYYY'),
    d.amount_pkr, v_cash, v_cash, COALESCE(p_driver_name, c.first_name), d.child_id, 'kafalat')
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE kafalat_disbursements
     SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method,
         recipient = CASE WHEN p_driver_name IS NOT NULL THEN 'driver' ELSE recipient END,
         driver_name = p_driver_name, signed_by = p_signed_by, signed_note = p_signed_note,
         proof_url = p_proof_url, voucher_id = v_voucher_id
   WHERE id = p_disbursement_id;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', d.amount_pkr);
END;
$function$;

create or replace function public.kafalat_pay_disbursement(p_disbursement_id uuid, p_method character varying, p_signed_by character varying DEFAULT NULL::character varying, p_driver_name character varying DEFAULT NULL::character varying, p_signed_note text DEFAULT NULL::text, p_proof_url text DEFAULT NULL::text, p_months_covered integer DEFAULT 1)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  d kafalat_disbursements%ROWTYPE; c kafalat_children%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_total decimal; v_month date; i int;
  v_future_id uuid; v_particular text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO d FROM kafalat_disbursements WHERE id = p_disbursement_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF d.status <> 'scheduled' THEN
    RAISE EXCEPTION 'This is already %.', d.status USING ERRCODE = 'P0001';
  END IF;
  IF d.category = 'transport' AND COALESCE(trim(p_driver_name), '') = '' THEN
    RAISE EXCEPTION 'Name the driver — this is a transport payment.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM kafalat_children WHERE id = d.child_id;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = my_tenant_id();
  v_total := d.amount_pkr;
  v_particular := c.first_name || ' (' || c.code || ') — ' || d.category || ', ' || to_char(d.month, 'Mon YYYY')
      || CASE WHEN p_months_covered > 1 THEN ' — ' || p_months_covered || ' months in advance' ELSE '' END;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, party_name, kafalat_child_id, fund_type, status)
  VALUES ('donors_projects', 'kafalat_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    v_particular, d.amount_pkr, v_cash, COALESCE(p_driver_name, c.first_name), d.child_id, 'kafalat', 'draft')
  RETURNING id INTO v_voucher_id;

  UPDATE kafalat_disbursements
     SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method,
         recipient = CASE WHEN p_driver_name IS NOT NULL THEN 'driver' ELSE recipient END,
         driver_name = p_driver_name, signed_by = p_signed_by, signed_note = p_signed_note,
         proof_url = p_proof_url, voucher_id = v_voucher_id
   WHERE id = p_disbursement_id;

  IF p_months_covered > 1 THEN
    FOR i IN 1..(p_months_covered - 1) LOOP
      v_month := (d.month + make_interval(months => i))::date;
      SELECT id INTO v_future_id FROM kafalat_disbursements
       WHERE child_id = d.child_id AND category = d.category AND month = v_month;
      IF v_future_id IS NULL THEN
        INSERT INTO kafalat_disbursements (child_id, category, month, amount_pkr, recipient, status)
        VALUES (d.child_id, d.category, v_month, d.amount_pkr,
                CASE WHEN d.category = 'transport' THEN 'driver' ELSE 'guardian' END, 'scheduled')
        RETURNING id INTO v_future_id;
      END IF;
      UPDATE kafalat_disbursements
         SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method,
             recipient = CASE WHEN p_driver_name IS NOT NULL THEN 'driver' ELSE recipient END,
             driver_name = p_driver_name, signed_by = p_signed_by,
             signed_note = COALESCE(signed_note, p_signed_note), proof_url = p_proof_url, voucher_id = v_voucher_id
       WHERE id = v_future_id AND status = 'scheduled';
      v_total := v_total + d.amount_pkr;
    END LOOP;
  END IF;

  -- One line item for the whole advance (finalize_voucher() sums this back
  -- into amount_pkr, so the manual months-covered total above is what
  -- actually posts).
  INSERT INTO voucher_line_items (voucher_id, account_id, amount, description, category, attachment_url)
  VALUES (v_voucher_id, kafalat_expense_account(d.category), v_total, v_particular, d.category, p_proof_url);

  PERFORM finalize_voucher(v_voucher_id);
  SELECT voucher_no INTO v_voucher_no FROM vouchers WHERE id = v_voucher_id;
  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', v_total);
END;
$function$;

create or replace function public.kafalat_pay_fee_item(p_line_id uuid, p_amount numeric, p_method character varying, p_paid_to character varying DEFAULT NULL::character varying, p_signed_by character varying DEFAULT NULL::character varying, p_proof_url text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  l kafalat_package_lines%ROWTYPE; c kafalat_children%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_payment_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be more than zero.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO l FROM kafalat_package_lines WHERE id = p_line_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO c FROM kafalat_children WHERE id = l.child_id;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = my_tenant_id();

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, kafalat_child_id, fund_type)
  VALUES ('donors_projects', 'kafalat_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    c.first_name || ' (' || c.code || ') — ' || l.category || ', ' || l.academic_year
      || COALESCE(' — ' || p_paid_to, ''),
    p_amount, v_cash, v_cash, COALESCE(p_paid_to, c.first_name), l.child_id, 'kafalat')
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  INSERT INTO kafalat_fee_payments (package_line_id, child_id, category, amount_pkr, method,
    paid_to, signed_by, proof_url, note, voucher_id, created_by)
  VALUES (p_line_id, l.child_id, l.category, p_amount, p_method, p_paid_to, p_signed_by,
    p_proof_url, p_note, v_voucher_id, current_admin_user_id())
  RETURNING id INTO v_payment_id;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount, 'payment_id', v_payment_id);
END;
$function$;

create or replace function public.kafalat_pay_fee_item(p_line_id uuid, p_amount numeric, p_method character varying, p_paid_to character varying DEFAULT NULL::character varying, p_signed_by character varying DEFAULT NULL::character varying, p_proof_url text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_months_covered integer DEFAULT 1)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  l kafalat_package_lines%ROWTYPE; c kafalat_children%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_payment_id uuid; v_covers_until date; v_particular text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be more than zero.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO l FROM kafalat_package_lines WHERE id = p_line_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO c FROM kafalat_children WHERE id = l.child_id;

  v_covers_until := (CASE WHEN p_months_covered > 1
    THEN ((now() AT TIME ZONE 'Asia/Karachi')::date + (make_interval(months => p_months_covered - 1)))
    ELSE NULL END);

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = my_tenant_id();

  v_particular := c.first_name || ' (' || c.code || ') — ' || l.category || ', ' || l.academic_year
      || COALESCE(' — ' || p_paid_to, '')
      || CASE WHEN p_months_covered > 1 THEN ' — ' || p_months_covered || ' months in advance' ELSE '' END;

  -- Drafted, not inserted straight to its real status -- the ledger trigger
  -- fires the moment the voucher row exists, and a category-accurate
  -- posting needs the line item to already be there when that happens.
  -- finalize_voucher() (below) is what actually decides pending/posted and
  -- ledgers it, once the line item is attached.
  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, party_name, kafalat_child_id, fund_type, status)
  VALUES ('donors_projects', 'kafalat_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    v_particular, p_amount, v_cash, COALESCE(p_paid_to, c.first_name), l.child_id, 'kafalat', 'draft')
  RETURNING id INTO v_voucher_id;

  INSERT INTO voucher_line_items (voucher_id, account_id, amount, description, category, attachment_url, period_end)
  VALUES (v_voucher_id, kafalat_expense_account(l.category), p_amount, v_particular, l.category, p_proof_url, v_covers_until);

  INSERT INTO kafalat_fee_payments (package_line_id, child_id, category, amount_pkr, method,
    paid_to, signed_by, proof_url, note, voucher_id, created_by, months_covered, covers_until)
  VALUES (p_line_id, l.child_id, l.category, p_amount, p_method, p_paid_to, p_signed_by,
    p_proof_url, p_note, v_voucher_id, current_admin_user_id(), GREATEST(p_months_covered, 1), v_covers_until)
  RETURNING id INTO v_payment_id;

  PERFORM finalize_voucher(v_voucher_id);
  SELECT voucher_no INTO v_voucher_no FROM vouchers WHERE id = v_voucher_id;
  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount, 'payment_id', v_payment_id);
END;
$function$;

create or replace function public.kafalat_record_monthly_payment(p_child_id uuid, p_method character varying, p_items jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  c kafalat_children%ROWTYPE; v_cash uuid;
  v_voucher_id uuid; v_voucher_no varchar;
  item jsonb; v_kind varchar; v_amount decimal; v_months int; v_desc text; v_category varchar;
  v_line kafalat_package_lines%ROWTYPE; v_disb kafalat_disbursements%ROWTYPE; v_unif kafalat_uniform_issues%ROWTYPE;
  v_covers_until date; v_month date; i int; v_future_id uuid;
  v_count int := 0;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM kafalat_children WHERE id = p_child_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Child not found' USING ERRCODE = 'P0001'; END IF;
  IF jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'Add at least one item.' USING ERRCODE = 'P0001'; END IF;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = my_tenant_id();

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, party_name, kafalat_child_id, fund_type, status)
  VALUES ('donors_projects', 'kafalat_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    c.first_name || ' (' || c.code || ') — monthly payment', 0, v_cash, c.first_name, p_child_id, 'kafalat', 'draft')
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_kind := item->>'kind';
    v_amount := (item->>'amount')::decimal;
    v_months := GREATEST(COALESCE((item->>'months_covered')::int, 1), 1);
    v_category := COALESCE(item->>'category', 'other');
    IF v_amount <= 0 THEN CONTINUE; END IF;
    v_covers_until := NULL;

    IF v_kind = 'fee' THEN
      SELECT * INTO v_line FROM kafalat_package_lines WHERE id = (item->>'line_id')::uuid AND tenant_id = my_tenant_id();
      IF NOT FOUND THEN RAISE EXCEPTION 'A budget line in this form no longer exists.' USING ERRCODE = 'P0001'; END IF;
      v_category := v_line.category;
      v_desc := initcap(replace(v_line.category, '_', ' ')) || ', ' || v_line.academic_year
        || CASE WHEN v_months > 1 THEN ' — ' || v_months || ' months in advance' ELSE '' END;
      IF v_months > 1 THEN v_covers_until := (now() AT TIME ZONE 'Asia/Karachi')::date + make_interval(months => v_months - 1); END IF;

      INSERT INTO kafalat_fee_payments (package_line_id, child_id, category, amount_pkr, method,
        proof_url, note, voucher_id, created_by, months_covered, covers_until)
      VALUES (v_line.id, p_child_id, v_line.category, v_amount, p_method,
        item->>'attachment_url', item->>'note', v_voucher_id, current_admin_user_id(), v_months, v_covers_until);

    ELSIF v_kind = 'disbursement' THEN
      SELECT * INTO v_disb FROM kafalat_disbursements WHERE id = (item->>'ref_id')::uuid AND tenant_id = my_tenant_id() FOR UPDATE;
      IF NOT FOUND OR v_disb.status <> 'scheduled' THEN
        RAISE EXCEPTION 'This month''s % is no longer awaiting payment.', v_category USING ERRCODE = 'P0001';
      END IF;
      v_category := v_disb.category;
      v_desc := initcap(replace(v_disb.category, '_', ' ')) || ', ' || to_char(v_disb.month, 'Mon YYYY')
        || CASE WHEN v_months > 1 THEN ' — ' || v_months || ' months in advance' ELSE '' END;

      UPDATE kafalat_disbursements SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
        method = p_method, proof_url = item->>'attachment_url', voucher_id = v_voucher_id,
        driver_name = COALESCE(item->>'paid_to', driver_name), signed_note = item->>'note'
       WHERE id = v_disb.id;

      IF v_months > 1 THEN
        FOR i IN 1..(v_months - 1) LOOP
          v_month := (v_disb.month + make_interval(months => i))::date;
          SELECT id INTO v_future_id FROM kafalat_disbursements
           WHERE child_id = p_child_id AND category = v_disb.category AND month = v_month;
          IF v_future_id IS NULL THEN
            INSERT INTO kafalat_disbursements (child_id, category, month, amount_pkr, recipient, status)
            VALUES (p_child_id, v_disb.category, v_month, v_disb.amount_pkr,
                    CASE WHEN v_disb.category = 'transport' THEN 'driver' ELSE 'guardian' END, 'scheduled')
            RETURNING id INTO v_future_id;
          END IF;
          UPDATE kafalat_disbursements SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
            method = p_method, proof_url = item->>'attachment_url', voucher_id = v_voucher_id
           WHERE id = v_future_id AND status = 'scheduled';
        END LOOP;
      END IF;

    ELSIF v_kind = 'uniform' THEN
      SELECT * INTO v_unif FROM kafalat_uniform_issues WHERE id = (item->>'ref_id')::uuid AND tenant_id = my_tenant_id() FOR UPDATE;
      IF NOT FOUND OR v_unif.status <> 'scheduled' THEN
        RAISE EXCEPTION 'This uniform is no longer awaiting payment.' USING ERRCODE = 'P0001';
      END IF;
      v_category := 'uniform';
      v_desc := 'Uniform ' || v_unif.issue_no || '/2, ' || v_unif.academic_year;
      UPDATE kafalat_uniform_issues SET status = 'issued', issued_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
        received_by = COALESCE(item->>'paid_to', c.first_name), signed_note = item->>'note',
        proof_url = item->>'attachment_url', voucher_id = v_voucher_id
       WHERE id = v_unif.id;

    ELSIF v_kind = 'other' THEN
      -- category comes straight from the form -- 'admission_fee' when the
      -- admin picks it, 'other' otherwise -- so it lands on its own real
      -- account instead of always being lumped as generic "other".
      v_desc := COALESCE(item->>'description', initcap(replace(v_category, '_', ' ')));
      INSERT INTO kafalat_fee_payments (package_line_id, child_id, category, amount_pkr, method,
        paid_to, proof_url, note, voucher_id, created_by, months_covered)
      VALUES (NULL, p_child_id, v_category, v_amount, p_method, item->>'paid_to',
        item->>'attachment_url', v_desc, v_voucher_id, current_admin_user_id(), 1);
    ELSE
      RAISE EXCEPTION 'Unknown item kind: %', v_kind USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO voucher_line_items (voucher_id, account_id, amount, description, category, attachment_url, period_start, period_end)
    VALUES (v_voucher_id, kafalat_expense_account(v_category), v_amount, v_desc, v_category, item->>'attachment_url',
      (now() AT TIME ZONE 'Asia/Karachi')::date, v_covers_until);
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    DELETE FROM vouchers WHERE id = v_voucher_id;
    RAISE EXCEPTION 'Nothing to save — every amount was zero.' USING ERRCODE = 'P0001';
  END IF;

  PERFORM finalize_voucher(v_voucher_id);
  RETURN (SELECT jsonb_build_object('voucher_id', id, 'voucher_no', voucher_no, 'status', status, 'amount', amount_pkr)
          FROM vouchers WHERE id = v_voucher_id);
END;
$function$;

create or replace function public.post_sadqa_asset_legs(p_voucher vouchers)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  o sadqa_objects%ROWTYPE; v_donor_acct uuid; v_donated uuid; v_fund uuid; v_particular text;
BEGIN
  SELECT * INTO o FROM sadqa_objects WHERE id = p_voucher.sadqa_object_id;
  v_particular := p_voucher.particular;
  v_donor_acct := o.donor_account_id;
  SELECT id INTO v_donated FROM accounts WHERE system = 'donors_projects' AND code = 'DP-2005' AND tenant_id = p_voucher.tenant_id;
  v_fund := fund_account_id('esal_e_sawab');

  -- The village owns it; the vendor was paid.
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, tenant_id)
  VALUES (p_voucher.to_account_id, p_voucher.voucher_date, v_particular,
          p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, p_voucher.tenant_id);
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, tenant_id)
  VALUES (p_voucher.from_account_id, p_voucher.voucher_date, v_particular,
          0, p_voucher.amount_pkr, 'voucher', p_voucher.id, p_voucher.receipt_no, p_voucher.tenant_id);

  -- Their money applied; the donated capital recognised. The label is the one
  -- the donor will look for on their statement.
  IF v_donor_acct IS NOT NULL AND v_donated IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, tenant_id)
    VALUES (v_donor_acct, p_voucher.voucher_date,
            'Sadqa-e-Jariya — ' || o.item_name || ' (' || o.object_no || ')',
            p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, p_voucher.tenant_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, tenant_id)
    VALUES (v_donated, p_voucher.voucher_date, v_particular,
            0, p_voucher.amount_pkr, 'voucher', p_voucher.id, p_voucher.receipt_no, p_voucher.tenant_id);
  END IF;

  -- The restricted fund is drawn down by what was spent out of it.
  IF v_fund IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, tenant_id)
    VALUES (v_fund, p_voucher.voucher_date, v_particular,
            p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, p_voucher.tenant_id);
  END IF;
END;
$function$;

create or replace function public.post_welfare_voucher_legs(p_voucher vouchers)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_expense uuid;
  v_receivable uuid;
  v_payable uuid;
  v_is_loan boolean := false;
  v_fund_account uuid;
  v_institution_account uuid;
  v_student_account uuid;
  v_child_account uuid;
  v_particular text;
BEGIN
  v_particular := p_voucher.particular;

  SELECT id INTO v_expense FROM accounts WHERE system = 'donors_projects' AND code =
    CASE p_voucher.voucher_type
      WHEN 'zakat_disbursement' THEN 'DP-5021'
      WHEN 'ushr_disbursement' THEN 'DP-5021'
      WHEN 'esal_e_sawab' THEN 'DP-5022'
      ELSE 'DP-5020' END
    AND tenant_id = p_voucher.tenant_id;
  SELECT id INTO v_receivable FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4020' AND tenant_id = p_voucher.tenant_id;
  SELECT id INTO v_payable FROM accounts WHERE system = 'donors_projects' AND code = 'DP-2020' AND tenant_id = p_voucher.tenant_id;

  IF p_voucher.fund_type IS NOT NULL THEN
    v_fund_account := fund_account_id(p_voucher.fund_type);
  END IF;
  IF p_voucher.wazifa_award_id IS NOT NULL THEN
    SELECT is_loan INTO v_is_loan FROM wazifa_awards WHERE id = p_voucher.wazifa_award_id;
  END IF;

  IF p_voucher.voucher_type IN ('zakat_disbursement', 'ushr_disbursement', 'esal_e_sawab',
                                'kafalat_payment', 'wazifa_payment') THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, tenant_id)
    VALUES (p_voucher.to_account_id, p_voucher.voucher_date, v_particular, 0, p_voucher.amount_pkr,
            'voucher', p_voucher.id, p_voucher.receipt_no, p_voucher.tenant_id);

    IF v_is_loan THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, tenant_id)
      VALUES (v_receivable, p_voucher.voucher_date, v_particular, p_voucher.amount_pkr, 0,
              'voucher', p_voucher.id, p_voucher.receipt_no, p_voucher.tenant_id);
    ELSE
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, tenant_id)
      VALUES (v_expense, p_voucher.voucher_date, v_particular, p_voucher.amount_pkr, 0,
              'voucher', p_voucher.id, p_voucher.receipt_no, p_voucher.tenant_id);
    END IF;

    IF v_fund_account IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, tenant_id)
      VALUES (v_fund_account, p_voucher.voucher_date, v_particular, p_voucher.amount_pkr, 0,
              'voucher', p_voucher.id, p_voucher.receipt_no, p_voucher.tenant_id);
    END IF;

  ELSIF p_voucher.voucher_type IN ('wazifa_repayment', 'wazifa_contribution') THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, tenant_id)
    VALUES (p_voucher.to_account_id, p_voucher.voucher_date, v_particular, p_voucher.amount_pkr, 0,
            'voucher', p_voucher.id, p_voucher.receipt_no, p_voucher.tenant_id);

    -- Money coming back lands wherever the money going out landed. On a loan
    -- that is the receivable, whether the student calls it a repayment or his
    -- monthly share; on a grant there is no debt, so a contribution reduces
    -- what the committee had to bear.
    IF p_voucher.voucher_type = 'wazifa_repayment' OR v_is_loan THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, tenant_id)
      VALUES (v_receivable, p_voucher.voucher_date, v_particular, 0, p_voucher.amount_pkr,
              'voucher', p_voucher.id, p_voucher.receipt_no, p_voucher.tenant_id);
    ELSE
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, tenant_id)
      VALUES (v_expense, p_voucher.voucher_date, v_particular, 0, p_voucher.amount_pkr,
              'voucher', p_voucher.id, p_voucher.receipt_no, p_voucher.tenant_id);
    END IF;

    IF v_fund_account IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, tenant_id)
      VALUES (v_fund_account, p_voucher.voucher_date, v_particular, 0, p_voucher.amount_pkr,
              'voucher', p_voucher.id, p_voucher.receipt_no, p_voucher.tenant_id);
    END IF;
  END IF;

  -- ── Subsidiary ledgers ────────────────────────────────────────────────
  IF p_voucher.school_id IS NOT NULL THEN
    v_institution_account := ensure_institution_account(p_voucher.school_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number, tenant_id)
    VALUES (v_institution_account, p_voucher.voucher_date, v_particular,
            p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, p_voucher.challan_no, p_voucher.tenant_id);
  END IF;

  IF p_voucher.wazifa_student_id IS NOT NULL THEN
    v_student_account := ensure_wazifa_student_account(p_voucher.wazifa_student_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, tenant_id)
    VALUES (v_student_account, p_voucher.voucher_date, v_particular,
            CASE WHEN p_voucher.voucher_type IN ('wazifa_repayment', 'wazifa_contribution')
                 THEN 0 ELSE p_voucher.amount_pkr END,
            CASE WHEN p_voucher.voucher_type IN ('wazifa_repayment', 'wazifa_contribution')
                 THEN p_voucher.amount_pkr ELSE 0 END,
            'voucher', p_voucher.id, p_voucher.receipt_no, p_voucher.tenant_id);
  END IF;

  IF p_voucher.kafalat_child_id IS NOT NULL THEN
    v_child_account := ensure_kafalat_child_account(p_voucher.kafalat_child_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, tenant_id)
    VALUES (v_child_account, p_voucher.voucher_date, v_particular,
            p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, p_voucher.tenant_id);
  END IF;
END;
$function$;

create or replace function public.sadqa_refund_balance(p_object_id uuid, p_amount numeric, p_method character varying DEFAULT 'bank'::character varying, p_note text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  o sadqa_objects%ROWTYPE; v_cash uuid; v_balance decimal; v_no varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO o FROM sadqa_objects WHERE id = p_object_id AND tenant_id = my_tenant_id();
  IF o.donor_account_id IS NULL THEN
    RAISE EXCEPTION 'This donor has no account yet.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(SUM(credit - debit), 0) INTO v_balance
    FROM ledger_entries WHERE account_id = o.donor_account_id;
  IF p_amount > v_balance THEN
    RAISE EXCEPTION 'Only Rs % is to their credit.',
      trim(to_char(v_balance, 'FM999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = my_tenant_id();

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, sadqa_object_id, fund_type)
  VALUES ('donors_projects', 'sadqa_refund', (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Sadqa-e-Jariya — returned to ' || o.donor_name || ' (' || o.object_no || ')'
      || COALESCE(' · ' || p_note, ''),
    p_amount, v_cash, o.donor_account_id, o.donor_name, p_object_id, 'esal_e_sawab')
  RETURNING voucher_no INTO v_no;
  RETURN jsonb_build_object('voucher_no', v_no, 'amount', p_amount);
END;
$function$;

create or replace function public.sadqa_settle_object(p_object_id uuid, p_method character varying DEFAULT 'bank'::character varying)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  o sadqa_objects%ROWTYPE;
  v_asset uuid; v_cash uuid; v_donated uuid; v_donor_acct uuid;
  v_voucher_id uuid; v_voucher_no varchar; v_amount decimal; v_balance decimal;
BEGIN
  SELECT * INTO o FROM sadqa_objects WHERE id = p_object_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF o.settled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Already settled.' USING ERRCODE = 'P0001';
  END IF;
  v_amount := o.actual_cost_pkr;
  IF COALESCE(v_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'Agree a bill before settling.' USING ERRCODE = 'P0001';
  END IF;

  v_asset := ensure_sadqa_asset_account(p_object_id);
  v_donor_acct := COALESCE(o.donor_account_id, ensure_donor_account(o.donor_name, o.donor_phone));
  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = my_tenant_id();
  SELECT id INTO v_donated FROM accounts WHERE system = 'donors_projects' AND code = 'DP-2005' AND tenant_id = my_tenant_id();

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, sadqa_object_id, fund_type)
  VALUES ('donors_projects', 'sadqa_asset', (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Sadqa-e-Jariya — ' || o.item_name || ' (' || o.object_no || '), dedicated to '
      || o.dedicated_to || ' · bill '
      || COALESCE((SELECT COALESCE(bill_no, vendor_name) FROM sadqa_bills WHERE id = o.agreed_bill_id), ''),
    v_amount, v_cash, v_asset, o.donor_name, p_object_id, 'esal_e_sawab')
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE sadqa_objects
     SET settled_at = now(), settlement_voucher_id = v_voucher_id,
         status = CASE WHEN status IN ('approved', 'funded') THEN 'procured' ELSE status END,
         updated_at = now()
   WHERE id = p_object_id;

  SELECT COALESCE(SUM(credit - debit), 0) INTO v_balance
    FROM ledger_entries WHERE account_id = v_donor_acct;

  PERFORM sadqa_system_message(p_object_id,
    'Bill agreed and posted as ' || v_voucher_no || '. '
    || CASE WHEN v_balance > 0 THEN 'Rs ' || trim(to_char(v_balance, 'FM999,999,990'))
                                    || ' remains to your credit.'
            WHEN v_balance < 0 THEN 'Rs ' || trim(to_char(-v_balance, 'FM999,999,990'))
                                    || ' is now due from you.'
            ELSE 'Your account is exactly settled.' END);

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', v_amount,
                            'donor_balance', v_balance,
                            'asset_account', (SELECT code FROM accounts WHERE id = v_asset));
END;
$function$;

create or replace function public.wazifa_pay_installment_advance(p_award_id uuid, p_months integer, p_method character varying)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE; ap wazifa_applications%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_total decimal := 0; v_count int := 0;
  v_month date; v_next_no int; v_charge_id uuid; v_charge_ids uuid[] := '{}'; r record;
  v_party varchar; v_dest_note text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_months < 1 OR p_months > 12 THEN
    RAISE EXCEPTION 'Choose between 1 and 12 months.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF NOT aw.installment_active OR COALESCE(aw.student_monthly_contribution_pkr, 0) <= 0 THEN
    RAISE EXCEPTION 'This award has no active instalment plan.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  SELECT * INTO ap FROM wazifa_applications WHERE id = aw.application_id;

  FOR r IN
    SELECT c.id, c.amount_pkr - c.paid_pkr AS remaining, c.due_on
      FROM wazifa_installment_charges c
     WHERE c.award_id = p_award_id AND c.status IN ('due', 'part_paid')
     ORDER BY c.due_on
     LIMIT p_months
  LOOP
    UPDATE wazifa_installment_charges SET paid_pkr = amount_pkr, status = 'paid',
           paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method
     WHERE id = r.id;
    v_total := v_total + r.remaining;
    v_count := v_count + 1;
    v_charge_ids := v_charge_ids || r.id;
  END LOOP;

  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;
  WHILE v_count < p_months LOOP
    v_month := v_month + interval '1 month';
    EXIT WHEN aw.installment_end_date IS NOT NULL AND v_month > date_trunc('month', aw.installment_end_date)::date;
    IF NOT EXISTS (SELECT 1 FROM wazifa_installment_charges
                    WHERE award_id = p_award_id AND due_on >= v_month AND due_on < v_month + interval '1 month') THEN
      SELECT COALESCE(MAX(charge_no), 0) + 1 INTO v_next_no FROM wazifa_installment_charges WHERE award_id = p_award_id;
      INSERT INTO wazifa_installment_charges (award_id, charge_no, due_on, amount_pkr, paid_pkr, status, paid_on, method)
      VALUES (p_award_id, v_next_no, v_month + (aw.installment_due_day - 1), aw.student_monthly_contribution_pkr,
              aw.student_monthly_contribution_pkr, 'paid', (now() AT TIME ZONE 'Asia/Karachi')::date, p_method)
      RETURNING id INTO v_charge_id;
      v_total := v_total + aw.student_monthly_contribution_pkr;
      v_count := v_count + 1;
      v_charge_ids := v_charge_ids || v_charge_id;
    END IF;
  END LOOP;

  IF v_total <= 0 THEN
    RAISE EXCEPTION 'Nothing to pay — this plan has already ended.' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = my_tenant_id();

  v_party := CASE aw.installment_pay_to
    WHEN 'institution' THEN COALESCE(ap.institution, st.full_name)
    WHEN 'hostel' THEN COALESCE(ap.hostel_name, st.full_name)
    ELSE st.full_name END;
  v_dest_note := CASE aw.installment_pay_to
    WHEN 'institution' THEN COALESCE(' · a/c ' || NULLIF(ap.institute_bank_account_no, ''), '')
    WHEN 'hostel' THEN COALESCE(' · a/c ' || NULLIF(ap.hostel_bank_account_no, ''), '')
    ELSE '' END;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, wazifa_student_id, wazifa_award_id, fund_type)
  VALUES ('donors_projects', 'wazifa_contribution', (now() AT TIME ZONE 'Asia/Karachi')::date,
    st.full_name || ' (' || st.code || ') — ' || v_count || ' months paid in advance, received from ' || v_party || v_dest_note,
    v_total, v_cash, v_cash, v_party, aw.student_id, aw.id,
    CASE aw.funded_by WHEN 'zakat' THEN 'zakat' WHEN 'sadqa' THEN 'sadqa' ELSE 'kafalat' END)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE wazifa_installment_charges SET voucher_id = v_voucher_id, paid_by = current_admin_user_id()
   WHERE id = ANY(v_charge_ids);

  UPDATE wazifa_awards SET contributed_pkr = contributed_pkr + v_total WHERE id = p_award_id;

  PERFORM wazifa_post_requirement_delta(aw.academic_year, -v_total,
    st.full_name || ' — ' || v_count || ' months paid in advance');

  PERFORM wazifa_allocate_qarz_repayment(aw.student_id, v_total);

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'months_paid', v_count, 'total', v_total);
END;
$function$;

create or replace function public.wazifa_pay_instalment(p_instalment_id uuid, p_method character varying, p_note text DEFAULT NULL::text, p_challan_no character varying DEFAULT NULL::character varying, p_school_id uuid DEFAULT NULL::uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  i wazifa_instalments%ROWTYPE;
  aw wazifa_awards%ROWTYPE;
  st wazifa_students%ROWTYPE;
  v_cash_account uuid;
  v_school_id uuid;
  v_voucher_id uuid;
  v_voucher_no varchar;
  v_receipt varchar;
  v_fund varchar;
  v_particular text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO i FROM wazifa_instalments WHERE id = p_instalment_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Instalment not found' USING ERRCODE = 'P0001'; END IF;
  IF i.status = 'paid' THEN RAISE EXCEPTION 'Already paid.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = i.award_id;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  v_fund := CASE aw.funded_by WHEN 'zakat' THEN 'zakat' WHEN 'sadqa' THEN 'sadqa' ELSE 'kafalat' END;
  v_school_id := COALESCE(p_school_id, aw.institution_school_id);

  -- A payment to an institution needs to know which institution, or the
  -- committee has no statement to reconcile against later.
  IF i.pay_to = 'institution' AND v_school_id IS NULL THEN
    RAISE EXCEPTION 'Choose the school or college this is being paid to.' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_cash_account FROM accounts
   WHERE system = 'donors_projects' AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = my_tenant_id();

  v_particular := st.code || ' · ' || i.purpose
    || CASE WHEN p_challan_no IS NOT NULL THEN ' · challan ' || p_challan_no ELSE '' END
    || CASE WHEN i.pay_to = 'student' THEN ' · paid to the student (zakat, tamleek)' ELSE '' END;

  INSERT INTO vouchers (
    system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name,
    wazifa_student_id, wazifa_award_id, school_id, challan_no, fund_type
  ) VALUES (
    'donors_projects', 'wazifa_payment',
    COALESCE(i.due_on, (now() AT TIME ZONE 'Asia/Karachi')::date),
    v_particular, i.amount_pkr,
    v_cash_account, v_cash_account,
    CASE WHEN i.pay_to = 'student' THEN st.full_name
         ELSE (SELECT name FROM schools WHERE id = v_school_id) END,
    aw.student_id, aw.id,
    CASE WHEN i.pay_to = 'institution' THEN v_school_id ELSE NULL END,
    p_challan_no, v_fund
  ) RETURNING id, voucher_no, receipt_no INTO v_voucher_id, v_voucher_no, v_receipt;

  UPDATE wazifa_instalments
     SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
         receipt_no = COALESCE(v_receipt, v_voucher_no), method = p_method,
         note = COALESCE(p_note, note), paid_by = current_admin_user_id()
   WHERE id = p_instalment_id;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', i.amount_pkr,
                            'paid_to', i.pay_to, 'voucher_id', v_voucher_id);
END;
$function$;

create or replace function public.wazifa_pay_instalment(p_instalment_id uuid, p_method character varying, p_note text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  i wazifa_instalments%ROWTYPE;
  aw wazifa_awards%ROWTYPE;
  st wazifa_students%ROWTYPE;
  v_receipt varchar;
  v_fund_account uuid;
  v_cash_account uuid;
  v_fund varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO i FROM wazifa_instalments WHERE id = p_instalment_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Instalment not found' USING ERRCODE = 'P0001'; END IF;
  IF i.status = 'paid' THEN RAISE EXCEPTION 'Already paid.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = i.award_id;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;

  v_fund := CASE aw.funded_by WHEN 'zakat' THEN 'zakat' WHEN 'sadqa' THEN 'sadqa' ELSE 'kafalat' END;
  v_fund_account := fund_account_id(v_fund);
  v_receipt := next_receipt_no();

  SELECT id INTO v_cash_account FROM accounts
   WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = my_tenant_id();

  -- The code, not the name — same rule as the zakat register. A student's
  -- financial need should not be legible to whoever opens the ledger.
  IF v_fund_account IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_fund_account, COALESCE(i.due_on, (now() AT TIME ZONE 'Asia/Karachi')::date),
            'Taleemi Wazifa — ' || st.code || ' · ' || i.purpose,
            i.amount_pkr, 0, 'manual', i.id, v_receipt);
  END IF;

  IF v_cash_account IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_cash_account, COALESCE(i.due_on, (now() AT TIME ZONE 'Asia/Karachi')::date),
            'Taleemi Wazifa — ' || st.code,
            0, i.amount_pkr, 'manual', i.id, v_receipt);
  END IF;

  UPDATE wazifa_instalments
     SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
         receipt_no = v_receipt, method = p_method,
         note = COALESCE(p_note, note), paid_by = current_admin_user_id()
   WHERE id = p_instalment_id;

  RETURN jsonb_build_object('receipt_no', v_receipt, 'amount', i.amount_pkr);
END;
$function$;

create or replace function public.wazifa_record_contribution(p_award_id uuid, p_amount numeric, p_method character varying, p_for_month date DEFAULT NULL::date, p_note text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE; v_cash uuid;
  v_voucher_id uuid; v_voucher_no varchar; v_receipt varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = my_tenant_id();

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, wazifa_student_id, wazifa_award_id, fund_type)
  VALUES ('donors_projects', 'wazifa_contribution', (now() AT TIME ZONE 'Asia/Karachi')::date,
    st.full_name || ' (' || st.code || ') — student''s own monthly share'
      || COALESCE(' · ' || to_char(p_for_month, 'Mon YYYY'), '') || COALESCE(' · ' || p_note, ''),
    p_amount, v_cash, v_cash, st.full_name, aw.student_id, aw.id,
    CASE aw.funded_by WHEN 'zakat' THEN 'zakat' WHEN 'sadqa' THEN 'sadqa' ELSE 'kafalat' END)
  RETURNING id, voucher_no, receipt_no INTO v_voucher_id, v_voucher_no, v_receipt;

  UPDATE wazifa_awards SET contributed_pkr = contributed_pkr + p_amount WHERE id = p_award_id;

  -- The measuring account only — the trigger fired by the insert above
  -- already posted the student's own subsidiary-account leg. This used to
  -- pass aw.student_id here too, which posted that same leg a second time.
  PERFORM wazifa_post_requirement_delta(aw.academic_year, -p_amount,
    st.full_name || ' contributed — ' || COALESCE(to_char(p_for_month, 'Mon YYYY'), to_char(now(), 'Mon YYYY')));

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount);
END;
$function$;

create or replace function public.wazifa_record_repayment(p_award_id uuid, p_amount numeric, p_method character varying, p_note text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE;
  v_cash_account uuid; v_voucher_id uuid; v_voucher_no varchar; v_receipt varchar; v_fund varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF NOT aw.is_loan THEN
    RAISE EXCEPTION 'This award was a grant, not a qarz-e-hasana — nothing is owed on it.' USING ERRCODE = 'P0001';
  END IF;
  IF aw.repaid_pkr + p_amount > aw.awarded_amount_pkr + 0.01 THEN
    RAISE EXCEPTION 'That is more than is outstanding. Rs % is still owed.',
      trim(to_char(aw.awarded_amount_pkr - aw.repaid_pkr, 'FM999,999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  v_fund := CASE aw.funded_by WHEN 'sadqa' THEN 'sadqa' ELSE 'kafalat' END;
  SELECT id INTO v_cash_account FROM accounts
   WHERE system = 'donors_projects' AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = my_tenant_id();

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, wazifa_student_id, wazifa_award_id, fund_type)
  VALUES ('donors_projects', 'wazifa_repayment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    st.code || ' · qarz-e-hasana repayment', p_amount,
    v_cash_account, v_cash_account, st.full_name, aw.student_id, aw.id, v_fund)
  RETURNING id, voucher_no, receipt_no INTO v_voucher_id, v_voucher_no, v_receipt;

  INSERT INTO wazifa_repayments (award_id, amount_pkr, method, receipt_no, note, received_by)
  VALUES (p_award_id, p_amount, p_method, COALESCE(v_receipt, v_voucher_no), p_note, current_admin_user_id());

  PERFORM wazifa_apply_repayment_to_schedule(p_award_id, p_amount);

  UPDATE wazifa_awards a
     SET repaid_pkr = (SELECT COALESCE(SUM(amount_pkr), 0) FROM wazifa_repayments WHERE award_id = a.id),
         status = CASE WHEN (SELECT COALESCE(SUM(amount_pkr), 0) FROM wazifa_repayments WHERE award_id = a.id)
                        >= a.awarded_amount_pkr - 0.01 THEN 'completed' ELSE a.status END
   WHERE a.id = p_award_id;

  PERFORM wazifa_allocate_qarz_repayment(aw.student_id, p_amount);

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount);
END;
$function$;

create or replace function public.wazifa_write_off_loan(p_award_id uuid, p_amount numeric, p_reason text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE;
  v_outstanding decimal; v_expense uuid; v_receivable uuid;
  v_voucher_no varchar;
BEGIN
  -- Deliberately a higher bar than taking a repayment: forgiving a debt owed
  -- to the village is a committee decision, not a counter transaction.
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false) THEN
    RAISE EXCEPTION 'Only an approver can write off a qarz-e-hasana.' USING ERRCODE = 'P0001';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Write down why this loan is being forgiven. It is money the village will not get back.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF NOT aw.is_loan THEN RAISE EXCEPTION 'This was a grant — there is nothing to write off.' USING ERRCODE = 'P0001'; END IF;

  v_outstanding := aw.awarded_amount_pkr - aw.repaid_pkr - aw.written_off_pkr;
  IF p_amount > v_outstanding + 0.01 THEN
    RAISE EXCEPTION 'Only Rs % is still outstanding.', trim(to_char(v_outstanding, 'FM999,999,999,990'))
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  SELECT id INTO v_expense FROM accounts WHERE system = 'donors_projects' AND code = 'DP-5020' AND tenant_id = my_tenant_id();
  SELECT id INTO v_receivable FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4020' AND tenant_id = my_tenant_id();

  -- The moment a loan stops being an asset and becomes expenditure.
  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, wazifa_student_id, wazifa_award_id)
  VALUES ('donors_projects', 'expense', (now() AT TIME ZONE 'Asia/Karachi')::date,
    st.code || ' · qarz-e-hasana written off · ' || trim(p_reason), p_amount,
    v_receivable, v_expense, st.full_name, aw.student_id, aw.id)
  RETURNING voucher_no INTO v_voucher_no;

  UPDATE wazifa_awards
     SET written_off_pkr = written_off_pkr + p_amount,
         written_off_at = now(), written_off_by = current_admin_user_id(),
         write_off_reason = p_reason,
         status = CASE WHEN repaid_pkr + written_off_pkr + p_amount >= awarded_amount_pkr - 0.01
                       THEN 'completed' ELSE status END
   WHERE id = p_award_id;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'written_off', p_amount);
END;
$function$;

create or replace function public.zakat_disburse(p_beneficiary_id uuid, p_method character varying, p_acknowledgement character varying, p_acknowledgement_ref character varying DEFAULT NULL::character varying, p_note text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  b zakat_round_beneficiaries%ROWTYPE; r zakat_rounds%ROWTYPE;
  v_cash_account uuid; v_voucher_no varchar; v_receipt varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO b FROM zakat_round_beneficiaries WHERE id = p_beneficiary_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status = 'paid' THEN RAISE EXCEPTION 'Already paid.' USING ERRCODE = 'P0001'; END IF;
  IF b.amount_pkr <= 0 THEN RAISE EXCEPTION 'Compute the shares first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO r FROM zakat_rounds WHERE id = b.round_id;
  SELECT id INTO v_cash_account FROM accounts
   WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method IN ('cash', 'in_kind') THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = my_tenant_id();

  -- The voucher carries the CODE and never the household. The accountant can
  -- post this without learning whose door the money went to.
  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, needs_code, fund_type)
  VALUES ('donors_projects',
    CASE WHEN r.fund_type = 'ushr' THEN 'ushr_disbursement' ELSE 'zakat_disbursement' END,
    (now() AT TIME ZONE 'Asia/Karachi')::date,
    upper(r.fund_type) || ' · ' || b.code || ' · ' || r.name, b.amount_pkr,
    v_cash_account, v_cash_account, b.code, b.code, r.fund_type)
  RETURNING voucher_no, receipt_no INTO v_voucher_no, v_receipt;

  UPDATE zakat_round_beneficiaries
     SET status = 'paid', method = p_method, receipt_no = COALESCE(v_receipt, v_voucher_no),
         acknowledgement = p_acknowledgement, acknowledgement_ref = p_acknowledgement_ref,
         note = p_note, paid_at = now(), paid_by = current_admin_user_id()
   WHERE id = p_beneficiary_id;

  UPDATE zakat_rounds z
     SET distributed_pkr = (SELECT COALESCE(SUM(amount_pkr), 0) FROM zakat_round_beneficiaries
                             WHERE round_id = z.id AND status = 'paid')
   WHERE z.id = b.round_id;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'receipt_no', COALESCE(v_receipt, v_voucher_no), 'amount', b.amount_pkr);
END;
$function$;
