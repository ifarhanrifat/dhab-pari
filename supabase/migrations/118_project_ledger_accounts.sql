-- Migration 118: Per-project ledger accounts. Until now project_id on a
-- donation was a display-only tag (used just to build the ledger particular
-- text) — no project ever had its own account, so "a project's ledger"
-- didn't exist. This gives every project a lazily-provisioned account that
-- mirrors ensure_collector_account()/ensure_employee_account(), credited on
-- verified donations and debited on project-tagged expenses, so the existing
-- generic accounts/[id] statement page becomes each project's real ledger
-- (consolidated view = the account_headers group; individual view = one
-- project's account).

-- 1. New account_headers group + link column, same shape as collector/employee.
INSERT INTO account_headers (system, code, label, code_prefix, display_order, is_system) VALUES
  ('donors_projects', 'project', 'Project Funds', 'DP-PRJ', 8, true)
ON CONFLICT (system, code) DO NOTHING;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_project_id_key ON accounts(project_id) WHERE project_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ensure_project_account(p_project_id uuid) RETURNS uuid AS $$
DECLARE
  v_account_id uuid;
  v_title varchar;
BEGIN
  SELECT id INTO v_account_id FROM accounts WHERE project_id = p_project_id;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;
  SELECT title INTO v_title FROM projects WHERE id = p_project_id;
  INSERT INTO accounts (code, name, type, system, project_id, opening_balance)
  VALUES ('PRJ-' || substr(replace(p_project_id::text, '-', ''), 1, 8), v_title, 'project', 'donors_projects', p_project_id, 0)
  RETURNING id INTO v_account_id;
  RETURN v_account_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 2. trg_donor_ledger() gains a third leg: credit the project's account too
--    (a memo/subsidiary posting, same style as the donor-credit leg — this
--    codebase doesn't enforce strict balance-to-zero per reference either,
--    e.g. the cash leg above is already skipped if the account lookup fails).
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

  SELECT id INTO v_cash_account_id FROM accounts
  WHERE system = 'donors_projects' AND code = (CASE WHEN NEW.payment_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);
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

-- 3. vouchers.project_id — expenses can now be attributed to a project, which
--    debits that project's account (money spent against its raised funds).
--    post_voucher_ledger_legs() is the single choke point every voucher type
--    (simple, multi-line, advance-settlement) posts through — add the extra
--    leg there once, at the end, rather than per-branch.
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id);

CREATE OR REPLACE FUNCTION post_voucher_ledger_legs(p_voucher vouchers) RETURNS void AS $$
DECLARE
  v_bill_number varchar;
  v_line_total decimal;
  v_advance_amount decimal;
  v_diff decimal;
  v_advance_account_id uuid;
  v_project_account_id uuid;
  v_project_amount decimal;
  r RECORD;
BEGIN
  IF p_voucher.bill_id IS NOT NULL THEN
    SELECT bill_number INTO v_bill_number FROM bills WHERE id = p_voucher.bill_id;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_line_total FROM voucher_line_items WHERE voucher_id = p_voucher.id;

  IF p_voucher.voucher_type = 'advance_settlement' THEN
    FOR r IN SELECT account_id, amount, description FROM voucher_line_items WHERE voucher_id = p_voucher.id LOOP
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (r.account_id, p_voucher.voucher_date, COALESCE(r.description, p_voucher.particular), r.amount, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    END LOOP;

    SELECT amount_pkr INTO v_advance_amount FROM vouchers WHERE id = p_voucher.settles_voucher_id;
    v_diff := v_advance_amount - v_line_total; -- > 0: refund received; < 0: extra paid

    SELECT id INTO v_advance_account_id FROM accounts WHERE system = p_voucher.system AND code = 'WS-4003';
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (v_advance_account_id, p_voucher.voucher_date, p_voucher.particular, 0, v_advance_amount, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);

    IF v_diff > 0 THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, v_diff, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    ELSIF v_diff < 0 THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, 0, -v_diff, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    END IF;

    UPDATE vouchers SET settled_at = now() WHERE id = p_voucher.settles_voucher_id;
    v_project_amount := v_line_total;

  ELSIF v_line_total > 0 THEN
    FOR r IN SELECT account_id, amount, description FROM voucher_line_items WHERE voucher_id = p_voucher.id LOOP
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (r.account_id, p_voucher.voucher_date, COALESCE(r.description, p_voucher.particular), r.amount, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    END LOOP;
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, 0, v_line_total, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    v_project_amount := v_line_total;

  ELSE
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (p_voucher.to_account_id, p_voucher.voucher_date, p_voucher.particular, p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, 0, p_voucher.amount_pkr, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    v_project_amount := p_voucher.amount_pkr;
  END IF;

  -- Project-tagged expense: an extra debit leg against the project's own
  -- account, so its balance falls when money is actually spent on it.
  IF p_voucher.system = 'donors_projects' AND p_voucher.voucher_type = 'expense' AND p_voucher.project_id IS NOT NULL THEN
    v_project_account_id := ensure_project_account(p_voucher.project_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (v_project_account_id, p_voucher.voucher_date, p_voucher.particular, v_project_amount, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4. Close an existing RLS gap: `projects` has had one blanket
--    auth.role()='authenticated' policy (admin_all_projects) since migration
--    002 — any staff member, including a water_accountant with zero
--    donors_projects access, can create/edit/delete projects today. Gate
--    writes like `donors` already is (migration 014/022). Public read stays
--    on the separate `public_read_projects USING (true)` policy from
--    migration 002 — untouched, so /projects keeps working.
DROP POLICY IF EXISTS "admin_all_projects" ON projects;

CREATE POLICY "projects_write" ON projects FOR INSERT TO authenticated
  WITH CHECK (can_access_system('donors_projects') AND current_admin_permission('manage_parties'));
CREATE POLICY "projects_update" ON projects FOR UPDATE TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects') AND current_admin_permission('manage_parties'));
CREATE POLICY "projects_delete" ON projects FOR DELETE TO authenticated
  USING (can_access_system('donors_projects') AND current_admin_permission('delete_transactions'));
