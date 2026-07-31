-- Migration 040: A security deposit is cash physically received from a consumer —
-- exactly like a bill payment — so it needs a receipt number just like payments get,
-- not just an internal voucher_no. Reuses the same receipt_no_seq/next_receipt_no()
-- payments already use, so receipt numbers stay one unified series across the whole
-- app rather than forking into a separate voucher-only numbering scheme.

ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS receipt_no varchar;

CREATE OR REPLACE FUNCTION trg_voucher_before_insert() RETURNS trigger AS $$
DECLARE
  v_from_type varchar;
  v_requires_approval boolean;
BEGIN
  SELECT type INTO v_from_type FROM accounts WHERE id = NEW.from_account_id;
  v_requires_approval := NEW.voucher_type = 'withdrawal'
    OR (NEW.voucher_type = 'expense' AND v_from_type = 'cash');

  IF v_requires_approval THEN
    NEW.status := 'pending';
    NEW.voucher_no := NULL;
    NEW.approval_token := encode(gen_random_bytes(20), 'hex');
  ELSE
    NEW.status := 'posted';
    NEW.voucher_no := COALESCE(NEW.voucher_no, next_voucher_no(NEW.system, NEW.voucher_type));
  END IF;

  IF NEW.voucher_type = 'security_deposit' AND NEW.receipt_no IS NULL THEN
    NEW.receipt_no := next_receipt_no();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- trg_voucher_ledger() now carries the voucher's receipt_no onto both ledger legs,
-- the same way trg_payment_ledger() does for bill payments.
CREATE OR REPLACE FUNCTION trg_voucher_ledger() RETURNS trigger AS $$
BEGIN
  IF NEW.status != 'posted' THEN
    RETURN NEW;
  END IF;
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
  VALUES (NEW.to_account_id, NEW.voucher_date, NEW.particular, NEW.amount_pkr, 0, 'voucher', NEW.id, NEW.receipt_no);
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
  VALUES (NEW.from_account_id, NEW.voucher_date, NEW.particular, 0, NEW.amount_pkr, 'voucher', NEW.id, NEW.receipt_no);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION trg_voucher_after_approval() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status = 'approved' THEN
    NEW.voucher_no := COALESCE(NEW.voucher_no, next_voucher_no(NEW.system, NEW.voucher_type));
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (NEW.to_account_id, NEW.voucher_date, NEW.particular, NEW.amount_pkr, 0, 'voucher', NEW.id, NEW.receipt_no);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (NEW.from_account_id, NEW.voucher_date, NEW.particular, 0, NEW.amount_pkr, 'voucher', NEW.id, NEW.receipt_no);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
