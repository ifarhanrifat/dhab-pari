-- Migration 859: two real bugs caught during end-to-end QA testing.
--
-- 1. check_catch_feasibility (850) only checked (a) close to the road,
--    (b) not yet passed — but "not yet passed" alone lets a rider
--    standing at the route's own DESTINATION, hundreds of km ahead of
--    the driver's actual current position, be marked "eligible" (the
--    destination's fraction_remaining is always 0, which is always
--    <= any driver fraction > 0, satisfying the old check trivially).
--    route_catch_feasibility now also returns the route's total
--    distance (it already computed this internally and discarded it,
--    same pattern as the original distance-discarding this function
--    was built to fix); check_catch_feasibility converts the fraction
--    gap to a real km-ahead figure and rejects anything beyond a
--    second, separate configurable radius — "close to the road" and
--    "actually near the bus right now" are two different distances,
--    both needed.
--
-- 2. run_route_proximity_alerts (857) called haversine_km(numeric,
--    numeric, double precision, double precision) — route_stops.lat/
--    lng are double precision, but haversine_km's signature is all
--    decimal — Postgres has no implicit cast across that combination
--    positionally and the whole sweep errored on every invocation.
--    Explicit ::decimal casts fix it; this was live-broken since 857
--    shipped (the cron job would have failed silently every 2 minutes
--    with nothing surfacing the error anywhere).

-- Row shape grew from (fraction_remaining, distance_km) to a third
-- column — CREATE OR REPLACE cannot change a function's OUT-parameter
-- row type, confirmed live (SQLSTATE 42P13) when this migration was
-- first applied without the drop; same class of lesson as 849's
-- overload-ambiguity fix, different specific error.
DROP FUNCTION IF EXISTS route_catch_feasibility(uuid, double precision, double precision);

