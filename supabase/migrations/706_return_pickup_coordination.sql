-- Migration 706: Phase 5 — return-departure timing + a real rider-side
-- location-sharing toggle for return-trip pickup coordination. "Once a
-- rider reaches their destination, they should see the return departure
-- timing and be able to track the driver's live location; the driver
-- should ALSO be able to see the rider's location... the rider can stop
-- sharing his location if he wants and he will no longer be seen to the
-- driver."
--
-- The bilateral location table (vehicle_trip_locations/ping_trip_location,
-- migration 400) already exists and is left completely unmodified — this
-- just adds a visibility gate the RIDER controls, mirroring the driver's
-- own pre-booking toggle shape (set_trip_offer_live_sharing, 415) applied
-- to the post-booking side instead.

ALTER TABLE vehicle_trip_offers ADD COLUMN IF NOT EXISTS return_departure_time_estimate time;
ALTER TABLE vehicle_trip_bookings ADD COLUMN IF NOT EXISTS rider_sharing_location boolean NOT NULL DEFAULT false;

-- place_trip_offer gains a trailing optional return-departure time —
-- only meaningful for trip_type='return', not enforced server-side
-- beyond that (a oneway trip simply never reads it). A trailing param
-- creates a new overload rather than replacing in place (same class of
-- bug fixed twice already this session) — drop the prior 14-arg
-- signature first so only the new one survives.
DROP FUNCTION IF EXISTS public.place_trip_offer(uuid, character varying, character varying, character varying, character varying, character varying, character varying, date, time without time zone, integer, numeric, numeric, numeric, numeric);

CREATE OR REPLACE FUNCTION public.place_trip_offer(p_vehicle_id uuid, p_trip_type character varying, p_origin character varying, p_origin_ur character varying, p_destination character varying, p_destination_ur character varying, p_classification character varying, p_travel_date date, p_departure_time_estimate time without time zone, p_seats_available integer, p_listed_fare_per_seat_pkr numeric DEFAULT NULL::numeric, p_distance_km numeric DEFAULT NULL::numeric, p_dest_lat numeric DEFAULT NULL::numeric, p_dest_lng numeric DEFAULT NULL::numeric, p_return_departure_time_estimate time without time zone DEFAULT NULL)
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

  INSERT INTO vehicle_trip_offers (vehicle_id, trip_type, origin, origin_ur, destination, destination_ur, classification, travel_date, departure_time_estimate, seats_available, listed_fare_per_seat_pkr, distance_km, dest_lat, dest_lng, return_departure_time_estimate)
  VALUES (p_vehicle_id, p_trip_type, p_origin, NULLIF(p_origin_ur, ''), p_destination, NULLIF(p_destination_ur, ''), p_classification, p_travel_date, p_departure_time_estimate, p_seats_available, p_listed_fare_per_seat_pkr, p_distance_km, p_dest_lat, p_dest_lng, CASE WHEN p_trip_type = 'return' THEN p_return_departure_time_estimate ELSE NULL END)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- my_trip_bookings: surface both the return-departure time and whether
-- the rider is currently sharing their location, so the rider's own
-- bookings list can show the toggle state without a second query.
CREATE OR REPLACE FUNCTION public.my_trip_bookings()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'status', b.status, 'seats', b.seats, 'leg', b.leg,
    'agreed_fare_per_seat_pkr', b.agreed_fare_per_seat_pkr, 'total_amount_pkr', b.total_amount_pkr,
    'created_at', b.created_at, 'cancellation_reason', b.cancellation_reason,
    'rider_sharing_location', b.rider_sharing_location,
    'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
    'origin', o.origin, 'origin_ur', o.origin_ur, 'destination', o.destination, 'destination_ur', o.destination_ur,
    'travel_date', o.travel_date, 'departure_time_estimate', o.departure_time_estimate, 'trip_type', o.trip_type,
    'return_departure_time_estimate', o.return_departure_time_estimate
  ) ORDER BY b.created_at DESC), '[]'::jsonb)
  FROM vehicle_trip_bookings b
  JOIN vehicle_trip_offers o ON o.id = b.trip_offer_id
  JOIN vehicles v ON v.id = b.vehicle_id
  WHERE b.portal_user_id = current_portal_user_id();
$function$;

-- set_rider_trip_location_sharing: the rider's own on/off toggle.
-- Turning on only flips the flag (ping_trip_location, unmodified, does
-- the actual writes). Turning off deletes the rider's row outright —
-- that delete is what actually makes them disappear to the driver, not
-- just the flag, since nothing else in this app enforces the flag at
-- read time by default.
CREATE OR REPLACE FUNCTION set_rider_trip_location_sharing(p_trip_booking_id uuid, p_on boolean) RETURNS void AS $$
DECLARE b vehicle_trip_bookings%ROWTYPE;
BEGIN
  SELECT * INTO b FROM vehicle_trip_bookings WHERE id = p_trip_booking_id AND portal_user_id = current_portal_user_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'confirmed' THEN RAISE EXCEPTION 'This trip is not active.' USING ERRCODE = 'P0001'; END IF;
  IF b.leg <> 'return' THEN RAISE EXCEPTION 'Return-pickup location sharing only applies to a return-leg booking.' USING ERRCODE = 'P0001'; END IF;

  UPDATE vehicle_trip_bookings SET rider_sharing_location = p_on WHERE id = p_trip_booking_id;
  IF NOT p_on THEN
    DELETE FROM vehicle_trip_locations WHERE trip_booking_id = p_trip_booking_id AND role = 'rider';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION set_rider_trip_location_sharing(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_rider_trip_location_sharing(uuid, boolean) TO authenticated;
