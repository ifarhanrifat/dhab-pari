-- Migration 280: a donor sponsoring a named Wazifa student can choose
-- qarz-e-hasana — they want this specific money back, as the student
-- repays — instead of sadqa/khairat, which they never get back.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Where this sits
-- ═════════════════════════════════════════════════════════════════════════
-- The "sponsor this student" window already uses pool_commitments
-- (migration 222) with a funded_by choice of sadqa/general — display-only
-- until now, never routed money differently either way. This adds a third
-- value that actually does something: it marks a specific donor's specific
-- gift as reclaimable, and every repayment that student makes afterward is
-- split, pro-rata, across every donor who chose it.
--
-- Blocked entirely for a zakat-family student (migration 274's is_zakat_
-- family) — that family's award is funded by the committee's own interim
-- support and repaid only once the student is employed, to the committee
-- in general, never to a named individual donor. A donor naming a zakat
-- family in a qarz-e-hasana pledge would be promised money back that this
-- system has no path to ever return.

ALTER TABLE pool_commitments DROP CONSTRAINT IF EXISTS pool_commitments_funded_by_check;
ALTER TABLE pool_commitments ADD CONSTRAINT pool_commitments_funded_by_check
  CHECK (funded_by IN ('sadqa', 'general', 'qarz_e_hasana'));

ALTER TABLE pool_commitments
  -- Running totals for a qarz_e_hasana commitment only. reclaimed is what
  -- has come back so far (the student's own repayments, allocated
  -- pro-rata); actioned is however much of that the donor has already
  -- withdrawn, converted to sadqa, or redirected. What the donor can still
  -- do something with is reclaimed - actioned, never stored directly so
  -- the two histories both stay visible.
  ADD COLUMN IF NOT EXISTS qarz_reclaimed_pkr decimal NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qarz_actioned_pkr decimal NOT NULL DEFAULT 0;

-- A donor's own deliberate choice about their own money — corrected
-- silently the way a fiqh routing default is (trg_wazifa_instalment_route)
-- would misrepresent what they actually asked for, so this refuses instead.
CREATE OR REPLACE FUNCTION trg_pool_commitment_qarz_validation() RETURNS trigger AS $$
DECLARE v_is_zakat boolean;
BEGIN
  IF NEW.funded_by = 'qarz_e_hasana' THEN
    IF NEW.wazifa_student_id IS NULL THEN
      RAISE EXCEPTION 'Qarz-e-hasana only applies to a named student, not the shared pool.' USING ERRCODE = 'P0001';
    END IF;
    SELECT is_zakat_family INTO v_is_zakat FROM wazifa_students WHERE id = NEW.wazifa_student_id;
    IF COALESCE(v_is_zakat, false) THEN
      RAISE EXCEPTION 'This student''s family is on the zakat register — money given is sadqa/khairat and is not returned.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS pool_commitment_qarz_validation ON pool_commitments;
CREATE TRIGGER pool_commitment_qarz_validation
  BEFORE INSERT OR UPDATE ON pool_commitments
  FOR EACH ROW EXECUTE FUNCTION trg_pool_commitment_qarz_validation();

