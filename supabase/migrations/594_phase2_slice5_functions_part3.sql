-- Phase 2, slice 5 (functions, part 3): the four wazifa payment-recording
-- functions missed in part 2. Each is admin-permission-gated only, with no
-- tenant filter on its target charge/award lookup, and each also looks up
-- a DP-1001/DP-1002 cash account by bare code with no tenant filter.
-- Reproduced from the real, current body (pulled live via
-- pg_get_functiondef) with only the minimal tenant-scoping fix applied.

create or replace function public.wazifa_pay_disbursement_charge(p_charge_id uuid, p_method character varying, p_note text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  c wazifa_disbursement_charges%ROWTYPE; aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE; ap wazifa_applications%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_party varchar; v_dest_note text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO c FROM wazifa_disbursement_charges WHERE id = p_charge_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF c.status = 'paid' THEN RAISE EXCEPTION 'Already paid.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = c.award_id;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  SELECT * INTO ap FROM wazifa_applications WHERE id = aw.application_id;
  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = c.tenant_id;

  v_party := CASE aw.disbursement_pay_to
    WHEN 'institution' THEN COALESCE(ap.institution, st.full_name)
    WHEN 'hostel' THEN COALESCE(ap.hostel_name, st.full_name)
    ELSE st.full_name END;
  v_dest_note := CASE aw.disbursement_pay_to
    WHEN 'institution' THEN COALESCE(' · a/c ' || NULLIF(ap.institute_bank_account_no, ''), '')
    WHEN 'hostel' THEN COALESCE(' · a/c ' || NULLIF(ap.hostel_bank_account_no, ''), '')
    ELSE '' END;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, wazifa_student_id, wazifa_award_id, fund_type)
  VALUES ('donors_projects', 'wazifa_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Wazifa Monthly Support — ' || st.full_name || ' (' || st.code || ') — ' || to_char(c.due_on, 'Mon YYYY')
      || ' — paid to ' || v_party || v_dest_note || COALESCE(' · ' || p_note, ''),
    c.amount_pkr, v_cash, v_cash, v_party, aw.student_id, aw.id,
    CASE aw.funded_by WHEN 'zakat' THEN 'zakat' WHEN 'sadqa' THEN 'sadqa' ELSE 'kafalat' END)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE wazifa_disbursement_charges
     SET paid_pkr = amount_pkr, status = 'paid',
         paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method,
         voucher_id = v_voucher_id, note = COALESCE(p_note, note), paid_by = current_admin_user_id()
   WHERE id = p_charge_id;

  UPDATE wazifa_awards SET disbursed_pkr = disbursed_pkr + c.amount_pkr WHERE id = c.award_id;

  IF st.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (st.portal_user_id, 'wazifa_support_paid', 'Taleemi Wazifa support paid',
      'Rs ' || trim(to_char(c.amount_pkr, 'FM999,999,999,990')) || ' for ' || to_char(c.due_on, 'Mon YYYY') || ' has been paid to you.',
      '/portal/wazifa', c.tenant_id);
  END IF;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', c.amount_pkr, 'charge_id', p_charge_id);
END;
$function$;

create or replace function public.wazifa_pay_installment_charge(p_charge_id uuid, p_amount numeric, p_method character varying, p_note text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  c wazifa_installment_charges%ROWTYPE; aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE; ap wazifa_applications%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_remaining decimal; v_party varchar; v_dest_note text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO c FROM wazifa_installment_charges WHERE id = p_charge_id AND tenant_id = my_tenant_id() FOR UPDATE;
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
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = c.tenant_id;

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
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (st.portal_user_id, 'wazifa_payment_recorded', 'Taleemi Wazifa payment recorded',
      'Rs ' || trim(to_char(p_amount, 'FM999,999,999,990')) || ' recorded for ' || to_char(c.due_on, 'Mon YYYY') || '.',
      '/portal/wazifa', c.tenant_id);
  END IF;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount, 'charge_id', p_charge_id, 'paid_to', aw.installment_pay_to);
END;
$function$;

create or replace function public.wazifa_pay_specific_months(p_award_id uuid, p_months date[], p_method character varying)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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

  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id AND tenant_id = my_tenant_id();
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
      INSERT INTO wazifa_installment_charges (award_id, charge_no, due_on, amount_pkr, paid_pkr, status, paid_on, method, tenant_id)
      VALUES (p_award_id, v_next_no, v_month + (aw.installment_due_day - 1), v_total, v_total, 'paid',
              (now() AT TIME ZONE 'Asia/Karachi')::date, p_method, aw.tenant_id)
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
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = aw.tenant_id;

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
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (st.portal_user_id, 'wazifa_payment_recorded', 'Taleemi Wazifa payment recorded',
      'Rs ' || trim(to_char(v_total, 'FM999,999,999,990')) || ' recorded for ' || array_to_string(v_month_labels, ', ') || '.',
      '/portal/wazifa', aw.tenant_id);
  END IF;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'months_paid', v_count, 'total', v_total, 'months', v_month_labels);
