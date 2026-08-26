-- Migration 363: project_comments_public (139) is the 4th view in the same
-- "plain view granted straight to anon, no idea privacy flags exist" family
-- already closed for donors_public/project_expenses_public/project_accounts_public
-- (361) and the ticker (360, 362). The donation trigger (139) auto-posts a
-- comment_type='system' row on every donation/pledge with the donor's real
-- name baked into the content text ("X submitted a donation of Rs. Y,
-- pending verification.") — for a project with hide_donor_names or
-- hide_donations set, that's the exact information those flags exist to
-- hide, reachable by anyone who queries this view directly with the
-- project's id, regardless of what the listing/detail page chooses to show.
--
-- Real (comment_type='user') discussion isn't donor-identifying — someone's
-- opinion on the project, not a donation record — so it stays visible
-- under hide_donations/hide_donor_names. Only full is_private (the
-- "everything" switch) hides it too, matching how is_private already
-- omits the row entirely in the other three views.

DROP VIEW IF EXISTS project_comments_public;
CREATE VIEW project_comments_public AS
SELECT c.id, c.project_id, c.content, c.created_at, c.portal_user_id, c.parent_comment_id, c.comment_type,
       CASE WHEN c.comment_type = 'system' THEN c.system_label ELSE p.username END AS username,
       CASE WHEN c.comment_type = 'system' THEN NULL ELSE p.avatar_url END AS avatar_url,
       CASE WHEN c.comment_type = 'system' THEN NULL ELSE donor_badge_tier(p.id) END AS badge_tier,
       (SELECT COUNT(*) FROM project_comment_likes l WHERE l.comment_id = c.id) AS like_count
FROM project_comments c
LEFT JOIN portal_users p ON p.id = c.portal_user_id
LEFT JOIN projects pr ON pr.id = c.project_id
WHERE c.is_hidden = false
  AND (
    c.project_id IS NULL
    OR COALESCE(pr.is_private, false) = false
       AND (
         c.comment_type = 'user'
         OR (COALESCE(pr.hide_donations, false) = false AND COALESCE(pr.hide_donor_names, false) = false)
       )
  );

GRANT SELECT ON project_comments_public TO anon, authenticated;
