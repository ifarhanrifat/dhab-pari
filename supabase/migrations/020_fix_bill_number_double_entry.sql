-- Migration 020: Fix a regression introduced by migration 018.
--
-- 018 rewrote trg_bill_ledger()/trg_payment_ledger() to add bill numbers into the
-- ledger particular, but based those rewrites on the pre-012 single-leg versions —
-- accidentally dropping the second leg (Water Bill Income credit / Cash-Bank debit)
-- that migration 012 added, and reintroducing an ON CONFLICT target
-- (ledger_entries_ref_key) that 012 had already dropped once vouchers/bills started
-- posting two rows per reference. This restores the two-leg postings from 012,
-- keeps the bill-number/status-aware particular text from 018, and backfills the
-- missing Cash/Bank leg for the payments that were inserted while the broken
-- version was live (migration 019's phantom-paid backfill, 19 rows).

CREATE OR REPLACE FUNCTION trg_bill_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
  v_income_account_id uuid;
  v_particular text;
BEGIN
  v_account_id := ensure_consumer_account(NEW.consumer_id);
  v_particular := 'Water Bill #' || NEW.bill_number || ' - ' || to_char(make_date(NEW.year, NEW.month, 1), 'FMMonth YYYY');

  DELETE FROM ledger_entries WHERE reference_type = 'bill' AND reference_id = NEW.id;

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
  VALUES (v_account_id, make_date(NEW.year, NEW.month, 1), v_particular, NEW.amount_pkr, 0, 'bill', NEW.id, NEW.bill_number);

  SELECT id INTO v_income_account_id FROM accounts WHERE system = 'water_supply' AND code = 'WS-2001';
  IF v_income_account_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
    VALUES (v_income_account_id, make_date(NEW.year, NEW.month, 1), v_particular, 0, NEW.amount_pkr, 'bill', NEW.id, NEW.bill_number);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
  VALUES (v_account_id, NEW.paid_date, v_particular, 0, NEW.amount_pkr, 'payment', NEW.id, v_bill.bill_number);

  SELECT id INTO v_cash_account_id FROM accounts
  WHERE system = 'water_supply' AND code = (CASE WHEN NEW.method = 'cash' THEN 'WS-1001' ELSE 'WS-1002' END);
  IF v_cash_account_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
    VALUES (v_cash_account_id, NEW.paid_date, v_particular, NEW.amount_pkr, 0, 'payment', NEW.id, v_bill.bill_number);
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

-- Backfill the Cash/Bank debit leg for payments inserted while the broken
-- single-leg version was live (migration 019's 19 backfilled payments).
INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
SELECT cb.id, p.paid_date, le.particular, p.amount_pkr, 0, 'payment', p.id, b.bill_number
FROM payments p
JOIN bills b ON b.id = p.bill_id
JOIN ledger_entries le ON le.reference_type = 'payment' AND le.reference_id = p.id
JOIN accounts cb ON cb.system = 'water_supply' AND cb.code = (CASE WHEN p.method = 'cash' THEN 'WS-1001' ELSE 'WS-1002' END)
WHERE NOT EXISTS (
  SELECT 1 FROM ledger_entries le2 WHERE le2.reference_type = 'payment' AND le2.reference_id = p.id AND le2.account_id = cb.id
);
