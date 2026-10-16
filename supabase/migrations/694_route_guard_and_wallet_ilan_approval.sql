-- Migration 694: real bugs found live, 2026-10-17 —
--
-- 1. create_vehicle_route_self() had no "one active route per vehicle"
--    guard at all (unlike place_trip_offer's one-open-trip rule from
--    682) -- confirmed live: the same vehicle had two simultaneously
--    active routes (Gujranwala posted today, Rawalpindi from a month
--    ago still active). Same rule now applies to routes.
--
-- 2. New wallet-based instant ilan approval: if the driver's own
--    marketplace wallet (vehicle account) already has enough balance
--    to cover an ilan's price, it can run immediately with no
--    committee review at all -- the price is deducted straight from
--    that wallet (a real debit/credit voucher, same ledger as
--    everything else in marketplace, so the money flow is fully
--    visible there) instead of waiting for a human to confirm cash
--    was handed over. Below that balance, nothing changes: it still
--    sits pending_approval exactly as before, for the committee to
--    confirm once real cash is actually received.

CREATE OR REPLACE FUNCTION public.create_vehicle_route_self(p_vehicle_id uuid, p_origin character varying, p_destination character varying, p_classification character varying, p_fare_mode character varying, p_total_fare_pkr numeric, p_departure_time time without time zone DEFAULT NULL::time without time zone, p_days_of_week integer[] DEFAULT '{}'::integer[], p_origin_ur character varying DEFAULT NULL::character varying, p_destination_ur character varying DEFAULT NULL::character varying, p_origin_lat numeric DEFAULT NULL::numeric, p_origin_lng numeric DEFAULT NULL::numeric, p_destination_lat numeric DEFAULT NULL::numeric, p_destination_lng numeric DEFAULT NULL::numeric)
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
  IF p_total_fare_pkr IS NULL OR p_total_fare_pkr <= 0 THEN
    RAISE EXCEPTION 'Enter the total fare';
  END IF;

  v_per_seat := round(p_total_fare_pkr / greatest(1, coalesce(v_seats, 1)));

  INSERT INTO vehicle_routes (
    vehicle_id, tenant_id, origin, origin_ur, destination, destination_ur,
    classification, fare_mode, total_fare_pkr, fare_per_seat_pkr,
    departure_time, days_of_week, is_active,
    origin_lat, origin_lng, destination_lat, destination_lng
  ) VALUES (
    p_vehicle_id, v_tenant_id, trim(p_origin), nullif(trim(coalesce(p_origin_ur, '')), ''), trim(p_destination), nullif(trim(coalesce(p_destination_ur, '')), ''),
    p_classification, p_fare_mode, p_total_fare_pkr, v_per_seat,
    p_departure_time, p_days_of_week, true,
    p_origin_lat, p_origin_lng, p_destination_lat, p_destination_lng
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.auto_approve_ilan_from_wallet(p_ilan_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  ilan commercial_ilans%rowtype;
  v_vehicle_account uuid;
  v_revenue_account uuid;
  v_balance numeric;
BEGIN
  SELECT * INTO ilan FROM commercial_ilans WHERE id = p_ilan_id AND status = 'pending_approval' FOR UPDATE;
  IF NOT FOUND OR ilan.vehicle_id IS NULL THEN RETURN false; END IF;

  v_vehicle_account := ensure_vehicle_account(ilan.vehicle_id);
  v_balance := seller_account_balance(v_vehicle_account);
  IF v_balance IS NULL OR v_balance < ilan.price_pkr THEN RETURN false; END IF;

  UPDATE commercial_ilans SET status = 'approved', reviewed_at = now() WHERE id = p_ilan_id;

  IF ilan.price_pkr > 0 THEN
    v_revenue_account := ensure_ilan_revenue_account(ilan.home_tenant_id);
    -- Same shape as committee_approve_ilan's cash voucher, with the
    -- driver's own wallet standing in for cash physically handed
    -- over: debiting the vehicle account here is what actually lowers
    -- its seller_account_balance (opening_balance - debit + credit).
    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id)
    VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
      'Ilan auto-approved from driver wallet balance — ' || ilan.title_ur, ilan.price_pkr, v_revenue_account, v_vehicle_account);
  END IF;

  RETURN true;
END;
$function$;

