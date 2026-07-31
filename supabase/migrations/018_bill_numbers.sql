-- Migration 018: Permanent, non-reusable bill numbers + status-aware ledger particulars
--
-- Bills had no user-facing serial number (only an internal uuid), unlike vouchers
-- (voucher_no via voucher_counters) and payments (receipt_no via receipt_no_seq).
-- This adds the same guarantee for bills: a sequence-backed number that is assigned
-- once and never reused, even if the bill is later deleted (sequences never roll
-- back). The number is also denormalized onto ledger_entries so every ledger/
-- statement view can show a "Bill #" column without extra joins, and the ledger
-- particular text for bills/payments now names the bill and states its resulting
-- status (paid in full / partial + remaining), so an accountant reading the ledger
-- alone can tell a bill's status without cross-referencing the billing page.

-- 1. Sequential, never-reused bill numbering
CREATE SEQUENCE IF NOT EXISTS bill_no_seq START 1;
CREATE OR REPLACE FUNCTION next_bill_no() RETURNS varchar AS $$
  SELECT 'WB-' || lpad(nextval('bill_no_seq')::text, 5, '0');
$$ LANGUAGE sql;

ALTER TABLE bills ADD COLUMN IF NOT EXISTS bill_number varchar UNIQUE;

CREATE OR REPLACE FUNCTION trg_bill_assign_number() RETURNS trigger AS $$
BEGIN
  IF NEW.bill_number IS NULL THEN
    NEW.bill_number := next_bill_no();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bill_assign_number_trigger ON bills;
CREATE TRIGGER bill_assign_number_trigger BEFORE INSERT ON bills
  FOR EACH ROW EXECUTE FUNCTION trg_bill_assign_number();

-- Backfill existing bills in creation order so earlier bills get lower numbers.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM bills WHERE bill_number IS NULL ORDER BY created_at, id LOOP
    UPDATE bills SET bill_number = next_bill_no() WHERE id = r.id;
  END LOOP;
END $$;

-- 2. Denormalize bill_number onto ledger_entries for zero-join "Bill #" columns
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS bill_number varchar;

-- 3. Bill -> ledger debit entry, now naming the bill number in the particular
CREATE OR REPLACE FUNCTION trg_bill_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
BEGIN
  v_account_id := ensure_consumer_account(NEW.consumer_id);
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
  VALUES (
    v_account_id, make_date(NEW.year, NEW.month, 1),
    'Water Bill #' || NEW.bill_number || ' - ' || to_char(make_date(NEW.year, NEW.month, 1), 'FMMonth YYYY'),
    NEW.amount_pkr, 0, 'bill', NEW.id, NEW.bill_number
  )
  ON CONFLICT (reference_type, reference_id) DO UPDATE
    SET debit = EXCLUDED.debit, particular = EXCLUDED.particular, entry_date = EXCLUDED.entry_date, bill_number = EXCLUDED.bill_number;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4. Payment -> ledger credit entry, now stating the bill number + resulting
--    status (paid in full / partial + remaining) + the user's own note, so the
--    ledger particular alone tells the whole story.
CREATE OR REPLACE FUNCTION trg_payment_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
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

-- 5. Backfill bill_number onto existing ledger_entries and rebuild their particulars
--    to match the new naming (bill rows only — payment rows keep their original
--    historical text rather than being rewritten with today's balance-derived status).
UPDATE ledger_entries le SET
  bill_number = b.bill_number,
  particular = 'Water Bill #' || b.bill_number || ' - ' || to_char(make_date(b.year, b.month, 1), 'FMMonth YYYY')
FROM bills b
WHERE le.reference_type = 'bill' AND le.reference_id = b.id;

UPDATE ledger_entries le SET bill_number = b.bill_number
FROM payments p JOIN bills b ON b.id = p.bill_id
WHERE le.reference_type = 'payment' AND le.reference_id = p.id;
