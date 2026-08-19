-- Migration 289: which months are paid, which are still due, and a way
-- to pick exactly the ones you mean to pay — instead of a "6 months"
-- button that quietly picks for you and never says which six.
--
-- ═════════════════════════════════════════════════════════════════════════
-- What actually happened, traced through a real payment
-- ═════════════════════════════════════════════════════════════════════════
-- Muhammad Azan's Aug 2026 instalment (Rs 3,125) was paid on its own.
-- Right after, "6 months in advance" was used on the same award —
-- Rs 18,750, exactly 6 × 3,125. The math is right: wazifa_pay_
-- installment_advance() settles whatever is already due first, so Aug
-- was correctly skipped and it raised/paid the next six unpaid months
-- instead. Nothing was double-paid.
--
-- But there was no way to see that from the screen. The voucher's own
-- particular just says "6 months paid in advance" — not which six — and
-- the award card only ever showed one running total. An accountant
-- watching this happen has no way to confirm which calendar months got
-- covered without going into the database directly, which is exactly
-- the "how do we know this can't be paid twice" worry, even though the
-- underlying logic was already correct.
--
-- The fix is visibility, not a new safety check the maths didn't need:
-- a real calendar of every month in the plan, each one showing paid /
-- due / not yet reached, and a single action that pays whichever exact
-- months are ticked — in one voucher, with every one of those months
-- spelled out in the particular, not just a count.

-- ── The full calendar for one award, paid and not ────────────────────────
CREATE OR REPLACE FUNCTION wazifa_award_calendar(p_award_id uuid) RETURNS jsonb AS $$
DECLARE
  aw wazifa_awards%ROWTYPE;
  v_start date; v_end date; v_month date; v_months jsonb := '[]'::jsonb;
  r wazifa_installment_charges%ROWTYPE;
BEGIN
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF aw.installment_start_date IS NULL THEN
    RETURN jsonb_build_object('months', '[]'::jsonb);
  END IF;

  v_start := date_trunc('month', aw.installment_start_date)::date;
  -- An open-ended settlement (no fixed end date — the "pay while
  -- studying, then settle until it's level" shape) has no natural stop,
  -- so the calendar shows a year ahead of whichever is further: the plan
  -- start, or today. A bounded collect-now plan just uses its own end
  -- date.
  v_end := COALESCE(date_trunc('month', aw.installment_end_date)::date,
    date_trunc('month', GREATEST((now() AT TIME ZONE 'Asia/Karachi')::date, aw.installment_start_date) + interval '11 months')::date);

  v_month := v_start;
  WHILE v_month <= v_end LOOP
    SELECT * INTO r FROM wazifa_installment_charges
     WHERE award_id = p_award_id AND due_on >= v_month AND due_on < v_month + interval '1 month'
     LIMIT 1;
    v_months := v_months || jsonb_build_object(
      'month', v_month,
      'charge_id', r.id,
      'amount', COALESCE(r.amount_pkr, aw.student_monthly_contribution_pkr),
      'paid_pkr', COALESCE(r.paid_pkr, 0),
      'status', COALESCE(r.status, CASE WHEN v_month > date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date
                                          THEN 'upcoming' ELSE 'due' END),
      'due_on', COALESCE(r.due_on, v_month + (aw.installment_due_day - 1))
    );
    v_month := v_month + interval '1 month';
  END LOOP;

  RETURN jsonb_build_object('months', v_months, 'monthly_amount', aw.student_monthly_contribution_pkr);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_award_calendar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_award_calendar(uuid) TO authenticated;

-- ── Pay exactly the months ticked — one voucher, every month named ───────
CREATE OR REPLACE FUNCTION wazifa_pay_specific_months(
  p_award_id uuid, p_months date[], p_method varchar
) RETURNS jsonb AS $$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_total decimal := 0; v_count int := 0;
  v_month date; v_next_no int; v_charge_id uuid; v_charge_ids uuid[] := '{}'; v_month_labels text[] := '{}';
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

    SELECT id, amount_pkr - paid_pkr INTO v_charge_id, v_total
      FROM wazifa_installment_charges
     WHERE award_id = p_award_id AND due_on >= v_month AND due_on < v_month + interval '1 month'
     LIMIT 1;

    IF v_charge_id IS NOT NULL THEN
      -- Already there — could be due, part-paid, or (if the same month
      -- was picked twice in one click, or it was paid a moment ago by
      -- someone else) already settled. Skip a paid one rather than
      -- erroring the whole batch over it; charge exactly what's left on
      -- a part-paid one.
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
    RAISE EXCEPTION 'Every month chosen is already paid.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_total FROM wazifa_installment_charges WHERE id = ANY(v_charge_ids);

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  -- Named explicitly, not just counted — the whole point of this
  -- migration. "Wazifa Instalment" up front so the transaction type
  -- reads on a printed voucher without opening it.
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

REVOKE ALL ON FUNCTION wazifa_pay_specific_months(uuid, date[], varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_pay_specific_months(uuid, date[], varchar) TO authenticated;

-- ── The single-charge path gets the same notification and a clearer
-- particular — used by the "Release" button on one already-raised
-- charge, not the new grid, but it deserves the same visibility ────────
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

REVOKE ALL ON FUNCTION wazifa_pay_installment_charge(uuid, decimal, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_pay_installment_charge(uuid, decimal, varchar, text) TO authenticated;

-- ── The disbursement side gets the same "you've been paid" notice ────────
CREATE OR REPLACE FUNCTION wazifa_pay_disbursement_charge(
  p_charge_id uuid, p_method varchar, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  c wazifa_disbursement_charges%ROWTYPE; aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE; ap wazifa_applications%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_party varchar; v_dest_note text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO c FROM wazifa_disbursement_charges WHERE id = p_charge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF c.status = 'paid' THEN RAISE EXCEPTION 'Already paid.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = c.award_id;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  SELECT * INTO ap FROM wazifa_applications WHERE id = aw.application_id;
  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

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
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (st.portal_user_id, 'wazifa_support_paid', 'Taleemi Wazifa support paid',
      'Rs ' || trim(to_char(c.amount_pkr, 'FM999,999,999,990')) || ' for ' || to_char(c.due_on, 'Mon YYYY') || ' has been paid to you.',
      '/portal/wazifa');
  END IF;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', c.amount_pkr, 'charge_id', p_charge_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_pay_disbursement_charge(uuid, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_pay_disbursement_charge(uuid, varchar, text) TO authenticated;
