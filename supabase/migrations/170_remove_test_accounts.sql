-- Migration 170: permanently remove the 11 leftover TEST admin accounts that
-- automated testing created on this production database. Requested explicitly
-- by the super_admin after they could not be deleted from the Users page.
--
-- WHY THEY WOULDN'T DELETE
-- The Users page failed with:
--   violates foreign key constraint "audit_log_deleted_by_fkey"
-- That name is misleading: audit_log's `deleted_by` column was renamed to
-- `actor_id` at some point, and Postgres does NOT rename a constraint when
-- its column is renamed. So the constraint still carries the old name while
-- actually guarding `actor_id`. 44 audit rows point at these test accounts,
-- which blocks the delete.
--
-- WHAT THIS DOES *NOT* DO
-- It does not delete, alter, or hide a single audit_log row. Every row, its
-- summary, its record_data, its timestamp, and — critically — its
-- `actor_name` text ("__TEST__ donoracct") are left exactly as they are, so
-- the audit trail still shows who performed every action. Only the foreign
-- key POINTER to the row being deleted is cleared, which is precisely what
-- ON DELETE SET NULL would do if the constraint had been declared that way.
--
-- SCOPE — three throwaway domains only. A real committee address
-- (@dhabpari.com, @gmail.com, ...) cannot match, so no genuine account can be
-- caught by accident. Verified before writing this: exactly 11 rows match,
-- and the 44 audit rows attached to them are all logs of test actions on
-- test records (__TEST__ E2E Donor / __TEST__ E2E Project).
DO $$
DECLARE
  v_ids uuid[];
  v_cleared int;
  v_deleted int;
  v_audit_before int;
  v_audit_after int;
BEGIN
  SELECT array_agg(id) INTO v_ids
  FROM admin_users
  WHERE email LIKE '%@example.invalid'
     OR email LIKE '%@dhabpari.local'
     OR email LIKE '%@dhabpari.test';

  IF v_ids IS NULL OR array_length(v_ids, 1) = 0 THEN
    RAISE NOTICE 'No test accounts found — nothing to do.';
    RETURN;
  END IF;

  SELECT count(*) INTO v_audit_before FROM audit_log;

  -- Clear only the FK pointer; actor_name keeps the attribution readable.
  UPDATE audit_log SET actor_id = NULL WHERE actor_id = ANY(v_ids);
  GET DIAGNOSTICS v_cleared = ROW_COUNT;

  UPDATE audit_log SET restored_by = NULL WHERE restored_by = ANY(v_ids);

  DELETE FROM admin_users WHERE id = ANY(v_ids);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  SELECT count(*) INTO v_audit_after FROM audit_log;

  -- Hard guarantee: this migration must never remove audit history.
  IF v_audit_after <> v_audit_before THEN
    RAISE EXCEPTION 'Aborting: audit_log row count changed (% -> %)', v_audit_before, v_audit_after;
  END IF;

  RAISE NOTICE 'Test accounts deleted: %. Audit pointers cleared: %. audit_log rows unchanged at %.',
    v_deleted, v_cleared, v_audit_after;
END $$;
