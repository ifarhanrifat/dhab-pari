-- Migration 313: Reset Welfare & Projects Test Data — a super-admin-only
-- companion to reset_accounting_system() (migration 067), for the point in
-- a village's rollout where the test donors/children/students/projects used
-- to build and verify the system need to be cleared before real data starts
-- arriving. Same philosophy: wipe transactional/test rows, keep every
-- structural thing intact — chart of accounts, the 3 shared-pool
-- definitions (Kafalat/Wazifa/Esal-e-Sawab pools themselves, just emptied
-- of pledges), portal_users (real people's logins and profiles), admin
-- users, committee members, and all settings.
--
-- Covers what reset_accounting_system() does not: projects (and their
-- comments/votes/media/tasks), Kafalat children, Wazifa students, Esal-e-
-- Sawab objects, Zakat rounds, the verified needs register, shared-pool
-- pledges/payments, and project volunteer signups — then calls
-- reset_accounting_system('donors_projects') itself for the donor/voucher/
-- ledger side, so this is the one call that clears everything migration
-- 313's ask covers in one transaction.
--
-- Ordering here is load-bearing, not arbitrary — worked out against the
-- live foreign-key graph (information_schema, not just migration reading):
--   1. wazifa_installment_charges/disbursement_charges are the only two
--      welfare tables with a NO ACTION (not CASCADE/SET NULL) reference to
--      vouchers — deleted explicitly first so reset_accounting_system's own
--      voucher wipe doesn't get blocked by them.
--   2. Kafalat/Wazifa per-child/per-student "measuring accounts" (accounts
--      rows with kafalat_child_id/wazifa_student_id set) are deleted next,
--      while vouchers/voucher_line_items still exist to block a premature
--      delete... no — deleted AFTER the accounting reset, once nothing
--      references them, using the FK columns before they'd otherwise be
--      SET NULL'd by deleting kafalat_children/wazifa_students. So the
--      accounting reset must run between steps 1 and 3, not last.
--   3. zakat_round_beneficiaries -> needs_register is RESTRICT, so
--      zakat_rounds (which cascades beneficiaries) is cleared before
--      needs_register.
--   4. donors/vouchers -> projects is NO ACTION, so the accounting reset
--      (which clears both) runs before DELETE FROM projects.
-- Every DELETE FROM projects/kafalat_children/wazifa_students/sadqa_objects/
-- zakat_rounds/needs_register below relies on ON DELETE CASCADE for its own
-- detail tables (package lines, fee payments, awards, applications, bills,
-- receipts, etc.) — verified against the live schema, not assumed.
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

  -- 1. Unblock the accounting reset's voucher wipe.
  DELETE FROM wazifa_disbursement_charges;
  DELETE FROM wazifa_installment_charges;

  -- 2. Donors, vouchers, purchases, recurring schedules, approval requests,
  --    ledger entries, opening balances — the whole donors_projects money
  --    side. Runs its own trigger disable/enable internally; nesting is
  --    harmless (same transaction either way).
  PERFORM reset_accounting_system('donors_projects');

  -- 3. Now safe to remove: nothing references these anymore.
  DELETE FROM accounts WHERE kafalat_child_id IS NOT NULL OR wazifa_student_id IS NOT NULL;

  -- 4. Welfare module master data — each cascades its own detail tables.
  DELETE FROM wazifa_students;
  DELETE FROM kafalat_nominations;
  DELETE FROM kafalat_children;
  DELETE FROM sadqa_objects;
  DELETE FROM zakat_rounds;
  DELETE FROM needs_register;

  -- 5. Shared-pool activity — the 3 pool definitions themselves
  --    (support_pools) are left in place so Kafalat/Wazifa/Esal-e-Sawab
  --    giving keeps working; only the pledges/payments into them clear.
  DELETE FROM pool_commitments;
  DELETE FROM pool_payments;
  DELETE FROM pool_months;

  -- 6. Projects and volunteer signups.
  DELETE FROM volunteers;
  DELETE FROM projects;

  FOREACH v_tbl IN ARRAY v_trigger_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE TRIGGER USER', v_tbl);
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION reset_welfare_and_projects_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reset_welfare_and_projects_data() TO authenticated;
