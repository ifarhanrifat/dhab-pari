-- Migration 007: General ledger, payment audit log, consumer & donor party accounts
--
-- Adds a real transaction ledger behind the Chart of Accounts (previously
-- `accounts.opening_balance` was a static, manually-edited number with no
-- history). Every consumer and every donor now gets an auto-provisioned
-- `accounts` row, and bills/payments/donations post double-entry-style
-- lines into `ledger_entries`, so "View Account" can render a real
-- bank-statement for any account in the system.

-- 1. Extend accounts to support consumer/donor party accounts
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_type_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_type_check
  CHECK (type IN ('cash', 'bank', 'expense', 'income', 'asset', 'liability', 'consumer', 'donor'));

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS consumer_id varchar REFERENCES consumers(consumer_id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS donor_key varchar;

CREATE UNIQUE INDEX IF NOT EXISTS accounts_consumer_id_key ON accounts(consumer_id) WHERE consumer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_donor_key_key ON accounts(donor_key) WHERE donor_key IS NOT NULL;

-- 2. Number of connections per consumer (shown on the statement header/rows)
ALTER TABLE consumers ADD COLUMN IF NOT EXISTS connections int NOT NULL DEFAULT 1;

-- 3. Payment audit log — one row per payment event (replaces overwrite-in-place paid_amount)
CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  consumer_id varchar NOT NULL REFERENCES consumers(consumer_id) ON DELETE CASCADE,
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  method varchar CHECK (method IN ('jazzcash', 'easypaisa', 'bank', 'cash')),
  paid_date date NOT NULL DEFAULT current_date,
  receipt_no varchar UNIQUE,
  note text,
  created_at timestamptz DEFAULT now()
);

-- 4. General ledger — every account's transaction history
CREATE TABLE IF NOT EXISTS ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  entry_date date NOT NULL DEFAULT current_date,
  particular text NOT NULL,
  debit decimal NOT NULL DEFAULT 0,
  credit decimal NOT NULL DEFAULT 0,
  reference_type varchar CHECK (reference_type IN ('bill', 'payment', 'donation', 'manual')),
  reference_id uuid,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_entries_account_idx ON ledger_entries(account_id, entry_date);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_ref_key
  ON ledger_entries(reference_type, reference_id) WHERE reference_id IS NOT NULL;

-- 5. Sequential receipt numbering
CREATE SEQUENCE IF NOT EXISTS receipt_no_seq START 1;
CREATE OR REPLACE FUNCTION next_receipt_no() RETURNS varchar AS $$
  SELECT lpad(nextval('receipt_no_seq')::text, 4, '0');
$$ LANGUAGE sql;

-- 6. Auto-provision a consumer party account
CREATE OR REPLACE FUNCTION ensure_consumer_account(p_consumer_id varchar) RETURNS uuid AS $$
DECLARE
  v_account_id uuid;
  v_name varchar;
  v_name_ur varchar;
BEGIN
  SELECT id INTO v_account_id FROM accounts WHERE consumer_id = p_consumer_id;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;
  SELECT name, name_ur INTO v_name, v_name_ur FROM consumers WHERE consumer_id = p_consumer_id;
  INSERT INTO accounts (code, name, name_ur, type, system, consumer_id, opening_balance)
  VALUES ('CON-' || p_consumer_id, v_name, v_name_ur, 'consumer', 'water_supply', p_consumer_id, 0)
  RETURNING id INTO v_account_id;
  RETURN v_account_id;
END;
$$ LANGUAGE plpgsql;

-- 7. Auto-provision a donor party account (grouped by phone, falling back to name)
CREATE OR REPLACE FUNCTION donor_key_for(p_name varchar, p_phone varchar) RETURNS varchar AS $$
  SELECT lower(COALESCE(NULLIF(TRIM(p_phone), ''), TRIM(p_name)));
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION ensure_donor_account(p_name varchar, p_phone varchar) RETURNS uuid AS $$
DECLARE
  v_key varchar := donor_key_for(p_name, p_phone);
  v_account_id uuid;