END;
$function$;

create or replace function public.wazifa_payout_specific_months(p_award_id uuid, p_months date[], p_method character varying)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE; ap wazifa_applications%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_total decimal := 0; v_count int := 0;
  v_month date; v_next_no int; v_charge_id uuid; v_charge_ids uuid[] := '{}'; v_month_labels text[] := '{}';
  v_party varchar; v_dest_note text; v_particular text; v_remaining decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(array_length(p_months, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Choose at least one month.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF NOT aw.disbursement_active OR COALESCE(aw.disbursement_monthly_pkr, 0) <= 0 THEN
    RAISE EXCEPTION 'This award has no active disbursement plan.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  SELECT * INTO ap FROM wazifa_applications WHERE id = aw.application_id;

  FOREACH v_month IN ARRAY p_months LOOP
    v_month := date_trunc('month', v_month)::date;

    SELECT id INTO v_charge_id FROM wazifa_disbursement_charges
     WHERE award_id = p_award_id AND due_on >= v_month AND due_on < v_month + interval '1 month'
     LIMIT 1;

    IF v_charge_id IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM wazifa_disbursement_charges WHERE id = v_charge_id AND status = 'paid') THEN
        CONTINUE;
      END IF;
      UPDATE wazifa_disbursement_charges SET paid_pkr = amount_pkr, status = 'paid',
             paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method
       WHERE id = v_charge_id;
      SELECT amount_pkr INTO v_remaining FROM wazifa_disbursement_charges WHERE id = v_charge_id;
    ELSE
      SELECT COALESCE(MAX(charge_no), 0) + 1 INTO v_next_no FROM wazifa_disbursement_charges WHERE award_id = p_award_id;
      v_remaining := aw.disbursement_monthly_pkr;
      INSERT INTO wazifa_disbursement_charges (award_id, charge_no, due_on, amount_pkr, paid_pkr, status, paid_on, method, tenant_id)
      VALUES (p_award_id, v_next_no, v_month + (aw.disbursement_due_day - 1), v_remaining, v_remaining, 'paid',
              (now() AT TIME ZONE 'Asia/Karachi')::date, p_method, aw.tenant_id)
      RETURNING id INTO v_charge_id;
    END IF;

    v_total := v_total + v_remaining;
    v_charge_ids := v_charge_ids || v_charge_id;
    v_month_labels := v_month_labels || to_char(v_month, 'Mon YYYY');
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'Every month chosen is already paid.' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = aw.tenant_id;

  v_party := CASE aw.disbursement_pay_to
    WHEN 'institution' THEN COALESCE(ap.institution, st.full_name)
    WHEN 'hostel' THEN COALESCE(ap.hostel_name, st.full_name)
    ELSE st.full_name END;
  v_dest_note := CASE aw.disbursement_pay_to
    WHEN 'institution' THEN COALESCE(' · a/c ' || NULLIF(ap.institute_bank_account_no, ''), '')
    WHEN 'hostel' THEN COALESCE(' · a/c ' || NULLIF(ap.hostel_bank_account_no, ''), '')
    ELSE '' END;

  v_particular := 'Wazifa Payout — ' || st.full_name || ' (' || st.code || ') — '
    || array_to_string(v_month_labels, ', ') || ' — paid to ' || v_party || v_dest_note;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, wazifa_student_id, wazifa_award_id, fund_type)
  VALUES ('donors_projects', 'wazifa_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    v_particular, v_total, v_cash, v_cash, v_party, aw.student_id, aw.id,
    CASE aw.funded_by WHEN 'zakat' THEN 'zakat' WHEN 'sadqa' THEN 'sadqa' ELSE 'kafalat' END)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE wazifa_disbursement_charges SET voucher_id = v_voucher_id, paid_by = current_admin_user_id()
   WHERE id = ANY(v_charge_ids);

  UPDATE wazifa_awards SET disbursed_pkr = disbursed_pkr + v_total WHERE id = p_award_id;

  IF st.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (st.portal_user_id, 'wazifa_support_paid', 'Taleemi Wazifa support paid',
      'Rs ' || trim(to_char(v_total, 'FM999,999,999,990')) || ' for ' || array_to_string(v_month_labels, ', ') || ' has been paid to you.',
      '/portal/wazifa', aw.tenant_id);
  END IF;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'months_paid', v_count, 'total', v_total, 'months', v_month_labels);
END;
$function$;
