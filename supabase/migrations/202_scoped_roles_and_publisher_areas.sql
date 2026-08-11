-- Migration 202: make system access an explicit setting, give publishers a
-- scope, and stop villagers being able to edit the village news.
--
-- Three things, all in the same area of the model.

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Any logged-in user could write the site's content
-- ═════════════════════════════════════════════════════════════════════════
-- Migration 002 wrote these as:
--
--   CREATE POLICY "admin_all_news" ON news_posts
--     FOR ALL USING (auth.role() = 'authenticated');
--
-- auth.role() is 'authenticated' for EVERY signed-in session, and since
-- migration 121 that includes portal users — the villagers themselves. Any
-- donor or consumer with a login could insert, edit or delete news posts,
-- videos, gallery albums and the homepage ticker. Nothing in the UI offered
-- it, but the API is public and the anon key ships in the browser.
--
-- These are FOR ALL policies, so they governed reads too; the replacements
-- keep public reading open (there are separate public_read_* policies, and the
-- site depends on them) while restricting writes to staff who hold the area.
DROP POLICY IF EXISTS "admin_all_news" ON news_posts;
DROP POLICY IF EXISTS "admin_all_videos" ON video_content;
DROP POLICY IF EXISTS "admin_all_albums" ON gallery_albums;
DROP POLICY IF EXISTS "admin_all_gallery_items" ON gallery_items;
DROP POLICY IF EXISTS "admin_all_ticker" ON news_ticker;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Publisher areas
-- ═════════════════════════════════════════════════════════════════════════
-- One publisher writes the news, another posts poetry and sports, a third
-- keeps the gallery. Each should see their own section and nothing else.
ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS can_publish_news boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_publish_videos boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_publish_gallery boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_publish_ticker boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_publish_jobs boolean NOT NULL DEFAULT false;

-- Nobody loses anything: existing publishers keep every area they could reach
-- before, and it is narrowed deliberately from the Users screen afterwards.
UPDATE admin_users SET
  can_publish_news = true, can_publish_videos = true,
  can_publish_gallery = true, can_publish_ticker = true, can_publish_jobs = true
WHERE role IN ('publisher', 'super_admin', 'admin')
   OR secondary_role IN ('publisher', 'super_admin', 'admin');

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
        ELSE false
      END)
    END
    FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1),
    false
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION current_admin_can_publish(varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION current_admin_can_publish(varchar) TO authenticated;

CREATE POLICY "news_posts_publish" ON news_posts FOR ALL TO authenticated
  USING (current_admin_can_publish('news')) WITH CHECK (current_admin_can_publish('news'));
CREATE POLICY "video_content_publish" ON video_content FOR ALL TO authenticated
  USING (current_admin_can_publish('videos')) WITH CHECK (current_admin_can_publish('videos'));
CREATE POLICY "gallery_albums_publish" ON gallery_albums FOR ALL TO authenticated
  USING (current_admin_can_publish('gallery')) WITH CHECK (current_admin_can_publish('gallery'));
CREATE POLICY "gallery_items_publish" ON gallery_items FOR ALL TO authenticated
  USING (current_admin_can_publish('gallery')) WITH CHECK (current_admin_can_publish('gallery'));
CREATE POLICY "news_ticker_publish" ON news_ticker FOR ALL TO authenticated
  USING (current_admin_can_publish('ticker')) WITH CHECK (current_admin_can_publish('ticker'));

-- The appeal functions write news_ticker rows on behalf of whoever posts an
-- appeal, and they are SECURITY DEFINER, so they are unaffected by the policy
-- above — an appeal does not require the ticker publishing right.

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Which books a user may see becomes an explicit setting
-- ═════════════════════════════════════════════════════════════════════════
-- Until now the system was inferred from the role name, and access_water_supply
-- / access_donors_projects were consulted only for the 'accountant' role. That
-- made "a viewer for the water accounts only" or "a collector for donations
-- only" impossible to express — a viewer always saw both sets of books.
--
-- Role now means what you may DO; these two flags mean which books you may do
-- it in. That is how established accounting packages separate a permission
-- template from company/branch scope, and it makes the answer visible as two
-- checkboxes instead of hidden in a CASE over role names.
--
-- Backfilled from what each role implied before, so no existing user's access
-- changes on the day this runs.
UPDATE admin_users SET access_water_supply = true
 WHERE role IN ('super_admin', 'admin', 'viewer', 'water_accountant')
    OR secondary_role IN ('super_admin', 'admin', 'viewer', 'water_accountant');

UPDATE admin_users SET access_donors_projects = true
 WHERE role IN ('super_admin', 'admin', 'viewer', 'donor_accountant')
    OR secondary_role IN ('super_admin', 'admin', 'viewer', 'donor_accountant');

-- A publisher has no business in either ledger unless somebody ticks it.
UPDATE admin_users SET access_water_supply = false, access_donors_projects = false
 WHERE role = 'publisher'
   AND (secondary_role IS NULL OR secondary_role = 'publisher');

CREATE OR REPLACE FUNCTION role_grants_system(
  p_role varchar,
  p_secondary_role varchar,
  p_access_water boolean,
  p_access_donors boolean,
  p_system varchar
) RETURNS boolean AS $$
  SELECT CASE
    -- Full administrators are not scoped; scoping them would lock the only
    -- people who can fix a scoping mistake out of fixing it.
    WHEN p_role IN ('super_admin', 'admin')
      OR p_secondary_role IN ('super_admin', 'admin') THEN true
    ELSE (p_system = 'water_supply'    AND COALESCE(p_access_water, false))
      OR (p_system = 'donors_projects' AND COALESCE(p_access_donors, false))
  END;
$$ LANGUAGE sql IMMUTABLE;

GRANT EXECUTE ON FUNCTION role_grants_system(varchar, varchar, boolean, boolean, varchar) TO authenticated;

CREATE OR REPLACE FUNCTION can_access_system(p_system varchar) RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT role_grants_system(role, secondary_role, access_water_supply, access_donors_projects, p_system)
       FROM admin_users
      WHERE auth_user_id = auth.uid() AND is_active = true
      LIMIT 1),
    false
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Lets an administrator answer "what can this user reach?" without logging in
-- as them, which is how the secondary-viewer fault stayed hidden.
--
-- Dropped first: migration 201 created this with five columns and it gains the
-- publishing flags here. CREATE OR REPLACE cannot change a RETURNS TABLE row
-- type (42P13) — the same trap that failed migration 199.
DROP FUNCTION IF EXISTS system_access_for(uuid);

CREATE OR REPLACE FUNCTION system_access_for(p_admin_user_id uuid)
RETURNS TABLE (full_name text, role text, secondary_role text,
               can_water boolean, can_donors boolean,
               publish_news boolean, publish_videos boolean, publish_gallery boolean,
               publish_ticker boolean, publish_jobs boolean) AS $$
  SELECT u.full_name::text, u.role::text, u.secondary_role::text,
         role_grants_system(u.role, u.secondary_role, u.access_water_supply, u.access_donors_projects, 'water_supply'),
         role_grants_system(u.role, u.secondary_role, u.access_water_supply, u.access_donors_projects, 'donors_projects'),
         u.can_publish_news, u.can_publish_videos, u.can_publish_gallery,
         u.can_publish_ticker, u.can_publish_jobs
    FROM admin_users u
   WHERE u.id = p_admin_user_id
     AND EXISTS (SELECT 1 FROM admin_users a
                  WHERE a.auth_user_id = auth.uid() AND a.is_active = true
                    AND a.role IN ('super_admin', 'admin'));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION system_access_for(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION system_access_for(uuid) TO authenticated;
