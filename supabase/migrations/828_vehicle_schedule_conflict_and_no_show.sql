-- Migration 828: real ask, 2026-11-07 — "during the route time which if
-- one driver already have the route fixed, then during these timing he
-- will never add new route... if he has created another route after
-- this timing and before of that old route starting time then he can
-- create that fix route." One vehicle is one physical resource — this
-- adds the "is this vehicle already committed during this window?"
-- check modern commute/van-pooling apps have and this one never did.
-- create_vehicle_route_self already blocked a SECOND simultaneous
-- active route on one vehicle outright (any time), which stays
-- unchanged; the real hole was that a one-off Trip Offer (shared ride)
-- never checked against a vehicle's own permanent route schedule at
-- all, and vice versa — nothing stopped a driver running a 6:30am
-- daily route from also posting an unrelated 7am trip to another city
-- on the same vehicle.
--
-- Scope, deliberately kept simple: a time-of-day window check against
-- each ACTIVE route's own scheduled (not live) departure/return times,
-- for any day the two schedules actually share — not a live-run
-- auto-restriction. A vehicle that has already arrived at its
-- destination and is sitting through its return-wait window is
-- untouched by this (it was never blocked from hourly/rental/local
-- bookings in the first place — those functions aren't touched here at
-- all), so "he can get calls for booking inside the city" during that
-- wait already just works. No handling for a schedule crossing
-- midnight — every real route in this app runs same-day daytime, so
-- that's a reasonable simplification, not an oversight.

CREATE OR REPLACE FUNCTION route_busy_window(p_departure_time time, p_return_departure_time time, p_duration_min numeric) RETURNS TABLE(window_start time, window_end time)
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_departure_time,
    CASE
      WHEN p_return_departure_time IS NOT NULL THEN (p_return_departure_time + (COALESCE(p_duration_min, 120) || ' minutes')::interval)::time
      WHEN p_duration_min IS NOT NULL THEN (p_departure_time + (p_duration_min * 2 || ' minutes')::interval)::time
      ELSE (p_departure_time + interval '4 hours')::time
    END
$$;

-- Used by create_vehicle_route_self + update_vehicle_route_schedule —
-- checks the vehicle's OTHER active routes AND any of its own open Trip
-- Offers for a date landing on a shared day of week.
CREATE OR REPLACE FUNCTION assert_no_route_conflict(p_vehicle_id uuid, p_exclude_route_id uuid, p_days_of_week int[], p_departure_time time, p_return_departure_time time, p_duration_min numeric)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_new_start time; v_new_end time; v_existing_end time;
BEGIN
  IF p_departure_time IS NULL THEN RETURN; END IF;
  SELECT * INTO v_new_start, v_new_end FROM route_busy_window(p_departure_time, p_return_departure_time, p_duration_min);

  FOR r IN
    SELECT id, origin, destination, departure_time, return_departure_time, route_duration_min FROM vehicle_routes
    WHERE vehicle_id = p_vehicle_id AND is_active = true AND departure_time IS NOT NULL
      AND (p_exclude_route_id IS NULL OR id != p_exclude_route_id)
      AND days_of_week && p_days_of_week
  LOOP
    SELECT window_end INTO v_existing_end FROM route_busy_window(r.departure_time, r.return_departure_time, r.route_duration_min);
    IF v_new_start < v_existing_end AND r.departure_time < v_new_end THEN
      RAISE EXCEPTION 'This vehicle already has a fixed route (% → %) running %–% on a shared day — pick a time entirely before % or after %.',
        r.origin, r.destination, to_char(r.departure_time, 'HH24:MI'), to_char(v_existing_end, 'HH24:MI'),
        to_char(r.departure_time, 'HH24:MI'), to_char(v_existing_end, 'HH24:MI')
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  FOR r IN
    SELECT id, origin, destination, travel_date, departure_time_estimate FROM vehicle_trip_offers
    WHERE vehicle_id = p_vehicle_id AND status = 'open' AND departure_time_estimate IS NOT NULL
      AND extract(dow FROM travel_date)::int = ANY(p_days_of_week)
  LOOP
    SELECT window_end INTO v_existing_end FROM route_busy_window(r.departure_time_estimate, NULL, NULL);
    IF v_new_start < v_existing_end AND r.departure_time_estimate < v_new_end THEN
      RAISE EXCEPTION 'This vehicle already has a one-off trip (% → %) posted for % around %-ish on a shared day — pick a time entirely outside that window.',
        r.origin, r.destination, to_char(r.travel_date, 'DD Mon'), to_char(r.departure_time_estimate, 'HH24:MI')
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
END;
$$;

