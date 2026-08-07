-- Migration 147: "Cash in Hand" -> "Cash" (it's the account for physical
-- cash, the "in Hand" was redundant), stop nesting project accounts under
-- it (they're their own header/section like every other account type —
-- type stays 'project' so they're still excluded from real cash/bank
-- voucher pickers; this is purely undoing the display nesting from
-- migration 144), and Urdu labels for every account header (none had ever
-- been translated — label_ur was NULL for all of them since they were
-- first seeded).

UPDATE accounts SET name = 'Cash', name_ur = 'نقد' WHERE code = 'WS-1001' AND system = 'water_supply';
UPDATE accounts SET name = 'Cash', name_ur = 'نقد' WHERE code = 'DP-1001' AND system = 'donors_projects';

-- Un-nest: projects go back to being a normal, flat, top-level header
-- section (their own collapsible group in the Chart of Accounts UI),
-- same pattern as Bank A/Cs, Income, Expenses etc. — not indented under
-- the Cash account specifically.
UPDATE accounts SET parent_account_id = NULL WHERE system = 'donors_projects' AND type = 'project';

CREATE OR REPLACE FUNCTION ensure_project_account(p_project_id uuid) RETURNS uuid AS $$
DECLARE
  v_account_id uuid;
  v_title varchar;
  v_title_ur varchar;
  v_header_id uuid;
BEGIN
  SELECT id INTO v_account_id FROM accounts WHERE project_id = p_project_id;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;
  SELECT title, title_ur INTO v_title, v_title_ur FROM projects WHERE id = p_project_id;
  SELECT id INTO v_header_id FROM account_headers WHERE system = 'donors_projects' AND code = 'project';
  INSERT INTO accounts (code, name, name_ur, type, system, project_id, opening_balance)
  VALUES (next_account_code(v_header_id), v_title, v_title_ur, 'project', 'donors_projects', p_project_id, 0)
  RETURNING id INTO v_account_id;
  RETURN v_account_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Header labels, both systems.
UPDATE account_headers SET label_ur = 'نقد' WHERE code = 'cash';
UPDATE account_headers SET label_ur = 'بینک اکاؤنٹس' WHERE code = 'bank';
UPDATE account_headers SET label_ur = 'آمدنی' WHERE code = 'income';
UPDATE account_headers SET label_ur = 'اخراجات' WHERE code = 'expense';
UPDATE account_headers SET label_ur = 'اثاثے' WHERE code = 'asset';
UPDATE account_headers SET label_ur = 'ذمہ داریاں' WHERE code = 'liability';
UPDATE account_headers SET label_ur = 'صارفین' WHERE code = 'consumer' AND system = 'water_supply';
UPDATE account_headers SET label_ur = 'عطیہ دہندگان' WHERE code = 'donor' AND system = 'donors_projects';
UPDATE account_headers SET label_ur = 'منصوبہ جات' WHERE code = 'project' AND system = 'donors_projects';
