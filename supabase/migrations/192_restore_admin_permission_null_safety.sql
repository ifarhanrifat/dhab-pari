-- Migration 192: restore current_admin_permission, and stop relying on it
-- returning a non-NULL answer.
--
-- ── What broke ───────────────────────────────────────────────────────────
-- Migration 188 rewrote current_admin_permission to add the blood permission
-- and, in doing so, retyped the function from scratch instead of extending
-- migration 066's version. Two things were lost:
--
--   1. COALESCE(..., false). The inner SELECT returns no row for anyone
--      without an active admin_users record, so the function returned NULL
--      rather than false. Every guard written as
--
--          IF NOT current_admin_permission('x') THEN RAISE EXCEPTION ...
--
--      then evaluated `NOT NULL` → NULL, and plpgsql does not run an IF whose
--      condition is NULL. The exception never fired and execution carried on
--      into the body. Because these are SECURITY DEFINER functions, RLS was
--      not there to catch what the guard let through.
--
--      Verified against the live database before writing this: calling
--      approve_blood_request as a caller with no admin_users row returned
--      success instead of raising. The functions are granted to `authenticated`,
--      so the exposed set was every logged-in portal user — any villager with
--      a donor login — against these guards:
--
--        approve / cancel / pause / fulfil blood requests, and both blood
--        ticker posts                              (189)
--        disconnect_consumer, reconnect_consumer   (071, 092, 097)
--        advance payments and multi-line vouchers  (083, 088, 090)
--        employee ledger posting                   (103)
--
--      Guards written as `IF NOT can_access_system(...) OR NOT
--      current_admin_permission(...)` were never exposed: can_access_system
--      kept its COALESCE, so the first half of the OR was already true for a
--      non-admin and the exception fired. That is most of the financial RPCs,
--      which is why this did not show up as broken behaviour anywhere.
--
--   2. secondary_role. Migration 066 added a second role slot; the 188 rewrite
--      only looked at `role`. Anyone whose permissions came from their
--      secondary role lost them, and a viewer with a real secondary role was
--      hard-blocked again — precisely the block 066 existed to remove.
--
-- ── The fix ──────────────────────────────────────────────────────────────
-- Migration 066's body, verbatim, with the one genuinely new line from 188
-- (manage_blood_requests) added to the permission list.
CREATE OR REPLACE FUNCTION current_admin_permission(perm varchar) RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT CASE
      WHEN role = 'super_admin' OR secondary_role = 'super_admin' THEN true
      WHEN role = 'viewer' AND (secondary_role IS NULL OR secondary_role = 'viewer') THEN false
      ELSE (CASE perm
        WHEN 'post_transactions' THEN can_post_transactions
        WHEN 'edit_transactions' THEN can_edit_transactions
        WHEN 'delete_transactions' THEN can_delete_transactions
        WHEN 'view_reports' THEN can_view_reports
        WHEN 'approve_transactions' THEN can_approve_transactions
        WHEN 'manage_parties' THEN can_manage_parties
        WHEN 'manage_accounts' THEN can_manage_accounts
        WHEN 'edit_accounts' THEN can_edit_accounts
        WHEN 'delete_accounts' THEN can_delete_accounts
        WHEN 'restore_deleted' THEN can_restore_deleted
        WHEN 'invite_users' THEN can_invite_users
        WHEN 'manage_blood_requests' THEN can_manage_blood_requests
        ELSE false
      END)
    END
    FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1),
    false
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ── Belt as well as braces ───────────────────────────────────────────────
-- Restoring the COALESCE fixes every caller at once, which is exactly why the
-- callers should not depend on it. `IS DISTINCT FROM true` is NULL-safe on its
-- own, so the next person who retypes this helper — as I just did — cannot
-- reopen the same hole from a distance.
--
-- Done as a textual replacement of the guard line against each function's own
-- current definition, rather than by retyping six bodies here. Retyping a
-- function from memory to change one line is what caused this migration to be
-- necessary; the definitions already in the database are the correct ones
-- (including migration 191's public-form call gate in approve), so the single
-- line is swapped and everything else is carried across untouched.
--
-- If a body ever stops matching the expected guard, the loop warns and leaves
-- that function alone instead of guessing.
DO $fix$
DECLARE
  fn text;
  src text;
  newsrc text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'approve_blood_request', 'set_blood_request_paused',
    'cancel_blood_request', 'fulfil_blood_request',
    'post_blood_request_ticker', 'post_blood_thanks_ticker'
  ] LOOP
    SELECT pg_get_functiondef(p.oid) INTO src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = fn
     LIMIT 1;

    IF src IS NULL THEN
      RAISE WARNING 'blood guard: % not found, skipped', fn;
      CONTINUE;
    END IF;

    newsrc := replace(
      src,
      'IF NOT current_admin_permission(''manage_blood_requests'') THEN',
      'IF current_admin_permission(''manage_blood_requests'') IS DISTINCT FROM true THEN'
    );

    IF newsrc = src THEN
      RAISE WARNING 'blood guard: % did not contain the expected guard, left alone', fn;
      CONTINUE;
    END IF;

    EXECUTE newsrc;
    RAISE NOTICE 'blood guard hardened: %', fn;
  END LOOP;
END $fix$;