-- Used by place_trip_offer — checks the vehicle's active routes whose
-- days_of_week includes this specific date's day of week.
CREATE OR REPLACE FUNCTION assert_no_trip_conflict(p_vehicle_id uuid, p_travel_date date, p_departure_time time)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_dow int := extract(dow FROM p_travel_date)::int; v_new_end time; v_existing_end time;
BEGIN
  IF p_departure_time IS NULL THEN RETURN; END IF;
  SELECT window_end INTO v_new_end FROM route_busy_window(p_departure_time, NULL, NULL);

  FOR r IN
    SELECT origin, destination, departure_time, return_departure_time, route_duration_min FROM vehicle_routes
    WHERE vehicle_id = p_vehicle_id AND is_active = true AND departure_time IS NOT NULL AND v_dow = ANY(days_of_week)
  LOOP
    SELECT window_end INTO v_existing_end FROM route_busy_window(r.departure_time, r.return_departure_time, r.route_duration_min);
    IF p_departure_time < v_existing_end AND r.departure_time < v_new_end THEN
      RAISE EXCEPTION 'This vehicle already has a fixed route (% → %) running %–% that day — pick a time entirely outside that window.',
        r.origin, r.destination, to_char(r.departure_time, 'HH24:MI'), to_char(v_existing_end, 'HH24:MI')
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
END;
$$;

-- create_vehicle_route_self (819's live body, unchanged apart from one
-- new PERFORM) gains the conflict check right after the existing
-- one-active-route gate.
DROP FUNCTION IF EXISTS public.create_vehicle_route_self(uuid, character varying, character varying, character varying, character varying, numeric, time without time zone, integer[], character varying, character varying, numeric, numeric, numeric, numeric, numeric, jsonb, numeric, time without time zone, boolean, numeric, boolean, int);

