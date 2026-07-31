-- Migration 009: Vouchers (Transactions module) — expense, income, bank transfer,
-- cash withdrawal, cash deposit. Each voucher posts a proper double-entry pair into
-- ledger_entries (to_account debited, from_account credited), auto-numbered per
-- system + voucher type.

-- 1. Due date for bill generation
ALTER TABLE bills ADD COLUMN IF NOT EXISTS due_date date;

-- 2. Serial numbering per system + voucher type
CREATE TABLE IF NOT EXISTS voucher_counters (
  system varchar NOT NULL,
  voucher_type varchar NOT NULL,
  prefix varchar NOT NULL,
  next_serial int NOT NULL DEFAULT 1,
  PRIMARY KEY (system, voucher_type)
);

INSERT INTO voucher_counters (system, voucher_type, prefix) VALUES
  ('water_supply', 'expense', 'WS-EXP-V'),
  ('water_supply', 'income', 'WS-INC-V'),
  ('water_supply', 'contra', 'WS-CTR-V'),
  ('water_supply', 'withdrawal', 'WS-WD-V'),
  ('water_supply', 'deposit', 'WS-DEP-V'),
  ('donors_projects', 'expense', 'DP-EXP-V'),
  ('donors_projects', 'income', 'DP-INC-V'),
  ('donors_projects', 'contra', 'DP-CTR-V'),
  ('donors_projects', 'withdrawal', 'DP-WD-V'),
  ('donors_projects', 'deposit', 'DP-DEP-V')
ON CONFLICT (system, voucher_type) DO NOTHING;

CREATE OR REPLACE FUNCTION next_voucher_no(p_system varchar, p_type varchar) RETURNS varchar AS $$
DECLARE
  v_prefix varchar;
  v_serial int;
BEGIN
  UPDATE voucher_counters SET next_serial = next_serial + 1
  WHERE system = p_system AND voucher_type = p_type
  RETURNING prefix, next_serial - 1 INTO v_prefix, v_serial;
  IF v_prefix IS NULL THEN
    RAISE EXCEPTION 'No voucher counter for %/%', p_system, p_type;
  END IF;
  RETURN v_prefix || '-' || lpad(v_serial::text, 4, '0');
END;
$$ LANGUAGE plpgsql;

-- 3. Vouchers — a voucher always moves value from one account to another
--    (to_account is debited, from_account is credited). Which side is "source"
--    vs "destination" depends on voucher_type and is decided by the UI/form,
--    not by this table — e.g. for an expense, from=cash/bank, to=the expense account.
CREATE TABLE IF NOT EXISTS vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system varchar NOT NULL CHECK (system IN ('water_supply', 'donors_projects')),
  voucher_type varchar NOT NULL CHECK (voucher_type IN ('expense', 'income', 'contra', 'withdrawal', 'deposit')),
  voucher_no varchar NOT NULL UNIQUE,
  voucher_date date NOT NULL DEFAULT current_date,
  particular text NOT NULL,
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  from_account_id uuid NOT NULL REFERENCES accounts(id),
  to_account_id uuid NOT NULL REFERENCES accounts(id),
  party_name varchar,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vouchers_system_idx ON vouchers(system, voucher_date);

ALTER TABLE vouchers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_vouchers" ON vouchers FOR SELECT USING (true);
CREATE POLICY "admin_all_vouchers" ON vouchers FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 4. Vouchers become a new ledger reference_type
ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_reference_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_reference_type_check
  CHECK (reference_type IN ('bill', 'payment', 'donation', 'manual', 'voucher'));

CREATE OR REPLACE FUNCTION trg_voucher_ledger() RETURNS trigger AS $$
BEGIN
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (NEW.to_account_id, NEW.voucher_date, NEW.particular, NEW.amount_pkr, 0, 'voucher', NEW.id);
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (NEW.from_account_id, NEW.voucher_date, NEW.particular, 0, NEW.amount_pkr, 'voucher', NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS voucher_ledger_trigger ON vouchers;
CREATE TRIGGER voucher_ledger_trigger AFTER INSERT ON vouchers
  FOR EACH ROW EXECUTE FUNCTION trg_voucher_ledger();

CREATE OR REPLACE FUNCTION trg_voucher_delete_ledger() RETURNS trigger AS $$
BEGIN
  DELETE FROM ledger_entries WHERE reference_type = 'voucher' AND reference_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS voucher_delete_ledger_trigger ON vouchers;
CREATE TRIGGER voucher_delete_ledger_trigger AFTER DELETE ON vouchers
  FOR EACH ROW EXECUTE FUNCTION trg_voucher_delete_ledger();
