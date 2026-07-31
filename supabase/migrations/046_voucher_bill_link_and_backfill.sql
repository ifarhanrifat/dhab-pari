-- Migration 046: Security deposit vouchers never carried the bill number onto their
-- ledger entries (trg_voucher_ledger only ever wrote account_id/particular/receipt_no,
-- never bill_number — there was no link back to the bill to look it up from). Adding
-- a bill_id FK on vouchers closes that gap, and backfilling both bill_number and
-- receipt_no (for the two security deposits recorded before migration 040 added
-- receipt numbering) fixes the existing rows that are still showing blank.

ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS bill_id uuid REFERENCES bills(id) ON DELETE SET NULL;

-- Backfill the link from the reverse pointer bills.security_deposit_voucher_id already has.
UPDATE vouchers v SET bill_id = b.id
FROM bills b WHERE b.security_deposit_voucher_id = v.id AND v.bill_id IS NULL;

-- Any security-deposit voucher that predates migration 040 never got a receipt_no.
UPDATE vouchers SET receipt_no = next_receipt_no()
WHERE voucher_type = 'security_deposit' AND receipt_no IS NULL;

CREATE OR REPLACE FUNCTION trg_voucher_ledger() RETURNS trigger AS $$
DECLARE
  v_bill_number varchar;
BEGIN
  IF NEW.status != 'posted' THEN
    RETURN NEW;
  END IF;
  IF NEW.bill_id IS NOT NULL THEN
    SELECT bill_number INTO v_bill_number FROM bills WHERE id = NEW.bill_id;
  END IF;
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
  VALUES (NEW.to_account_id, NEW.voucher_date, NEW.particular, NEW.amount_pkr, 0, 'voucher', NEW.id, NEW.receipt_no, v_bill_number);
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
  VALUES (NEW.from_account_id, NEW.voucher_date, NEW.particular, 0, NEW.amount_pkr, 'voucher', NEW.id, NEW.receipt_no, v_bill_number);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION trg_voucher_after_approval() RETURNS trigger AS $$
DECLARE
  v_bill_number varchar;
BEGIN
  IF OLD.status = 'pending' AND NEW.status = 'approved' THEN
    NEW.voucher_no := COALESCE(NEW.voucher_no, next_voucher_no(NEW.system, NEW.voucher_type));
    IF NEW.bill_id IS NOT NULL THEN
      SELECT bill_number INTO v_bill_number FROM bills WHERE id = NEW.bill_id;
    END IF;
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (NEW.to_account_id, NEW.voucher_date, NEW.particular, NEW.amount_pkr, 0, 'voucher', NEW.id, NEW.receipt_no, v_bill_number);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (NEW.from_account_id, NEW.voucher_date, NEW.particular, 0, NEW.amount_pkr, 'voucher', NEW.id, NEW.receipt_no, v_bill_number);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Backfill existing security-deposit ledger rows with the bill_number and (now
-- generated) receipt_no they were missing.
UPDATE ledger_entries le SET
  bill_number = b.bill_number,
  receipt_no = COALESCE(le.receipt_no, v.receipt_no)
FROM vouchers v JOIN bills b ON b.id = v.bill_id
WHERE le.reference_type = 'voucher' AND le.reference_id = v.id AND v.bill_id IS NOT NULL;
