-- Real correctness fix, not just a UI change: set_vehicle_delivery_prefs
-- (428) let a driver set their own per_km_pkr — the personal-shopping/
-- errand delivery rate. Every other rate in this system (hourly,
-- shadi, route fares) is committee-set; per-km was the one exception,
-- and the committee wants it closed — a driver could otherwise price
-- themselves however they liked for exactly the flow the admin's own
-- vehicle form already has a rate field for. The toggle (delivers
-- on/off) stays self-service; only the rate itself moves to admin-only.
CREATE OR REPLACE FUNCTION set_vehicle_delivery_prefs(p_vehicle_id uuid, p_delivers boolean, p_per_km_pkr decimal DEFAULT NULL)
RETURNS void AS $$
DECLARE v vehicles%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF p_per_km_pkr IS NOT NULL THEN
    IF NOT v_is_admin THEN RAISE EXCEPTION 'Only the committee can set the per-km rate.' USING ERRCODE = 'P0001'; END IF;
    IF p_per_km_pkr < 0 THEN RAISE EXCEPTION 'Rate cannot be negative.' USING ERRCODE = 'P0001'; END IF;
  END IF;

  UPDATE vehicles SET delivers = p_delivers, per_km_pkr = COALESCE(p_per_km_pkr, per_km_pkr) WHERE id = p_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION set_vehicle_delivery_prefs(uuid, boolean, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_vehicle_delivery_prefs(uuid, boolean, decimal) TO authenticated;

-- Self-service toggles for the two admin-set-once, driver-toggled-after
-- capability flags (night bookings, out-of-city trips) — both already
-- existed as columns (416, 429) and were admin-only; a driver couldn't
-- turn either on/off themselves even after the committee cleared them
-- for it, matching the exact pattern set_vehicle_delivery_prefs already
-- uses for `delivers`.
CREATE OR REPLACE FUNCTION set_vehicle_capability_prefs(p_vehicle_id uuid, p_night_booking_enabled boolean, p_allows_out_of_city boolean)
RETURNS void AS $$
DECLARE v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND OR v.portal_user_id IS DISTINCT FROM current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE vehicles SET night_booking_enabled = p_night_booking_enabled, allows_out_of_city = p_allows_out_of_city WHERE id = p_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION set_vehicle_capability_prefs(uuid, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_vehicle_capability_prefs(uuid, boolean, boolean) TO authenticated;
