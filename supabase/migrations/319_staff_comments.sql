-- Migration 319: Staff can comment on the public site as themselves — no
-- separate portal_users signup needed. Two fully separate identity systems
-- (admin_users for staff, portal_users for donors) previously meant a
-- Publisher or Water Accountant had no way to leave a comment except by
-- signing up through the donor portal like a villager. Everyone (every
-- role, including Viewer) can comment as staff — that was explicit.
--
-- comment_type gains a third value, 'staff', alongside 'user' and
-- 'system'. A staff comment carries admin_user_id instead of
-- portal_user_id — the two remain mutually exclusive, same discipline the
-- author_check constraint already enforced for user/system.

ALTER TABLE project_comments ADD COLUMN IF NOT EXISTS admin_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE project_comments DROP CONSTRAINT IF EXISTS project_comments_comment_type_check;
ALTER TABLE project_comments ADD CONSTRAINT project_comments_comment_type_check
  CHECK (comment_type IN ('user', 'staff', 'system'));

ALTER TABLE project_comments DROP CONSTRAINT IF EXISTS project_comments_author_check;
ALTER TABLE project_comments ADD CONSTRAINT project_comments_author_check
  CHECK (
    (comment_type = 'user' AND portal_user_id IS NOT NULL AND admin_user_id IS NULL)
    OR (comment_type = 'staff' AND admin_user_id IS NOT NULL AND portal_user_id IS NULL)
    OR (comment_type = 'system')
  );

CREATE POLICY "project_comments_insert_staff" ON project_comments FOR INSERT TO authenticated
  WITH CHECK (comment_type = 'staff' AND admin_user_id = current_admin_user_id());

-- Staff can delete their own staff comment the same way a donor deletes
-- their own — mirrors project_comments_delete_own's shape exactly.
CREATE POLICY "project_comments_delete_own_staff" ON project_comments FOR DELETE TO authenticated
  USING (admin_user_id = current_admin_user_id());

-- Public comment feed: a staff comment shows the admin's own name and role
-- instead of a username/donor badge. role is admin_users.role (the CHECK-
-- constrained primary role: super_admin/admin/accountant/water_accountant/
-- donor_accountant/publisher/viewer) — the frontend renders the label.
DROP VIEW IF EXISTS project_comments_public;
CREATE VIEW project_comments_public AS
SELECT c.id, c.project_id, c.content, c.created_at, c.portal_user_id, c.admin_user_id, c.parent_comment_id, c.comment_type,
       CASE
         WHEN c.comment_type = 'system' THEN c.system_label
         WHEN c.comment_type = 'staff' THEN a.full_name
         ELSE p.username
       END AS username,
       CASE WHEN c.comment_type = 'user' THEN p.avatar_url ELSE NULL END AS avatar_url,
       CASE WHEN c.comment_type = 'user' THEN donor_badge_tier(p.id) ELSE NULL END AS badge_tier,
       CASE WHEN c.comment_type = 'staff' THEN a.role ELSE NULL END AS staff_role,
       (SELECT COUNT(*) FROM project_comment_likes l WHERE l.comment_id = c.id) AS like_count
FROM project_comments c
LEFT JOIN portal_users p ON p.id = c.portal_user_id
LEFT JOIN admin_users a ON a.id = c.admin_user_id
WHERE c.is_hidden = false;

GRANT SELECT ON project_comments_public TO anon, authenticated;