-- ── Every repayment the student makes, split pro-rata across whoever
--    holds a qarz-e-hasana commitment on them ────────────────────────────
-- Pure tracking — no ledger entries here. The repayment itself was already
-- posted correctly (cash moved, the student's own balance already fell)
-- by whichever function called this. This only updates who could still
-- ask for some of that cash back.
CREATE OR REPLACE FUNCTION wazifa_allocate_qarz_repayment(p_student_id uuid, p_amount decimal) RETURNS void AS $$
DECLARE v_total_qarz decimal; r record; v_share decimal; v_remaining decimal;
BEGIN
  IF p_amount <= 0 THEN RETURN; END IF;

  SELECT COALESCE(SUM(given.total), 0) INTO v_total_qarz FROM (
    SELECT c.id, COALESCE((SELECT SUM(p.amount_pkr) FROM pool_payments p WHERE p.commitment_id = c.id), 0) AS total
    FROM pool_commitments c
    WHERE c.wazifa_student_id = p_student_id AND c.funded_by = 'qarz_e_hasana' AND c.status = 'active'
  ) given;
  IF v_total_qarz <= 0 THEN RETURN; END IF;

  v_remaining := p_amount;
  FOR r IN
    SELECT c.id,
           COALESCE((SELECT SUM(p.amount_pkr) FROM pool_payments p WHERE p.commitment_id = c.id), 0) AS total_given
      FROM pool_commitments c
     WHERE c.wazifa_student_id = p_student_id AND c.funded_by = 'qarz_e_hasana' AND c.status = 'active'
     ORDER BY c.created_at
  LOOP
    -- Pro-rata by what each donor actually gave, capped at what they gave —
    -- nobody's reclaimable balance can exceed their own gift, however the
    -- rounding falls on the last donor in the loop.
    v_share := LEAST(ROUND(p_amount * r.total_given / v_total_qarz), r.total_given -
      (SELECT qarz_reclaimed_pkr FROM pool_commitments WHERE id = r.id));
    v_share := GREATEST(v_share, 0);
    IF v_share > 0 THEN
      UPDATE pool_commitments SET qarz_reclaimed_pkr = qarz_reclaimed_pkr + v_share, updated_at = now() WHERE id = r.id;
      v_remaining := v_remaining - v_share;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_allocate_qarz_repayment(uuid, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_allocate_qarz_repayment(uuid, decimal) TO authenticated;

-- Hook it into both places a student's own repayment gets recorded.
CREATE OR REPLACE FUNCTION wazifa_pay_installment_charge(
  p_charge_id uuid, p_amount decimal, p_method varchar, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  c wazifa_installment_charges%ROWTYPE; aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_remaining decimal;
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
  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, wazifa_student_id, wazifa_award_id, fund_type)
  VALUES ('donors_projects', 'wazifa_contribution', (now() AT TIME ZONE 'Asia/Karachi')::date,
    st.full_name || ' (' || st.code || ') — instalment due ' || to_char(c.due_on, 'Mon YYYY')
      || COALESCE(' · ' || p_note, ''),
    p_amount, v_cash, v_cash, st.full_name, aw.student_id, aw.id,
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

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount, 'charge_id', p_charge_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_pay_installment_charge(uuid, decimal, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_pay_installment_charge(uuid, decimal, varchar, text) TO authenticated;

-- The other place a student repays — post-employment, migration 219.
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

  PERFORM wazifa_allocate_qarz_repayment(aw.student_id, p_amount);

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- What a donor can do with money that has come back — request it, the
-- committee fulfils it, the same shape as every other transaction here
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS wazifa_qarz_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commitment_id uuid NOT NULL REFERENCES pool_commitments(id) ON DELETE CASCADE,
  action varchar NOT NULL CHECK (action IN ('withdraw', 'convert_sadqa', 'redirect_project')),
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  -- Only meaningful for redirect_project. convert_sadqa needs no target —
  -- the gift was already counted in the Wazifa measuring account the
  -- moment it was first given, so releasing the reclaim right is the
  -- whole action; it does not need to be pointed at a particular student.
  target_project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  note text,
  status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fulfilled', 'declined')),
  requested_by uuid REFERENCES portal_users(id),
  requested_at timestamptz DEFAULT now(),
  fulfilled_by uuid REFERENCES admin_users(id),
  fulfilled_at timestamptz,
  decline_reason text,
  voucher_id uuid REFERENCES vouchers(id)
);

CREATE INDEX IF NOT EXISTS wazifa_qarz_actions_commitment_idx ON wazifa_qarz_actions(commitment_id, status);

ALTER TABLE wazifa_qarz_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY wazifa_qarz_actions_admin ON wazifa_qarz_actions FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));
CREATE POLICY wazifa_qarz_actions_own ON wazifa_qarz_actions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM pool_commitments c WHERE c.id = wazifa_qarz_actions.commitment_id
                  AND c.portal_user_id = current_portal_user_id()));
-- No portal INSERT policy — requesting goes through wazifa_request_qarz_
-- action() below, which checks the balance itself before the row exists.

