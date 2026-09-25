-- Migration 509: restore staff/committee comment identity, dropped by 363's
-- privacy rewrite of this exact view.
--
-- Real report, 2026-09-25: an admin posted a comment on a project and it
-- showed up with no username, no role badge, no bold/colored text -- none
-- of the staff-comment styling built for it. Root cause: migration 319
-- added the admin_users JOIN (a.full_name as username, a.role as
-- staff_role) this view needs for a staff comment to render as anything
-- but blank -- migration 363, written later to close a real donor-privacy
-- leak in this same view, redefined it from scratch and never carried that
-- join forward at all. Both are real requirements; this merges them:
-- 363's privacy WHERE clause (system-comment donor info hidden under
-- hide_donations/hide_donor_names, everything hidden under is_private),
-- plus 319's admin_users join and username/staff_role logic, unchanged.
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
LEFT JOIN projects pr ON pr.id = c.project_id
WHERE c.is_hidden = false
  AND (
    c.project_id IS NULL
    OR COALESCE(pr.is_private, false) = false
       AND (
         c.comment_type != 'system'
         OR (COALESCE(pr.hide_donations, false) = false AND COALESCE(pr.hide_donor_names, false) = false)
       )
  );

GRANT SELECT ON project_comments_public TO anon, authenticated;
