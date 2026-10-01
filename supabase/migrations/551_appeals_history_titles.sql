-- Migration 551: surface title_en in appeals_history -- real ask,
-- 2026-10-01, "complete list of already aired... everything like a
-- control room". appeals_history already returns every appeal regardless
-- of origin (Help Requests, Death Announcements, weather, blood, manual
-- ones) since they all land in the same appeals table -- it just never
-- showed anything that actually told them apart (kind='other' for most
-- of them). title_en already distinguishes them cleanly ("Need Help",
-- "Death Announcement", "Weather Alert") since each caller sets its own.
DROP FUNCTION IF EXISTS appeals_history(int);
CREATE OR REPLACE FUNCTION appeals_history(p_limit int DEFAULT 50)
RETURNS TABLE (
  id uuid, kind text, severity text, title_en text, body_ur text, body_en text,
  audience text, is_public boolean, status text,
  starts_at timestamptz, expires_at timestamptz, created_at timestamptz,
  closed_at timestamptz, close_reason text,
  created_by text, closed_by text
) AS $$
  SELECT a.id, a.kind::text, a.severity::text, a.title_en::text, a.body_ur, a.body_en,
         a.audience::text, a.is_public, a.status::text,
         a.starts_at, a.expires_at, a.created_at, a.closed_at, a.close_reason,
         cb.full_name::text, xb.full_name::text
    FROM appeals a
    LEFT JOIN admin_users cb ON cb.id = a.created_by_admin_user_id
    LEFT JOIN admin_users xb ON xb.id = a.closed_by_admin_user_id
   WHERE EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)
   ORDER BY a.created_at DESC
   LIMIT greatest(1, least(coalesce(p_limit, 50), 500));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION appeals_history(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION appeals_history(int) TO authenticated;
