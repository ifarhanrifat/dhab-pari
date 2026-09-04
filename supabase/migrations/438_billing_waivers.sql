-- Migration 438: committee-decided waivers for pending (unpaid) bills,
-- wazifa loan repayments, wazifa installment charges, and academy fee
-- charges. Distinct from the existing complaint-linked bill waiver
-- (097_complaint_waiver_and_reconnect.sql) — that one is tied to a real
-- complaint, auto-continues onto every future bill, and posts a real
-- expense voucher (committee absorbing the cost). This one is a plain
-- committee decision on a SINGLE pending item ("as per meeting X, we're
-- forgiving this one"), never touches cash/ledger at all — the amount
-- was never collected in the first place, so there's nothing to reverse.
--
-- wazifa_repayment_schedule/wazifa_installment_charges/training_fee_charges
-- already had a 'waived' status value sitting unused in their CHECK
-- constraints (confirmed via full migration history search — nothing
-- ever set it via a real flow, only training_fee_charges' bulk
-- withdraw() touches 'waived' at all, with no reason/audit trail). This
-- finally gives that status a real, reason-required, single-item path.

ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_status_check;
ALTER TABLE bills ADD CONSTRAINT bills_status_check CHECK (status IN ('paid', 'unpaid', 'pending', 'late', 'partial', 'waived'));
ALTER TABLE bills ADD COLUMN IF NOT EXISTS waived_at timestamptz;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS waived_by_admin_id uuid REFERENCES admin_users(id);
ALTER TABLE bills ADD COLUMN IF NOT EXISTS waived_reason text;

ALTER TABLE wazifa_repayment_schedule ADD COLUMN IF NOT EXISTS waived_at timestamptz;
ALTER TABLE wazifa_repayment_schedule ADD COLUMN IF NOT EXISTS waived_by_admin_id uuid REFERENCES admin_users(id);
-- waived_reason already exists on this table (214_wazifa_verification_and_decision.sql)

ALTER TABLE wazifa_installment_charges ADD COLUMN IF NOT EXISTS waived_at timestamptz;
ALTER TABLE wazifa_installment_charges ADD COLUMN IF NOT EXISTS waived_by_admin_id uuid REFERENCES admin_users(id);
ALTER TABLE wazifa_installment_charges ADD COLUMN IF NOT EXISTS waived_reason text;

ALTER TABLE training_fee_charges ADD COLUMN IF NOT EXISTS waived_at timestamptz;
ALTER TABLE training_fee_charges ADD COLUMN IF NOT EXISTS waived_by_admin_id uuid REFERENCES admin_users(id);
ALTER TABLE training_fee_charges ADD COLUMN IF NOT EXISTS waived_reason text;

-- ═════════════════════════════════════════════════════════════════════════
-- waive_bill — a water bill with no payment recorded against it yet.
-- Sets discount_amount to cover the full remaining balance (so billBadge's
-- own net = amount_pkr - discount_amount math naturally reads ₨0 owed —
-- no separate "waived amount" concept to keep in sync) and flips status
-- to 'waived' so the UI can tell "waived to zero" apart from "genuinely
-- a ₨0 bill" or "fully discounted for an unrelated reason".
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION waive_bill(p_bill_id uuid, p_reason text) RETURNS void AS $$
DECLARE b bills%ROWTYPE; v_admin_id uuid := current_admin_user_id();
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Give a reason for the waiver — it is the only record of why this bill was forgiven.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO b FROM bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status = 'waived' THEN RAISE EXCEPTION 'This bill is already waived.' USING ERRCODE = 'P0001'; END IF;
  IF COALESCE(b.paid_amount, 0) > 0 THEN
    RAISE EXCEPTION 'This bill already has a payment recorded — a waiver only applies to a bill nothing has been paid on yet.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE bills SET
    discount_amount = amount_pkr, -- net owed becomes 0 via billBadge's own math
    status = 'waived', waived_at = now(), waived_by_admin_id = v_admin_id, waived_reason = trim(p_reason)
  WHERE id = p_bill_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION waive_bill(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION waive_bill(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION waive_wazifa_repayment(p_id uuid, p_reason text) RETURNS void AS $$
DECLARE r wazifa_repayment_schedule%ROWTYPE; v_admin_id uuid := current_admin_user_id();
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Give a reason for the waiver — it is the only record of why this instalment was forgiven.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO r FROM wazifa_repayment_schedule WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Instalment not found' USING ERRCODE = 'P0001'; END IF;
  IF r.status = 'waived' THEN RAISE EXCEPTION 'This instalment is already waived.' USING ERRCODE = 'P0001'; END IF;
  IF COALESCE(r.paid_pkr, 0) > 0 THEN
    RAISE EXCEPTION 'This instalment already has a payment recorded — a waiver only applies before anything has been paid.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_repayment_schedule SET
    status = 'waived', waived_at = now(), waived_by_admin_id = v_admin_id, waived_reason = trim(p_reason)
  WHERE id = p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION waive_wazifa_repayment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION waive_wazifa_repayment(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION waive_wazifa_installment_charge(p_id uuid, p_reason text) RETURNS void AS $$
DECLARE c wazifa_installment_charges%ROWTYPE; v_admin_id uuid := current_admin_user_id();
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Give a reason for the waiver — it is the only record of why this charge was forgiven.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM wazifa_installment_charges WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Charge not found' USING ERRCODE = 'P0001'; END IF;
  IF c.status = 'waived' THEN RAISE EXCEPTION 'This charge is already waived.' USING ERRCODE = 'P0001'; END IF;
  IF COALESCE(c.paid_pkr, 0) > 0 THEN
    RAISE EXCEPTION 'This charge already has a payment recorded — a waiver only applies before anything has been paid.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_installment_charges SET
    status = 'waived', waived_at = now(), waived_by_admin_id = v_admin_id, waived_reason = trim(p_reason)
  WHERE id = p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION waive_wazifa_installment_charge(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION waive_wazifa_installment_charge(uuid, text) TO authenticated;

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
  IF COALESCE(c.paid_pkr, 0) > 0 THEN
    RAISE EXCEPTION 'This fee already has a payment recorded — a waiver only applies before anything has been paid.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE training_fee_charges SET
    status = 'waived', waived_at = now(), waived_by_admin_id = v_admin_id, waived_reason = trim(p_reason)
  WHERE id = p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION waive_academy_fee_charge(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION waive_academy_fee_charge(uuid, text) TO authenticated;
