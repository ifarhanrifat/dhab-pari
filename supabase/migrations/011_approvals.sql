-- Migration 011: Approval workflow for cash withdrawals and cash-paid expenses.
--
-- A voucher of these two kinds is created as 'pending' (no voucher_no, no ledger
-- postings yet). A designated committee member decides via a one-time secure link;
-- on approval the voucher gets its serial number and posts to the ledger exactly as
-- before. On rejection it never posts and never consumes a serial number.

-- 1. Mark which committee members are authorized approvers
ALTER TABLE committee_members ADD COLUMN IF NOT EXISTS can_approve boolean NOT NULL DEFAULT false;

-- 2. Voucher status + deferred numbering + one-time approval token
ALTER TABLE vouchers ALTER COLUMN voucher_no DROP NOT NULL;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS status varchar NOT NULL DEFAULT 'posted'
  CHECK (status IN ('pending', 'approved', 'rejected'));
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS approval_token varchar UNIQUE;

-- 3. Approval decisions log
CREATE TABLE IF NOT EXISTS voucher_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id uuid NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES committee_members(id),
  decision varchar NOT NULL CHECK (decision IN ('approved', 'rejected')),
  note text,
  decided_at timestamptz DEFAULT now()
);

ALTER TABLE voucher_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_all_voucher_approvals" ON voucher_approvals FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- No public policy here on purpose: the public approval page never talks to the
-- database directly — it goes through the /api/approvals/decide server route, which
-- uses the service-role key and validates the one-time token itself.

-- 4. Decide status/numbering at insert time instead of the app pre-fetching a voucher_no
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
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS voucher_before_insert_trigger ON vouchers;
CREATE TRIGGER voucher_before_insert_trigger BEFORE INSERT ON vouchers
  FOR EACH ROW EXECUTE FUNCTION trg_voucher_before_insert();

-- 5. Only post ledger entries for vouchers that are actually posted (guard the
--    existing AFTER INSERT trigger function rather than replacing the trigger).
CREATE OR REPLACE FUNCTION trg_voucher_ledger() RETURNS trigger AS $$
BEGIN
  IF NEW.status != 'posted' THEN
    RETURN NEW;
  END IF;
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (NEW.to_account_id, NEW.voucher_date, NEW.particular, NEW.amount_pkr, 0, 'voucher', NEW.id);
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (NEW.from_account_id, NEW.voucher_date, NEW.particular, 0, NEW.amount_pkr, 'voucher', NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 6. Approving a pending voucher assigns its serial number and posts the ledger pair;
--    rejecting it does neither.
CREATE OR REPLACE FUNCTION trg_voucher_after_approval() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status = 'approved' THEN
    NEW.voucher_no := COALESCE(NEW.voucher_no, next_voucher_no(NEW.system, NEW.voucher_type));
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (NEW.to_account_id, NEW.voucher_date, NEW.particular, NEW.amount_pkr, 0, 'voucher', NEW.id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (NEW.from_account_id, NEW.voucher_date, NEW.particular, 0, NEW.amount_pkr, 'voucher', NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS voucher_after_approval_trigger ON vouchers;
CREATE TRIGGER voucher_after_approval_trigger BEFORE UPDATE OF status ON vouchers
  FOR EACH ROW EXECUTE FUNCTION trg_voucher_after_approval();
