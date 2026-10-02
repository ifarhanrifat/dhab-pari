-- Migration 562: generic "don't show this again" mechanism -- 2026-10-02.
--
-- Real ask: replace the old push-permission banner (which re-asked on
-- every single page load forever, with no way to tell it to stop) with a
-- proper "notifications are off" nudge that a person can permanently
-- dismiss with a checkbox -- and the same mechanism should work for any
-- future helper/instruction banner too, not just this one. One generic
-- table + hook, keyed by an arbitrary hint_id, rather than a bespoke
-- dismissed-flag column per banner.
CREATE TABLE dismissed_hints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid REFERENCES admin_users(id) ON DELETE CASCADE,
  portal_user_id uuid REFERENCES portal_users(id) ON DELETE CASCADE,
  hint_id varchar NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((admin_user_id IS NOT NULL) <> (portal_user_id IS NOT NULL))
);
-- Partial, not a plain UNIQUE(admin_user_id, hint_id) -- NULLs are distinct
-- from each other in a unique constraint, which would let the same portal
-- user's rows (admin_user_id always NULL) collide against each other's
-- hint_id under a single non-partial two-column unique index the other way
-- round. Two separate partial indexes, one per owner column, each only
-- indexing the rows where that column is actually set.
CREATE UNIQUE INDEX dismissed_hints_admin_uniq ON dismissed_hints(admin_user_id, hint_id) WHERE admin_user_id IS NOT NULL;
CREATE UNIQUE INDEX dismissed_hints_portal_uniq ON dismissed_hints(portal_user_id, hint_id) WHERE portal_user_id IS NOT NULL;

ALTER TABLE dismissed_hints ENABLE ROW LEVEL SECURITY;
CREATE POLICY "dismissed_hints_admin_own" ON dismissed_hints FOR ALL TO authenticated
  USING (admin_user_id = current_admin_user_id())
  WITH CHECK (admin_user_id = current_admin_user_id());
CREATE POLICY "dismissed_hints_portal_own" ON dismissed_hints FOR ALL TO authenticated
  USING (portal_user_id = current_portal_user_id())
  WITH CHECK (portal_user_id = current_portal_user_id());
