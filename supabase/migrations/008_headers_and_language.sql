-- Migration 008: Custom account headers with auto-serial codes, donor Urdu names,
-- Assets & Liabilities for Water Supply, and a display-language setting.

-- 1. Account headers — replaces the fixed 6-type CHECK constraint with a real, extensible
--    table so admins can add their own header categories (e.g. "Inventory") from the UI.
CREATE TABLE IF NOT EXISTS account_headers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system varchar NOT NULL CHECK (system IN ('water_supply', 'donors_projects')),
  code varchar NOT NULL,
  label varchar NOT NULL,
  label_ur varchar,
  code_prefix varchar NOT NULL,
  next_serial int NOT NULL DEFAULT 1,
  display_order int NOT NULL DEFAULT 0,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE(system, code)
);

ALTER TABLE account_headers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_account_headers" ON account_headers FOR SELECT USING (true);
CREATE POLICY "admin_all_account_headers" ON account_headers FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Seed a header row for every type value already in use (both systems), so the existing
-- accounts.type values validate against the new FK below without needing any data changes.
-- Water Supply gets Assets & Liabilities headers here too (it previously had none).
INSERT INTO account_headers (system, code, label, label_ur, code_prefix, display_order, is_system) VALUES
  ('water_supply', 'cash', 'Cash-in-hand', NULL, 'WS-CSH', 1, true),
  ('water_supply', 'bank', 'Bank A/Cs', NULL, 'WS-BNK', 2, true),
  ('water_supply', 'income', 'Income', NULL, 'WS-INC', 3, true),
  ('water_supply', 'expense', 'Expenses', NULL, 'WS-EXP', 4, true),
  ('water_supply', 'asset', 'Assets', NULL, 'WS-AST', 5, true),
  ('water_supply', 'liability', 'Liabilities', NULL, 'WS-LIA', 6, true),
  ('water_supply', 'consumer', 'Consumers', NULL, 'WS-CON', 0, true),
  ('donors_projects', 'cash', 'Cash-in-hand', NULL, 'DP-CSH', 1, true),
  ('donors_projects', 'bank', 'Bank A/Cs', NULL, 'DP-BNK', 2, true),
  ('donors_projects', 'income', 'Income', NULL, 'DP-INC', 3, true),
  ('donors_projects', 'expense', 'Expenses', NULL, 'DP-EXP', 4, true),
  ('donors_projects', 'asset', 'Assets', NULL, 'DP-AST', 5, true),
  ('donors_projects', 'liability', 'Liabilities', NULL, 'DP-LIA', 6, true),
  ('donors_projects', 'donor', 'Donors', NULL, 'DP-DNR', 0, true)
ON CONFLICT (system, code) DO NOTHING;

-- 2. Validate accounts.type against the new headers table instead of a fixed CHECK list.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_type_check;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_type_fkey;
ALTER TABLE accounts ADD CONSTRAINT accounts_type_fkey FOREIGN KEY (system, type) REFERENCES account_headers(system, code);

-- 3. Water Supply now has real Assets & Liabilities accounts to book inventory etc. against.
INSERT INTO accounts (code, name, name_ur, type, system, description) VALUES
  ('WS-4001', 'Equipment & Assets', 'اثاثے', 'asset', 'water_supply', 'Pumps, tools and equipment inventory'),
  ('WS-5001', 'Loan Payable', 'قرض', 'liability', 'water_supply', 'Outstanding loans or payables')
ON CONFLICT (code, system) DO NOTHING;

-- 4. Auto-generated serial account codes for new sub-accounts created under a header.
CREATE OR REPLACE FUNCTION next_account_code(p_header_id uuid) RETURNS varchar AS $$
DECLARE
  v_prefix varchar;
  v_serial int;
BEGIN
  UPDATE account_headers SET next_serial = next_serial + 1
  WHERE id = p_header_id
  RETURNING code_prefix, next_serial - 1 INTO v_prefix, v_serial;
  RETURN v_prefix || '-' || lpad(v_serial::text, 4, '0');
END;
$$ LANGUAGE plpgsql;

-- 5. Donors get a separate Urdu name field (mirrors consumers.name_ur), kept in sync onto
--    the donor's auto-provisioned account so it displays correctly per the language setting.
ALTER TABLE donors ADD COLUMN IF NOT EXISTS name_ur varchar;

CREATE OR REPLACE FUNCTION trg_donor_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
  v_project_title text;
BEGIN
  v_account_id := ensure_donor_account(NEW.name, NEW.phone);
  UPDATE accounts SET name_ur = NEW.name_ur WHERE id = v_account_id AND name_ur IS DISTINCT FROM NEW.name_ur;
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

-- 6. Admin-wide display-language preference for accounts data (not applied to org/company name).
INSERT INTO site_settings (key, value, description) VALUES
  ('display_language', 'en', 'Preferred display language (en/ur) for accounts data across the admin panel and reports')
ON CONFLICT (key) DO NOTHING;
