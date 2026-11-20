-- 2026-11-20: real bug caught by direct curl verification of 929's
-- driver_check_in — a check-in from Karachi coordinates (1,135 km from
-- the assigned Rawalpindi terminal) was ACCEPTED instead of rejected.
-- Root cause: `SELECT COALESCE(value::numeric, 0.5) INTO v_radius_km
-- FROM site_settings WHERE key = ...` only guards a NULL *value column*
-- on a matching row — when zero rows match (no config row exists for
-- this brand-new key at all), the SELECT returns no rows and INTO
-- leaves v_radius_km at its prior value, NULL, so `v_distance_km >
-- v_radius_km` is NULL (not true) and the whole check silently never
-- fires. The existing copies of this pattern (859's mid_route_catch_
-- radius_km/route_proximity_alert_km) only happened to be safe because
-- those config rows already exist in site_settings — not because the
-- pattern itself is correct. Fixed here with a scalar-subquery COALESCE,
-- which evaluates to the default even when the subquery returns zero
-- rows; also seeds the actual config row so the behavior is explicit.
CREATE OR REPLACE FUNCTION driver_check_in(p_lat numeric, p_lng numeric) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fs fleet_staff%ROWTYPE; v_counter fleet_counters%ROWTYPE; v_distance_km numeric; v_radius_km numeric; v_id uuid;
BEGIN
  IF p_lat IS NULL OR p_lng IS NULL THEN RAISE EXCEPTION 'Location is required to check in.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_fs FROM fleet_staff WHERE portal_user_id = current_portal_user_id() AND counter_id IS NOT NULL LIMIT 1;
  IF v_fs.id IS NULL THEN
    RAISE EXCEPTION 'You have no assigned terminal yet — ask your fleet owner to assign one.' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM driver_attendance_log WHERE fleet_staff_id = v_fs.id AND check_out_at IS NULL) THEN
    RAISE EXCEPTION 'You are already checked in — check out first.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_counter FROM fleet_counters WHERE id = v_fs.counter_id;
  IF v_counter.lat IS NULL OR v_counter.lng IS NULL THEN
    RAISE EXCEPTION 'Your terminal has no stored location yet — ask your fleet owner to set it.' USING ERRCODE = 'P0001';
  END IF;

  v_distance_km := haversine_km(p_lat, p_lng, v_counter.lat, v_counter.lng);
  v_radius_km := COALESCE((SELECT value::numeric FROM site_settings WHERE key = 'driver_checkin_radius_km' LIMIT 1), 0.5);

  IF v_distance_km > v_radius_km THEN
    RAISE EXCEPTION 'You are %.2f km from % — move within %.1f km to check in.', v_distance_km, v_counter.city, v_radius_km USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO driver_attendance_log (fleet_staff_id, counter_id, check_in_lat, check_in_lng, distance_km_at_checkin)
  VALUES (v_fs.id, v_counter.id, p_lat, p_lng, v_distance_km)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'counter_city', v_counter.city, 'counter_name', v_counter.name, 'distance_km', v_distance_km);
END;
$$;
REVOKE ALL ON FUNCTION driver_check_in(numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION driver_check_in(numeric, numeric) TO authenticated;

-- No seed row inserted: site_settings is tenant-scoped (566,
-- UNIQUE(tenant_id, key)) and this fleet's tenant_id isn't something
-- to guess at from a migration. The scalar-subquery COALESCE above is
-- already correct with zero rows present — an owner can still add a
-- per-tenant override later the same way other site_settings keys do.
