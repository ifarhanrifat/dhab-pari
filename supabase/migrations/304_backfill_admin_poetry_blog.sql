-- Migration 304: super_admin/admin never got can_publish_poetry/
-- can_publish_blog set true, unlike every other publish area (migration 202
-- backfilled News/Videos/Gallery/Ticker/Jobs true for them, on the reasoning
-- "Administrators are given every area by the migration, so nothing changes
-- for them"). RLS itself was never affected — current_admin_can_publish()'s
-- role check bypasses the column read entirely for super_admin/admin — but
-- AdminSidebar's client-side nav-visibility check reads the raw column
-- directly, so Poetry/Blog silently vanished from the menu for every admin,
-- caught live while verifying the feature. Publishers are deliberately left
-- alone here — that would defeat the entire point of splitting these two
-- out as their own grant.
UPDATE admin_users SET can_publish_poetry = true, can_publish_blog = true
 WHERE role IN ('super_admin', 'admin')
    OR secondary_role IN ('super_admin', 'admin');