CREATE OR REPLACE FUNCTION route_catch_feasibility(p_route_id uuid, p_lat double precision, p_lng double precision)
RETURNS TABLE(fraction_remaining numeric, distance_km numeric, total_km numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_path jsonb;
  v_point record;
  v_prev record;
  v_cum numeric[] := ARRAY[0];
  v_total numeric;
  v_best_idx int := 0;
  v_best_dist numeric := 999999;
  v_idx int := 0;
  v_dist numeric;
BEGIN
  SELECT route_path INTO v_path FROM vehicle_routes WHERE id = p_route_id;
  IF v_path IS NULL OR jsonb_array_length(v_path) < 2 THEN
    fraction_remaining := 1; distance_km := NULL; total_km := NULL; RETURN NEXT; RETURN;
  END IF;

  v_prev := NULL;
  FOR v_point IN SELECT (p->>'lat')::decimal AS lat, (p->>'lng')::decimal AS lng FROM jsonb_array_elements(v_path) p LOOP
    IF v_prev IS NOT NULL THEN
      v_cum := array_append(v_cum, v_cum[array_length(v_cum, 1)] + haversine_km(v_prev.lat, v_prev.lng, v_point.lat, v_point.lng));
    END IF;
    v_dist := haversine_km(p_lat::decimal, p_lng::decimal, v_point.lat, v_point.lng);
    IF v_dist < v_best_dist THEN v_best_dist := v_dist; v_best_idx := v_idx; END IF;
    v_prev := v_point;
    v_idx := v_idx + 1;
  END LOOP;

  v_total := v_cum[array_length(v_cum, 1)];
  IF v_total <= 0 THEN
    fraction_remaining := 1; distance_km := v_best_dist; total_km := v_total; RETURN NEXT; RETURN;
  END IF;
  fraction_remaining := greatest(0, least(1, (v_total - v_cum[v_best_idx + 1]) / v_total));
  distance_km := v_best_dist;
  total_km := v_total;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION route_catch_feasibility(uuid, double precision, double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION route_catch_feasibility(uuid, double precision, double precision) TO authenticated;

INSERT INTO site_settings (key, value, description) VALUES
  ('mid_route_catch_max_ahead_km', '25', 'How far ahead (km, along the route) of the vehicle''s current position a rider may still be to catch an already-departed run')
ON CONFLICT (tenant_id, key) DO NOTHING;

CREATE OR REPLACE FUNCTION check_catch_feasibility(p_route_id uuid, p_lat numeric, p_lng numeric) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_run route_runs%ROWTYPE;
  v_vehicle_id uuid;
  v_owner_portal_user_id uuid;
  v_driver_lat numeric; v_driver_lng numeric; v_driver_age_minutes numeric;
  v_radius_km numeric; v_max_ahead_km numeric;
  v_rider_fraction numeric; v_rider_distance_km numeric; v_rider_total_km numeric;
  v_driver_fraction numeric;
  v_km_ahead numeric;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_run FROM route_runs
    WHERE route_id = p_route_id AND ended_at IS NULL AND (started_at AT TIME ZONE 'Asia/Karachi')::date = v_today
    ORDER BY started_at DESC LIMIT 1;
  IF v_run.id IS NULL THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'This ride has not departed yet — book it normally.');
  END IF;

  SELECT vr.vehicle_id INTO v_vehicle_id FROM vehicle_routes vr WHERE vr.id = p_route_id;
  SELECT v.portal_user_id INTO v_owner_portal_user_id FROM vehicles v WHERE v.id = v_vehicle_id;

  SELECT rl.lat, rl.lng, round(extract(epoch FROM (now() - rl.updated_at)) / 60, 1)
    INTO v_driver_lat, v_driver_lng, v_driver_age_minutes
    FROM route_live_locations rl WHERE rl.route_id = p_route_id AND rl.portal_user_id = v_owner_portal_user_id;

  IF v_driver_lat IS NULL OR v_driver_age_minutes IS NULL OR v_driver_age_minutes > 5 THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'The driver''s live position isn''t available right now — try again in a moment.');
  END IF;

  SELECT COALESCE(value::numeric, 1.5) INTO v_radius_km FROM site_settings WHERE key = 'mid_route_catch_radius_km' LIMIT 1;
  SELECT COALESCE(value::numeric, 25) INTO v_max_ahead_km FROM site_settings WHERE key = 'mid_route_catch_max_ahead_km' LIMIT 1;

  SELECT fraction_remaining, distance_km, total_km INTO v_rider_fraction, v_rider_distance_km, v_rider_total_km FROM route_catch_feasibility(p_route_id, p_lat, p_lng);
  SELECT fraction_remaining INTO v_driver_fraction FROM route_catch_feasibility(p_route_id, v_driver_lat, v_driver_lng);

  IF v_rider_distance_km > coalesce(v_radius_km, 1.5) THEN
    RETURN jsonb_build_object('eligible', false, 'reason', format('You''re about %s km from this route''s road — too far to catch it.', round(v_rider_distance_km, 1)), 'distance_km', v_rider_distance_km);
  END IF;
  IF v_rider_fraction > v_driver_fraction THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'The vehicle has already passed this point.', 'distance_km', v_rider_distance_km);
  END IF;

  -- 859: "not yet passed" alone isn't enough — the destination (or any
  -- point still far ahead) always satisfies that trivially. Reject
  -- anything beyond a realistic catch-up distance along the route.
  v_km_ahead := (v_driver_fraction - v_rider_fraction) * coalesce(v_rider_total_km, 0);
  IF v_rider_total_km IS NOT NULL AND v_km_ahead > v_max_ahead_km THEN
    RETURN jsonb_build_object('eligible', false, 'reason', format('That''s about %s km further along the route — too far ahead for this bus to reach you soon.', round(v_km_ahead, 1)), 'distance_km', v_rider_distance_km);
  END IF;

  RETURN jsonb_build_object('eligible', true, 'reason', NULL, 'distance_km', v_rider_distance_km);
