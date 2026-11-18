-- Migration 921: real bug caught by direct curl verification right
-- after 920 shipped — haversine_km takes decimal params, but
-- route_stops.lat/lng are double precision, and Postgres does not
-- implicitly cast float8 -> numeric for function-overload resolution
-- (only an explicit/assignment cast exists). Confirmed live:
-- "function haversine_km(double precision, double precision, double
-- precision, double precision) does not exist". Fixes both
-- recompute_route_fare_zones and fleet_route_fare_zones (920) with
-- explicit ::numeric casts — no other line changed.

CREATE OR REPLACE FUNCTION recompute_route_fare_zones(p_route_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_route vehicle_routes%ROWTYPE;
  v_stop record;
  v_prev_lat double precision; v_prev_lng double precision;
  v_cum numeric := 0;
  v_cities jsonb := '[]'::jsonb;
  v_total_km numeric;
  v_a jsonb; v_b jsonb;
  v_fare decimal;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only manage your own route.' USING ERRCODE = 'P0001'; END IF;

  FOR v_stop IN
    SELECT rs.lat, rs.lng, fc.city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id
    WHERE rs.route_id = p_route_id ORDER BY rs.stop_order ASC
  LOOP
    IF v_prev_lat IS NOT NULL THEN
      v_cum := v_cum + haversine_km(v_prev_lat::numeric, v_prev_lng::numeric, v_stop.lat::numeric, v_stop.lng::numeric);
    END IF;
    v_prev_lat := v_stop.lat; v_prev_lng := v_stop.lng;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_cities) e WHERE e->>'city' = v_stop.city) THEN
      v_cities := v_cities || jsonb_build_object('city', v_stop.city, 'km', v_cum);
    END IF;
  END LOOP;

  IF jsonb_array_length(v_cities) < 2 THEN RETURN; END IF;
  v_total_km := (SELECT max((e->>'km')::numeric) FROM jsonb_array_elements(v_cities) e);
  IF v_total_km <= 0 THEN RETURN; END IF;

  FOR v_a IN SELECT * FROM jsonb_array_elements(v_cities) LOOP
    FOR v_b IN SELECT * FROM jsonb_array_elements(v_cities) LOOP
      IF (v_a->>'city') = (v_b->>'city') THEN CONTINUE; END IF;
      v_fare := round(v_route.fare_per_seat_pkr * abs((v_b->>'km')::numeric - (v_a->>'km')::numeric) / v_total_km / 100) * 100;
      INSERT INTO route_fare_zones (route_id, from_city, to_city, fare_pkr, is_auto_calculated)
      VALUES (p_route_id, v_a->>'city', v_b->>'city', v_fare, true)
      ON CONFLICT (route_id, from_city, to_city) DO UPDATE SET fare_pkr = EXCLUDED.fare_pkr, updated_at = now()
        WHERE route_fare_zones.is_auto_calculated = true;
    END LOOP;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION fleet_route_fare_zones(p_route_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_zones jsonb; v_cities jsonb; v_total_km numeric; v_stop record; v_prev_lat double precision; v_prev_lng double precision; v_cum numeric := 0;
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only manage your own route.' USING ERRCODE = 'P0001'; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('from_city', from_city, 'to_city', to_city, 'fare_pkr', fare_pkr, 'is_auto_calculated', is_auto_calculated) ORDER BY from_city, to_city), '[]'::jsonb)
    INTO v_zones FROM route_fare_zones WHERE route_id = p_route_id;

  v_cities := '[]'::jsonb;
  FOR v_stop IN
    SELECT rs.lat, rs.lng, fc.city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id
    WHERE rs.route_id = p_route_id ORDER BY rs.stop_order ASC
  LOOP
    IF v_prev_lat IS NOT NULL THEN v_cum := v_cum + haversine_km(v_prev_lat::numeric, v_prev_lng::numeric, v_stop.lat::numeric, v_stop.lng::numeric); END IF;
    v_prev_lat := v_stop.lat; v_prev_lng := v_stop.lng;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_cities) e WHERE e->>'city' = v_stop.city) THEN
      v_cities := v_cities || jsonb_build_object('city', v_stop.city);
    END IF;
  END LOOP;
  v_total_km := v_cum;

  RETURN jsonb_build_object('zones', v_zones, 'cities', v_cities, 'total_distance_km', round(v_total_km));
END;
$$;
