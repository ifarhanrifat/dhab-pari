-- Migration 356: import_legacy_expense_split (migration 355) set each
-- category line item's own `description` to the bare category name
-- ("Vehicle Rent"). post_voucher_ledger_legs_base's line-item branch does
-- `COALESCE(r.description, p_voucher.particular)` per leg, so a non-null
-- description wins — every category leg's own ledger_entries.particular
-- ended up as just its account name instead of the real descriptive text
-- (the narration, the BookKeeper reference), while the Cash and project
-- legs of the SAME voucher correctly kept the full particular. A single-
-- line legacy expense never had this problem (no line items at all, so
-- every leg already fell through to the voucher's own particular) — this
-- is why the bug only ever showed up on the 53 compound vouchers.
--
-- Fix: leave description NULL so every leg of a voucher shares the same
-- full particular, exactly like a single-line expense already does — the
-- per-line account name is already shown on its own in the itemized
-- table, repeating it as "the particular" added nothing and lost the
-- real text. ensure_expense_account's caller in openView() already falls
-- back to a formatted category label when description is NULL, so the
-- itemized "Paid To" table is unaffected.

CREATE OR REPLACE FUNCTION import_legacy_expense_split(
  p_external_ref varchar, p_project_id uuid, p_amount decimal, p_date date,
  p_particular text, p_receipt_no varchar, p_lines jsonb
) RETURNS uuid AS $$
DECLARE
  v_voucher_id uuid;
  v_cash_account_id uuid;
  v_account_id uuid;
  v_line jsonb;
BEGIN
  IF current_admin_role() != 'super_admin' THEN
    RAISE EXCEPTION 'Only a super admin can run the legacy import.';
  END IF;

  SELECT entity_id INTO v_voucher_id FROM legacy_import_records WHERE external_ref = p_external_ref AND entity_type = 'expense';
  IF v_voucher_id IS NOT NULL THEN RETURN v_voucher_id; END IF;

  IF NOT EXISTS (SELECT 1 FROM approval_approvers WHERE system = 'donors_projects' AND is_active = true) THEN
    RAISE EXCEPTION 'A split-line import needs an active donors_projects approver configured (it relies on the normal pending state, not the no-approver auto-post path).';
  END IF;

  SELECT id INTO v_cash_account_id FROM accounts WHERE system = 'donors_projects' AND code = 'DP-1001';

  BEGIN
    ALTER TABLE vouchers DISABLE TRIGGER voucher_after_insert_approval_trigger;
    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, project_id, receipt_no)
    VALUES ('donors_projects', 'expense', p_date, p_particular, p_amount, v_cash_account_id, NULL, p_project_id, p_receipt_no)
    RETURNING id INTO v_voucher_id;
  EXCEPTION WHEN OTHERS THEN
    ALTER TABLE vouchers ENABLE TRIGGER voucher_after_insert_approval_trigger;
    RAISE;
  END;
  ALTER TABLE vouchers ENABLE TRIGGER voucher_after_insert_approval_trigger;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_account_id := ensure_expense_account(v_line->>'category');
    -- description left NULL on purpose — see migration comment above.
    INSERT INTO voucher_line_items (voucher_id, account_id, amount, category)
    VALUES (v_voucher_id, v_account_id, (v_line->>'amount')::decimal, v_line->>'category');
  END LOOP;

  UPDATE vouchers SET status = 'posted' WHERE id = v_voucher_id;

  INSERT INTO legacy_import_records (external_ref, entity_type, entity_id, imported_by)
  VALUES (p_external_ref, 'expense', v_voucher_id, current_admin_user_id());

  RETURN v_voucher_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Fix the already-posted data: every ledger leg of the 53 split
-- legacy-import vouchers (identified via legacy_import_records, not
-- "any voucher with line items" — a real multi-line voucher elsewhere,
-- e.g. Kafalat's monthly payment, legitimately gives each line its own
-- distinct description and must not be touched) gets the voucher's own
-- full particular, matching what the Cash/project legs of the same
-- voucher already correctly have.
UPDATE ledger_entries le
SET particular = v.particular
FROM vouchers v
WHERE le.reference_type = 'voucher' AND le.reference_id = v.id
  AND v.id IN (SELECT entity_id FROM legacy_import_records WHERE entity_type = 'expense')
  AND le.particular IS DISTINCT FROM v.particular;

UPDATE voucher_line_items
SET description = NULL
WHERE voucher_id IN (
  SELECT entity_id FROM legacy_import_records WHERE entity_type = 'expense'
);
