-- Migration 955: real bug found live, 2026-11-25, setting up a fresh
-- fleet bus service and testing the mid-route "catch" flow end to end —
-- check_catch_feasibility (850/859) resolves "the driver's live
-- location" via vehicles.portal_user_id, which is the vehicle's
-- registered owner. For a solo-owner vehicle that's always the same
-- person who's actually driving, so this never surfaced before — but
-- for a fleet-owned vehicle (vehicles.portal_user_id is simply whoever
-- registered it in the fleet, often the fleet owner, who is never
-- physically on the bus), it's the wrong id entirely: the real driver's
-- ping lands under THEIR OWN portal_user_id, which never matches, so
-- every catch request for a fleet route failed with "the driver's live
-- position isn't available," regardless of how fresh the real ping was.
--
-- Root cause traced one level deeper: start_route_run (719/724/734/850/
-- 879/882) seeds route_run_driver_shifts — the table the driver-shuffle
-- mechanism (879) already built specifically to track "who is actually
-- driving this run right now," handover and all — with
-- v_vehicle.portal_user_id instead of the real caller
-- (current_portal_user_id()), the same solo-owner assumption at its
-- source. True-replacing both: start_route_run now seeds the shift with
-- whoever actually started the run (identical result for a solo vehicle,
-- where those two ids were always the same person anyway), and
-- check_catch_feasibility now resolves the driver's live location
-- through that same shift record instead of the vehicle's registered
-- owner — correct for solo vehicles, fleet-owned vehicles, and a
-- mid-route substitute driver after a shuffle, all three through the
-- one mechanism already built for exactly this.

CREATE OR REPLACE FUNCTION start_route_run(p_route_id uuid, p_direction varchar DEFAULT 'outbound') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE; v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only start your own route.' USING ERRCODE = 'P0001'; END IF;
  IF p_direction NOT IN ('outbound', 'return') THEN RAISE EXCEPTION 'Invalid direction.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM route_runs WHERE route_id = p_route_id AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'This route already has an active run — end it before starting another.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  IF EXISTS (SELECT 1 FROM hourly_bookings WHERE vehicle_id = v_vehicle.id AND status = 'in_progress') THEN
    RAISE EXCEPTION 'This vehicle is currently out on an hourly rental — finish that trip before starting a scheduled run.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM rental_bookings WHERE vehicle_id = v_vehicle.id AND status = 'in_progress') THEN
    RAISE EXCEPTION 'This vehicle is currently out on a rental trip — finish that trip before starting a scheduled run.' USING ERRCODE = 'P0001';
  END IF;

  PERFORM charge_vehicle_ride_stake(v_route.vehicle_id, 'Route run started (' ||
    (CASE WHEN p_direction = 'return' THEN v_route.destination || ' → ' || v_route.origin ELSE v_route.origin || ' → ' || v_route.destination END) || ')');

  INSERT INTO route_runs (route_id, direction) VALUES (p_route_id, p_direction) RETURNING id INTO v_id;

  -- Whoever actually started the run is the real driver for this shift —
  -- identical to v_vehicle.portal_user_id for a solo-owner vehicle
  -- (same person either way), correct for a fleet vehicle too (where
  -- the vehicle's own portal_user_id is just whoever registered it).
  INSERT INTO route_run_driver_shifts (route_run_id, driver_portal_user_id) VALUES (v_id, v_portal_user_id);

  INSERT INTO route_participants (route_id, portal_user_id, is_active, sharing_location)
  VALUES (p_route_id, v_portal_user_id, true, true)
  ON CONFLICT (route_id, portal_user_id) DO UPDATE SET sharing_location = true, is_active = true;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT rp.portal_user_id, 'route_run_started', 'The van is on its way',
    (CASE WHEN p_direction = 'return' THEN v_route.destination || ' → ' || v_route.origin ELSE v_route.origin || ' → ' || v_route.destination END) || ' — live arrival times are now showing.',
    '/portal/marketplace/route/' || p_route_id
  FROM route_participants rp WHERE rp.route_id = p_route_id AND rp.is_active = true;

  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION start_route_run(uuid, varchar) TO authenticated;

CREATE OR REPLACE FUNCTION check_catch_feasibility(p_route_id uuid, p_lat numeric, p_lng numeric) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_run route_runs%ROWTYPE;
  v_driver_portal_user_id uuid;
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

  -- The real current driver for this run — the same route_run_driver_
  -- shifts record the shuffle/handover mechanism (879) already keeps
  -- current, rather than the vehicle's registered portal_user_id (which
  -- is the fleet owner, not the driver, for any fleet-owned vehicle).
  SELECT sh.driver_portal_user_id INTO v_driver_portal_user_id
    FROM route_run_driver_shifts sh WHERE sh.route_run_id = v_run.id AND sh.ended_at IS NULL LIMIT 1;

  SELECT rl.lat, rl.lng, round(extract(epoch FROM (now() - rl.updated_at)) / 60, 1)
    INTO v_driver_lat, v_driver_lng, v_driver_age_minutes
    FROM route_live_locations rl WHERE rl.route_id = p_route_id AND rl.portal_user_id = v_driver_portal_user_id;

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

  v_km_ahead := (v_driver_fraction - v_rider_fraction) * coalesce(v_rider_total_km, 0);
  IF v_rider_total_km IS NOT NULL AND v_km_ahead > v_max_ahead_km THEN
    RETURN jsonb_build_object('eligible', false, 'reason', format('That''s about %s km further along the route — too far ahead for this bus to reach you soon.', round(v_km_ahead, 1)), 'distance_km', v_rider_distance_km);
  END IF;

  RETURN jsonb_build_object('eligible', true, 'reason', NULL, 'distance_km', v_rider_distance_km);
END;
$$;
GRANT EXECUTE ON FUNCTION check_catch_feasibility(uuid, numeric, numeric) TO authenticated;