CREATE OR REPLACE FUNCTION public.create_vehicle_route_self(p_vehicle_id uuid, p_origin character varying, p_destination character varying, p_classification character varying, p_fare_mode character varying, p_total_fare_pkr numeric DEFAULT NULL::numeric, p_departure_time time without time zone DEFAULT NULL::time without time zone, p_days_of_week integer[] DEFAULT '{}'::integer[], p_origin_ur character varying DEFAULT NULL::character varying, p_destination_ur character varying DEFAULT NULL::character varying, p_origin_lat numeric DEFAULT NULL::numeric, p_origin_lng numeric DEFAULT NULL::numeric, p_destination_lat numeric DEFAULT NULL::numeric, p_destination_lng numeric DEFAULT NULL::numeric, p_distance_km numeric DEFAULT NULL::numeric, p_route_path jsonb DEFAULT NULL::jsonb, p_route_duration_min numeric DEFAULT NULL::numeric, p_return_departure_time time without time zone DEFAULT NULL::time without time zone, p_is_monthly_fixed boolean DEFAULT false, p_monthly_reference_fee_pkr numeric DEFAULT NULL::numeric, p_is_two_way boolean DEFAULT false, p_return_wait_minutes int DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_tenant_id uuid;
  v_seats int;
  v_per_seat decimal;
  v_id uuid;
  v_fair_per_seat decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required';
  END IF;

  SELECT tenant_id, total_seats INTO v_tenant_id, v_seats
    FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id AND is_active = true;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'You can only post a route for your own vehicle';
  END IF;

  IF EXISTS (SELECT 1 FROM vehicle_routes WHERE vehicle_id = p_vehicle_id AND is_active = true) THEN
    RAISE EXCEPTION 'You already have an active route posted — close it before posting a new one.' USING ERRCODE = 'P0001';
  END IF;

  IF coalesce(trim(p_origin), '') = '' OR coalesce(trim(p_destination), '') = '' THEN
    RAISE EXCEPTION 'Origin and destination are required';
  END IF;
  IF p_days_of_week IS NULL OR array_length(p_days_of_week, 1) IS NULL THEN
    RAISE EXCEPTION 'Pick at least one day';
  END IF;

  PERFORM assert_no_route_conflict(p_vehicle_id, NULL, p_days_of_week, p_departure_time,
    CASE WHEN p_is_two_way THEN p_return_departure_time ELSE NULL END, p_route_duration_min);

  IF p_is_monthly_fixed THEN
    IF p_monthly_reference_fee_pkr IS NULL OR p_monthly_reference_fee_pkr <= 0 THEN
      RAISE EXCEPTION 'Enter the monthly reference fee';
    END IF;
    p_total_fare_pkr := 0;
    v_per_seat := 0;
  ELSE
    IF p_distance_km IS NOT NULL THEN
      v_fair_per_seat := (fare_band_for('route', p_distance_km)->>'fair')::decimal;
      IF v_fair_per_seat IS NOT NULL THEN
        IF p_total_fare_pkr IS NULL THEN
          p_total_fare_pkr := round(v_fair_per_seat * greatest(1, coalesce(v_seats, 1)));
        ELSIF round(p_total_fare_pkr / greatest(1, coalesce(v_seats, 1))) > round(v_fair_per_seat) THEN
          RAISE EXCEPTION 'The fair fare per seat for this distance is ₨% (₨% total across % seats) — you can list that or less, not more.', round(v_fair_per_seat), round(v_fair_per_seat * greatest(1, coalesce(v_seats, 1))), greatest(1, coalesce(v_seats, 1)) USING ERRCODE = 'P0001';
        END IF;
      END IF;
    END IF;

    IF p_total_fare_pkr IS NULL OR p_total_fare_pkr <= 0 THEN
      RAISE EXCEPTION 'Enter the total fare';
    END IF;

    v_per_seat := round(p_total_fare_pkr / greatest(1, coalesce(v_seats, 1)));
  END IF;

  INSERT INTO vehicle_routes (
    vehicle_id, tenant_id, origin, origin_ur, destination, destination_ur,
    classification, fare_mode, total_fare_pkr, fare_per_seat_pkr,
    departure_time, days_of_week, is_active,
    origin_lat, origin_lng, destination_lat, destination_lng, distance_km,
    route_path, route_duration_min, return_departure_time,
    is_monthly_fixed, monthly_reference_fee_pkr,
    is_two_way, return_wait_minutes
  ) VALUES (
    p_vehicle_id, v_tenant_id, trim(p_origin), nullif(trim(coalesce(p_origin_ur, '')), ''), trim(p_destination), nullif(trim(coalesce(p_destination_ur, '')), ''),
    p_classification, p_fare_mode, p_total_fare_pkr, v_per_seat,
    p_departure_time, p_days_of_week, true,
    p_origin_lat, p_origin_lng, p_destination_lat, p_destination_lng, p_distance_km,
    p_route_path, p_route_duration_min, p_return_departure_time,
    p_is_monthly_fixed, p_monthly_reference_fee_pkr,
    p_is_two_way, p_return_wait_minutes
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;
GRANT EXECUTE ON FUNCTION create_vehicle_route_self(uuid, character varying, character varying, character varying, character varying, numeric, time without time zone, integer[], character varying, character varying, numeric, numeric, numeric, numeric, numeric, jsonb, numeric, time without time zone, boolean, numeric, boolean, int) TO authenticated;

-- update_vehicle_route_schedule (819's live body) gains the same check —
-- fetches the route first so it can pass the vehicle_id, the route's
-- own route_duration_min, and the effective is_two_way (the param when
-- given, else whatever the route already has, matching the UPDATE's own
-- COALESCE below it).
DROP FUNCTION IF EXISTS update_vehicle_route_schedule(uuid, time, integer[], time, boolean, int);

CREATE OR REPLACE FUNCTION update_vehicle_route_schedule(p_route_id uuid, p_departure_time time, p_days_of_week int[], p_return_departure_time time DEFAULT NULL, p_is_two_way boolean DEFAULT NULL, p_return_wait_minutes int DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route vehicle_routes%ROWTYPE;
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only edit your own route.' USING ERRCODE = 'P0001'; END IF;
  IF p_days_of_week IS NULL OR array_length(p_days_of_week, 1) IS NULL THEN RAISE EXCEPTION 'Pick at least one day.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  PERFORM assert_no_route_conflict(v_route.vehicle_id, p_route_id, p_days_of_week, p_departure_time,
    CASE WHEN COALESCE(p_is_two_way, v_route.is_two_way) THEN p_return_departure_time ELSE NULL END, v_route.route_duration_min);

  UPDATE vehicle_routes SET departure_time = p_departure_time, days_of_week = p_days_of_week, return_departure_time = p_return_departure_time,
    is_two_way = COALESCE(p_is_two_way, is_two_way), return_wait_minutes = CASE WHEN p_is_two_way IS NOT NULL THEN p_return_wait_minutes ELSE return_wait_minutes END
  WHERE id = p_route_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT DISTINCT riders.portal_user_id, 'route_schedule_changed', 'Route timing changed',
    'The departure time or days for a route you ride changed — check the new schedule.', '/portal/marketplace/route/' || p_route_id
  FROM (
    SELECT portal_user_id FROM ride_bookings WHERE route_id = p_route_id AND status NOT IN ('cancelled', 'rejected')
    UNION
    SELECT portal_user_id FROM route_participants WHERE route_id = p_route_id AND is_active = true
  ) riders;
END;
$$;
GRANT EXECUTE ON FUNCTION update_vehicle_route_schedule(uuid, time, int[], time, boolean, int) TO authenticated;

-- place_trip_offer (734's live body) gains the same check right after
-- the travel-date-in-future validation.
DROP FUNCTION IF EXISTS public.place_trip_offer(uuid, character varying, character varying, character varying, character varying, character varying, character varying, date, time without time zone, integer, numeric, numeric, numeric, numeric, time without time zone, int);

CREATE OR REPLACE FUNCTION public.place_trip_offer(p_vehicle_id uuid, p_trip_type character varying, p_origin character varying, p_origin_ur character varying, p_destination character varying, p_destination_ur character varying, p_classification character varying, p_travel_date date, p_departure_time_estimate time without time zone, p_seats_available integer, p_listed_fare_per_seat_pkr numeric DEFAULT NULL::numeric, p_distance_km numeric DEFAULT NULL::numeric, p_dest_lat numeric DEFAULT NULL::numeric, p_dest_lng numeric DEFAULT NULL::numeric, p_return_departure_time_estimate time without time zone DEFAULT NULL, p_return_wait_minutes int DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid; v_allows_out_of_city boolean; v_is_online boolean; v_fair decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT allows_out_of_city, is_online INTO v_allows_out_of_city, v_is_online FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF NOT v_is_online THEN RAISE EXCEPTION 'Go online first — you can''t post a new trip while offline.' USING ERRCODE = 'P0001'; END IF;
  IF NOT vehicle_ride_eligible(p_vehicle_id) THEN
    RAISE EXCEPTION 'Your vehicle''s class is not enabled for rides — ask the committee.' USING ERRCODE = 'P0001';
  END IF;
  IF p_trip_type NOT IN ('oneway', 'return') THEN RAISE EXCEPTION 'Pick one-way or return.' USING ERRCODE = 'P0001'; END IF;
  IF p_classification = 'out_of_city' AND NOT v_allows_out_of_city THEN
    RAISE EXCEPTION 'This vehicle is only set up for trips within the home city — ask the committee if you need out-of-station enabled.' USING ERRCODE = 'P0001';
  END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
  IF p_seats_available IS NULL OR p_seats_available <= 0 THEN RAISE EXCEPTION 'Enter how many seats are free.' USING ERRCODE = 'P0001'; END IF;

  PERFORM assert_no_trip_conflict(p_vehicle_id, p_travel_date, p_departure_time_estimate);

  IF EXISTS (
    SELECT 1 FROM vehicle_trip_offers
     WHERE vehicle_id = p_vehicle_id
       AND status = 'open'
       AND travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
  ) THEN
    RAISE EXCEPTION 'You already have an open trip posted — close it (or wait for its date to pass) before posting a new one.' USING ERRCODE = 'P0001';
  END IF;

  IF p_distance_km IS NOT NULL THEN
    v_fair := (fare_band_for('trip_share', p_distance_km)->>'fair')::decimal;
    IF v_fair IS NOT NULL THEN
      IF p_listed_fare_per_seat_pkr IS NULL THEN
        p_listed_fare_per_seat_pkr := round(v_fair);
      ELSIF round(p_listed_fare_per_seat_pkr) > round(v_fair) THEN
        RAISE EXCEPTION 'The fair fare per seat for this distance is ₨% — you can list that or less, not more.', round(v_fair) USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  IF p_listed_fare_per_seat_pkr IS NULL OR p_listed_fare_per_seat_pkr < 0 THEN
    RAISE EXCEPTION 'Enter the fare per seat.' USING ERRCODE = 'P0001';
  END IF;

  PERFORM charge_vehicle_ride_stake(p_vehicle_id, 'Shared ride posted (' || p_origin || ' → ' || p_destination || ')');

  INSERT INTO vehicle_trip_offers (vehicle_id, trip_type, origin, origin_ur, destination, destination_ur, classification, travel_date, departure_time_estimate, seats_available, listed_fare_per_seat_pkr, distance_km, dest_lat, dest_lng, return_departure_time_estimate, return_wait_minutes)
  VALUES (p_vehicle_id, p_trip_type, p_origin, NULLIF(p_origin_ur, ''), p_destination, NULLIF(p_destination_ur, ''), p_classification, p_travel_date, p_departure_time_estimate, p_seats_available, p_listed_fare_per_seat_pkr, p_distance_km, p_dest_lat, p_dest_lng,
    CASE WHEN p_trip_type = 'return' THEN p_return_departure_time_estimate ELSE NULL END,
    CASE WHEN p_trip_type = 'return' THEN p_return_wait_minutes ELSE NULL END)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.place_trip_offer(uuid, character varying, character varying, character varying, character varying, character varying, character varying, date, time without time zone, integer, numeric, numeric, numeric, numeric, time without time zone, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_trip_offer(uuid, character varying, character varying, character varying, character varying, character varying, character varying, date, time without time zone, integer, numeric, numeric, numeric, numeric, time without time zone, int) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- Real gap found during the same audit: board_ride_bookings can mark a
-- rider PRESENT, nothing could mark one a no-show. Treated the same as
-- a late rider-triggered self-cancellation (436) — the rider's own
-- fault, not the driver's — so whatever's already been paid/posted
-- stays with the driver, non-refundable, matching the fare policy the
-- user just confirmed for this whole vertical.
-- ═════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION mark_rider_no_show(p_booking_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b ride_bookings%ROWTYPE; v_owner_ok boolean;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF b.status NOT IN ('announced', 'confirmed') THEN RAISE EXCEPTION 'This booking is not active.' USING ERRCODE = 'P0001'; END IF;
  IF b.boarded_at IS NOT NULL THEN RAISE EXCEPTION 'This rider has already boarded.' USING ERRCODE = 'P0001'; END IF;

  IF b.route_id IS NOT NULL THEN
    v_owner_ok := is_route_owner(b.route_id);
  ELSE
    SELECT EXISTS (SELECT 1 FROM adda_queue_entries e JOIN vehicles v ON v.id = e.vehicle_id WHERE e.id = b.adda_queue_entry_id AND v.portal_user_id = current_portal_user_id()) INTO v_owner_ok;
  END IF;
  IF NOT v_owner_ok THEN RAISE EXCEPTION 'You do not manage this booking''s vehicle.' USING ERRCODE = 'P0001'; END IF;

  UPDATE ride_bookings SET status = 'cancelled', rejected_reason = 'Marked as a no-show by the driver.' WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'ride_booking_no_show', 'Marked as a no-show',
    'The driver marked you absent for this ride and closed the booking.',
    CASE WHEN b.route_id IS NOT NULL THEN '/portal/marketplace/route/' || b.route_id ELSE '/portal/marketplace' END);
END;
$$;
GRANT EXECUTE ON FUNCTION mark_rider_no_show(uuid) TO authenticated;
