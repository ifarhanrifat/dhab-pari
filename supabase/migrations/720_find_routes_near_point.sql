-- Migration 720: "any passenger searching toward a stop — whether the
-- driver has set explicit stops or not — should see every vehicle
-- whose route actually passes near there, with its timing, and book a
-- seat (or see it's already full and not even see it in the list)."
-- Matches on proximity to the route's own real road path (route_path,
-- 717) rather than requiring a driver-confirmed stop to exist first —
-- a rider can discover a route that passes their village even if no
-- one has ever added that exact point as a named stop.

CREATE OR REPLACE FUNCTION find_routes_near_point(p_lat numeric, p_lng numeric, p_max_km numeric DEFAULT 2)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid := coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
  v_result jsonb := '[]'::jsonb;
  v_route record;
  v_point record;
  v_min_dist numeric;
  v_next_date date;
  v_seats int;
  i int;
BEGIN
  FOR v_route IN
    SELECT vr.id, vr.origin, vr.origin_ur, vr.destination, vr.destination_ur,
           vr.fare_mode, vr.fare_per_seat_pkr, vr.total_fare_pkr, vr.departure_time, vr.days_of_week,
           vr.route_path, vr.route_duration_min,
           v.total_seats, v.owner_name, v.vehicle_type, v.vehicle_number
    FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id
    WHERE vr.is_active = true AND vr.tenant_id = v_tenant AND vr.route_path IS NOT NULL
  LOOP
    v_min_dist := NULL;
    FOR v_point IN SELECT (p->>'lat')::decimal AS lat, (p->>'lng')::decimal AS lng FROM jsonb_array_elements(v_route.route_path) p LOOP
      v_min_dist := LEAST(coalesce(v_min_dist, 999999), haversine_km(p_lat, p_lng, v_point.lat, v_point.lng));
    END LOOP;
    CONTINUE WHEN v_min_dist IS NULL OR v_min_dist > p_max_km;

    v_next_date := NULL;
    FOR i IN 0..6 LOOP
      IF extract(dow FROM (current_date + i))::int = ANY(v_route.days_of_week) THEN
        v_next_date := current_date + i;
        EXIT;
      END IF;
    END LOOP;
    CONTINUE WHEN v_next_date IS NULL;

    v_seats := v_route.total_seats - COALESCE((
      SELECT SUM(rb.seats)::int FROM ride_bookings rb WHERE rb.route_id = v_route.id AND rb.travel_date = v_next_date AND rb.status IN ('announced', 'confirmed')
    ), 0);
    -- A fully-booked vehicle never appears in this list at all — not
    -- shown with zero seats, simply absent, per the real ask.
    CONTINUE WHEN v_seats IS NULL OR v_seats <= 0;

    v_result := v_result || jsonb_build_object(
      'route_id', v_route.id, 'origin', v_route.origin, 'origin_ur', v_route.origin_ur,
      'destination', v_route.destination, 'destination_ur', v_route.destination_ur,
      'owner_name', v_route.owner_name, 'vehicle_type', v_route.vehicle_type,
      'fare_mode', v_route.fare_mode, 'fare_per_seat_pkr', v_route.fare_per_seat_pkr, 'total_fare_pkr', v_route.total_fare_pkr,
      'departure_time', v_route.departure_time, 'route_path', v_route.route_path, 'route_duration_min', v_route.route_duration_min,
      'next_date', v_next_date, 'seats_available', v_seats, 'distance_to_point_km', round(v_min_dist, 2)
    );
  END LOOP;
  RETURN v_result;
END;
$$;
GRANT EXECUTE ON FUNCTION find_routes_near_point(numeric, numeric, numeric) TO authenticated;
