-- Two small lookups the "Manage Staff" screen needs, both SECURITY
-- DEFINER because portal_users' own RLS (portal_users_read_own) only
-- ever lets someone read their OWN row — a shopkeeper adding a second
-- account by mobile number, or just listing who's already on their
-- staff, would otherwise see nothing at all for anyone but themselves.
-- Both expose the minimum needed (name + mobile), nothing else off the
-- portal_users row.

-- Exact-mobile lookup only (portal_users.mobile is UNIQUE) — not a
-- fuzzy search, so this can't be used to browse/enumerate accounts,
-- only to confirm "is this the right person" before adding them.
CREATE OR REPLACE FUNCTION find_portal_user_by_mobile(p_mobile text)
RETURNS TABLE (id uuid, full_name text) AS $$
  SELECT id, full_name FROM portal_users WHERE mobile = p_mobile AND is_active LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION find_portal_user_by_mobile(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION find_portal_user_by_mobile(text) TO authenticated;

CREATE OR REPLACE FUNCTION list_shop_staff(p_shop_id uuid)
RETURNS TABLE (id uuid, portal_user_id uuid, full_name text, mobile text, added_at timestamptz) AS $$
BEGIN
  IF NOT (current_admin_permission('manage_parties') OR user_manages_shop(p_shop_id)) THEN
    RAISE EXCEPTION 'You do not manage this shop.';
  END IF;
  RETURN QUERY
  SELECT st.id, st.portal_user_id, pu.full_name, pu.mobile, st.added_at
  FROM shop_staff st JOIN portal_users pu ON pu.id = st.portal_user_id
  WHERE st.shop_id = p_shop_id
  ORDER BY st.added_at;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION list_shop_staff(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION list_shop_staff(uuid) TO authenticated;
