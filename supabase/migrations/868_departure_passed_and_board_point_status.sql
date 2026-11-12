-- Migration 868: real gap confirmed live — normal advance booking
-- (place_ride_booking without GPS coords) has zero awareness of
-- whether today's scheduled departure has already passed; it only
-- checks the date and weekday. The existing "catch a departed ride"
-- system (850) only ever appears once the driver has actually tapped
-- Start (a real route_runs row) — correctly scoped to today, never to
-- a future date, so it was never going to misfire for someone booking
-- a different day. The real missing middle state: today, departure
-- time passed, but no route_run yet (ambiguous — delayed, or the
-- driver forgot to tap Start) had no signal to the rider at all.
--
-- Also confirmed by direct question: on a long (e.g. 24h) route, once
-- the driver DOES start, a rider wanting to board far ahead down the
-- road (still hours from being reached) must NOT be blocked or warned
-- — only a board point the vehicle has ALREADY physically passed
-- should ever be flagged. route_catch_feasibility's own fraction-
-- remaining walk (850) already does exactly this comparison for any
-- lat/lng, not just a rider's live position — reused here for a
-- route STOP (or the route's own origin, for a full-route booking)
-- instead of requiring the rider's own GPS.

DROP FUNCTION IF EXISTS public.route_today_run_status(uuid);

CREATE OR REPLACE FUNCTION route_today_run_status(p_route_id uuid, p_lat numeric DEFAULT NULL, p_lng numeric DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_run route_runs%ROWTYPE;
  v_route vehicle_routes%ROWTYPE;
  v_owner_portal_user_id uuid;
  v_driver_lat numeric; v_driver_lng numeric; v_driver_age_minutes numeric;
  v_ref_lat numeric; v_ref_lng numeric;
  v_point_fraction numeric; v_driver_fraction numeric;
  v_already_passed boolean;
  v_departure_passed boolean := false;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('has_active_run', false); END IF;

  IF v_route.departure_time IS NOT NULL THEN
    v_departure_passed := (v_today + v_route.departure_time) AT TIME ZONE 'Asia/Karachi' < now();
  END IF;

  SELECT * INTO v_run FROM route_runs
    WHERE route_id = p_route_id AND ended_at IS NULL AND (started_at AT TIME ZONE 'Asia/Karachi')::date = v_today
    ORDER BY started_at DESC LIMIT 1;

  IF v_run.id IS NOT NULL THEN
    SELECT v.portal_user_id INTO v_owner_portal_user_id FROM vehicles v WHERE v.id = v_route.vehicle_id;
    SELECT rl.lat, rl.lng, round(extract(epoch FROM (now() - rl.updated_at)) / 60, 1)
      INTO v_driver_lat, v_driver_lng, v_driver_age_minutes
      FROM route_live_locations rl WHERE rl.route_id = p_route_id AND rl.portal_user_id = v_owner_portal_user_id;

    IF v_driver_lat IS NOT NULL AND v_driver_age_minutes IS NOT NULL AND v_driver_age_minutes <= 5 THEN
      v_ref_lat := COALESCE(p_lat, v_route.origin_lat);
      v_ref_lng := COALESCE(p_lng, v_route.origin_lng);
      IF v_ref_lat IS NOT NULL AND v_ref_lng IS NOT NULL THEN
        SELECT fraction_remaining INTO v_point_fraction FROM route_catch_feasibility(p_route_id, v_ref_lat, v_ref_lng);
        SELECT fraction_remaining INTO v_driver_fraction FROM route_catch_feasibility(p_route_id, v_driver_lat, v_driver_lng);
        v_already_passed := v_point_fraction > v_driver_fraction;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'has_active_run', v_run.id IS NOT NULL,
    'started_at', v_run.started_at,
    'minutes_since_departure', CASE WHEN v_run.id IS NOT NULL THEN round(extract(epoch FROM (now() - v_run.started_at)) / 60) ELSE NULL END,
    'seats_available', route_seats_available(p_route_id, v_today),
    'departure_time_passed', v_departure_passed,
    'already_passed', v_already_passed
  );
END;
$$;
REVOKE ALL ON FUNCTION route_today_run_status(uuid, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION route_today_run_status(uuid, numeric, numeric) TO authenticated, anon;
