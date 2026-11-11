-- Migration 850: "catch a departed ride" — a rider whose live GPS
-- position is still physically ahead of a route's vehicle on its own
-- road path can request a seat after the scheduled run has already
-- departed, instead of simply missing it. Builds entirely on the
-- existing route_runs/route_live_locations live-run system (717-734,
-- 817) rather than inventing parallel plumbing — see this session's
-- plan file for the full research trail.
--
-- Design decisions:
-- 1. The catch point is the rider's raw live GPS, not a forced stop
--    pick — "anywhere on that road" per the real ask. place_ride_booking
--    already computes fare from route_fraction_remaining(route_id,
--    stop.lat, stop.lng); it takes the rider's raw point the same way.
-- 2. Eligibility = within a configurable radius of the actual road AND
--    not yet passed by the driver's current live position. Fails
--    closed (no catch allowed) if the driver has no fresh (<5 min,
--    matching nearby_open_trips' existing staleness convention)
--    position on file.
-- 3. route_catch_feasibility is its OWN independent copy of
--    route_fraction_remaining's walk (never touching that heavily-
--    depended-on function) — it additionally returns the nearest-
--    vertex distance that loop already computes internally and
--    discards today.
-- 4. Driver position is never exposed raw to a rider — only
--    eligible/reason/distance_km. check_catch_feasibility requires
--    sign-in; route_today_run_status (the plain public status card)
--    exposes no position data at all, just departed-state + seat count.

ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS is_mid_route_catch boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS ride_booking_catch_locations (
  ride_booking_id uuid PRIMARY KEY REFERENCES ride_bookings(id) ON DELETE CASCADE,
  lat decimal NOT NULL,
  lng decimal NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ride_booking_catch_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ride_booking_catch_locations_read" ON ride_booking_catch_locations FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM ride_bookings rb WHERE rb.id = ride_booking_id AND (rb.portal_user_id = current_portal_user_id() OR is_route_owner(rb.route_id))));
-- No INSERT/UPDATE/DELETE policy — writes only via the SECURITY
-- DEFINER RPCs below, same convention as vehicle_trip_offer_locations.

INSERT INTO site_settings (key, value, description) VALUES
  ('mid_route_catch_radius_km', '1.5', 'How close (km) a rider''s live position must be to a route''s road path to be allowed to catch an already-departed run')
ON CONFLICT (tenant_id, key) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════
-- route_catch_feasibility — independent copy of route_fraction_
-- remaining's (723) walk, additionally returning the nearest-vertex
-- distance it already computes internally. Deliberately not touching
-- or calling route_fraction_remaining itself.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION route_catch_feasibility(p_route_id uuid, p_lat double precision, p_lng double precision)
RETURNS TABLE(fraction_remaining numeric, distance_km numeric)
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
    fraction_remaining := 1; distance_km := NULL; RETURN NEXT; RETURN;
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
    fraction_remaining := 1; distance_km := v_best_dist; RETURN NEXT; RETURN;
  END IF;
  fraction_remaining := greatest(0, least(1, (v_total - v_cum[v_best_idx + 1]) / v_total));
  distance_km := v_best_dist;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION route_catch_feasibility(uuid, double precision, double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION route_catch_feasibility(uuid, double precision, double precision) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- route_today_run_status — plain public status for a route's booking
-- card ("departed 15m ago · 2 seats left"). No position data exposed.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION route_today_run_status(p_route_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_run route_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM route_runs
    WHERE route_id = p_route_id AND ended_at IS NULL AND (started_at AT TIME ZONE 'Asia/Karachi')::date = v_today
    ORDER BY started_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'has_active_run', v_run.id IS NOT NULL,
    'started_at', v_run.started_at,
    'minutes_since_departure', CASE WHEN v_run.id IS NOT NULL THEN round(extract(epoch FROM (now() - v_run.started_at)) / 60) ELSE NULL END,
    'seats_available', route_seats_available(p_route_id, v_today)
  );
END;
$$;
REVOKE ALL ON FUNCTION route_today_run_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION route_today_run_status(uuid) TO authenticated, anon;

-- ═════════════════════════════════════════════════════════════════════
-- check_catch_feasibility — the rider-facing dry-run eligibility check.
-- Requires sign-in; never returns the driver's raw position, only
-- whether THIS rider is close enough and not yet passed.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION check_catch_feasibility(p_route_id uuid, p_lat numeric, p_lng numeric) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_run route_runs%ROWTYPE;
  v_vehicle_id uuid;
  v_owner_portal_user_id uuid;
  v_driver_lat numeric; v_driver_lng numeric; v_driver_age_minutes numeric;
  v_radius_km numeric;
  v_rider_fraction numeric; v_rider_distance_km numeric;
  v_driver_fraction numeric;
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

  SELECT fraction_remaining, distance_km INTO v_rider_fraction, v_rider_distance_km FROM route_catch_feasibility(p_route_id, p_lat, p_lng);
  SELECT fraction_remaining INTO v_driver_fraction FROM route_catch_feasibility(p_route_id, v_driver_lat, v_driver_lng);

  IF v_rider_distance_km > coalesce(v_radius_km, 1.5) THEN
    RETURN jsonb_build_object('eligible', false, 'reason', format('You''re about %s km from this route''s road — too far to catch it.', round(v_rider_distance_km, 1)), 'distance_km', v_rider_distance_km);
  END IF;
  IF v_rider_fraction > v_driver_fraction THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'The vehicle has already passed this point.', 'distance_km', v_rider_distance_km);
  END IF;

  RETURN jsonb_build_object('eligible', true, 'reason', NULL, 'distance_km', v_rider_distance_km);
END;
$$;
REVOKE ALL ON FUNCTION check_catch_feasibility(uuid, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION check_catch_feasibility(uuid, numeric, numeric) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- set_catch_location_sharing / ping_catch_location — mirror set_trip_
-- offer_live_sharing / ping_trip_offer_location (414/415/417) exactly,
-- scoped to one ride_bookings row instead of a vehicle_trip_offers
-- row. ping raises once the booking leaves a shareable state, same
-- "client learns to stop" pattern as the original.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION set_catch_location_sharing(p_booking_id uuid, p_on boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); b ride_bookings%ROWTYPE;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id AND portal_user_id = v_portal_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That is not your booking.' USING ERRCODE = 'P0001'; END IF;
  IF NOT b.is_mid_route_catch THEN RAISE EXCEPTION 'This booking is not a mid-route catch request.' USING ERRCODE = 'P0001'; END IF;

  IF p_on THEN
    IF b.status NOT IN ('announced', 'confirmed') OR b.boarded_at IS NOT NULL THEN
      RAISE EXCEPTION 'This booking can no longer share its position.' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    DELETE FROM ride_booking_catch_locations WHERE ride_booking_id = p_booking_id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION set_catch_location_sharing(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_catch_location_sharing(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION ping_catch_location(p_booking_id uuid, p_lat numeric, p_lng numeric) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); b ride_bookings%ROWTYPE;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id AND portal_user_id = v_portal_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That is not your booking.' USING ERRCODE = 'P0001'; END IF;
  IF NOT b.is_mid_route_catch OR b.status NOT IN ('announced', 'confirmed') OR b.boarded_at IS NOT NULL THEN
    RAISE EXCEPTION 'Live sharing is not active for this booking.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO ride_booking_catch_locations (ride_booking_id, lat, lng, updated_at)
  VALUES (p_booking_id, p_lat, p_lng, now())
  ON CONFLICT (ride_booking_id) DO UPDATE SET lat = p_lat, lng = p_lng, updated_at = now();
END;
$$;
REVOKE ALL ON FUNCTION ping_catch_location(uuid, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ping_catch_location(uuid, numeric, numeric) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- place_ride_booking — gains p_board_lat/p_board_lng (mutually
-- exclusive with p_board_stop_id). Signature grows, so the OLD 8-param
-- overload must be dropped explicitly first — CREATE OR REPLACE cannot
-- change a signature (this is exactly the bug migration 849 just fixed
-- for this same function; see that migration's header before ever
-- touching this function's signature again).
-- ═════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS place_ride_booking(uuid, date, int, varchar, text, uuid, uuid, int[]);

CREATE OR REPLACE FUNCTION place_ride_booking(
  p_route_id uuid, p_travel_date date, p_seats int, p_method varchar, p_proof_url text,
  p_board_stop_id uuid DEFAULT NULL, p_alight_stop_id uuid DEFAULT NULL, p_seat_numbers int[] DEFAULT NULL,
  p_board_lat numeric DEFAULT NULL, p_board_lng numeric DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE;
  v_vehicle vehicles%ROWTYPE;
  v_vehicle_kind varchar;
  v_available int;
  v_total decimal;
  v_per_seat decimal;
  v_seats_booked_so_far int;
  v_booking_id uuid;
  v_weekday int;
  v_commission_pct decimal;
  v_expected_commission decimal;
  v_board_stop route_stops%ROWTYPE;
  v_alight_stop route_stops%ROWTYPE;
  v_segment_fraction numeric := 1;
  v_is_catch boolean := false;
  v_feas jsonb;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND OR NOT v_route.is_active THEN RAISE EXCEPTION 'Route not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  IF v_vehicle.tenant_id != my_tenant_id() AND NOT has_share_agreement(v_vehicle.tenant_id, my_tenant_id(), 'route') THEN
    RAISE EXCEPTION 'This route is not shared with your village yet.' USING ERRCODE = 'P0001';
  END IF;

  IF p_seats IS NULL OR p_seats <= 0 THEN RAISE EXCEPTION 'Pick at least one seat.' USING ERRCODE = 'P0001'; END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
  IF v_route.one_off_date IS NOT NULL AND p_travel_date != v_route.one_off_date THEN
    RAISE EXCEPTION 'This ride only runs once, on %.', to_char(v_route.one_off_date, 'DD Mon YYYY') USING ERRCODE = 'P0001';
  END IF;

  v_weekday := extract(dow FROM p_travel_date)::int;
  IF NOT (v_weekday = ANY(v_route.days_of_week)) THEN
    RAISE EXCEPTION 'This route does not run on that day.' USING ERRCODE = 'P0001';
  END IF;

  v_available := route_seats_available(p_route_id, p_travel_date);
  IF p_seats > v_available THEN
    RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001';
  END IF;

  SELECT vc.vehicle_kind INTO v_vehicle_kind FROM vehicle_categories vc WHERE vc.id = v_vehicle.category_id;
  IF v_vehicle_kind = 'van' THEN
    IF p_seat_numbers IS NULL OR array_length(p_seat_numbers, 1) IS DISTINCT FROM p_seats THEN
      RAISE EXCEPTION 'Pick exactly % seat(s).', p_seats USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_seat_numbers) sn WHERE sn < 1 OR sn > route_effective_seats(p_route_id)) THEN
      RAISE EXCEPTION 'That seat doesn''t exist on this vehicle.' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_seat_numbers IS NOT NULL THEN
    RAISE EXCEPTION 'This vehicle doesn''t use seat numbers.' USING ERRCODE = 'P0001';
  END IF;

  -- 850: a mid-route catch supplies p_board_lat/p_board_lng — the
  -- rider's own raw live position — instead of a route_stops row.
  IF p_board_stop_id IS NOT NULL AND (p_board_lat IS NOT NULL OR p_board_lng IS NOT NULL) THEN
    RAISE EXCEPTION 'Pick either a board stop or a live catch point, not both.' USING ERRCODE = 'P0001';
  END IF;
  v_is_catch := p_board_lat IS NOT NULL AND p_board_lng IS NOT NULL;

  IF v_is_catch THEN
    IF p_alight_stop_id IS NULL THEN
      RAISE EXCEPTION 'Pick where you''re getting off.' USING ERRCODE = 'P0001';
    END IF;
    v_feas := check_catch_feasibility(p_route_id, p_board_lat, p_board_lng);
    IF NOT (v_feas->>'eligible')::boolean THEN
      RAISE EXCEPTION '%', coalesce(v_feas->>'reason', 'You can''t catch this ride right now.') USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_alight_stop FROM route_stops WHERE id = p_alight_stop_id AND route_id = p_route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real alight stop on this route.' USING ERRCODE = 'P0001'; END IF;
    v_segment_fraction := route_fraction_remaining(p_route_id, p_board_lat, p_board_lng) - route_fraction_remaining(p_route_id, v_alight_stop.lat, v_alight_stop.lng);
    IF v_segment_fraction <= 0 THEN RAISE EXCEPTION 'The alight stop must be further along the route than where you''re catching it.' USING ERRCODE = 'P0001'; END IF;
  ELSIF (p_board_stop_id IS NOT NULL) != (p_alight_stop_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Pick both a board and an alight stop, or leave both blank for the full route.' USING ERRCODE = 'P0001';
  ELSIF p_board_stop_id IS NOT NULL THEN
    SELECT * INTO v_board_stop FROM route_stops WHERE id = p_board_stop_id AND route_id = p_route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real board stop on this route.' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO v_alight_stop FROM route_stops WHERE id = p_alight_stop_id AND route_id = p_route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real alight stop on this route.' USING ERRCODE = 'P0001'; END IF;
    v_segment_fraction := route_fraction_remaining(p_route_id, v_board_stop.lat, v_board_stop.lng) - route_fraction_remaining(p_route_id, v_alight_stop.lat, v_alight_stop.lng);
    IF v_segment_fraction <= 0 THEN RAISE EXCEPTION 'The alight stop must be further along the route than the board stop.' USING ERRCODE = 'P0001'; END IF;
  END IF;

  IF v_route.fare_mode = 'flex' THEN
    SELECT COALESCE(SUM(seats), 0) INTO v_seats_booked_so_far FROM ride_bookings
      WHERE route_id = p_route_id AND travel_date = p_travel_date AND status IN ('announced', 'confirmed');
    v_per_seat := v_route.total_fare_pkr / (v_seats_booked_so_far + p_seats);
    v_total := p_seats * v_per_seat;
  ELSE
    v_total := round(p_seats * v_route.fare_per_seat_pkr * v_segment_fraction);
  END IF;

  IF v_vehicle.commission_mode = 'monthly_lumpsum' THEN
    IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  ELSE
    IF NOT v_vehicle.is_active THEN
      RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings — try another one.' USING ERRCODE = 'P0001';
    END IF;
    v_commission_pct := vehicle_commission_pct(v_vehicle.vehicle_type, v_route.classification);
    v_expected_commission := round(v_total * v_commission_pct / 100, 2);
    IF seller_account_balance(ensure_vehicle_account(v_vehicle.id)) < v_expected_commission THEN
      RAISE EXCEPTION 'This vehicle''s wallet balance is too low to cover this booking''s commission — the driver needs to top up first.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO ride_bookings (route_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at, board_stop_id, alight_stop_id, is_mid_route_catch)
  VALUES (p_route_id, v_portal_user_id, p_travel_date, p_seats, v_total, 'announced', v_total, p_method, p_proof_url, now(), p_board_stop_id, p_alight_stop_id, v_is_catch)
  RETURNING id INTO v_booking_id;

  IF p_seat_numbers IS NOT NULL THEN
    BEGIN
      INSERT INTO ride_booking_seat_numbers (ride_booking_id, route_id, travel_date, direction, seat_number)
      SELECT v_booking_id, p_route_id, p_travel_date, 'outbound', sn FROM unnest(p_seat_numbers) sn;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'One of those seats was just taken by someone else — pick again.' USING ERRCODE = 'P0001';
    END;
  END IF;

  IF v_is_catch THEN
    INSERT INTO ride_booking_catch_locations (ride_booking_id, lat, lng) VALUES (v_booking_id, p_board_lat, p_board_lng);
  END IF;

  IF v_vehicle.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_vehicle.portal_user_id,
      CASE WHEN v_is_catch THEN 'route_catch_request' ELSE 'route_seat_booked' END,
      CASE WHEN v_is_catch THEN 'Someone is trying to catch your ride' ELSE 'New seat booked — confirm once paid' END,
      CASE WHEN v_is_catch THEN p_seats || ' seat(s) requested near your current position — view their live location before accepting.'
        ELSE p_seats || ' seat(s) for ' || to_char(p_travel_date, 'DD Mon') || ' — Rs ' || round(v_total) || '. Confirm their seat once they''ve paid you directly, to add them to your ride group.' END,
      '/portal/my-vehicle/routes');
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_portal_user_id, 'ride_booking_pending', 'Seat booked — not confirmed yet',
    'Pay the driver directly to confirm this seat. Until the driver confirms your payment, another paying rider could take it, and you won''t yet see the live map/chat/group for this ride.',
    '/portal/marketplace/trips');

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total, 'is_mid_route_catch', v_is_catch);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION place_ride_booking(uuid, date, int, varchar, text, uuid, uuid, int[], numeric, numeric) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- start_route_run — auto-enables the driver's own live-location
-- sharing (user's confirmed choice). Must upsert, not a bare UPDATE —
-- the driver's route_participants row is otherwise only created
-- lazily by set_route_location_sharing (717), so a first-time driver
-- who never manually toggled sharing would have no row to update.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION start_route_run(p_route_id uuid, p_direction varchar DEFAULT 'outbound') RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_route vehicle_routes%ROWTYPE; v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only start your own route.' USING ERRCODE = 'P0001'; END IF;
  IF p_direction NOT IN ('outbound', 'return') THEN RAISE EXCEPTION 'Invalid direction.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM route_runs WHERE route_id = p_route_id AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'This route already has an active run — end it before starting another.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;

  PERFORM charge_vehicle_ride_stake(v_route.vehicle_id, 'Route run started (' ||
    (CASE WHEN p_direction = 'return' THEN v_route.destination || ' → ' || v_route.origin ELSE v_route.origin || ' → ' || v_route.destination END) || ')');

  INSERT INTO route_runs (route_id, direction) VALUES (p_route_id, p_direction) RETURNING id INTO v_id;

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

-- ═════════════════════════════════════════════════════════════════════
-- Cleanup additions: free the catch-location row the moment a booking
-- leaves a shareable state — same transitions ride_booking_seat_
-- numbers already cleans up on (845/846), one more table.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION board_ride_bookings(p_booking_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; b ride_bookings%ROWTYPE; v_owner_ok boolean;
BEGIN
  FOREACH v_id IN ARRAY p_booking_ids LOOP
    SELECT * INTO b FROM ride_bookings WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF b.status NOT IN ('announced', 'confirmed') OR b.boarded_at IS NOT NULL THEN CONTINUE; END IF;

    IF b.route_id IS NOT NULL THEN
      v_owner_ok := is_route_owner(b.route_id);
    ELSE
      SELECT EXISTS (SELECT 1 FROM adda_queue_entries e JOIN vehicles v ON v.id = e.vehicle_id WHERE e.id = b.adda_queue_entry_id AND v.portal_user_id = current_portal_user_id()) INTO v_owner_ok;
    END IF;
    IF NOT v_owner_ok THEN RAISE EXCEPTION 'You do not manage this booking''s vehicle.' USING ERRCODE = 'P0001'; END IF;

    UPDATE ride_bookings SET boarded_at = now() WHERE id = v_id;
    DELETE FROM ride_booking_catch_locations WHERE ride_booking_id = v_id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (b.portal_user_id, 'rider_boarded', 'You''re on board', 'The driver has marked you as boarded.',
      CASE WHEN b.route_id IS NOT NULL THEN '/portal/marketplace/route/' || b.route_id ELSE '/portal/marketplace/buses' END);
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION board_ride_bookings(uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION decline_ride_booking_seat(p_booking_id uuid, p_reason text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b ride_bookings%ROWTYPE; v_route vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND OR b.route_id IS NULL OR NOT is_route_owner(b.route_id) THEN RAISE EXCEPTION 'You can only manage your own route''s bookings.' USING ERRCODE = 'P0001'; END IF;
  IF b.status != 'announced' THEN RAISE EXCEPTION 'This booking is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;

  UPDATE ride_bookings SET status = 'rejected', rejected_reason = p_reason WHERE id = p_booking_id;
  DELETE FROM ride_booking_seat_numbers WHERE ride_booking_id = p_booking_id;
  DELETE FROM ride_booking_catch_locations WHERE ride_booking_id = p_booking_id;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = b.route_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'ride_booking_rejected', 'Your seat request could not be confirmed',
    'The driver could not confirm your seat for ' || v_route.origin || ' → ' || v_route.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || '.' || COALESCE(' ' || p_reason, '') || ' Your payment was not taken through the app — settle directly with the driver if anything was already paid.',
    '/portal/marketplace/trips');
END;
$$;
GRANT EXECUTE ON FUNCTION decline_ride_booking_seat(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION cancel_ride_booking(p_booking_id uuid, p_reason text) RETURNS jsonb AS $$
DECLARE
  b ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v vehicles%ROWTYPE;
  v_portal_user_id uuid := current_portal_user_id();
  v_is_rider boolean; v_is_driver boolean; v_is_admin boolean;
  v_departure timestamptz;
  v_within_cutoff boolean;
  v_late boolean := false;
  v_reversal_id uuid; v_reversal_no varchar;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status = 'cancelled' THEN RAISE EXCEPTION 'This booking is already cancelled.' USING ERRCODE = 'P0001'; END IF;
  IF b.status = 'rejected' THEN RAISE EXCEPTION 'This booking was already declined.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_routes WHERE id = b.route_id;
  SELECT * INTO v FROM vehicles WHERE id = r.vehicle_id;

  v_is_rider := v_portal_user_id IS NOT NULL AND b.portal_user_id = v_portal_user_id;
  v_is_driver := v.portal_user_id IS NOT NULL AND v.portal_user_id = v_portal_user_id;
  v_is_admin := COALESCE(current_admin_permission('post_transactions'), false);
  IF NOT (v_is_rider OR v_is_driver OR v_is_admin) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  IF v_is_rider AND NOT v_is_driver AND NOT v_is_admin AND b.status = 'confirmed' THEN
    v_departure := (b.travel_date + COALESCE(r.departure_time, '00:00'::time)) AT TIME ZONE 'Asia/Karachi';
    v_within_cutoff := r.departure_time IS NOT NULL AND v_departure - now() < interval '2 hours';
    v_late := v_within_cutoff;
  END IF;

  IF b.status = 'confirmed' AND NOT v_late THEN
    IF b.commission_voucher_id IS NOT NULL THEN
      SELECT id, voucher_no INTO v_reversal_id, v_reversal_no FROM vouchers WHERE id = b.commission_voucher_id;
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name, reverses_voucher_id, reversal_reason)
      SELECT system, voucher_type, (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Reversal of ' || voucher_no || ' — ride booking cancelled: ' || COALESCE(trim(p_reason), 'no reason given'),
        amount_pkr, to_account_id, from_account_id, party_name, id, COALESCE(trim(p_reason), 'Ride booking cancelled')
      FROM vouchers WHERE id = b.commission_voucher_id
      RETURNING id INTO v_reversal_id;
      UPDATE vouchers SET reversed_by_voucher_id = v_reversal_id WHERE id = b.commission_voucher_id;
    END IF;
    IF b.gross_voucher_id IS NOT NULL THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name, reverses_voucher_id, reversal_reason)
      SELECT system, voucher_type, (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Reversal of ' || voucher_no || ' — ride booking cancelled: ' || COALESCE(trim(p_reason), 'no reason given'),
        amount_pkr, to_account_id, from_account_id, party_name, id, COALESCE(trim(p_reason), 'Ride booking cancelled')
      FROM vouchers WHERE id = b.gross_voucher_id
      RETURNING id INTO v_reversal_id;
      UPDATE vouchers SET reversed_by_voucher_id = v_reversal_id WHERE id = b.gross_voucher_id;
    END IF;
  END IF;

  UPDATE ride_bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by_portal_user_id = v_portal_user_id,
    cancellation_reason = trim(p_reason), is_late_cancellation = v_late
  WHERE id = p_booking_id;
  DELETE FROM ride_booking_seat_numbers WHERE ride_booking_id = p_booking_id;
  DELETE FROM ride_booking_catch_locations WHERE ride_booking_id = p_booking_id;

  IF v_is_rider AND NOT v_is_driver THEN
    IF v.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (v.portal_user_id, 'ride_booking_cancelled', 'A rider cancelled',
        'A seat booking for ' || r.origin || ' → ' || r.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || ' was cancelled' || (CASE WHEN v_late THEN ' (late — inside the 2-hour cutoff).' ELSE '.' END), '/my-vehicle');
    END IF;
  ELSE
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (b.portal_user_id, 'ride_booking_cancelled', 'Your booking was cancelled',
      'Your seat booking for ' || r.origin || ' → ' || r.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || ' was cancelled.' || COALESCE(' ' || trim(p_reason), ''), '/accounts');
  END IF;

  RETURN jsonb_build_object('status', 'cancelled', 'was_late', v_late, 'reversed', b.status = 'confirmed' AND NOT v_late);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION cancel_ride_booking(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancel_ride_booking(uuid, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- route_today_ad_hoc_bookings — surfaces catch info so RouteGroupPanel
-- can render a "Trying to catch you" sub-list alongside "Still boarding".
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION route_today_ad_hoc_bookings(p_route_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RETURN '[]'::jsonb; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', rb.id, 'name', pu.full_name, 'seats', rb.seats, 'boarded_at', rb.boarded_at, 'dropped_off_at', rb.dropped_off_at,
      'board_stop_id', rb.board_stop_id, 'seat_accepted_at', rb.seat_accepted_at,
      'is_mid_route_catch', rb.is_mid_route_catch,
      'catch_lat', cl.lat, 'catch_lng', cl.lng, 'catch_updated_at', cl.updated_at
    ) ORDER BY rb.created_at), '[]'::jsonb)
    FROM ride_bookings rb JOIN portal_users pu ON pu.id = rb.portal_user_id
    LEFT JOIN ride_booking_catch_locations cl ON cl.ride_booking_id = rb.id
    WHERE rb.route_id = p_route_id AND rb.travel_date = (now() AT TIME ZONE 'Asia/Karachi')::date
      AND rb.status IN ('announced', 'confirmed') AND rb.direction = 'outbound'
  );
END;
$$;
GRANT EXECUTE ON FUNCTION route_today_ad_hoc_bookings(uuid) TO authenticated;
