-- Migration 439: close a real gap the waiver feature (438) opened.
--
-- waive_bill() zeroes a bill's net-payable via discount_amount, so every
-- existing "can this be paid" check (all of them read amount_pkr minus
-- discount_amount) already reads ₨0 and the Receive Payment button never
-- even renders — bills needed no further changes.
--
-- wazifa_installment_charges / training_fee_charges have no equivalent
-- "amount owed" field to zero — waive_wazifa_installment_charge() and
-- waive_academy_fee_charge() only set status = 'waived', leaving
-- amount_pkr/paid_pkr untouched. Every payment-recording RPC against
-- these two tables only ever checked `status = 'paid'` before accepting
-- money — never 'waived', because that value didn't have a real meaning
-- until now. Left alone, an accountant could still tick a waived month
-- in the wazifa calendar, or collect/confirm a training fee charge the
-- committee already forgave, silently reversing the waiver and posting
-- real cash against it. This adds the missing guard to every one of
-- those paths, matching the "already paid" rejection each already has.
--
-- wazifa_repayment_schedule has no live payment-recording RPC at all
-- (checked: nothing outside 438 has ever UPDATEd its status column) —
-- nothing to patch there.

-- ── Single-charge wazifa instalment payment ───────────────────────────
CREATE OR REPLACE FUNCTION wazifa_pay_installment_charge(
  p_charge_id uuid, p_amount decimal, p_method varchar, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  c wazifa_installment_charges%ROWTYPE; aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE; ap wazifa_applications%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_remaining decimal; v_party varchar; v_dest_note text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO c FROM wazifa_installment_charges WHERE id = p_charge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Instalment not found' USING ERRCODE = 'P0001'; END IF;
  IF c.status = 'paid' THEN RAISE EXCEPTION 'Already paid.' USING ERRCODE = 'P0001'; END IF;
  IF c.status = 'waived' THEN RAISE EXCEPTION 'This instalment was waived by the committee — nothing to collect.' USING ERRCODE = 'P0001'; END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Enter an amount greater than zero.' USING ERRCODE = 'P0001'; END IF;

  v_remaining := c.amount_pkr - c.paid_pkr;
  IF p_amount > v_remaining + 0.01 THEN
    RAISE EXCEPTION 'That is more than is due — Rs % is left on this instalment.',
      trim(to_char(v_remaining, 'FM999,999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = c.award_id;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  SELECT * INTO ap FROM wazifa_applications WHERE id = aw.application_id;
  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

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
    'Wazifa Instalment — ' || st.full_name || ' (' || st.code || ') — ' || to_char(c.due_on, 'Mon YYYY')
      || ' — received from ' || v_party || v_dest_note || COALESCE(' · ' || p_note, ''),
    p_amount, v_cash, v_cash, v_party, aw.student_id, aw.id,
    CASE aw.funded_by WHEN 'zakat' THEN 'zakat' WHEN 'sadqa' THEN 'sadqa' ELSE 'kafalat' END)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE wazifa_installment_charges
     SET paid_pkr = paid_pkr + p_amount,
         status = CASE WHEN paid_pkr + p_amount >= amount_pkr - 0.01 THEN 'paid' ELSE 'part_paid' END,
         paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method,
         voucher_id = v_voucher_id, note = COALESCE(p_note, note), paid_by = current_admin_user_id()
   WHERE id = p_charge_id;

  UPDATE wazifa_awards SET contributed_pkr = contributed_pkr + p_amount WHERE id = c.award_id;

  PERFORM wazifa_post_requirement_delta(aw.academic_year, -p_amount,
    st.full_name || ' — instalment ' || to_char(c.due_on, 'Mon YYYY'));

  PERFORM wazifa_allocate_qarz_repayment(aw.student_id, p_amount);

  IF st.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (st.portal_user_id, 'wazifa_payment_recorded', 'Taleemi Wazifa payment recorded',
      'Rs ' || trim(to_char(p_amount, 'FM999,999,999,990')) || ' recorded for ' || to_char(c.due_on, 'Mon YYYY') || '.',
      '/portal/wazifa');
  END IF;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount, 'charge_id', p_charge_id, 'paid_to', aw.installment_pay_to);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── The calendar "pay ticked months" batch path ───────────────────────
CREATE OR REPLACE FUNCTION wazifa_pay_specific_months(
  p_award_id uuid, p_months date[], p_method varchar
) RETURNS jsonb AS $$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_total decimal := 0; v_count int := 0;
  v_month date; v_next_no int; v_charge_id uuid; v_charge_status varchar; v_charge_ids uuid[] := '{}'; v_month_labels text[] := '{}';
  v_particular text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(array_length(p_months, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Choose at least one month.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF NOT aw.installment_active OR COALESCE(aw.student_monthly_contribution_pkr, 0) <= 0 THEN
    RAISE EXCEPTION 'This award has no active instalment plan.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;

  FOREACH v_month IN ARRAY p_months LOOP
    v_month := date_trunc('month', v_month)::date;

    SELECT id, status, amount_pkr - paid_pkr INTO v_charge_id, v_charge_status, v_total
      FROM wazifa_installment_charges
     WHERE award_id = p_award_id AND due_on >= v_month AND due_on < v_month + interval '1 month'
     LIMIT 1;

    IF v_charge_id IS NOT NULL THEN
      -- Already there — could be due, part-paid, waived, or (if the same
      -- month was picked twice in one click, or it was paid a moment ago
      -- by someone else) already settled. A waived month is skipped the
      -- same way an already-paid one is — nothing left to collect, and
      -- ticking it in the calendar must never quietly un-waive it.
      IF v_charge_status = 'waived' THEN CONTINUE; END IF;
      SELECT amount_pkr - paid_pkr INTO v_total FROM wazifa_installment_charges WHERE id = v_charge_id;
      IF v_total <= 0 THEN CONTINUE; END IF;
      UPDATE wazifa_installment_charges SET paid_pkr = amount_pkr, status = 'paid',
             paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method
       WHERE id = v_charge_id;
    ELSE
      SELECT COALESCE(MAX(charge_no), 0) + 1 INTO v_next_no FROM wazifa_installment_charges WHERE award_id = p_award_id;
      v_total := aw.student_monthly_contribution_pkr;
      INSERT INTO wazifa_installment_charges (award_id, charge_no, due_on, amount_pkr, paid_pkr, status, paid_on, method)
      VALUES (p_award_id, v_next_no, v_month + (aw.installment_due_day - 1), v_total, v_total, 'paid',
              (now() AT TIME ZONE 'Asia/Karachi')::date, p_method)
      RETURNING id INTO v_charge_id;
    END IF;

    v_charge_ids := v_charge_ids || v_charge_id;
    v_month_labels := v_month_labels || to_char(v_month, 'Mon YYYY');
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'Every month chosen is already paid or waived.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_total FROM wazifa_installment_charges WHERE id = ANY(v_charge_ids);

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  v_particular := 'Wazifa Instalment — ' || st.full_name || ' (' || st.code || ') — '
    || array_to_string(v_month_labels, ', ') || ' — received from ' || st.full_name;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, wazifa_student_id, wazifa_award_id, fund_type)
  VALUES ('donors_projects', 'wazifa_contribution', (now() AT TIME ZONE 'Asia/Karachi')::date,
    v_particular, v_total, v_cash, v_cash, st.full_name, aw.student_id, aw.id,
    CASE aw.funded_by WHEN 'zakat' THEN 'zakat' WHEN 'sadqa' THEN 'sadqa' ELSE 'kafalat' END)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE wazifa_installment_charges SET voucher_id = v_voucher_id, paid_by = current_admin_user_id()
   WHERE id = ANY(v_charge_ids);

  UPDATE wazifa_awards SET contributed_pkr = contributed_pkr + v_total WHERE id = p_award_id;

  PERFORM wazifa_post_requirement_delta(aw.academic_year, -v_total,
    st.full_name || ' — ' || array_to_string(v_month_labels, ', '));

  PERFORM wazifa_allocate_qarz_repayment(aw.student_id, v_total);

  IF st.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (st.portal_user_id, 'wazifa_payment_recorded', 'Taleemi Wazifa payment recorded',
      'Rs ' || trim(to_char(v_total, 'FM999,999,999,990')) || ' recorded for ' || array_to_string(v_month_labels, ', ') || '.',
      '/portal/wazifa');
  END IF;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'months_paid', v_count, 'total', v_total, 'months', v_month_labels);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── Academy fee: staff/collector direct collection ────────────────────
CREATE OR REPLACE FUNCTION pay_training_fee_charge(
  p_charge_id uuid, p_amount decimal, p_method varchar, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  c training_fee_charges%ROWTYPE; e training_enrollments%ROWTYPE; proj projects%ROWTYPE;
  v_is_full_accountant boolean;
  v_is_collector boolean;
  v_from_account uuid;
  v_project_account uuid;
  v_voucher_id uuid; v_voucher_no varchar; v_remaining decimal;
  v_collected_by uuid;
  v_popup_enabled boolean;
  v_collector_name varchar;
  r record;
BEGIN
  SELECT * INTO c FROM training_fee_charges WHERE id = p_charge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Charge not found' USING ERRCODE = 'P0001'; END IF;
  IF c.status = 'paid' THEN RAISE EXCEPTION 'Already paid.' USING ERRCODE = 'P0001'; END IF;
  IF c.status = 'waived' THEN RAISE EXCEPTION 'This fee was waived by the committee — nothing to collect.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO e FROM training_enrollments WHERE id = c.enrollment_id;

  v_is_full_accountant := COALESCE(current_admin_permission('post_transactions'), false);
  v_is_collector := current_admin_can_collect_for_training_program(e.project_id);
  IF NOT v_is_full_accountant AND NOT v_is_collector THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Enter an amount greater than zero.' USING ERRCODE = 'P0001'; END IF;

  v_remaining := c.amount_pkr - c.paid_pkr;
  IF p_amount > v_remaining + 0.01 THEN
    RAISE EXCEPTION 'That is more than is due — Rs % is left on this charge.',
      trim(to_char(v_remaining, 'FM999,999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO proj FROM projects WHERE id = e.project_id;
  v_project_account := ensure_project_account(e.project_id);

  IF v_is_full_accountant AND NOT v_is_collector THEN
    v_collected_by := NULL;
    SELECT id INTO v_from_account FROM accounts WHERE system = 'donors_projects'
       AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);
  ELSE
    v_collected_by := current_admin_user_id();
    v_from_account := ensure_collector_account(v_collected_by, 'donors_projects');
  END IF;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, project_id)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    e.student_name || ' — training fee, charge ' || c.charge_no || ' (' || COALESCE(proj.display_name, proj.title) || ')'
      || COALESCE(' · ' || p_note, ''),
    p_amount, v_project_account, v_from_account, e.student_name, e.project_id)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE training_fee_charges
     SET paid_pkr = paid_pkr + p_amount,
         status = CASE WHEN paid_pkr + p_amount >= amount_pkr - 0.01 THEN 'paid' ELSE 'part_paid' END,
         paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method,
         voucher_id = v_voucher_id, note = COALESCE(p_note, note), collected_by = v_collected_by
   WHERE id = p_charge_id;

  IF v_collected_by IS NOT NULL THEN
    SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'training_fee_collected';
    IF v_popup_enabled IS TRUE THEN
      SELECT full_name INTO v_collector_name FROM admin_users WHERE id = v_collected_by;
      FOR r IN
        SELECT id FROM admin_users
        WHERE is_active = true AND id != v_collected_by AND (
          role IN ('super_admin', 'admin', 'donor_accountant')
          OR (role = 'accountant' AND access_donors_projects)
        )
      LOOP
        INSERT INTO notifications (recipient_id, event_type, title, body, link)
        VALUES (r.id, 'training_fee_collected', 'Training fee collected',
          COALESCE(v_collector_name, 'A trainer') || ' collected Rs ' || trim(to_char(p_amount, 'FM999,999,999,990'))
            || ' from ' || e.student_name || ' (' || COALESCE(proj.display_name, proj.title) || ')',
          '/admin/donors/collectors');
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount, 'charge_id', p_charge_id, 'collected_by', v_collected_by);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── Academy fee: portal self-announce (parent/student uploads a slip) ──
CREATE OR REPLACE FUNCTION announce_training_fee_payment(
  p_charge_id uuid, p_amount decimal, p_method varchar, p_proof_url text
) RETURNS void AS $$
DECLARE
  c training_fee_charges%ROWTYPE; e training_enrollments%ROWTYPE;
  v_portal_user_id uuid := current_portal_user_id();
  v_remaining decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO c FROM training_fee_charges WHERE id = p_charge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Charge not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO e FROM training_enrollments WHERE id = c.enrollment_id;
  IF e.portal_user_id IS DISTINCT FROM v_portal_user_id THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF c.status IN ('paid', 'announced') THEN
    RAISE EXCEPTION 'This charge already has a payment recorded or awaiting confirmation.' USING ERRCODE = 'P0001';
  END IF;
  IF c.status = 'waived' THEN
    RAISE EXCEPTION 'This fee was waived by the committee — there is nothing to pay.' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Enter an amount greater than zero.' USING ERRCODE = 'P0001'; END IF;
  IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;

  v_remaining := c.amount_pkr - c.paid_pkr;
  IF p_amount > v_remaining + 0.01 THEN
    RAISE EXCEPTION 'That is more than is due — Rs % is left on this charge.',
      trim(to_char(v_remaining, 'FM999,999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  UPDATE training_fee_charges
     SET status = 'announced', announced_amount_pkr = p_amount, announced_method = p_method,
         announced_proof_url = p_proof_url, announced_at = now()
   WHERE id = p_charge_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── waive_academy_fee_charge (438) gets one more guard: a charge with a
-- self-announced payment sitting unconfirmed already has real money in
-- transit (a bank slip was uploaded) even though paid_pkr is still 0 —
-- 438's own "nothing paid yet" check didn't know that state existed.
-- Waiving it now would leave a live confirm_training_fee_announcement()
-- able to overwrite 'waived' back to 'paid' and post the cash anyway.
-- The committee needs to reject the announcement first (or the family
-- withdraws it), the same order any other pending-payment conflict is
-- already resolved in.
CREATE OR REPLACE FUNCTION waive_academy_fee_charge(p_id uuid, p_reason text) RETURNS void AS $$
DECLARE c training_fee_charges%ROWTYPE; v_admin_id uuid := current_admin_user_id();
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Give a reason for the waiver — it is the only record of why this fee was forgiven.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM training_fee_charges WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fee charge not found' USING ERRCODE = 'P0001'; END IF;
  IF c.status = 'waived' THEN RAISE EXCEPTION 'This fee is already waived.' USING ERRCODE = 'P0001'; END IF;
  IF c.status = 'announced' THEN
    RAISE EXCEPTION 'A payment for this fee is already announced and awaiting confirmation — confirm or reject it first, then waive if still needed.' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(c.paid_pkr, 0) > 0 THEN
    RAISE EXCEPTION 'This fee already has a payment recorded — a waiver only applies before anything has been paid.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE training_fee_charges SET
    status = 'waived', waived_at = now(), waived_by_admin_id = v_admin_id, waived_reason = trim(p_reason)
  WHERE id = p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
