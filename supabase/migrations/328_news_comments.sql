-- Migration 328: blog/news post comments — project_comments (migration 138,
-- extended by 319 for staff) exists for projects; news_posts had nothing.
-- The mentorship blogs (migration 325) need somewhere for a student to
-- react publicly, separate from the private mentor chat (migration 324).
-- Same shape as project_comments post-319: portal user OR staff, with
-- replies and moderation.

CREATE TABLE IF NOT EXISTS news_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  news_post_id uuid NOT NULL REFERENCES news_posts(id) ON DELETE CASCADE,
  parent_comment_id uuid REFERENCES news_comments(id) ON DELETE CASCADE,
  portal_user_id uuid REFERENCES portal_users(id) ON DELETE CASCADE,
  admin_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  comment_type varchar NOT NULL DEFAULT 'user' CHECK (comment_type IN ('user', 'staff')),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),
  is_hidden boolean NOT NULL DEFAULT false,
  hidden_by uuid REFERENCES admin_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT news_comments_author_check CHECK (
    (comment_type = 'user' AND portal_user_id IS NOT NULL AND admin_user_id IS NULL)
    OR (comment_type = 'staff' AND admin_user_id IS NOT NULL AND portal_user_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS news_comments_post_idx ON news_comments(news_post_id, created_at);

ALTER TABLE news_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "news_comments_read" ON news_comments FOR SELECT
  USING (
    is_hidden = false
    OR portal_user_id = current_portal_user_id()
    OR EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)
  );

CREATE POLICY "news_comments_insert_portal" ON news_comments FOR INSERT TO authenticated
  WITH CHECK (comment_type = 'user' AND portal_user_id = current_portal_user_id());
CREATE POLICY "news_comments_insert_staff" ON news_comments FOR INSERT TO authenticated
  WITH CHECK (comment_type = 'staff' AND admin_user_id = current_admin_user_id());

CREATE POLICY "news_comments_delete_own_portal" ON news_comments FOR DELETE TO authenticated
  USING (portal_user_id = current_portal_user_id());
CREATE POLICY "news_comments_delete_own_staff" ON news_comments FOR DELETE TO authenticated
  USING (admin_user_id = current_admin_user_id());
CREATE POLICY "news_comments_moderate" ON news_comments FOR UPDATE TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin'))
  WITH CHECK (current_admin_role() IN ('super_admin', 'admin'));

-- Public view — same pattern as project_comments_public: resolves author
-- display name/avatar server-side so the client never queries portal_users/
-- admin_users directly for this.
CREATE OR REPLACE VIEW news_comments_public AS
SELECT
  c.id, c.news_post_id, c.parent_comment_id, c.comment_type, c.content, c.created_at,
  c.portal_user_id, c.admin_user_id,
  CASE WHEN c.comment_type = 'staff' THEN a.full_name ELSE p.full_name END AS username,
  CASE WHEN c.comment_type = 'staff' THEN NULL ELSE p.avatar_url END AS avatar_url,
  CASE WHEN c.comment_type = 'staff' THEN NULL ELSE donor_badge_tier(p.id) END AS badge_tier,
  CASE WHEN c.comment_type = 'staff' THEN a.role ELSE NULL END AS staff_role
FROM news_comments c
LEFT JOIN portal_users p ON p.id = c.portal_user_id
LEFT JOIN admin_users a ON a.id = c.admin_user_id
WHERE c.is_hidden = false;

GRANT SELECT ON news_comments_public TO anon, authenticated;

ALTER PUBLICATION supabase_realtime ADD TABLE news_comments;