-- Reproduced verbatim (693's real current body) with one new line: try
-- the wallet auto-approval right after creating the ilan, inside the
-- same exception-swallowing block so a billing hiccup still never
-- blocks the actual trip post.
CREATE OR REPLACE FUNCTION public.place_trip_offer(p_vehicle_id uuid, p_trip_type character varying, p_origin character varying, p_origin_ur character varying, p_destination character varying, p_destination_ur character varying, p_classification character varying, p_travel_date date, p_departure_time_estimate time without time zone, p_seats_available integer, p_listed_fare_per_seat_pkr numeric, p_distance_km numeric DEFAULT NULL::numeric, p_dest_lat numeric DEFAULT NULL::numeric, p_dest_lng numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid; v_allows_out_of_city boolean; v_is_online boolean; v_ilan_id uuid;
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

  BEGIN
    v_ilan_id := auto_generate_trip_ilan(v_id);
    IF v_ilan_id IS NOT NULL THEN PERFORM auto_approve_ilan_from_wallet(v_ilan_id); END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN v_id;
END;
$function$;

-- Reproduced verbatim (real current body) with one new line: try
-- wallet auto-approval right after the request is created.
CREATE OR REPLACE FUNCTION public.request_commercial_ilan(p_vehicle_id uuid, p_placement character varying, p_target_tenant_ids uuid[], p_title_ur character varying, p_body_ur text, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_vehicle_route_id uuid DEFAULT NULL::uuid, p_title_en character varying DEFAULT NULL::character varying, p_body_en text DEFAULT NULL::text, p_contact_mobile character varying DEFAULT NULL::character varying)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_tenant_id uuid := my_tenant_id();
  v_card_id uuid;
  v_price decimal;
  v_id uuid;
  v_bad_target uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required';
  END IF;
  IF NOT can_access_system('commercial_ilans') THEN
    RAISE EXCEPTION 'Your village is not on the commercial ilan network yet';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = v_portal_user_id AND v.is_active = true
  ) THEN
    RAISE EXCEPTION 'You can only advertise your own vehicle';
  END IF;
  IF p_vehicle_route_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM vehicle_routes r WHERE r.id = p_vehicle_route_id AND r.vehicle_id = p_vehicle_id
  ) THEN
    RAISE EXCEPTION 'Route does not belong to this vehicle';
  END IF;
  IF coalesce(trim(p_title_ur), '') = '' OR coalesce(trim(p_body_ur), '') = '' THEN
    RAISE EXCEPTION 'An ilan needs an Urdu title and message';
  END IF;

  SELECT t.id INTO v_bad_target FROM unnest(p_target_tenant_ids) AS t(id)
   WHERE NOT EXISTS (SELECT 1 FROM tenants tt WHERE tt.id = t.id AND tt.is_active = true AND tt.commercial_ilans_enabled = true)
   LIMIT 1;
  IF v_bad_target IS NOT NULL THEN
    RAISE EXCEPTION 'One of the selected villages is not eligible for ilans';
  END IF;

  SELECT id INTO v_card_id FROM ilan_rate_cards WHERE placement = p_placement AND is_active = true LIMIT 1;
  IF v_card_id IS NULL THEN
    RAISE EXCEPTION 'No active rate card for %', p_placement;
  END IF;

  v_price := quote_commercial_ilan(p_placement, p_target_tenant_ids, p_starts_at, p_ends_at);

  INSERT INTO commercial_ilans (
    advertiser_portal_user_id, home_tenant_id, vehicle_id, vehicle_route_id, placement,
    target_tenant_ids, title_ur, title_en, body_ur, body_en, contact_mobile,
    starts_at, ends_at, rate_card_id, price_pkr
  ) VALUES (
    v_portal_user_id, v_tenant_id, p_vehicle_id, p_vehicle_route_id, p_placement,
    p_target_tenant_ids, trim(p_title_ur), nullif(trim(coalesce(p_title_en, '')), ''), trim(p_body_ur), nullif(trim(coalesce(p_body_en, '')), ''), p_contact_mobile,
    p_starts_at, p_ends_at, v_card_id, v_price
  ) RETURNING id INTO v_id;

  PERFORM auto_approve_ilan_from_wallet(v_id);

  RETURN v_id;
END;
$function$;
