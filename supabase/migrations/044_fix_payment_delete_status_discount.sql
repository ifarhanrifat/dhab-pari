-- Migration 044: Same bug as 043, in the sibling trigger — deleting a payment
-- recomputed bill status by comparing remaining payments against the bill's GROSS
-- amount_pkr, ignoring discount_amount. Fixed to use net payable (gross - discount),
-- matching trg_payment_ledger().

CREATE OR REPLACE FUNCTION trg_payment_delete_ledger() RETURNS trigger AS $$
DECLARE
  v_bill bills%ROWTYPE;
  v_total_paid decimal;
  v_net_payable decimal;
BEGIN
  DELETE FROM ledger_entries WHERE reference_type = 'payment' AND reference_id = OLD.id;
  SELECT * INTO v_bill FROM bills WHERE id = OLD.bill_id;
  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_total_paid FROM payments WHERE bill_id = OLD.bill_id AND id != OLD.id;
  v_net_payable := v_bill.amount_pkr - COALESCE(v_bill.discount_amount, 0);
  UPDATE bills SET
    paid_amount = v_total_paid,
    status = CASE WHEN v_total_paid >= v_net_payable AND v_total_paid > 0 THEN 'paid'
                  WHEN v_total_paid > 0 THEN 'partial'
                  ELSE 'unpaid' END
  WHERE id = OLD.bill_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
