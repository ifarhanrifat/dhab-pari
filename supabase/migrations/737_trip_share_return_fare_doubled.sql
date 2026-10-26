-- Real bug, reported live: "I chosen one way from chakwal to
-- Rawalpindi the fare is calculated by the system 720 rs and when I
-- chosen return... the fare remain same... 4 riders want to book this
-- ride sharing and those 4 want to traciback with me, now they will
-- pay me only 720 rs?"
--
-- Confirmed in the code: fare_band_for(flow, km) is purely distance-
-- based, with no concept of one-way vs return at all — the same
-- ceiling/suggestion is shown and enforced whether trip_type is
-- 'oneway' or 'return'. But the booking side already has a real,
-- separate rule (693/728): a rider who books only the one-way leg of a
-- 'return' trip automatically pays HALF of listed_fare_per_seat_pkr.
-- That rule only makes economic sense if listed_fare_per_seat_pkr for
-- a return trip represents the FULL ROUND-TRIP price — but nothing
-- ever made it one. The driver's 720 one-way fair price was being
-- shown and capped identically for a return listing, so a full round
-- trip (the driver covering the distance twice) was priced the same
-- as a single one-way leg — exactly the bug reported.
--
-- Fix: when p_trip_type = 'return', the ceiling is the one-way fair
-- price DOUBLED — not fare_band_for called with double the distance.
-- Doubling the already-computed single-leg fair value (rather than the
-- km input) keeps the existing half-fare booking rule exact: half of
-- (2 × one-way fair) is back to exactly the real one-way fair, so a
-- rider booking just the return-trip's one-way leg pays the same as
-- someone who posted a direct one-way trip for that same distance —
-- doubling the km input instead would under-count the fixed base fare
-- and make that leg artificially cheaper than a real one-way trip.
--
-- Same signature as 735's body (no DROP needed).

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
      IF p_trip_type = 'return' THEN v_fair := v_fair * 2; END IF;
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

  INSERT INTO vehicle_trip_offers (vehicle_id, trip_type, origin, origin_ur, destination, destination_ur, classification, travel_date, departure_time_estimate, seats_available, listed_fare_per_seat_pkr, distance_km, dest_lat, dest_lng, return_departure_time_estimate, return_wait_minutes)
  VALUES (p_vehicle_id, p_trip_type, p_origin, NULLIF(p_origin_ur, ''), p_destination, NULLIF(p_destination_ur, ''), p_classification, p_travel_date, p_departure_time_estimate, p_seats_available, p_listed_fare_per_seat_pkr, p_distance_km, p_dest_lat, p_dest_lng,
    CASE WHEN p_trip_type = 'return' THEN p_return_departure_time_estimate ELSE NULL END,
    CASE WHEN p_trip_type = 'return' THEN p_return_wait_minutes ELSE NULL END)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;
