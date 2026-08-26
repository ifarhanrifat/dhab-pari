-- Migration 354: two corrections found by cross-checking the import against
-- BookKeeper's own per-account reports.
--
-- 1. import_legacy_expense's p_receipt_no was assumed to equal its
--    p_external_ref suffix. That stopped being true once the importer
--    started splitting one compound BookKeeper voucher (e.g. PAY28) into
--    several real expense lines with external refs like "PAY28-1",
--    "PAY28-2" — the receipt/bill number shown on statements should stay
--    the plain original voucher number ("PAY28") on every line, not the
--    synthetic per-line suffix. No signature change needed: the caller now
--    passes the plain vch_no as p_receipt_no explicitly (see the commit
--    route), so this migration only documents the contract — the function
--    body already takes p_receipt_no as given.
--
-- 2. A Receipt voucher whose credited party is an expense account, not a
--    donor (e.g. a hospital refunding an unused advance), is a reduction of
--    that expense — not new donor income. import_legacy_donation must never
--    be called for these; import_legacy_expense_reversal posts the mirror
--    image of a normal expense (expense account credited, cash debited) and
--    — since that's not the general voucher pipeline's default direction
--    for the project sub-ledger leg — adds the project's credit leg itself
--    rather than let post_voucher_ledger_legs_base add a same-direction
--    debit leg meant for genuine spending.

CREATE OR REPLACE FUNCTION import_legacy_expense_reversal(
  p_external_ref varchar, p_expense_account_name varchar, p_project_id uuid,
  p_amount decimal, p_date date, p_particular text, p_receipt_no varchar
) RETURNS uuid AS $$
DECLARE
  v_voucher_id uuid;
  v_expense_account_id uuid;
  v_cash_account_id uuid;
  v_project_account_id uuid;
BEGIN
  IF current_admin_role() != 'super_admin' THEN
    RAISE EXCEPTION 'Only a super admin can run the legacy import.';
  END IF;

  SELECT entity_id INTO v_voucher_id FROM legacy_import_records WHERE external_ref = p_external_ref AND entity_type = 'expense';
  IF v_voucher_id IS NOT NULL THEN RETURN v_voucher_id; END IF;

  v_expense_account_id := ensure_expense_account(p_expense_account_name);
  SELECT id INTO v_cash_account_id FROM accounts WHERE system = 'donors_projects' AND code = 'DP-1001';

  -- from_account_id/to_account_id swapped relative to a normal expense
  -- voucher: post_voucher_ledger_legs_base's no-line-items branch debits
  -- to_account_id and credits from_account_id, so this debits Cash
  -- (money in) and credits the expense account (its balance goes down).
  -- project_id left NULL so the base function's own "expense + project_id"
  -- branch (which would debit the project account, the direction for real
  -- spending) never fires — the correct credit leg is added below instead.
  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, project_id, receipt_no)
  VALUES ('donors_projects', 'expense', p_date, p_particular, p_amount, v_expense_account_id, v_cash_account_id, NULL, p_receipt_no)
  RETURNING id INTO v_voucher_id;

  IF p_project_id IS NOT NULL THEN
    v_project_account_id := ensure_project_account(p_project_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_project_account_id, p_date, p_particular, 0, p_amount, 'voucher', v_voucher_id, p_receipt_no);
  END IF;

  INSERT INTO legacy_import_records (external_ref, entity_type, entity_id, imported_by)
  VALUES (p_external_ref, 'expense', v_voucher_id, current_admin_user_id());

  RETURN v_voucher_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION import_legacy_expense_reversal(varchar, varchar, uuid, decimal, date, text, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION import_legacy_expense_reversal(varchar, varchar, uuid, decimal, date, text, varchar) TO authenticated;
