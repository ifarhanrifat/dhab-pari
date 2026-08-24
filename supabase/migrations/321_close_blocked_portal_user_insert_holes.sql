-- Migration 321: a blocked portal account (is_active = false) could still
-- submit a suggestion, and could have still filed a complaint under their
-- own name. Root cause: public_insert_suggestions (migration 002) and
-- complaints_public_insert (migration 063) predate portal_user_id existing
-- on these tables (added migration 122) and were never tightened to check
-- it — both still accept ANY portal_user_id value from ANY caller, blocked
-- or not, logged in or not, since neither policy ever consults
-- current_portal_user_id(). Blocking a portal account already correctly
-- nulls current_portal_user_id() (migration 121 filters is_active = true
-- there) — these two policies just never checked it, so the block had no
-- effect on either table. True anonymous submission (no portal_user_id at
-- all) stays fully open, unchanged — only attributing a submission to a
-- specific portal identity now requires that identity to be the live,
-- non-blocked caller, closing an impersonation hole too (previously any
-- caller could attach ANY other portal_user_id to a complaint/suggestion).

DROP POLICY IF EXISTS "public_insert_suggestions" ON suggestions;
CREATE POLICY "public_insert_suggestions" ON suggestions FOR INSERT
  WITH CHECK (portal_user_id IS NULL OR portal_user_id = current_portal_user_id());

DROP POLICY IF EXISTS "complaints_public_insert" ON complaints;
CREATE POLICY "complaints_public_insert" ON complaints FOR INSERT
  WITH CHECK (
    source = 'website' AND status = 'open' AND assigned_to IS NULL
    AND (portal_user_id IS NULL OR portal_user_id = current_portal_user_id())
  );
