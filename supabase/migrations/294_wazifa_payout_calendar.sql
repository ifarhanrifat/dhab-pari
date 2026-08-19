-- Migration 294: Phase 3 — the disbursement side gets the same real
-- calendar the settlement side already has, and the two get their
-- correct names. "Payout" is the committee paying the student; "Receive"
-- is the committee collecting from the student — migration 289's grid
-- was built for the collect side and called "Pay months", which reads
-- backwards from the committee's own point of view once there's a real
-- payout side to compare it to.

-- ── Every month of the disbursement plan, paid or not ────────────────────
CREATE OR REPLACE FUNCTION wazifa_disbursement_calendar(p_award_id uuid) RETURNS jsonb AS $$
DECLARE
  aw wazifa_awards%ROWTYPE;
  v_start date; v_end date; v_month date; v_months jsonb := '[]'::jsonb;
  r wazifa_disbursement_charges%ROWTYPE;
BEGIN
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF aw.disbursement_start_date IS NULL THEN
    RETURN jsonb_build_object('months', '[]'::jsonb);
  END IF;

  v_start := date_trunc('month', aw.disbursement_start_date)::date;
  v_end := COALESCE(date_trunc('month', aw.disbursement_end_date)::date, v_start);

  v_month := v_start;
  WHILE v_month <= v_end LOOP
    SELECT * INTO r FROM wazifa_disbursement_charges
     WHERE award_id = p_award_id AND due_on >= v_month AND due_on < v_month + interval '1 month'
     LIMIT 1;
    v_months := v_months || jsonb_build_object(
      'month', v_month,
      'charge_id', r.id,
      'amount', COALESCE(r.amount_pkr, aw.disbursement_monthly_pkr),
      'status', COALESCE(r.status, CASE WHEN v_month > date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date
                                          THEN 'upcoming' ELSE 'due' END),
      'due_on', COALESCE(r.due_on, v_month + (aw.disbursement_due_day - 1))
    );
    v_month := v_month + interval '1 month';
  END LOOP;

  RETURN jsonb_build_object('months', v_months, 'monthly_amount', aw.disbursement_monthly_pkr);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_disbursement_calendar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_disbursement_calendar(uuid) TO authenticated;

-- ── Pay out exactly the months ticked — one voucher, every month named,
-- same shape as wazifa_pay_specific_months but the opposite direction ────
CREATE OR REPLACE FUNCTION wazifa_payout_specific_months(
  p_award_id uuid, p_months date[], p_method varchar
) RETURNS jsonb AS $$
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

  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
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
      INSERT INTO wazifa_disbursement_charges (award_id, charge_no, due_on, amount_pkr, paid_pkr, status, paid_on, method)
      VALUES (p_award_id, v_next_no, v_month + (aw.disbursement_due_day - 1), v_remaining, v_remaining, 'paid',
              (now() AT TIME ZONE 'Asia/Karachi')::date, p_method)
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
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

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
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (st.portal_user_id, 'wazifa_support_paid', 'Taleemi Wazifa support paid',
      'Rs ' || trim(to_char(v_total, 'FM999,999,999,990')) || ' for ' || array_to_string(v_month_labels, ', ') || ' has been paid to you.',
      '/portal/wazifa');
  END IF;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'months_paid', v_count, 'total', v_total, 'months', v_month_labels);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_payout_specific_months(uuid, date[], varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_payout_specific_months(uuid, date[], varchar) TO authenticated;
