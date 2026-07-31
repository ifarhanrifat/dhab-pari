-- Migration 025: Show the receipt number alongside the bill number for payment
-- rows in every ledger/statement view. Previously the "Bill #" column only ever
-- showed the bill being paid — for a payment row specifically, the receipt issued
-- for that payment itself is equally identifying information an accountant needs
-- at a glance (e.g. "Bill #WB-00017 · Receipt #0028").

ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS receipt_no varchar;

CREATE OR REPLACE FUNCTION trg_payment_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
  v_cash_account_id uuid;
  v_bill bills%ROWTYPE;
  v_total_paid decimal;
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

  v_status_note := CASE
    WHEN v_total_paid >= v_bill.amount_pkr THEN 'Bill Paid in Full'
    ELSE 'Partial Payment — Rs. ' || to_char(v_bill.amount_pkr - v_total_paid, 'FM999999990.00') || ' remaining'
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
    status = CASE WHEN v_total_paid >= v_bill.amount_pkr THEN 'paid'
                  WHEN v_total_paid > 0 THEN 'partial'
                  ELSE v_bill.status END,
    paid_date = NEW.paid_date,
    payment_method = NEW.method
  WHERE id = NEW.bill_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Backfill existing payment ledger rows
UPDATE ledger_entries le SET receipt_no = p.receipt_no
FROM payments p
WHERE le.reference_type = 'payment' AND le.reference_id = p.id AND le.receipt_no IS NULL;
