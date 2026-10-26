-- Real correction, 2026-10-26: "the fix 30 rs commission was for the
-- fixed monthly route ride like school vans and not for the ride
-- sharing which will work according to its full fair commission which
-- we already have fixed in the backend." Migration 734 charged the
-- flat Rs 30 posting stake in BOTH place_trip_offer (one-off shared
-- ride posts) and start_route_run (recurring daily van routes) — wrong
-- scope. The one-off shared-ride system keeps its existing, already-
-- correct percentage commission charged at completion
-- (complete_trip_booking, 709) — untouched, no new charge at post
-- time. Only start_route_run (the fixed/recurring school-van-style
-- route) keeps the new Rs 30 per-run stake from 734.
--
-- place_trip_offer: same signature as 734's body, minus the
-- charge_vehicle_ride_stake call — otherwise identical (no DROP
-- needed, signature unchanged).

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