END;
$$;
REVOKE ALL ON FUNCTION check_catch_feasibility(uuid, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION check_catch_feasibility(uuid, numeric, numeric) TO authenticated;

-- run_route_proximity_alerts — explicit ::decimal casts so the mixed
-- numeric/double precision call to haversine_km actually resolves.
CREATE OR REPLACE FUNCTION run_route_proximity_alerts() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_threshold_km numeric;
  r record; stop record;
  v_owner_portal_user_id uuid;
  v_driver_lat numeric; v_driver_lng numeric; v_driver_age_minutes numeric;
  v_dist numeric;
BEGIN
  SELECT COALESCE(value::numeric, 2) INTO v_threshold_km FROM site_settings WHERE key = 'route_proximity_alert_km' LIMIT 1;

  FOR r IN
    SELECT run.id AS run_id, vr.id AS route_id, vr.vehicle_id, vr.origin, vr.destination, vr.tenant_id
    FROM route_runs run JOIN vehicle_routes vr ON vr.id = run.route_id
    WHERE run.ended_at IS NULL
  LOOP
    SELECT v.portal_user_id INTO v_owner_portal_user_id FROM vehicles v WHERE v.id = r.vehicle_id;
    IF v_owner_portal_user_id IS NULL THEN CONTINUE; END IF;

    SELECT rl.lat, rl.lng, round(extract(epoch FROM (now() - rl.updated_at)) / 60, 1)
      INTO v_driver_lat, v_driver_lng, v_driver_age_minutes
      FROM route_live_locations rl WHERE rl.route_id = r.route_id AND rl.portal_user_id = v_owner_portal_user_id;
    IF v_driver_lat IS NULL OR v_driver_age_minutes IS NULL OR v_driver_age_minutes > 5 THEN CONTINUE; END IF;

    FOR stop IN SELECT s.id, s.label, s.lat::decimal AS lat, s.lng::decimal AS lng FROM route_stops s WHERE s.route_id = r.route_id AND s.stop_order > 0
    LOOP
      v_dist := haversine_km(v_driver_lat, v_driver_lng, stop.lat, stop.lng);

      IF v_dist <= v_threshold_km AND NOT EXISTS (SELECT 1 FROM route_stop_proximity_alerts_sent a WHERE a.run_id = r.run_id AND a.stop_id = stop.id) THEN
        INSERT INTO route_stop_proximity_alerts_sent (run_id, stop_id) VALUES (r.run_id, stop.id);

        INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
        SELECT rb.portal_user_id, 'route_bus_approaching', 'Your bus is approaching',
          'The vehicle for ' || r.origin || ' → ' || r.destination || ' is about ' || round(v_dist, 1) || ' km from ' || stop.label || ' — be ready.',
          '/portal/marketplace/route/' || r.route_id, r.tenant_id
        FROM ride_bookings rb
        WHERE rb.route_id = r.route_id AND rb.board_stop_id = stop.id
          AND rb.travel_date = (now() AT TIME ZONE 'Asia/Karachi')::date AND rb.status IN ('announced', 'confirmed');

        INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
        SELECT rs.portal_user_id, 'route_bus_approaching', 'Your bus is approaching',
          'The vehicle for ' || r.origin || ' → ' || r.destination || ' is about ' || round(v_dist, 1) || ' km from ' || stop.label || ' — be ready.',
          '/portal/marketplace/route/' || r.route_id, r.tenant_id
        FROM route_subscriptions rs
        WHERE rs.route_id = r.route_id AND rs.board_stop_id = stop.id AND rs.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM route_subscription_leave_days ld WHERE ld.subscription_id = rs.id AND ld.leave_date = (now() AT TIME ZONE 'Asia/Karachi')::date);
      END IF;
    END LOOP;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION run_route_proximity_alerts() FROM PUBLIC, anon, authenticated;
