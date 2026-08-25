-- Migration 345: Talent Showcase discussion — comments, likes, and
-- flag-for-review, same shape as project_comments (migration 138) with
-- the staff/system comment types dropped (villagers cheering someone on
-- doesn't need a committee-reply lane the way project spending questions
-- do). Deliberately not gated on support_status — a need being met is
-- when people are most likely to want to say something, so comments and
-- likes keep working after 'fulfilled' exactly as before.

CREATE TABLE talent_showcase_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  talent_showcase_id uuid NOT NULL REFERENCES talent_showcases(id) ON DELETE CASCADE,
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  content text NOT NULL,
  is_hidden boolean NOT NULL DEFAULT false,
  hidden_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);
CREATE INDEX talent_showcase_comments_entry_idx ON talent_showcase_comments(talent_showcase_id, created_at);

CREATE TABLE talent_showcase_comment_likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id uuid NOT NULL REFERENCES talent_showcase_comments(id) ON DELETE CASCADE,
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE (comment_id, portal_user_id)
);

ALTER TABLE talent_showcase_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "talent_showcase_comments_read" ON talent_showcase_comments FOR SELECT
  USING (is_hidden = false OR portal_user_id = current_portal_user_id() OR EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));
CREATE POLICY "talent_showcase_comments_insert_own" ON talent_showcase_comments FOR INSERT TO authenticated
  WITH CHECK (portal_user_id = current_portal_user_id());
CREATE POLICY "talent_showcase_comments_delete_own" ON talent_showcase_comments FOR DELETE TO authenticated
  USING (portal_user_id = current_portal_user_id());
CREATE POLICY "talent_showcase_comments_staff_moderate" ON talent_showcase_comments FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));

ALTER TABLE talent_showcase_comment_likes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "talent_showcase_comment_likes_read" ON talent_showcase_comment_likes FOR SELECT USING (true);
CREATE POLICY "talent_showcase_comment_likes_insert_own" ON talent_showcase_comment_likes FOR INSERT TO authenticated
  WITH CHECK (portal_user_id = current_portal_user_id());
CREATE POLICY "talent_showcase_comment_likes_delete_own" ON talent_showcase_comment_likes FOR DELETE TO authenticated
  USING (portal_user_id = current_portal_user_id());

-- Public comment feed — portal_public_name() (migration 336), not
-- full_name, same rule as everywhere else a portal user's identity
-- reaches the public site: it's the name they chose to show, not
-- whatever they registered with.
CREATE VIEW talent_showcase_comments_public AS
SELECT c.id, c.talent_showcase_id, c.content, c.created_at, c.portal_user_id,
       portal_public_name(p.id) AS username, p.avatar_url, donor_badge_tier(p.id) AS badge_tier,
       (SELECT COUNT(*) FROM talent_showcase_comment_likes l WHERE l.comment_id = c.id) AS like_count
FROM talent_showcase_comments c JOIN portal_users p ON p.id = c.portal_user_id
WHERE c.is_hidden = false;

GRANT SELECT ON talent_showcase_comments_public TO anon, authenticated;

-- Flagging routes to the same complaints inbox as project comments
-- (donors_projects system) — no direct delete power for portal users.
CREATE OR REPLACE FUNCTION flag_talent_showcase_comment(p_comment_id uuid, p_reason text) RETURNS void AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_comment talent_showcase_comments%ROWTYPE;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'براہ کرم پہلے لاگ ان کریں۔ Please log in first.'; END IF;
  SELECT * INTO v_comment FROM talent_showcase_comments WHERE id = p_comment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'یہ تبصرہ نہیں ملا۔ Comment not found.'; END IF;

  INSERT INTO complaints (system, portal_user_id, complainant_name, complaint_text, source, status)
  SELECT 'donors_projects', v_portal_user_id, full_name,
         'Flagged comment on talent showcase ' || v_comment.talent_showcase_id || ': "' || v_comment.content || '"' ||
           CASE WHEN p_reason IS NOT NULL AND trim(p_reason) != '' THEN ' — Reason: ' || p_reason ELSE '' END,
         'website', 'open'
  FROM portal_users WHERE id = v_portal_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION flag_talent_showcase_comment(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION flag_talent_showcase_comment(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION set_talent_showcase_comment_hidden(p_comment_id uuid, p_hidden boolean) RETURNS void AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  UPDATE talent_showcase_comments SET is_hidden = p_hidden, hidden_by = CASE WHEN p_hidden THEN current_admin_user_id() ELSE NULL END
  WHERE id = p_comment_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION set_talent_showcase_comment_hidden(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_talent_showcase_comment_hidden(uuid, boolean) TO authenticated;

ALTER PUBLICATION supabase_realtime ADD TABLE talent_showcase_comments;
