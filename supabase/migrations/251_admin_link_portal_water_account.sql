-- Migration 251: staff-side half of linking a donor's portal login to their
-- water consumer record — the fallback for when signup's own auto-match
-- (by mobile/WhatsApp number) misses, e.g. the connection is registered
-- under a family member's or an older number.
--
-- No admin screen has ever touched portal_users before this — its own RLS
-- (migration 121) only lets a portal user read/update their own row, plus
-- super_admin/admin SELECT. These are SECURITY DEFINER and gate on
-- can_access_system() themselves rather than relying on that RLS, the same
-- way every other cross-table admin action in this codebase works.
--
-- Deliberately no free-text "type the number" field anywhere in this flow —
-- staff pick from search results (real, already-verified rows), never type
-- a phone number by hand, so a mistyped digit can never attach the wrong
-- person's water history to someone else's account.

CREATE OR REPLACE FUNCTION admin_search_portal_users(p_query varchar) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(can_access_system('water_supply'), false) OR COALESCE(can_access_system('donors_projects'), false)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF length(trim(p_query)) < 3 THEN RETURN '[]'::jsonb; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'full_name', full_name, 'mobile', mobile, 'whatsapp_number', whatsapp_number,
    'consumer_id', consumer_id
  ) ORDER BY full_name), '[]'::jsonb) INTO v_result
  FROM portal_users
  WHERE is_active
    AND (full_name ILIKE '%' || p_query || '%' OR mobile ILIKE '%' || p_query || '%' OR whatsapp_number ILIKE '%' || p_query || '%')
  LIMIT 15;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION admin_link_portal_account(p_portal_user_id uuid, p_consumer_id varchar) RETURNS void AS $$
BEGIN
  IF NOT (COALESCE(can_access_system('water_supply'), false) OR COALESCE(can_access_system('donors_projects'), false)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM consumers WHERE consumer_id = p_consumer_id) THEN
    RAISE EXCEPTION 'That consumer account does not exist' USING ERRCODE = 'P0001';
  END IF;
  UPDATE portal_users SET consumer_id = p_consumer_id WHERE id = p_portal_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION admin_unlink_portal_account(p_portal_user_id uuid) RETURNS void AS $$
BEGIN
  IF NOT (COALESCE(can_access_system('water_supply'), false) OR COALESCE(can_access_system('donors_projects'), false)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  UPDATE portal_users SET consumer_id = NULL WHERE id = p_portal_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION admin_search_portal_users(varchar) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION admin_link_portal_account(uuid, varchar) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION admin_unlink_portal_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_search_portal_users(varchar) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_link_portal_account(uuid, varchar) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_unlink_portal_account(uuid) TO authenticated;