CREATE OR REPLACE FUNCTION wazifa_request_qarz_action(
  p_commitment_id uuid, p_action varchar, p_amount decimal,
  p_target_project_id uuid DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE c pool_commitments%ROWTYPE; v_available decimal; v_id uuid;
BEGIN
  IF current_portal_user_id() IS NULL THEN
    RAISE EXCEPTION 'Please sign in.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM pool_commitments WHERE id = p_commitment_id;
  IF NOT FOUND OR c.portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'Not your commitment.' USING ERRCODE = 'P0001';
  END IF;
  IF c.funded_by <> 'qarz_e_hasana' THEN
    RAISE EXCEPTION 'Only a qarz-e-hasana gift can be reclaimed.' USING ERRCODE = 'P0001';
  END IF;
  IF p_action NOT IN ('withdraw', 'convert_sadqa', 'redirect_project') THEN
    RAISE EXCEPTION 'Not a real action.' USING ERRCODE = 'P0001';
  END IF;
  IF p_action = 'redirect_project' AND p_target_project_id IS NULL THEN
    RAISE EXCEPTION 'Choose which project.' USING ERRCODE = 'P0001';
  END IF;

  v_available := c.qarz_reclaimed_pkr - c.qarz_actioned_pkr;
  IF p_amount > v_available + 0.01 THEN
    RAISE EXCEPTION 'Only Rs % has come back so far and is available.',
      trim(to_char(v_available, 'FM999,999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO wazifa_qarz_actions (commitment_id, action, amount_pkr, target_project_id, note, requested_by)
  VALUES (p_commitment_id, p_action, p_amount, p_target_project_id, p_note, current_portal_user_id())
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('action_id', v_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_request_qarz_action(uuid, varchar, decimal, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_request_qarz_action(uuid, varchar, decimal, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION wazifa_fulfill_qarz_action(p_action_id uuid) RETURNS jsonb AS $$
DECLARE
  qa wazifa_qarz_actions%ROWTYPE; c pool_commitments%ROWTYPE;
  v_payable uuid; v_cash uuid; v_project_account uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false) THEN
    RAISE EXCEPTION 'Only an approver can move money out of the committee''s hands.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO qa FROM wazifa_qarz_actions WHERE id = p_action_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found' USING ERRCODE = 'P0001'; END IF;
  IF qa.status <> 'pending' THEN RAISE EXCEPTION 'Already dealt with.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO c FROM pool_commitments WHERE id = qa.commitment_id;

  -- Qarz-e-Hasana Payable — one account, the committee's own record of how
  -- much reclaimed cash it is holding on donors' behalf. Ensured lazily,
  -- the same way every other shared account in this schema is.
  SELECT id INTO v_payable FROM accounts WHERE system = 'donors_projects' AND code = 'DP-2050';
  IF v_payable IS NULL THEN
    INSERT INTO accounts (code, name, name_ur, type, system, is_protected, description)
    VALUES ('DP-2050', 'Qarz-e-Hasana Payable', 'قرضِ حسنہ — قابلِ ادائیگی', 'liability', 'donors_projects', true,
      'What the committee is holding, already received back from students, that a donor could still ask to have returned, converted to sadqa, or moved to a project.')
    RETURNING id INTO v_payable;
  END IF;

  IF qa.action = 'withdraw' THEN
    SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects' AND code = 'DP-1001';
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit)
    VALUES (v_payable, (now() AT TIME ZONE 'Asia/Karachi')::date,
      c.donor_name || ' — qarz-e-hasana withdrawn', qa.amount_pkr, 0);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit)
    VALUES (v_cash, (now() AT TIME ZONE 'Asia/Karachi')::date,
      c.donor_name || ' — qarz-e-hasana withdrawn', 0, qa.amount_pkr);

  ELSIF qa.action = 'convert_sadqa' THEN
    -- No ledger entries at all, and no student to point it at. The gift
    -- was already counted in the Wazifa measuring account the day it was
    -- first given (wazifa_post_requirement_delta, at the award), and
    -- nothing was ever booked to DP-2050 for the tracking step — a
    -- reclaimable balance the donor never asked for was never a real
    -- liability, only a possibility. Converting it to sadqa just lets
    -- that possibility lapse; the cash stays exactly where it already was.
    NULL;

  ELSIF qa.action = 'redirect_project' THEN
    v_project_account := ensure_project_account(qa.target_project_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit)
    VALUES (v_payable, (now() AT TIME ZONE 'Asia/Karachi')::date,
      c.donor_name || ' — qarz-e-hasana moved to project', qa.amount_pkr, 0);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit)
    VALUES (v_project_account, (now() AT TIME ZONE 'Asia/Karachi')::date,
      c.donor_name || ' — redirected from qarz-e-hasana', 0, qa.amount_pkr);
  END IF;

  UPDATE pool_commitments SET qarz_actioned_pkr = qarz_actioned_pkr + qa.amount_pkr, updated_at = now()
   WHERE id = qa.commitment_id;

  UPDATE wazifa_qarz_actions
     SET status = 'fulfilled', fulfilled_by = current_admin_user_id(), fulfilled_at = now()
   WHERE id = p_action_id;

  RETURN jsonb_build_object('ok', true, 'action', qa.action, 'amount', qa.amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_fulfill_qarz_action(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_fulfill_qarz_action(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION wazifa_decline_qarz_action(p_action_id uuid, p_reason text) RETURNS jsonb AS $$
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  UPDATE wazifa_qarz_actions
     SET status = 'declined', decline_reason = p_reason, fulfilled_by = current_admin_user_id(), fulfilled_at = now()
   WHERE id = p_action_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Not a pending request.' USING ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_decline_qarz_action(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_decline_qarz_action(uuid, text) TO authenticated;

-- ── The donor's own read of it all ────────────────────────────────────────
CREATE OR REPLACE FUNCTION my_qarz_e_hasana() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'commitment_id', c.id, 'student_name', s.full_name, 'wazifa_student_id', c.wazifa_student_id,
    'given', COALESCE((SELECT SUM(p.amount_pkr) FROM pool_payments p WHERE p.commitment_id = c.id), 0),
    'reclaimed', c.qarz_reclaimed_pkr, 'actioned', c.qarz_actioned_pkr,
    'available', c.qarz_reclaimed_pkr - c.qarz_actioned_pkr,
    'status', c.status,
    'pending_actions', (SELECT jsonb_agg(jsonb_build_object(
        'id', a.id, 'action', a.action, 'amount', a.amount_pkr, 'status', a.status, 'requested_at', a.requested_at
      ) ORDER BY a.requested_at DESC) FROM wazifa_qarz_actions a WHERE a.commitment_id = c.id)
  ) ORDER BY c.created_at DESC), '[]'::jsonb)
  FROM pool_commitments c
  JOIN wazifa_students s ON s.id = c.wazifa_student_id
  WHERE c.portal_user_id = current_portal_user_id() AND c.funded_by = 'qarz_e_hasana';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_qarz_e_hasana() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_qarz_e_hasana() TO authenticated;
