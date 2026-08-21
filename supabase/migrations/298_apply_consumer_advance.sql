-- Migration 298: let an accountant apply a consumer's existing advance
-- credit to one of their bills, from the Billing page.
--
-- The consumer's own subsidiary ledger account already nets correctly the
-- moment a new bill posts its debit -- an advance credit of Rs. 2,000 plus a
-- new Rs. 200 bill leaves the account at -1,800 with zero extra action, no
-- new ledger entry required. What's actually missing is bookkeeping at the
-- *bill* level: bills.status/paid_amount only ever change via a payments row
-- (trg_payment_ledger, migration 089), and that trigger unconditionally
-- posts a second ledger leg debiting Cash/Bank -- correct for real cash
-- received, wrong here, since the cash behind this credit already posted
-- when the original advance payment was recorded. Inserting another payment
-- row through the normal path would double-count that cash and overstate
-- how much advance remains.
--
-- So this bypasses the payments/ledger machinery entirely and only updates
-- the bill directly -- same shape as the complaint-waiver flow (migration
-- 097), which also marks a bill settled without new cash changing hands.
-- advance_applied_* columns give it the same kind of visible trail on the
-- Billing page that a waiver already has.
ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS advance_applied_amount numeric,
  ADD COLUMN IF NOT EXISTS advance_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS advance_applied_by uuid REFERENCES admin_users(id);

CREATE OR REPLACE FUNCTION apply_consumer_advance_to_bill(p_bill_id uuid) RETURNS jsonb AS $$
DECLARE
  v_bill bills%ROWTYPE;
  v_available numeric;
  v_net_payable numeric;
  v_outstanding numeric;
  v_apply numeric;
  v_new_paid numeric;
  v_new_status varchar;
BEGIN
  IF NOT COALESCE(can_access_system('water_supply'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_bill FROM bills WHERE id = p_bill_id FOR UPDATE;
  IF v_bill.id IS NULL THEN
    RAISE EXCEPTION 'Bill not found' USING ERRCODE = 'P0001';
  END IF;

  SELECT -(a.opening_balance + COALESCE(SUM(le.debit), 0) - COALESCE(SUM(le.credit), 0)) INTO v_available
  FROM accounts a LEFT JOIN ledger_entries le ON le.account_id = a.id
  WHERE a.type = 'consumer' AND a.consumer_id = v_bill.consumer_id
  GROUP BY a.id, a.opening_balance;
  v_available := GREATEST(COALESCE(v_available, 0), 0);

  v_net_payable := v_bill.amount_pkr - COALESCE(v_bill.discount_amount, 0);
  v_outstanding := GREATEST(v_net_payable - COALESCE(v_bill.paid_amount, 0), 0);
  v_apply := LEAST(v_available, v_outstanding);

  IF v_apply <= 0 THEN
    RAISE EXCEPTION 'No advance credit available to apply to this bill' USING ERRCODE = 'P0001';
  END IF;

  v_new_paid := COALESCE(v_bill.paid_amount, 0) + v_apply;
  v_new_status := CASE WHEN v_new_paid >= v_net_payable THEN 'paid'
                        WHEN v_new_paid > 0 THEN 'partial'
                        ELSE v_bill.status END;

  UPDATE bills SET
    paid_amount = v_new_paid,
    status = v_new_status,
    advance_applied_amount = COALESCE(advance_applied_amount, 0) + v_apply,
    advance_applied_at = now(),
    advance_applied_by = current_admin_user_id()
  WHERE id = p_bill_id;

  RETURN jsonb_build_object('applied', v_apply, 'status', v_new_status);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION apply_consumer_advance_to_bill(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION apply_consumer_advance_to_bill(uuid) TO authenticated;
