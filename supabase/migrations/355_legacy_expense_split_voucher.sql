-- Migration 355: a compound BookKeeper voucher (one real payment that
-- covered several expense categories, e.g. PAY31 — Vehicle Rent + OT
-- Expenses advance + misc, all in one trip) was being imported as SEVERAL
-- independent single-leg vouchers, one per real category. That was correct
-- on the numbers (every category totalled right) but wrong on the shape:
-- printing any one of them showed only its own slice and none of the
-- siblings, and each got its own synthetic voucher number instead of the
-- one real BookKeeper voucher having one real system voucher number.
--
-- The fix: one voucher per original BookKeeper voucher, carrying its real
-- per-category breakdown as voucher_line_items — the exact mechanism this
-- app already uses for Kafalat's monthly payment and other multi-category
-- vouchers, so a compound legacy expense now prints as one itemized
-- Payment Voucher instead of several unrelated-looking ones.
--
-- Sequencing note: voucher_line_items must exist BEFORE the ledger posts,
-- but the normal insert-time trigger (trg_voucher_before_insert) posts
-- immediately when no approver is configured, and posts nothing (status
-- stays 'pending') when one is — this function relies on an active
-- approver existing so the initial insert lands 'pending', then adds the
-- real lines, then transitions to 'posted' itself (the same pending→
-- posted path a normal multi-approver voucher takes once fully approved),
-- which is what actually triggers the ledger posting with the lines now
-- present. The one side effect of going through 'pending' — a real
-- approval_requests/approval_confirmations/notification row for a
-- transaction already years settled — is skipped by briefly disabling
-- just that one AFTER INSERT trigger around the single INSERT statement.

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
    INSERT INTO voucher_line_items (voucher_id, account_id, amount, description, category)
    VALUES (v_voucher_id, v_account_id, (v_line->>'amount')::decimal, v_line->>'category', v_line->>'category');
  END LOOP;

  -- The same transition a fully-approved voucher goes through — assigns
  -- the real voucher_no and posts the ledger legs from the lines above.
  UPDATE vouchers SET status = 'posted' WHERE id = v_voucher_id;

  INSERT INTO legacy_import_records (external_ref, entity_type, entity_id, imported_by)
  VALUES (p_external_ref, 'expense', v_voucher_id, current_admin_user_id());

  RETURN v_voucher_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION import_legacy_expense_split(varchar, uuid, decimal, date, text, varchar, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION import_legacy_expense_split(varchar, uuid, decimal, date, text, varchar, jsonb) TO authenticated;
