-- Migration 043: Fix a bug from the discount feature (migration 035) — the "is this
-- bill fully paid" check compared total payments against the bill's GROSS amount_pkr,
-- never subtracting discount_amount. A bill of Rs. 1500 with a Rs. 500 discount only
-- actually owes Rs. 1000, but paying exactly Rs. 1000 left status stuck at 'partial'
-- forever (1000 < 1500), so the consumer permanently showed as still owing money
-- that had already been waived. The net-payable amount (amount_pkr - discount_amount)
-- is now the real threshold everywhere "fully paid" is decided.

CREATE OR REPLACE FUNCTION trg_payment_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
  v_cash_account_id uuid;
  v_bill bills%ROWTYPE;
  v_total_paid decimal;
  v_net_payable decimal;
  v_status_note text;
  v_particular text;
BEGIN
  IF NEW.receipt_no IS NULL THEN
    NEW.receipt_no := next_receipt_no();
  END IF;
  v_account_id := ensure_consumer_account(NEW.consumer_id);

  SELECT * INTO v_bill FROM bills WHERE id = NEW.bill_id;
  SELECT COALESCE(SUM(amount_pkr), 0) + NEW.amount_pkr INTO v_total_paid
    FROM payments WHERE bill_id = NEW.bill_id;
  v_net_payable := v_bill.amount_pkr - COALESCE(v_bill.discount_amount, 0);

  v_status_note := CASE
    WHEN v_total_paid >= v_net_payable THEN 'Bill Paid in Full'
    ELSE 'Partial Payment — Rs. ' || to_char(v_net_payable - v_total_paid, 'FM999999990.00') || ' remaining'
  END;
  v_particular := 'Payment received (' || NEW.method || ') — Bill #' || v_bill.bill_number || ' — ' || v_status_note
    || CASE WHEN NEW.note IS NOT NULL AND trim(NEW.note) != '' THEN ' — ' || NEW.note ELSE '' END;

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, receipt_no)
  VALUES (v_account_id, NEW.paid_date, v_particular, 0, NEW.amount_pkr, 'payment', NEW.id, v_bill.bill_number, NEW.receipt_no);

  SELECT id INTO v_cash_account_id FROM accounts
  WHERE system = 'water_supply' AND code = (CASE WHEN NEW.method = 'cash' THEN 'WS-1001' ELSE 'WS-1002' END);
  IF v_cash_account_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, receipt_no)
    VALUES (v_cash_account_id, NEW.paid_date, v_particular, NEW.amount_pkr, 0, 'payment', NEW.id, v_bill.bill_number, NEW.receipt_no);
  END IF;

  UPDATE bills SET
    paid_amount = v_total_paid,
    status = CASE WHEN v_total_paid >= v_net_payable THEN 'paid'
                  WHEN v_total_paid > 0 THEN 'partial'
                  ELSE v_bill.status END,
    paid_date = NEW.paid_date,
    payment_method = NEW.method
  WHERE id = NEW.bill_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Backfill: any existing bill with a discount whose payments already cover the net
-- payable amount was silently stuck as 'partial' (or 'unpaid') — recompute status now
-- that the threshold is correct. Bills with no discount are untouched (net = gross).
UPDATE bills b SET status = CASE
  WHEN COALESCE(b.paid_amount, 0) >= (b.amount_pkr - COALESCE(b.discount_amount, 0)) AND COALESCE(b.paid_amount, 0) > 0 THEN 'paid'
  WHEN COALESCE(b.paid_amount, 0) > 0 THEN 'partial'
  ELSE b.status
END
WHERE b.discount_amount > 0;
