-- Migration 282: paying several months at once — monthly cash, or six
-- months, or a year in advance, in one transaction.
--
-- The simpler of the two pieces asked for alongside qarz-e-hasana. The
-- other — splitting a multi-year course's cost across the academic years
-- it actually spans in the measuring account — depends on the course-cost
-- calculator (duration, fee, hostel/food) that was flagged as its own
-- separate pass; there is nothing yet to split across years without it,
-- so it stays out of this migration rather than being built on guesses
-- about a form that does not exist yet.
--
-- This settles the next N months a student's own plan has already raised
-- or would raise, in one voucher rather than N — "same as we already have"
-- meaning one clean transaction, the way any other lump payment in this
-- app already looks, not N small entries cluttering the ledger for one
-- visit to the accountant.
CREATE OR REPLACE FUNCTION wazifa_pay_installment_advance(
  p_award_id uuid, p_months int, p_method varchar
) RETURNS jsonb AS $$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_total decimal := 0; v_count int := 0;
  v_month date; v_next_no int; v_charge_id uuid; v_charge_ids uuid[] := '{}'; r record;
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

  -- Whatever is already due or part-paid gets settled first, then this
  -- raises and immediately pays ahead of schedule for the rest — the same
  -- monthly figure and due day the plan already has, just paid early. The
  -- monthly job (wazifa_installment_run) will find these months already
  -- covered and skip them when it would otherwise have raised them.
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

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, wazifa_student_id, wazifa_award_id, fund_type)
  VALUES ('donors_projects', 'wazifa_contribution', (now() AT TIME ZONE 'Asia/Karachi')::date,
    st.full_name || ' (' || st.code || ') — ' || v_count || ' months paid in advance',
    v_total, v_cash, v_cash, st.full_name, aw.student_id, aw.id,
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
