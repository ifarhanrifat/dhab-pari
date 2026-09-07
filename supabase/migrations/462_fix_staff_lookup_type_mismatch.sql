-- Real bug, caught by testing immediately after 461 shipped: portal_users
-- .full_name/.mobile are character varying, not text — RETURNS TABLE
-- requires an exact type match (or an explicit cast), so both functions
-- failed at call time with "structure of query does not match function
-- result type" despite compiling and pushing without error (same lazy-
-- validation story as the earlier ambiguous-column bugs: PL/pgSQL/SQL
-- functions don't fully typecheck their embedded query against the
-- declared RETURNS TABLE until the query actually runs).
CREATE OR REPLACE FUNCTION find_portal_user_by_mobile(p_mobile text)
RETURNS TABLE (id uuid, full_name text) AS $$
  SELECT id, full_name::text FROM portal_users WHERE mobile = p_mobile AND is_active LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION list_shop_staff(p_shop_id uuid)
RETURNS TABLE (id uuid, portal_user_id uuid, full_name text, mobile text, added_at timestamptz) AS $$
BEGIN
  IF NOT (current_admin_permission('manage_parties') OR user_manages_shop(p_shop_id)) THEN
    RAISE EXCEPTION 'You do not manage this shop.';
  END IF;
  RETURN QUERY
  SELECT st.id, st.portal_user_id, pu.full_name::text, pu.mobile::text, st.added_at
  FROM shop_staff st JOIN portal_users pu ON pu.id = st.portal_user_id
  WHERE st.shop_id = p_shop_id
  ORDER BY st.added_at;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
