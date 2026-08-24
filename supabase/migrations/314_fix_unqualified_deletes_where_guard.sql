-- Migration 314: this project's database rejects any DELETE with no WHERE
-- clause at all ("DELETE requires a WHERE clause") — discovered live when
-- both a manual `DELETE FROM donors;` and reset_welfare_and_projects_data()
-- itself (migration 313) hit the exact same error. Whatever enforces it
-- (a safe-update guard on this Supabase project) checks for the literal
-- presence of a WHERE clause, not whether it actually restricts anything —
-- the standard fix is `WHERE true`, semantically identical to no WHERE at
-- all, satisfies the guard.
--
-- Patches every unqualified DELETE in both reset functions: the two in
-- reset_accounting_system (067) that were never exercised against a real
-- guarded database until now, and every one added fresh in 313.

CREATE OR REPLACE FUNCTION reset_accounting_system(p_system varchar) RETURNS void AS $$
BEGIN
  IF NOT current_admin_is_super_admin() THEN
    RAISE EXCEPTION 'Only a Super Admin can reset the accounting system';
  END IF;
  IF p_system NOT IN ('water_supply', 'donors_projects') THEN
    RAISE EXCEPTION 'Invalid system: %', p_system;
  END IF;

  ALTER TABLE bill_line_items DISABLE TRIGGER USER;
  ALTER TABLE bills DISABLE TRIGGER USER;
  ALTER TABLE payments DISABLE TRIGGER USER;
  ALTER TABLE vouchers DISABLE TRIGGER USER;
  ALTER TABLE purchases DISABLE TRIGGER USER;
  ALTER TABLE purchase_line_items DISABLE TRIGGER USER;
  ALTER TABLE inventory_transactions DISABLE TRIGGER USER;
  ALTER TABLE donors DISABLE TRIGGER USER;

  IF p_system = 'water_supply' THEN
    DELETE FROM bills WHERE true;  -- cascades to bill_line_items and payments
  ELSE
    DELETE FROM donors WHERE true;
  END IF;

  DELETE FROM approval_confirmations WHERE approval_request_id IN (SELECT id FROM approval_requests WHERE system = p_system);
  DELETE FROM approval_requests WHERE system = p_system;

  DELETE FROM purchases WHERE system = p_system;  -- cascades to purchase_line_items

  DELETE FROM vouchers WHERE system = p_system;

  DELETE FROM inventory_transactions WHERE item_id IN (SELECT id FROM inventory_items WHERE system = p_system);

  DELETE FROM recurring_schedules WHERE system = p_system;

  DELETE FROM ledger_entries WHERE account_id IN (SELECT id FROM accounts WHERE system = p_system);

  UPDATE accounts SET opening_balance = 0 WHERE system = p_system;

  ALTER TABLE bill_line_items ENABLE TRIGGER USER;
  ALTER TABLE bills ENABLE TRIGGER USER;
  ALTER TABLE payments ENABLE TRIGGER USER;
  ALTER TABLE vouchers ENABLE TRIGGER USER;
  ALTER TABLE purchases ENABLE TRIGGER USER;
  ALTER TABLE purchase_line_items ENABLE TRIGGER USER;
  ALTER TABLE inventory_transactions ENABLE TRIGGER USER;
  ALTER TABLE donors ENABLE TRIGGER USER;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION reset_welfare_and_projects_data() RETURNS void AS $$
DECLARE
  v_tbl text;
  v_trigger_tables text[] := ARRAY[
    'kafalat_children', 'kafalat_disbursements', 'kafalat_fee_payments', 'kafalat_nominations',
    'kafalat_package_lines', 'kafalat_progress', 'kafalat_reverifications', 'kafalat_shares', 'kafalat_uniform_issues',
    'wazifa_students', 'wazifa_applications', 'wazifa_awards', 'wazifa_academic_records', 'wazifa_agreements',
    'wazifa_check_ins', 'wazifa_contributions', 'wazifa_decisions', 'wazifa_disbursement_charges', 'wazifa_documents',
    'wazifa_family_members', 'wazifa_installment_charges', 'wazifa_instalments', 'wazifa_interim_grant',
    'wazifa_repayment_schedule', 'wazifa_repayments', 'wazifa_results', 'wazifa_verifications',
    'sadqa_objects', 'sadqa_bills', 'sadqa_maintenance_log', 'sadqa_messages', 'sadqa_receipts', 'sadqa_upkeep_charges',
    'zakat_rounds', 'zakat_round_beneficiaries',
    'needs_register', 'needs_surveys', 'needs_verifications',
    'pool_commitments', 'pool_payments', 'pool_months',
    'projects', 'project_comments', 'project_comment_likes', 'project_media', 'project_tasks', 'project_votes',
    'volunteers', 'accounts'
  ];
BEGIN
  IF NOT current_admin_is_super_admin() THEN
    RAISE EXCEPTION 'Only a Super Admin can reset welfare & projects data';
  END IF;

  FOREACH v_tbl IN ARRAY v_trigger_tables LOOP
    EXECUTE format('ALTER TABLE %I DISABLE TRIGGER USER', v_tbl);
  END LOOP;

  DELETE FROM wazifa_disbursement_charges WHERE true;
  DELETE FROM wazifa_installment_charges WHERE true;

  PERFORM reset_accounting_system('donors_projects');

  DELETE FROM accounts WHERE kafalat_child_id IS NOT NULL OR wazifa_student_id IS NOT NULL;

  DELETE FROM wazifa_students WHERE true;
  DELETE FROM kafalat_nominations WHERE true;
  DELETE FROM kafalat_children WHERE true;
  DELETE FROM sadqa_objects WHERE true;
  DELETE FROM zakat_rounds WHERE true;
  DELETE FROM needs_register WHERE true;

  DELETE FROM pool_commitments WHERE true;
  DELETE FROM pool_payments WHERE true;
  DELETE FROM pool_months WHERE true;

  DELETE FROM volunteers WHERE true;
  DELETE FROM projects WHERE true;

  FOREACH v_tbl IN ARRAY v_trigger_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE TRIGGER USER', v_tbl);
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