BEGIN
  SELECT id INTO v_account_id FROM accounts WHERE donor_key = v_key;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;
  INSERT INTO accounts (code, name, type, system, donor_key, opening_balance)
  VALUES ('DON-' || substr(md5(v_key), 1, 8), p_name, 'donor', 'donors_projects', v_key, 0)
  RETURNING id INTO v_account_id;
  RETURN v_account_id;
END;
$$ LANGUAGE plpgsql;

-- 8. Bill -> ledger debit entry
CREATE OR REPLACE FUNCTION trg_bill_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
BEGIN
  v_account_id := ensure_consumer_account(NEW.consumer_id);
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (
    v_account_id, make_date(NEW.year, NEW.month, 1),
    'Water Bill - ' || to_char(make_date(NEW.year, NEW.month, 1), 'FMMonth YYYY'),
    NEW.amount_pkr, 0, 'bill', NEW.id
  )
  ON CONFLICT (reference_type, reference_id) DO UPDATE
    SET debit = EXCLUDED.debit, particular = EXCLUDED.particular, entry_date = EXCLUDED.entry_date;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bill_ledger_trigger ON bills;
CREATE TRIGGER bill_ledger_trigger AFTER INSERT OR UPDATE OF amount_pkr, month, year ON bills
  FOR EACH ROW EXECUTE FUNCTION trg_bill_ledger();

CREATE OR REPLACE FUNCTION trg_bill_delete_ledger() RETURNS trigger AS $$
BEGIN
  DELETE FROM ledger_entries WHERE reference_type = 'bill' AND reference_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bill_delete_ledger_trigger ON bills;
CREATE TRIGGER bill_delete_ledger_trigger AFTER DELETE ON bills
  FOR EACH ROW EXECUTE FUNCTION trg_bill_delete_ledger();

-- 9. Payment -> ledger credit entry + roll up onto the bill (paid_amount/status)
CREATE OR REPLACE FUNCTION trg_payment_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
  v_bill bills%ROWTYPE;
  v_total_paid decimal;
BEGIN
  IF NEW.receipt_no IS NULL THEN
    NEW.receipt_no := next_receipt_no();
  END IF;
  v_account_id := ensure_consumer_account(NEW.consumer_id);

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (
    v_account_id, NEW.paid_date, 'Payment received (' || NEW.method || ')',
    0, NEW.amount_pkr, 'payment', NEW.id
  );

  SELECT * INTO v_bill FROM bills WHERE id = NEW.bill_id;
  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_total_paid FROM payments WHERE bill_id = NEW.bill_id;

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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_ledger_trigger ON payments;
CREATE TRIGGER payment_ledger_trigger BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION trg_payment_ledger();

CREATE OR REPLACE FUNCTION trg_payment_delete_ledger() RETURNS trigger AS $$
DECLARE
  v_bill bills%ROWTYPE;
  v_total_paid decimal;
BEGIN
  DELETE FROM ledger_entries WHERE reference_type = 'payment' AND reference_id = OLD.id;
  SELECT * INTO v_bill FROM bills WHERE id = OLD.bill_id;
  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_total_paid FROM payments WHERE bill_id = OLD.bill_id AND id != OLD.id;
  UPDATE bills SET
    paid_amount = v_total_paid,
    status = CASE WHEN v_total_paid >= v_bill.amount_pkr THEN 'paid'
                  WHEN v_total_paid > 0 THEN 'partial'
                  ELSE 'unpaid' END
  WHERE id = OLD.bill_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_delete_ledger_trigger ON payments;
CREATE TRIGGER payment_delete_ledger_trigger AFTER DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION trg_payment_delete_ledger();

-- 10. Donor -> ledger credit entry
CREATE OR REPLACE FUNCTION trg_donor_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
  v_project_title text;
