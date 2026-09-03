-- Migration 428: vehicles is admin-write-only RLS (388) — a driver can't
-- UPDATE their own row directly, so "toggle delivery on/off" and "set my
-- per-km rate" (both self-service asks in the handoff spec: "how can the
-- vehicles turn on or off the ordering/delivery option") need a narrow
-- SECURITY DEFINER RPC, same ownership-check shape as
-- vehicle_check_in_city (421), touching only these two columns.
CREATE OR REPLACE FUNCTION set_vehicle_delivery_prefs(p_vehicle_id uuid, p_delivers boolean, p_per_km_pkr decimal DEFAULT NULL)
RETURNS void AS $$
DECLARE v vehicles%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF p_per_km_pkr IS NOT NULL AND p_per_km_pkr < 0 THEN RAISE EXCEPTION 'Rate cannot be negative.' USING ERRCODE = 'P0001'; END IF;

  UPDATE vehicles SET delivers = p_delivers, per_km_pkr = COALESCE(p_per_km_pkr, per_km_pkr) WHERE id = p_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION set_vehicle_delivery_prefs(uuid, boolean, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_vehicle_delivery_prefs(uuid, boolean, decimal) TO authenticated;
