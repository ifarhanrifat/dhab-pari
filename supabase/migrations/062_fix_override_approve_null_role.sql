-- Migration 062: Fix a fail-open bug in override_approve_confirmation()
-- (migration 061), caught via live testing before this ever reached the UI.
--
-- `IF current_admin_role() != 'super_admin' THEN RAISE EXCEPTION` relies on
-- standard SQL three-valued logic: if current_admin_role() returns NULL (no
-- matching active admin_users row for the calling session — e.g. a deleted
-- account with a still-valid auth session, or any other edge case), then
-- `NULL != 'super_admin'` evaluates to NULL, and plpgsql treats a NULL IF
-- condition as false — so the RAISE EXCEPTION is silently skipped and the
-- override proceeds anyway. This is exactly backwards for an authorization
-- check: an unidentifiable caller must be rejected, not waved through.
--
-- IS DISTINCT FROM treats NULL as an ordinary comparable value (NULL IS
-- DISTINCT FROM 'super_admin' is TRUE), so the check now fails closed.

CREATE OR REPLACE FUNCTION override_approve_confirmation(p_confirmation_id uuid) RETURNS void AS $$
DECLARE
  v_confirmation approval_confirmations%ROWTYPE;
BEGIN
  IF current_admin_role() IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'Only a super admin can approve on behalf of another approver.';
  END IF;
  SELECT * INTO v_confirmation FROM approval_confirmations WHERE id = p_confirmation_id;
  IF v_confirmation.id IS NULL THEN
    RAISE EXCEPTION 'Confirmation not found.';
  END IF;
  IF v_confirmation.confirmed IS NOT NULL THEN
    RAISE EXCEPTION 'This approver has already decided — nothing to override.';
  END IF;
  UPDATE approval_confirmations
  SET confirmed = true, decided_at = now(), overridden_by = current_admin_user_id()
  WHERE id = p_confirmation_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
