-- Migration 697: real ask, 2026-10-17 — "these are commercial ads...
-- only for paid not free... only when driver or shopkeeper will buy
-- this and pay for this." Posting a trip no longer silently creates a
-- pending ad request as a side effect at all. Advertising a ride is
-- now always a separate, explicit, informed action the driver takes —
-- request_trip_ilan(), called only from a "Advertise this ride"
-- button the driver taps after seeing what it costs and what it does.
-- Same payment rule as routes already got (694): if the driver's own
-- wallet covers the price, it runs immediately with the price
-- deducted from that wallet; otherwise it sits pending for the
-- committee to confirm once cash/online payment is actually received.

-- Reproduced from 693's real current body, with the auto-ilan call
-- removed entirely — posting a trip now only ever posts the trip.
CREATE OR REPLACE FUNCTION public.place_trip_offer(p_vehicle_id uuid, p_trip_type character varying, p_origin character varying, p_origin_ur character varying, p_destination character varying, p_destination_ur character varying, p_classification character varying, p_travel_date date, p_departure_time_estimate time without time zone, p_seats_available integer, p_listed_fare_per_seat_pkr numeric, p_distance_km numeric DEFAULT NULL::numeric, p_dest_lat numeric DEFAULT NULL::numeric, p_dest_lng numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid; v_allows_out_of_city boolean; v_is_online boolean;
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

  INSERT INTO vehicle_trip_offers (vehicle_id, trip_type, origin, origin_ur, destination, destination_ur, classification, travel_date, departure_time_estimate, seats_available, listed_fare_per_seat_pkr, distance_km, dest_lat, dest_lng)
  VALUES (p_vehicle_id, p_trip_type, p_origin, NULLIF(p_origin_ur, ''), p_destination, NULLIF(p_destination_ur, ''), p_classification, p_travel_date, p_departure_time_estimate, p_seats_available, p_listed_fare_per_seat_pkr, p_distance_km, p_dest_lat, p_dest_lng)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- Quote what advertising a trip would cost, before the driver commits
-- to anything — same quote-then-request shape my-vehicle/ilan's own
-- manual flow already uses.
CREATE OR REPLACE FUNCTION public.quote_trip_ilan(p_trip_offer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_price decimal;
  v_wallet_balance decimal;
  v_vehicle_id uuid;
BEGIN
  SELECT o.vehicle_id INTO v_vehicle_id FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id
    WHERE o.id = p_trip_offer_id AND v.portal_user_id = v_portal_user_id;
  IF v_vehicle_id IS NULL THEN RAISE EXCEPTION 'You do not manage this trip.' USING ERRCODE = 'P0001'; END IF;

  SELECT price_per_village_per_day_pkr INTO v_price FROM ilan_rate_cards WHERE placement = 'auto_trip' AND is_active = true LIMIT 1;
  IF v_price IS NULL THEN RAISE EXCEPTION 'Ad pricing is not configured yet — ask the committee.' USING ERRCODE = 'P0001'; END IF;

  v_wallet_balance := seller_account_balance(ensure_vehicle_account(v_vehicle_id));

  RETURN jsonb_build_object(
    'price_pkr', v_price,
    'wallet_balance_pkr', COALESCE(v_wallet_balance, 0),
    'covered_by_wallet', COALESCE(v_wallet_balance, 0) >= v_price
  );
END;
$function$;

-- The actual, explicit, driver-initiated request — only ever called
-- from a real "Advertise this ride" tap, never as a side effect of
-- anything else.
CREATE OR REPLACE FUNCTION public.request_trip_ilan(p_trip_offer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_vehicle_id uuid;
  v_ilan_id uuid;
  v_approved boolean;
BEGIN
  SELECT o.vehicle_id INTO v_vehicle_id FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id
    WHERE o.id = p_trip_offer_id AND v.portal_user_id = v_portal_user_id AND o.status = 'open';
  IF v_vehicle_id IS NULL THEN RAISE EXCEPTION 'You do not manage this trip, or it is no longer open.' USING ERRCODE = 'P0001'; END IF;

  IF EXISTS (
    SELECT 1 FROM commercial_ilans
    WHERE vehicle_trip_offer_id = p_trip_offer_id
      AND (status = 'pending_approval' OR (status = 'approved' AND is_paused = false AND ends_at > now()))
  ) THEN
    RAISE EXCEPTION 'This trip already has an ad running or awaiting approval.' USING ERRCODE = 'P0001';
  END IF;

  v_ilan_id := auto_generate_trip_ilan(p_trip_offer_id);
  IF v_ilan_id IS NULL THEN RAISE EXCEPTION 'Ad pricing is not configured yet — ask the committee.' USING ERRCODE = 'P0001'; END IF;

  v_approved := auto_approve_ilan_from_wallet(v_ilan_id);

  RETURN jsonb_build_object('ilan_id', v_ilan_id, 'approved_instantly', v_approved);
END;
$function$;
