-- Migration 353: import_legacy_expense was consolidating BookKeeper's 16
-- distinct expense categories (مزدوری, میٹیریل کے اخراجات, Doctor Fee,
-- Vehicle Rent, OT Expenses...) into just two buckets ("Labour Cost" /
-- "Project Expenditure") on the theory that the site's own chart of
-- accounts was already deliberately consolidated and a one-off historical
-- category wasn't worth permanent sprawl. Explicit correction: every
-- BookKeeper category gets its own real expense account here — matching
-- one that already exists by name, or created fresh via the same
-- next_account_code() the "+ New Account" UI itself uses, so a new
-- category account looks exactly like one a staff member created by hand.

CREATE OR REPLACE FUNCTION ensure_expense_account(p_name varchar) RETURNS uuid AS $$
DECLARE
  v_account_id uuid;
  v_header_id uuid;
  v_code varchar;
BEGIN
  SELECT id INTO v_account_id FROM accounts WHERE system = 'donors_projects' AND type = 'expense' AND name = p_name;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;

  SELECT id INTO v_header_id FROM account_headers WHERE system = 'donors_projects' AND code = 'expense';
  v_code := next_account_code(v_header_id);

  INSERT INTO accounts (code, name, type, system, opening_balance)
  VALUES (v_code, p_name, 'expense', 'donors_projects', 0)
  RETURNING id INTO v_account_id;

  RETURN v_account_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION ensure_expense_account(varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ensure_expense_account(varchar) TO authenticated;

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

  -- The one change from the previous version: create the category's own
  -- account on demand instead of requiring it to already exist as one of
  -- two fixed buckets.
  v_expense_account_id := ensure_expense_account(p_expense_account_name);
  SELECT id INTO v_cash_account_id FROM accounts WHERE system = 'donors_projects' AND code = 'DP-1001';

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, project_id, receipt_no)
  VALUES ('donors_projects', 'expense', p_date, p_particular, p_amount, v_cash_account_id, v_expense_account_id, p_project_id, p_receipt_no)
  RETURNING id INTO v_voucher_id;

  INSERT INTO legacy_import_records (external_ref, entity_type, entity_id, imported_by)
  VALUES (p_external_ref, 'expense', v_voucher_id, current_admin_user_id());

  RETURN v_voucher_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
