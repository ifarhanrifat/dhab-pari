-- Migration 138: Project discussion — comments, likes, donor badges, and
-- flag-for-review moderation (NOT direct delete power for donors — a badge
-- is a funding-volume signal, not a trust credential; flags route to the
-- existing complaints inbox for a real staff decision, per explicit
-- direction). Works on any `projects` row regardless of status (proposal
-- while voting, or launched).

CREATE TABLE IF NOT EXISTS project_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  content text NOT NULL,
  is_hidden boolean NOT NULL DEFAULT false,
  hidden_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_comments_project_idx ON project_comments(project_id, created_at);

CREATE TABLE IF NOT EXISTS project_comment_likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id uuid NOT NULL REFERENCES project_comments(id) ON DELETE CASCADE,
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE (comment_id, portal_user_id)
);

ALTER TABLE project_comments ENABLE ROW LEVEL SECURITY;
-- Hidden comments are simply excluded from the public-read condition —
-- anyone can read non-hidden comments; the author can still see their own
-- even if hidden (so they know it was moderated, not just vanished).
CREATE POLICY "project_comments_read" ON project_comments FOR SELECT
  USING (is_hidden = false OR portal_user_id = current_portal_user_id() OR EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));
CREATE POLICY "project_comments_insert_own" ON project_comments FOR INSERT TO authenticated
  WITH CHECK (portal_user_id = current_portal_user_id());
CREATE POLICY "project_comments_delete_own" ON project_comments FOR DELETE TO authenticated
  USING (portal_user_id = current_portal_user_id());
-- Staff can hide/unhide (moderation), not portal users directly.
CREATE POLICY "project_comments_staff_moderate" ON project_comments FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));

ALTER TABLE project_comment_likes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "project_comment_likes_read" ON project_comment_likes FOR SELECT USING (true);
CREATE POLICY "project_comment_likes_insert_own" ON project_comment_likes FOR INSERT TO authenticated
  WITH CHECK (portal_user_id = current_portal_user_id());
CREATE POLICY "project_comment_likes_delete_own" ON project_comment_likes FOR DELETE TO authenticated
  USING (portal_user_id = current_portal_user_id());

-- Badge tier — computed from a donor's total VERIFIED giving (their own
-- donor account's credit total), not a stored column, so it's always
-- current. Thresholds are a reasonable village-charity default, editable
-- later via site_settings if needed.
CREATE OR REPLACE FUNCTION donor_badge_tier(p_portal_user_id uuid) RETURNS varchar AS $$
DECLARE
  v_account_id uuid;
  v_total decimal;
BEGIN
  SELECT donor_account_id INTO v_account_id FROM portal_users WHERE id = p_portal_user_id;
  IF v_account_id IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(credit) - SUM(debit), 0) INTO v_total FROM ledger_entries WHERE account_id = v_account_id;
  RETURN CASE
    WHEN v_total >= 500000 THEN 'platinum'
    WHEN v_total >= 100000 THEN 'gold'
    WHEN v_total >= 50000 THEN 'silver'
    WHEN v_total >= 10000 THEN 'bronze'
    ELSE NULL
  END;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Public comment feed with the commenter's public identity (username/avatar,
-- never phone) + badge — same reasoning as project_votes_public.
CREATE VIEW project_comments_public AS
SELECT c.id, c.project_id, c.content, c.created_at, c.portal_user_id,
       p.username, p.avatar_url, donor_badge_tier(p.id) AS badge_tier,
       (SELECT COUNT(*) FROM project_comment_likes l WHERE l.comment_id = c.id) AS like_count
FROM project_comments c JOIN portal_users p ON p.id = c.portal_user_id
WHERE c.is_hidden = false;

GRANT SELECT ON project_comments_public TO anon, authenticated;

-- Flagging a comment — routes to the existing complaints inbox (donors_projects
-- system) rather than giving any portal user, badged or not, direct delete
-- power. portal_user_id lock mirrors trg_complaint_portal_consumer_lock.
CREATE OR REPLACE FUNCTION flag_project_comment(p_comment_id uuid, p_reason text) RETURNS void AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_comment project_comments%ROWTYPE;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Not logged in'; END IF;
  SELECT * INTO v_comment FROM project_comments WHERE id = p_comment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Comment not found'; END IF;

  INSERT INTO complaints (system, portal_user_id, complainant_name, complaint_text, source, status)
  SELECT 'donors_projects', v_portal_user_id, full_name,
         'Flagged comment on project ' || v_comment.project_id || ': "' || v_comment.content || '"' ||
           CASE WHEN p_reason IS NOT NULL AND trim(p_reason) != '' THEN ' — Reason: ' || p_reason ELSE '' END,
         'website', 'open'
  FROM portal_users WHERE id = v_portal_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION flag_project_comment(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION flag_project_comment(uuid, text) TO authenticated;

-- Staff hide/unhide via RPC (simpler client call than a raw UPDATE, and
-- keeps a record of who moderated it).
CREATE OR REPLACE FUNCTION set_project_comment_hidden(p_comment_id uuid, p_hidden boolean) RETURNS void AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  UPDATE project_comments SET is_hidden = p_hidden, hidden_by = CASE WHEN p_hidden THEN current_admin_user_id() ELSE NULL END
  WHERE id = p_comment_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION set_project_comment_hidden(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_project_comment_hidden(uuid, boolean) TO authenticated;

ALTER PUBLICATION supabase_realtime ADD TABLE project_comments;
