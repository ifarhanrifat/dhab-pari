-- Migration 336: a portal user's real full_name was leaking onto every
-- public surface that shows "who did this" — project comments, blog
-- comments, the mentor directory, the volunteer list, and (found live
-- while investigating this) the donor name recorded when someone
-- announces a pledge on a project, since that flow copied
-- portalUser.full_name straight into the publicly-shown donors.name.
--
-- Fix: an explicit, user-controlled display_name, separate from the real
-- name used for accounting/records. NULL means "haven't set one" — every
-- public surface falls back to username (already what comments showed
-- before this) and only falls back further to full_name where a username
-- genuinely doesn't apply. full_name itself is never touched or hidden —
-- it's what's on record; display_name is what a stranger reading the
-- website sees.
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS display_name varchar;

CREATE OR REPLACE FUNCTION portal_public_name(p_portal_user_id uuid) RETURNS varchar AS $$
  SELECT COALESCE(NULLIF(trim(display_name), ''), username, full_name)
  FROM portal_users WHERE id = p_portal_user_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION portal_public_name(uuid) TO anon, authenticated;

-- project_comments_public (migration 319) already used p.username, not
-- full_name, for a 'user' comment — so this specifically fixes it up to
-- also honor a set display_name, without changing behavior for anyone who
-- hasn't set one.
CREATE OR REPLACE VIEW project_comments_public AS
SELECT c.id, c.project_id, c.content, c.created_at, c.portal_user_id, c.admin_user_id, c.parent_comment_id, c.comment_type,
       CASE
         WHEN c.comment_type = 'system' THEN c.system_label
         WHEN c.comment_type = 'staff' THEN a.full_name
         ELSE portal_public_name(p.id)
       END AS username,
       CASE WHEN c.comment_type = 'user' THEN p.avatar_url ELSE NULL END AS avatar_url,
       CASE WHEN c.comment_type = 'user' THEN donor_badge_tier(p.id) ELSE NULL END AS badge_tier,
       CASE WHEN c.comment_type = 'staff' THEN a.role ELSE NULL END AS staff_role,
       (SELECT COUNT(*) FROM project_comment_likes l WHERE l.comment_id = c.id) AS like_count
FROM project_comments c
LEFT JOIN portal_users p ON p.id = c.portal_user_id
LEFT JOIN admin_users a ON a.id = c.admin_user_id
WHERE c.is_hidden = false;

-- news_comments_public (migration 328, this same build) used p.full_name
-- outright — a real bug, fixed here rather than patched in place so the
-- history stays honest about what changed and why.
CREATE OR REPLACE VIEW news_comments_public AS
SELECT
  c.id, c.news_post_id, c.parent_comment_id, c.comment_type, c.content, c.created_at,
  c.portal_user_id, c.admin_user_id,
  CASE WHEN c.comment_type = 'staff' THEN a.full_name ELSE portal_public_name(p.id) END AS username,
  CASE WHEN c.comment_type = 'staff' THEN NULL ELSE p.avatar_url END AS avatar_url,
  CASE WHEN c.comment_type = 'staff' THEN NULL ELSE donor_badge_tier(p.id) END AS badge_tier,
  CASE WHEN c.comment_type = 'staff' THEN a.role ELSE NULL END AS staff_role
FROM news_comments c
LEFT JOIN portal_users p ON p.id = c.portal_user_id
LEFT JOIN admin_users a ON a.id = c.admin_user_id
WHERE c.is_hidden = false;

-- mentor_directory (migration 323) — a mentor's own public listing.
CREATE OR REPLACE VIEW mentor_directory AS
SELECT id, portal_public_name(id) AS full_name, avatar_url, mentor_type, mentor_bio, mentor_expertise, mentor_available
FROM portal_users
WHERE mentor_status = 'approved' AND is_active = true;

-- volunteers_public (migration 149).
CREATE OR REPLACE VIEW volunteers_public AS
SELECT v.id, v.project_id, v.message, v.status, v.created_at, portal_public_name(p.id) AS full_name, p.avatar_url
FROM volunteers v JOIN portal_users p ON p.id = v.portal_user_id;

-- Donor/mentor blog byline (migrations 312, 325) — was crediting
-- NEW.full_name from the submitter's real profile name outright.
CREATE OR REPLACE FUNCTION trg_donor_blog_submission_defaults() RETURNS trigger AS $$
DECLARE
  v_tier varchar;
  v_mentor_status varchar;
BEGIN
  IF NEW.submitted_by_portal_user_id IS NULL THEN RETURN NEW; END IF;

  v_tier := donor_badge_tier(NEW.submitted_by_portal_user_id);
  SELECT mentor_status INTO v_mentor_status FROM portal_users WHERE id = NEW.submitted_by_portal_user_id;

  IF v_tier NOT IN ('river', 'ocean', 'wellspring') AND v_mentor_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'Submitting a blog post is open to donors who have reached at least the Darya (River) badge, or approved mentors.';
  END IF;
  IF NEW.category <> 'blog' THEN
    RAISE EXCEPTION 'Donor/mentor submissions may only be blog posts.';
  END IF;

  NEW.author := portal_public_name(NEW.submitted_by_portal_user_id);
  NEW.is_published := false;
  NEW.moderation_status := 'pending';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
