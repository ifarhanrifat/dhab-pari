-- Migration 350: The three writes the legacy BookKeeper importer needs —
-- create a project, import a donation, import an expense — each atomic,
-- each idempotent via legacy_import_records (migration 349), each callable
-- only by a super_admin's own session (not a bypassed service-role path),
-- so confirmed_by/imported_by attribute correctly and the existing RLS on
-- projects/donors/ledger_entries is respected rather than routed around.

-- A distinct reference_type rather than reusing 'voucher' (which other code
-- assumes has a matching vouchers row — not true here, these are posted
-- directly, deliberately bypassing that table) or 'manual' (which would
-- make an imported expense indistinguishable from one a staff member typed
-- in by hand today).
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_reference_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_reference_type_check
  CHECK (reference_type IN ('bill', 'payment', 'donation', 'manual', 'voucher', 'inventory', 'collector_settlement', 'project_transfer', 'legacy_import'));

-- 1. Project — a straight insert; "project" here also covers the general
-- committee fund and the two personal medical accounts (kept exactly as
-- they exist in BookKeeper per explicit direction — a private/aggregate
-- display mode for the medical ones is a later, separate feature).
CREATE OR REPLACE FUNCTION import_legacy_project(p_external_ref varchar, p_title varchar, p_category varchar) RETURNS uuid AS $$
DECLARE
  v_project_id uuid;
BEGIN
  IF current_admin_role() != 'super_admin' THEN
    RAISE EXCEPTION 'Only a super admin can run the legacy import.';
  END IF;

  SELECT entity_id INTO v_project_id FROM legacy_import_records WHERE external_ref = p_external_ref AND entity_type = 'project';
  IF v_project_id IS NOT NULL THEN RETURN v_project_id; END IF;

  INSERT INTO projects (title, title_ur, status, category)
  VALUES (p_title, p_title, 'ongoing', p_category)
  RETURNING id INTO v_project_id;

  INSERT INTO legacy_import_records (external_ref, entity_type, entity_id, imported_by)
  VALUES (p_external_ref, 'project', v_project_id, current_admin_user_id());

  RETURN v_project_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION import_legacy_project(varchar, varchar, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION import_legacy_project(varchar, varchar, varchar) TO authenticated;

-- 2. Donation — inserts unverified, then finalizes exactly the way
-- confirm_donation() (migration 117) finalizes a real one: assigns the
-- donor's permanent account number and this donation's voucher number if
-- either is still missing, then flips is_verified (which is what actually
-- fires trg_donor_ledger() and posts the donor/cash/project ledger legs —
-- migration 118). Reusing that exact finalization logic here rather than
-- re-deriving it keeps an imported donation indistinguishable, in the
-- books, from one confirmed by hand at the time.
CREATE OR REPLACE FUNCTION import_legacy_donation(
  p_external_ref varchar, p_name varchar, p_phone varchar, p_donor_type varchar,
  p_amount decimal, p_date date, p_project_id uuid, p_notes text
) RETURNS uuid AS $$
DECLARE
  v_donor_id uuid;
  v_account_id uuid;
  v_account_no varchar;
  v_voucher_no varchar;
BEGIN
  IF current_admin_role() != 'super_admin' THEN
    RAISE EXCEPTION 'Only a super admin can run the legacy import.';
  END IF;

  SELECT entity_id INTO v_donor_id FROM legacy_import_records WHERE external_ref = p_external_ref AND entity_type = 'donation';
  IF v_donor_id IS NOT NULL THEN RETURN v_donor_id; END IF;

  INSERT INTO donors (name, phone, donor_type, amount_pkr, date, project_id, payment_method, is_anonymous, submitted_via, payment_status, fund_type, notes, is_verified)
  VALUES (p_name, p_phone, p_donor_type, p_amount, p_date, p_project_id, 'cash', false, 'staff', 'paid', 'general', p_notes, false)
  RETURNING id INTO v_donor_id;

  v_account_id := ensure_donor_account(p_name, p_phone);
  SELECT donor_account_no INTO v_account_no FROM accounts WHERE id = v_account_id;
  IF v_account_no IS NULL THEN
    v_account_no := next_donor_account_no();
    UPDATE accounts SET donor_account_no = v_account_no WHERE id = v_account_id;
  END IF;

  v_voucher_no := next_voucher_no('donors_projects', 'income');
  UPDATE donors SET voucher_no = v_voucher_no, is_verified = true, confirmed_at = now(), confirmed_by = current_admin_user_id()
  WHERE id = v_donor_id;

  INSERT INTO legacy_import_records (external_ref, entity_type, entity_id, imported_by)
  VALUES (p_external_ref, 'donation', v_donor_id, current_admin_user_id());

  RETURN v_donor_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION import_legacy_donation(varchar, varchar, varchar, varchar, decimal, date, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION import_legacy_donation(varchar, varchar, varchar, varchar, decimal, date, uuid, text) TO authenticated;

-- 3. Expense — the same three ledger legs post_voucher_ledger_legs() would
-- post for a project-tagged expense voucher (migration 118): debit the
-- expense category, credit cash, debit the project's own account. Posted
-- directly rather than through the vouchers table on purpose — these are
-- already-settled historical facts, not new spending decisions, and
-- routing them through the live multi-approver workflow (migration 060)
-- would put a two-year-old grocery receipt in someone's pending-approval
-- queue today.
CREATE OR REPLACE FUNCTION import_legacy_expense(
  p_external_ref varchar, p_expense_account_name varchar, p_project_id uuid,
  p_amount decimal, p_date date, p_particular text
) RETURNS uuid AS $$
DECLARE
  v_ref_id uuid;
  v_expense_account_id uuid;
  v_cash_account_id uuid;
  v_project_account_id uuid;
BEGIN
  IF current_admin_role() != 'super_admin' THEN
    RAISE EXCEPTION 'Only a super admin can run the legacy import.';
  END IF;

  SELECT entity_id INTO v_ref_id FROM legacy_import_records WHERE external_ref = p_external_ref AND entity_type = 'expense';
  IF v_ref_id IS NOT NULL THEN RETURN v_ref_id; END IF;

  SELECT id INTO v_expense_account_id FROM accounts WHERE system = 'donors_projects' AND type = 'expense' AND name = p_expense_account_name;
  IF v_expense_account_id IS NULL THEN RAISE EXCEPTION 'Expense account "%" not found', p_expense_account_name; END IF;

  SELECT id INTO v_cash_account_id FROM accounts WHERE system = 'donors_projects' AND code = 'DP-1001';
  v_project_account_id := ensure_project_account(p_project_id);
  v_ref_id := gen_random_uuid();

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id) VALUES
    (v_expense_account_id, p_date, p_particular, p_amount, 0, 'legacy_import', v_ref_id),
    (v_cash_account_id, p_date, p_particular, 0, p_amount, 'legacy_import', v_ref_id),
    (v_project_account_id, p_date, p_particular, p_amount, 0, 'legacy_import', v_ref_id);

  INSERT INTO legacy_import_records (external_ref, entity_type, entity_id, imported_by)
  VALUES (p_external_ref, 'expense', v_ref_id, current_admin_user_id());

  RETURN v_ref_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION import_legacy_expense(varchar, varchar, uuid, decimal, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION import_legacy_expense(varchar, varchar, uuid, decimal, date, text) TO authenticated;
