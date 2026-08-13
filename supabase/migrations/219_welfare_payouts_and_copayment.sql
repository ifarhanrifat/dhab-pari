-- Migration 219: the payout functions issue vouchers, and the student pays a
-- share of their own fee.
--
-- ═════════════════════════════════════════════════════════════════════════
-- The co-payment
-- ═════════════════════════════════════════════════════════════════════════
-- A student who says "I can pay 5,000 of my 10,000 fee" and then pays 3,000 a
-- month to the committee is telling it something no verification visit can:
-- that they are still enrolled, still attending, and still serious. When the
-- payments stop, the committee learns something is wrong months before the
-- semester result would have told it.
--
-- The money never touches the student either way — the committee pays the
-- institution the whole fee against its challan. The student's share comes
-- back to the committee separately, which is what makes it a signal rather
-- than a discount.
--
-- Two guards on it, both deliberate:
--   A contribution is never a condition of approval. An orphan with nothing
--   is supported in full at zero, and the form says so.
--   A missed month does not stop the fee. It is already paid; pulling out
--   mid-semester punishes a student for one bad month and wastes the money.

ALTER TABLE wazifa_awards
  ADD COLUMN IF NOT EXISTS student_monthly_contribution_pkr decimal NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS contributed_pkr decimal NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS institution_school_id uuid REFERENCES schools(id) ON DELETE SET NULL;

ALTER TABLE wazifa_applications
  -- Asked on the form: what can you manage yourself?
  ADD COLUMN IF NOT EXISTS offered_monthly_contribution_pkr decimal NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS institution_monthly_fee_pkr decimal NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS wazifa_contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  award_id uuid NOT NULL REFERENCES wazifa_awards(id) ON DELETE CASCADE,
  paid_on date NOT NULL DEFAULT current_date,
  for_month date,
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  method varchar CHECK (method IN ('cash', 'bank', 'jazzcash', 'easypaisa')),
  receipt_no varchar,
  voucher_id uuid REFERENCES vouchers(id) ON DELETE SET NULL,
  note text,
  received_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wazifa_contributions_award_idx ON wazifa_contributions(award_id, paid_on);

