-- Migration 284: the plan fixes where the money goes too, not just how
-- much — set once, at the agreement, not re-decided every month.
--
-- "No further posting needed" was the actual ask: once the committee has
-- agreed the monthly figure goes to the institute's account, or the
-- hostel's, or the student's own hand, an accountant paying that month
-- should not be choosing a destination from scratch each time — it was
-- already agreed. This adds that one fixed choice to the plan itself and
-- has both payment paths (a single month, or several in advance) read it.

ALTER TABLE wazifa_awards
  ADD COLUMN IF NOT EXISTS installment_pay_to varchar NOT NULL DEFAULT 'student'
    CHECK (installment_pay_to IN ('institution', 'student', 'hostel'));

CREATE OR REPLACE FUNCTION wazifa_set_installment_plan(
  p_award_id uuid, p_basis varchar, p_percentage decimal,
  p_start_date date, p_end_date date, p_due_day int, p_pay_to varchar DEFAULT 'student',
  p_terms_text text DEFAULT NULL, p_terms_text_ur text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE; ap wazifa_applications%ROWTYPE;
  v_total decimal; v_months int; v_monthly decimal; v_terms text; v_terms_ur text; v_dest text;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false)
     AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_basis NOT IN ('percentage', 'full') THEN
    RAISE EXCEPTION 'Choose percentage or full.' USING ERRCODE = 'P0001';
  END IF;
  IF p_basis = 'percentage' AND (p_percentage IS NULL OR p_percentage <= 0 OR p_percentage > 100) THEN
    RAISE EXCEPTION 'Enter a percentage between 1 and 100.' USING ERRCODE = 'P0001';
  END IF;
  IF p_end_date <= p_start_date THEN
    RAISE EXCEPTION 'The end date has to be after the start date.' USING ERRCODE = 'P0001';
  END IF;
  IF p_due_day < 1 OR p_due_day > 28 THEN
    RAISE EXCEPTION 'Choose a due day between 1 and 28, so it falls in every month.' USING ERRCODE = 'P0001';
  END IF;
  IF p_pay_to NOT IN ('institution', 'student', 'hostel') THEN
    RAISE EXCEPTION 'Choose institution, student, or hostel.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  SELECT * INTO ap FROM wazifa_applications WHERE id = aw.application_id;

  v_total := CASE WHEN p_basis = 'full' THEN aw.awarded_amount_pkr ELSE aw.awarded_amount_pkr * p_percentage / 100 END;
  v_months := GREATEST(1, (
    (EXTRACT(YEAR FROM p_end_date) - EXTRACT(YEAR FROM p_start_date)) * 12
    + (EXTRACT(MONTH FROM p_end_date) - EXTRACT(MONTH FROM p_start_date)) + 1
  )::int);
  v_monthly := ROUND(v_total / v_months);

  UPDATE wazifa_awards
     SET student_monthly_contribution_pkr = v_monthly, installment_due_day = p_due_day,
         installment_start_date = p_start_date, installment_end_date = p_end_date,
         installment_basis = p_basis, installment_percentage = CASE WHEN p_basis = 'percentage' THEN p_percentage ELSE NULL END,
         installment_pay_to = p_pay_to
   WHERE id = p_award_id;

  v_dest := CASE p_pay_to
    WHEN 'institution' THEN COALESCE(ap.institution, 'the institution')
    WHEN 'hostel' THEN COALESCE(ap.hostel_name, 'the hostel')
    ELSE st.full_name END;

  v_terms := COALESCE(p_terms_text, format(
    'You are awarded Rs %s toward %s. The committee will pay Rs %s per month, from %s to %s (%s months), by the %s of each month, to %s.',
    trim(to_char(v_total, 'FM999,999,999,990')), st.full_name,
    trim(to_char(v_monthly, 'FM999,999,999,990')), to_char(p_start_date, 'Mon YYYY'), to_char(p_end_date, 'Mon YYYY'),
    v_months, p_due_day, v_dest));
  v_terms_ur := COALESCE(p_terms_text_ur, format(
    'آپ کو %s کے لیے %s روپے دیے گئے۔ کمیٹی ہر ماہ کی %s تاریخ تک، %s سے %s تک (%s ماہ)، %s روپے ماہانہ %s کو ادا کرے گی۔',
    st.full_name, trim(to_char(v_total, 'FM999,999,999,990')), p_due_day,
    to_char(p_start_date, 'Mon YYYY'), to_char(p_end_date, 'Mon YYYY'), v_months,
    trim(to_char(v_monthly, 'FM999,999,999,990')), v_dest));

  PERFORM wazifa_send_agreement(p_award_id, v_terms, v_terms_ur);

  RETURN jsonb_build_object('monthly_amount', v_monthly, 'months', v_months, 'total', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_set_installment_plan(uuid, varchar, decimal, date, date, int, varchar, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_set_installment_plan(uuid, varchar, decimal, date, date, int, varchar, text, text) TO authenticated;

-- ── wazifa_record_decision passes the destination through too ───────────
CREATE OR REPLACE FUNCTION wazifa_record_decision(
  p_application_id uuid,
  p_decision varchar,
  p_amount decimal DEFAULT 0,
  p_as_loan boolean DEFAULT false,
  p_funded_by varchar DEFAULT 'sadqa',
  p_reason text DEFAULT NULL,
  p_reason_ur text DEFAULT NULL,
  p_internal_note text DEFAULT NULL,
  p_meeting_id uuid DEFAULT NULL,
  p_shortfall_note text DEFAULT NULL,
  p_installment_basis varchar DEFAULT NULL,
  p_installment_percentage decimal DEFAULT NULL,
  p_installment_start_date date DEFAULT NULL,
  p_installment_end_date date DEFAULT NULL,
  p_installment_due_day int DEFAULT NULL,
  p_installment_pay_to varchar DEFAULT 'student'
) RETURNS jsonb AS $$
DECLARE
  a wazifa_applications%ROWTYPE;
  v_award_id uuid;
  v_status varchar;
  v_year varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false)
     AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized to decide an application' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO a FROM wazifa_applications WHERE id = p_application_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Application not found' USING ERRCODE = 'P0001'; END IF;
  IF a.status IN ('approved', 'declined') THEN
    RAISE EXCEPTION 'This application has already been decided.' USING ERRCODE = 'P0001';
  END IF;

  IF p_decision IN ('approved_full', 'approved_partial') AND p_amount <= 0 THEN
    RAISE EXCEPTION 'An approved application needs an amount.' USING ERRCODE = 'P0001';
  END IF;
  IF p_decision = 'declined' AND (p_reason IS NULL OR trim(p_reason) = '') THEN
    RAISE EXCEPTION 'Write the reason for refusing — the family will read it, and they may apply again once they know what was missing.'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_as_loan AND p_funded_by = 'zakat' THEN
    RAISE EXCEPTION 'A repayable award cannot be funded from zakat. Choose sadqa or the general fund.'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO wazifa_decisions (
    application_id, meeting_id, decision, approved_amount_pkr, as_loan, funded_by,
    reason, reason_ur, internal_note, shortfall_note, decided_by
  ) VALUES (
    p_application_id, p_meeting_id, p_decision,
    CASE WHEN p_decision LIKE 'approved%' THEN p_amount ELSE 0 END,
    p_as_loan, p_funded_by, p_reason, p_reason_ur, p_internal_note, p_shortfall_note,
    current_admin_user_id()
  );

  v_status := CASE p_decision
    WHEN 'approved_full' THEN 'approved'
    WHEN 'approved_partial' THEN 'approved'
    WHEN 'declined' THEN 'declined'
    ELSE 'waitlisted'
  END;

  UPDATE wazifa_applications
     SET status = v_status, decided_at = now(),
         reviewed_by = current_admin_user_id(), reviewed_at = now(),
         decline_reason = CASE WHEN p_decision = 'declined' THEN p_reason ELSE decline_reason END
   WHERE id = p_application_id;

  IF p_decision LIKE 'approved%' THEN
    INSERT INTO wazifa_awards (
      application_id, student_id, academic_year, awarded_amount_pkr,
      funded_by, is_loan, created_by
    ) VALUES (
      p_application_id, a.student_id, a.academic_year, p_amount,
      p_funded_by, p_as_loan, current_admin_user_id()
    ) RETURNING id INTO v_award_id;

    UPDATE wazifa_students SET status = 'awarded', updated_at = now() WHERE id = a.student_id;

    PERFORM ensure_wazifa_student_account(a.student_id);

    v_year := a.academic_year;
    PERFORM wazifa_post_requirement_delta(v_year, p_amount,
      (SELECT full_name FROM wazifa_students WHERE id = a.student_id) || ' — approved ' || p_decision,
      a.student_id);

    IF p_installment_basis IS NOT NULL THEN
      PERFORM wazifa_set_installment_plan(v_award_id, p_installment_basis, p_installment_percentage,
        p_installment_start_date, p_installment_end_date, COALESCE(p_installment_due_day, 10),
        COALESCE(p_installment_pay_to, 'student'));
    END IF;
  END IF;

  RETURN jsonb_build_object('status', v_status, 'award_id', v_award_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── Both payment paths route to, and label, the agreed destination ──────
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
    st.full_name || ' (' || st.code || ') — instalment due ' || to_char(c.due_on, 'Mon YYYY')
      || ' — paid to ' || v_party || v_dest_note || COALESCE(' · ' || p_note, ''),
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

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount, 'charge_id', p_charge_id, 'paid_to', aw.installment_pay_to);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_pay_installment_charge(uuid, decimal, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_pay_installment_charge(uuid, decimal, varchar, text) TO authenticated;

-- ── The advance-payment path gets the same routing ────────────────────────
CREATE OR REPLACE FUNCTION wazifa_pay_installment_advance(
  p_award_id uuid, p_months int, p_method varchar
) RETURNS jsonb AS $$
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

  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
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
    st.full_name || ' (' || st.code || ') — ' || v_count || ' months paid in advance to ' || v_party || v_dest_note,
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_pay_installment_advance(uuid, int, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_pay_installment_advance(uuid, int, varchar) TO authenticated;
