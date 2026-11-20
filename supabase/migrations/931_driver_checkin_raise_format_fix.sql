-- 2026-11-20: real bug caught by direct curl verification of 930's fix —
-- the rejection message read "You are 1135.63155154221.2f km from
-- Rawalpindi — move within 0.5.1f km to check in." plpgsql's RAISE only
-- supports a bare % as a positional placeholder (no printf-style width/
-- precision specifiers like %.2f) — each % consumed one argument and
-- the literal ".2f"/".1f" text was left dangling. Fixed by rounding the
-- numbers in SQL first and using plain % placeholders.
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
    RAISE EXCEPTION 'You are % km from % — move within % km to check in.', round(v_distance_km, 2), v_counter.city, round(v_radius_km, 1) USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO driver_attendance_log (fleet_staff_id, counter_id, check_in_lat, check_in_lng, distance_km_at_checkin)
  VALUES (v_fs.id, v_counter.id, p_lat, p_lng, v_distance_km)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'counter_city', v_counter.city, 'counter_name', v_counter.name, 'distance_km', v_distance_km);
END;
$$;
REVOKE ALL ON FUNCTION driver_check_in(numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION driver_check_in(numeric, numeric) TO authenticated;