-- ═════════════════════════════════════════════════════════════════════════
-- Paying an institution
-- ═════════════════════════════════════════════════════════════════════════
-- The money goes to the school, against its challan, with the student's code
-- on the line. Nothing is handed to the student — except where zakat funds it,
-- because tamleek requires the money to become theirs first (migration 212).
CREATE OR REPLACE FUNCTION wazifa_pay_instalment(
  p_instalment_id uuid, p_method varchar, p_note text DEFAULT NULL,
  p_challan_no varchar DEFAULT NULL, p_school_id uuid DEFAULT NULL
) RETURNS jsonb AS $$
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
  SELECT * INTO i FROM wazifa_instalments WHERE id = p_instalment_id;
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
   WHERE system = 'donors_projects' AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION wazifa_pay_instalment(uuid, varchar, text, varchar, uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Repayments and contributions
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION wazifa_record_repayment(
  p_award_id uuid, p_amount decimal, p_method varchar, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE;
  v_cash_account uuid; v_voucher_id uuid; v_voucher_no varchar; v_receipt varchar; v_fund varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
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
   WHERE system = 'donors_projects' AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

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

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION wazifa_record_repayment(uuid, decimal, varchar, text) TO authenticated;

-- The student's monthly share, taken while they are still studying. Recorded
-- separately from a repayment so the student is never confused about what
-- they still owe.
CREATE OR REPLACE FUNCTION wazifa_record_contribution(
  p_award_id uuid, p_amount decimal, p_method varchar,
  p_for_month date DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE;
  v_cash_account uuid; v_voucher_id uuid; v_voucher_no varchar; v_receipt varchar; v_fund varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  v_fund := CASE aw.funded_by WHEN 'zakat' THEN 'zakat' WHEN 'sadqa' THEN 'sadqa' ELSE 'kafalat' END;
  SELECT id INTO v_cash_account FROM accounts
   WHERE system = 'donors_projects' AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, wazifa_student_id, wazifa_award_id, fund_type)
  VALUES ('donors_projects', 'wazifa_contribution', (now() AT TIME ZONE 'Asia/Karachi')::date,
    st.code || ' · student''s own monthly share'
      || CASE WHEN p_for_month IS NOT NULL THEN ' for ' || to_char(p_for_month, 'Mon YYYY') ELSE '' END,
    p_amount, v_cash_account, v_cash_account, st.full_name, aw.student_id, aw.id, v_fund)
  RETURNING id, voucher_no, receipt_no INTO v_voucher_id, v_voucher_no, v_receipt;

  INSERT INTO wazifa_contributions (award_id, amount_pkr, method, for_month, receipt_no, voucher_id, note, received_by)
  VALUES (p_award_id, p_amount, p_method, p_for_month, COALESCE(v_receipt, v_voucher_no), v_voucher_id, p_note, current_admin_user_id());

  UPDATE wazifa_awards a
     SET contributed_pkr = (SELECT COALESCE(SUM(amount_pkr), 0) FROM wazifa_contributions WHERE award_id = a.id)
   WHERE a.id = p_award_id;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION wazifa_record_contribution(uuid, decimal, varchar, date, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Zakat handed over, as a voucher
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION zakat_disburse(
  p_beneficiary_id uuid, p_method varchar, p_acknowledgement varchar,
  p_acknowledgement_ref varchar DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  b zakat_round_beneficiaries%ROWTYPE; r zakat_rounds%ROWTYPE;
  v_cash_account uuid; v_voucher_no varchar; v_receipt varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO b FROM zakat_round_beneficiaries WHERE id = p_beneficiary_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status = 'paid' THEN RAISE EXCEPTION 'Already paid.' USING ERRCODE = 'P0001'; END IF;
  IF b.amount_pkr <= 0 THEN RAISE EXCEPTION 'Compute the shares first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO r FROM zakat_rounds WHERE id = b.round_id;
  SELECT id INTO v_cash_account FROM accounts
   WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method IN ('cash', 'in_kind') THEN 'DP-1001' ELSE 'DP-1002' END);

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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION zakat_disburse(uuid, varchar, varchar, varchar, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- The fund movement statement
-- ═════════════════════════════════════════════════════════════════════════
-- Opening, received, spent, closing — per fund. The report the committee
-- reads out at a meeting, and what proves zakat was spent on zakat.
CREATE OR REPLACE FUNCTION fund_movement_report(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'fund'), '[]'::jsonb) FROM (
    SELECT jsonb_build_object(
      'fund', a.fund_type,
      'account', a.code,
      'name', a.name,
      'name_ur', a.name_ur,
      'opening', COALESCE((SELECT SUM(l.credit - l.debit) FROM ledger_entries l
                            WHERE l.account_id = a.id
                              AND (p_from IS NULL OR l.entry_date < p_from)), 0),
      'received', COALESCE((SELECT SUM(l.credit) FROM ledger_entries l
                             WHERE l.account_id = a.id
                               AND (p_from IS NULL OR l.entry_date >= p_from)
                               AND (p_to IS NULL OR l.entry_date <= p_to)), 0),
      'spent', COALESCE((SELECT SUM(l.debit) FROM ledger_entries l
                          WHERE l.account_id = a.id
                            AND (p_from IS NULL OR l.entry_date >= p_from)
                            AND (p_to IS NULL OR l.entry_date <= p_to)), 0),
      'closing', COALESCE((SELECT SUM(l.credit - l.debit) FROM ledger_entries l
                            WHERE l.account_id = a.id
                              AND (p_to IS NULL OR l.entry_date <= p_to)), 0)
    ) AS x
    FROM accounts a
    WHERE a.system = 'donors_projects' AND a.type = 'restricted_fund'
  ) y;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION fund_movement_report(date, date) TO authenticated;

-- What a school is owed and has been paid, one line per student.
CREATE OR REPLACE FUNCTION institution_statement(p_school_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'school', (SELECT name FROM schools WHERE id = p_school_id),
    'total_paid', COALESCE((SELECT SUM(v.amount_pkr) FROM vouchers v
                             WHERE v.school_id = p_school_id AND v.status = 'posted'), 0),
    'students', (SELECT COALESCE(jsonb_agg(DISTINCT s.code), '[]'::jsonb)
                   FROM vouchers v JOIN wazifa_students s ON s.id = v.wazifa_student_id
                  WHERE v.school_id = p_school_id),
    'lines', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'date', v.voucher_date, 'voucher_no', v.voucher_no,
                 'challan_no', v.challan_no, 'student', s.code,
                 'amount', v.amount_pkr, 'particular', v.particular
               ) ORDER BY v.voucher_date, v.voucher_no), '[]'::jsonb)
               FROM vouchers v LEFT JOIN wazifa_students s ON s.id = v.wazifa_student_id
              WHERE v.school_id = p_school_id AND v.status = 'posted')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION institution_statement(uuid) TO authenticated;

ALTER TABLE wazifa_contributions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wazifa_contributions_admin ON wazifa_contributions;
CREATE POLICY wazifa_contributions_admin ON wazifa_contributions FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

DROP POLICY IF EXISTS wazifa_contributions_own ON wazifa_contributions;
CREATE POLICY wazifa_contributions_own ON wazifa_contributions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM wazifa_awards a JOIN wazifa_students s ON s.id = a.student_id
                  WHERE a.id = wazifa_contributions.award_id
                    AND s.portal_user_id = current_portal_user_id()));

REVOKE ALL ON wazifa_contributions FROM anon;
