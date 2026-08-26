-- Migration 352: import_legacy_expense posted straight to ledger_entries,
-- deliberately bypassing the vouchers table to dodge the live multi-approver
-- workflow (migration 060) — a real concern in general, but it meant an
-- imported expense had no voucher_no, no receipt_no, and was invisible on
-- every page that lists transactions by reading `vouchers`, not raw
-- ledger_entries (Transactions, Recent Transactions). That's a worse trade
-- than the one it was avoiding.
--
-- The actual fix: these expenses predate the approval feature entirely (the
-- one active approver was only configured 2026-08-03, months to years after
-- every date in this import) — approval was never a live gate at the time
-- they happened. So the importer now inserts a real vouchers row, same as
-- a live-entered expense, and the admin running the import temporarily
-- deactivates the donors_projects approver for the duration (a UI checkbox
-- would be more polish than this one-time operation needs) so
-- trg_voucher_before_insert posts immediately instead of queuing a
-- two-year-old grocery receipt for someone to approve today.

CREATE OR REPLACE FUNCTION import_legacy_expense(
  p_external_ref varchar, p_expense_account_name varchar, p_project_id uuid,
  p_amount decimal, p_date date, p_particular text, p_receipt_no varchar
) RETURNS uuid AS $$
DECLARE
  v_voucher_id uuid;
  v_expense_account_id uuid;
  v_cash_account_id uuid;
BEGIN
  IF current_admin_role() != 'super_admin' THEN
    RAISE EXCEPTION 'Only a super admin can run the legacy import.';
  END IF;

  SELECT entity_id INTO v_voucher_id FROM legacy_import_records WHERE external_ref = p_external_ref AND entity_type = 'expense';
  IF v_voucher_id IS NOT NULL THEN RETURN v_voucher_id; END IF;

  SELECT id INTO v_expense_account_id FROM accounts WHERE system = 'donors_projects' AND type = 'expense' AND name = p_expense_account_name;
  IF v_expense_account_id IS NULL THEN RAISE EXCEPTION 'Expense account "%" not found', p_expense_account_name; END IF;
  SELECT id INTO v_cash_account_id FROM accounts WHERE system = 'donors_projects' AND code = 'DP-1001';

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, project_id, receipt_no)
  VALUES ('donors_projects', 'expense', p_date, p_particular, p_amount, v_cash_account_id, v_expense_account_id, p_project_id, p_receipt_no)
  RETURNING id INTO v_voucher_id;

  INSERT INTO legacy_import_records (external_ref, entity_type, entity_id, imported_by)
  VALUES (p_external_ref, 'expense', v_voucher_id, current_admin_user_id());

  RETURN v_voucher_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION import_legacy_expense(varchar, varchar, uuid, decimal, date, text, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION import_legacy_expense(varchar, varchar, uuid, decimal, date, text, varchar) TO authenticated;

-- The old 6-argument signature is dead now that receipt_no was added —
-- drop it so there's no ambiguous overload left for PostgREST to trip on.
DROP FUNCTION IF EXISTS import_legacy_expense(varchar, varchar, uuid, decimal, date, text);
