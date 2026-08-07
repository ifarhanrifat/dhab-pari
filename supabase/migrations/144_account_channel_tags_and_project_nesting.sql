-- Migration 144: payment_channel tag (decouples ledger routing from
-- account code/name), proper next_account_code() serials + correct Bank
-- A/Cs grouping for JazzCash/EasyPaisa (both were added ad-hoc in migration
-- 143, bypassing the header/serial system every other sub-account goes
-- through), and a real parent_account_id so project accounts can nest
-- under Cash-in-Hand in the Chart of Accounts tree — purely a display
-- grouping; `type` keeps doing its existing job (voucher-picker filtering,
-- balance-sign rules), so a project's memo balance still can't be picked
-- as a real cash/bank source anywhere.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS payment_channel varchar CHECK (payment_channel IN ('cash', 'bank', 'jazzcash', 'easypaisa'));
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS parent_account_id uuid REFERENCES accounts(id);

-- Tag the default settlement accounts (both systems) with a stable channel
-- key, independent of their code/name — water_supply's routing trigger is
-- left alone (still correct, lower risk to touch for no functional gain),
-- but the tag is added for consistency and any future use.
UPDATE accounts SET payment_channel = 'cash' WHERE system = 'water_supply' AND code = 'WS-1001';
UPDATE accounts SET payment_channel = 'bank' WHERE system = 'water_supply' AND code = 'WS-1002';
UPDATE accounts SET payment_channel = 'cash' WHERE system = 'donors_projects' AND code = 'DP-1001';
UPDATE accounts SET payment_channel = 'bank' WHERE system = 'donors_projects' AND code = 'DP-1002';

-- Move JazzCash/EasyPaisa under the Bank A/Cs header with a real serial
-- code — the same next_account_code() mechanism the Chart of Accounts UI
-- already uses for every staff-created sub-account (migration 008).
DO $$
DECLARE
  v_bank_header_id uuid;
  v_jazzcash_id uuid;
  v_easypaisa_id uuid;
BEGIN
  SELECT id INTO v_bank_header_id FROM account_headers WHERE system = 'donors_projects' AND code = 'bank';
  SELECT id INTO v_jazzcash_id FROM accounts WHERE system = 'donors_projects' AND code = 'DP-1003';
  SELECT id INTO v_easypaisa_id FROM accounts WHERE system = 'donors_projects' AND code = 'DP-1004';

  IF v_jazzcash_id IS NOT NULL THEN
    UPDATE accounts SET type = 'bank', payment_channel = 'jazzcash', code = next_account_code(v_bank_header_id) WHERE id = v_jazzcash_id;
  END IF;
  IF v_easypaisa_id IS NOT NULL THEN
    UPDATE accounts SET type = 'bank', payment_channel = 'easypaisa', code = next_account_code(v_bank_header_id) WHERE id = v_easypaisa_id;
  END IF;
END $$;

-- trg_donor_ledger() (migration 143): route by the new stable payment_channel
-- tag instead of a hardcoded/guessable code string — this is what actually
-- lets JazzCash/EasyPaisa get real auto-generated codes above without
-- breaking the routing that depended on them being literally 'DP-1003'/'DP-1004'.
CREATE OR REPLACE FUNCTION trg_donor_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
  v_cash_account_id uuid;
  v_project_account_id uuid;
  v_project_title text;
  v_particular text;
BEGIN
  v_account_id := ensure_donor_account(NEW.name, NEW.phone);
  UPDATE accounts SET name_ur = NEW.name_ur WHERE id = v_account_id AND name_ur IS DISTINCT FROM NEW.name_ur;

  DELETE FROM ledger_entries WHERE reference_type = 'donation' AND reference_id = NEW.id;

  IF NOT NEW.is_verified THEN
    RETURN NEW;
  END IF;

  SELECT title INTO v_project_title FROM projects WHERE id = NEW.project_id;
  v_particular := 'Donation' || CASE WHEN v_project_title IS NOT NULL THEN ' - ' || v_project_title ELSE '' END;

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (v_account_id, NEW.date, v_particular, 0, NEW.amount_pkr, 'donation', NEW.id);

  SELECT id INTO v_cash_account_id FROM accounts WHERE system = 'donors_projects' AND payment_channel = NEW.payment_method;
  IF v_cash_account_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_cash_account_id, NEW.date, v_particular, NEW.amount_pkr, 0, 'donation', NEW.id);
  END IF;

  IF NEW.project_id IS NOT NULL THEN
    v_project_account_id := ensure_project_account(NEW.project_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_project_account_id, NEW.date, v_particular, 0, NEW.amount_pkr, 'donation', NEW.id);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ensure_project_account() (migration 118): proper serial code via
-- next_account_code() instead of a UUID-fragment code, Urdu name sourced
-- from the project's own title_ur, and parent_account_id = Cash-in-Hand so
-- it nests correctly in the Chart of Accounts tree.
CREATE OR REPLACE FUNCTION ensure_project_account(p_project_id uuid) RETURNS uuid AS $$
DECLARE
  v_account_id uuid;
  v_title varchar;
  v_title_ur varchar;
  v_header_id uuid;
  v_parent_id uuid;
BEGIN
  SELECT id INTO v_account_id FROM accounts WHERE project_id = p_project_id;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;
  SELECT title, title_ur INTO v_title, v_title_ur FROM projects WHERE id = p_project_id;
  SELECT id INTO v_header_id FROM account_headers WHERE system = 'donors_projects' AND code = 'project';
  SELECT id INTO v_parent_id FROM accounts WHERE system = 'donors_projects' AND code = 'DP-1001';
  INSERT INTO accounts (code, name, name_ur, type, system, project_id, parent_account_id, opening_balance)
  VALUES (next_account_code(v_header_id), v_title, v_title_ur, 'project', 'donors_projects', p_project_id, v_parent_id, 0)
  RETURNING id INTO v_account_id;
  RETURN v_account_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Backfill existing project accounts: proper serial codes (replacing the
-- old PRJ-<uuid> codes), parent = Cash-in-Hand, and name_ur where the
-- underlying project has one.
DO $$
DECLARE
  v_header_id uuid;
  v_parent_id uuid;
  r RECORD;
BEGIN
  SELECT id INTO v_header_id FROM account_headers WHERE system = 'donors_projects' AND code = 'project';
  SELECT id INTO v_parent_id FROM accounts WHERE system = 'donors_projects' AND code = 'DP-1001';
  FOR r IN SELECT id FROM accounts WHERE system = 'donors_projects' AND type = 'project' AND code LIKE 'PRJ-%' LOOP
    UPDATE accounts SET code = next_account_code(v_header_id) WHERE id = r.id;
  END LOOP;
  UPDATE accounts SET parent_account_id = v_parent_id
  WHERE system = 'donors_projects' AND type = 'project' AND parent_account_id IS NULL;
END $$;

UPDATE accounts a SET name_ur = p.title_ur
FROM projects p
WHERE a.project_id = p.id AND a.name_ur IS NULL AND p.title_ur IS NOT NULL;