BEGIN
  v_account_id := ensure_donor_account(NEW.name, NEW.phone);
  SELECT title INTO v_project_title FROM projects WHERE id = NEW.project_id;
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (
    v_account_id, NEW.date,
    'Donation' || CASE WHEN v_project_title IS NOT NULL THEN ' - ' || v_project_title ELSE '' END,
    0, NEW.amount_pkr, 'donation', NEW.id
  )
  ON CONFLICT (reference_type, reference_id) DO UPDATE
    SET credit = EXCLUDED.credit, particular = EXCLUDED.particular, entry_date = EXCLUDED.entry_date;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS donor_ledger_trigger ON donors;
CREATE TRIGGER donor_ledger_trigger AFTER INSERT OR UPDATE OF amount_pkr, date, project_id ON donors
  FOR EACH ROW EXECUTE FUNCTION trg_donor_ledger();

CREATE OR REPLACE FUNCTION trg_donor_delete_ledger() RETURNS trigger AS $$
BEGIN
  DELETE FROM ledger_entries WHERE reference_type = 'donation' AND reference_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS donor_delete_ledger_trigger ON donors;
CREATE TRIGGER donor_delete_ledger_trigger AFTER DELETE ON donors
  FOR EACH ROW EXECUTE FUNCTION trg_donor_delete_ledger();

-- 11. RLS for new tables (same posture as the rest of this transparency-first site)
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_read_payments" ON payments FOR SELECT USING (true);
CREATE POLICY "admin_all_payments" ON payments FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "public_read_ledger_entries" ON ledger_entries FOR SELECT USING (true);
CREATE POLICY "admin_all_ledger_entries" ON ledger_entries FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 12. Backfill existing data ------------------------------------------------

-- 12a. Consumer accounts for existing consumers
INSERT INTO accounts (code, name, name_ur, type, system, consumer_id, opening_balance)
SELECT 'CON-' || c.consumer_id, c.name, c.name_ur, 'consumer', 'water_supply', c.consumer_id, 0
FROM consumers c
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.consumer_id = c.consumer_id);

-- 12b. Debit entries for existing bills
INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
SELECT a.id, make_date(b.year, b.month, 1),
       'Water Bill - ' || to_char(make_date(b.year, b.month, 1), 'FMMonth YYYY'),
       b.amount_pkr, 0, 'bill', b.id
FROM bills b
JOIN accounts a ON a.consumer_id = b.consumer_id
WHERE NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.reference_type = 'bill' AND le.reference_id = b.id);

-- 12c. Existing paid amounts become one backfilled payment each (fires the payment trigger,
--      which posts the matching credit entry and re-derives paid_amount/status — idempotent).
INSERT INTO payments (bill_id, consumer_id, amount_pkr, method, paid_date, note)
SELECT b.id, b.consumer_id, b.paid_amount, COALESCE(b.payment_method, 'cash'),
       COALESCE(b.paid_date, b.created_at::date), 'Backfilled from existing bill record'
FROM bills b
WHERE b.paid_amount > 0
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.bill_id = b.id);

-- 12d. Donor accounts for existing donors
INSERT INTO accounts (code, name, type, system, donor_key, opening_balance)
SELECT DISTINCT ON (donor_key_for(d.name, d.phone))
  'DON-' || substr(md5(donor_key_for(d.name, d.phone)), 1, 8),
  d.name, 'donor', 'donors_projects', donor_key_for(d.name, d.phone), 0
FROM donors d
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.donor_key = donor_key_for(d.name, d.phone));

-- 12e. Credit entries for existing donations
INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
SELECT a.id, d.date,
       'Donation' || CASE WHEN p.title IS NOT NULL THEN ' - ' || p.title ELSE '' END,
       0, d.amount_pkr, 'donation', d.id
FROM donors d
JOIN accounts a ON a.donor_key = donor_key_for(d.name, d.phone)
LEFT JOIN projects p ON p.id = d.project_id
WHERE NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.reference_type = 'donation' AND le.reference_id = d.id);
