-- Migration 303: split Poetry and Blog out of the general News publishing
-- right, add a Featured flag posts can carry, and add a Committee Notes
-- board for the homepage.
--
-- ═════════════════════════════════════════════════════════════════════════
-- 1. Poetry and Blog become their own publishing areas
-- ═════════════════════════════════════════════════════════════════════════
-- Migration 202 gave 'poetry' a post_categories row, but writing one still
-- required can_publish_news — a publisher could not be handed poems without
-- also being handed the whole newsroom. Explicit committee decision: Poetry
-- and Blog become their own areas, exactly like News/Videos/Gallery/Ticker/
-- Jobs already are. Nobody's access widens here — these are new columns,
-- default false, including for existing News publishers (that is the whole
-- point of splitting them out; a News publisher who should also write poems
-- gets it ticked explicitly from Users, same as any other area).
ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS can_publish_poetry boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_publish_blog boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION current_admin_can_publish(p_area varchar) RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT CASE
      WHEN role IN ('super_admin', 'admin')
        OR secondary_role IN ('super_admin', 'admin') THEN true
      ELSE (CASE p_area
        WHEN 'news' THEN can_publish_news
        WHEN 'videos' THEN can_publish_videos
        WHEN 'gallery' THEN can_publish_gallery
        WHEN 'ticker' THEN can_publish_ticker
        WHEN 'jobs' THEN can_publish_jobs
        WHEN 'poetry' THEN can_publish_poetry
        WHEN 'blog' THEN can_publish_blog
        ELSE false
      END)
    END
    FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1),
    false
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- news_posts holds News, Editorial, Poetry and (now) Blog rows in one table
-- (migration 181's own design: "Editorial and Poetry are articles"). A single
-- can_publish_news check on the whole table can no longer be right once
-- Poetry and Blog are separately grantable — this maps a row's own category
-- to the area that actually governs it, so a poems-only publisher can write
-- category='poetry' rows and nothing else, symmetrically a News publisher
-- with no poetry/blog grant can't touch those rows either.
CREATE OR REPLACE FUNCTION current_admin_can_publish_category(p_category varchar) RETURNS boolean AS $$
  SELECT CASE p_category
    WHEN 'poetry' THEN current_admin_can_publish('poetry')
    WHEN 'blog' THEN current_admin_can_publish('blog')
    ELSE current_admin_can_publish('news')
  END;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

DROP POLICY IF EXISTS "news_posts_publish" ON news_posts;
CREATE POLICY "news_posts_publish" ON news_posts FOR ALL TO authenticated
  USING (current_admin_can_publish_category(category))
  WITH CHECK (current_admin_can_publish_category(category));

-- Extended, not just re-run: CREATE OR REPLACE cannot change a RETURNS TABLE
-- row type (42P13, same trap migration 202 itself notes), so the function is
-- dropped first.
DROP FUNCTION IF EXISTS system_access_for(uuid);
CREATE OR REPLACE FUNCTION system_access_for(p_admin_user_id uuid)
RETURNS TABLE (full_name text, role text, secondary_role text,
               can_water boolean, can_donors boolean,
               publish_news boolean, publish_videos boolean, publish_gallery boolean,
               publish_ticker boolean, publish_jobs boolean,
               publish_poetry boolean, publish_blog boolean) AS $$
  SELECT u.full_name::text, u.role::text, u.secondary_role::text,
         role_grants_system(u.role, u.secondary_role, u.access_water_supply, u.access_donors_projects, 'water_supply'),
         role_grants_system(u.role, u.secondary_role, u.access_water_supply, u.access_donors_projects, 'donors_projects'),
         u.can_publish_news, u.can_publish_videos, u.can_publish_gallery,
         u.can_publish_ticker, u.can_publish_jobs,
         u.can_publish_poetry, u.can_publish_blog
    FROM admin_users u
   WHERE u.id = p_admin_user_id
     AND EXISTS (SELECT 1 FROM admin_users a
                  WHERE a.auth_user_id = auth.uid() AND a.is_active = true
                    AND a.role IN ('super_admin', 'admin'))
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION system_access_for(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION system_access_for(uuid) TO authenticated;

-- 'blog' joins 'poetry' as a real category, data only — same reasoning as
-- migration 181 (a blog post is an article, not a new shape of table).
INSERT INTO post_categories (key, label_en, label_ur, icon, display_order) VALUES
  ('blog', 'Blog', 'بلاگ', '📝', 10)
ON CONFLICT (key) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Featured posts
-- ═════════════════════════════════════════════════════════════════════════
-- Any publisher who can already write a post can mark it Featured — this is
-- not a new permission, just a property of the post, governed by the same
-- current_admin_can_publish_category() check the row's other columns already
-- go through.
ALTER TABLE news_posts ADD COLUMN IF NOT EXISTS is_featured boolean NOT NULL DEFAULT false;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Committee Notes
-- ═════════════════════════════════════════════════════════════════════════
-- What the committee posts on the homepage to speak directly to the village —
-- a new project, a decision, anything that isn't a News article. Kept
-- separate from news_posts on purpose: this is the committee speaking in its
-- own voice (no author byline, no category, no publisher system involved),
-- not one more article category — writing one is restricted to admin/
-- super_admin, not delegable to a Publisher the way News/Poetry/Blog are.
CREATE TABLE IF NOT EXISTS committee_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_en text NOT NULL,
  body_ur text NOT NULL,
  release_date date NOT NULL DEFAULT CURRENT_DATE,
  is_published boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE committee_notes ENABLE ROW LEVEL SECURITY;

-- Published notes are readable by anyone (the homepage card); admin/super_admin
-- get everything (including drafts) through the FOR ALL policy below, which
-- covers SELECT too.
CREATE POLICY "committee_notes_public_read" ON committee_notes
  FOR SELECT USING (is_published = true);

CREATE POLICY "committee_notes_write" ON committee_notes FOR ALL TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin'))
  WITH CHECK (current_admin_role() IN ('super_admin', 'admin'));

CREATE INDEX IF NOT EXISTS committee_notes_release_date_idx ON committee_notes (release_date DESC);
