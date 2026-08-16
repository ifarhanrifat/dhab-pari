-- Migration 252: the other half of migration 251's search — given a
-- consumer_id, who (if anyone) is currently linked to it. A direct client
-- read of portal_users would be blocked by its own RLS for anyone who isn't
-- super_admin/admin (migration 121), so the account page needs this the
-- same way it needs admin_search_portal_users().
CREATE OR REPLACE FUNCTION admin_portal_user_for_consumer(p_consumer_id varchar) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(can_access_system('water_supply'), false) OR COALESCE(can_access_system('donors_projects'), false)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT jsonb_build_object('id', id, 'full_name', full_name, 'mobile', mobile) INTO v_result
  FROM portal_users WHERE consumer_id = p_consumer_id AND is_active LIMIT 1;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION admin_portal_user_for_consumer(varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_portal_user_for_consumer(varchar) TO authenticated;
