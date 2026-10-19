-- Migration 699: Phase 2 of the vehicle-marketplace rebuild — "nothing
-- is manual for the vehicals to set fare on there own, but if any
-- vehical want to put less fare... they can offer less rate." Routes
-- and one-off Shared trips are the two flows where a driver free-types
-- a total fare with zero backend check (the exact bug that kicked off
-- this whole redesign — the Rawalpindi route at an uncontrolled
-- ₨2700/seat). When a distance is given, the backend now computes a
-- fair price via the existing fare_bands engine and only ever allows
-- that price or lower — never a driver-typed number above it. No
-- distance given keeps today's fully-manual path unchanged.
--
-- Real gap found while checking this live, not from migration-file
-- archaeology: only 1 of the app's 3 real tenants has ANY fare_bands
-- rows at all — the other 2 have zero rows for even the pre-existing
-- trip_share/city_fetch flows, meaning their negotiation fare-hints
-- have been silently no-op this whole time. Backfilling all 3 tenants
-- for all 3 flows now, using tenant 1's existing numbers as the
-- sensible default (committee can retune via marketplace-reference).

ALTER TABLE vehicle_routes ADD COLUMN IF NOT EXISTS distance_km decimal CHECK (distance_km IS NULL OR distance_km >= 0);

ALTER TABLE fare_bands DROP CONSTRAINT fare_bands_flow_check;
ALTER TABLE fare_bands ADD CONSTRAINT fare_bands_flow_check CHECK (flow::text = ANY (ARRAY['trip_share', 'city_fetch', 'route']::text[]));

INSERT INTO fare_bands (tenant_id, flow, base_pkr, per_km_pkr, spread)
SELECT t.id, f.flow, f.base_pkr, f.per_km_pkr, f.spread
FROM tenants t
CROSS JOIN (VALUES ('trip_share', 150, 5, 0.28), ('city_fetch', 100, 4, 0.28), ('route', 150, 5, 0.28)) AS f(flow, base_pkr, per_km_pkr, spread)
ON CONFLICT (tenant_id, flow) DO NOTHING;

-- Adding a trailing param creates a new overload rather than replacing
-- the old one in place — drop the pre-existing 14-arg signature so
-- callers can't ambiguously resolve to the stale version.
DROP FUNCTION IF EXISTS public.create_vehicle_route_self(uuid, character varying, character varying, character varying, character varying, numeric, time without time zone, integer[], character varying, character varying, numeric, numeric, numeric, numeric);

CREATE OR REPLACE FUNCTION public.create_vehicle_route_self(p_vehicle_id uuid, p_origin character varying, p_destination character varying, p_classification character varying, p_fare_mode character varying, p_total_fare_pkr numeric DEFAULT NULL::numeric, p_departure_time time without time zone DEFAULT NULL::time without time zone, p_days_of_week integer[] DEFAULT '{}'::integer[], p_origin_ur character varying DEFAULT NULL::character varying, p_destination_ur character varying DEFAULT NULL::character varying, p_origin_lat numeric DEFAULT NULL::numeric, p_origin_lng numeric DEFAULT NULL::numeric, p_destination_lat numeric DEFAULT NULL::numeric, p_destination_lng numeric DEFAULT NULL::numeric, p_distance_km numeric DEFAULT NULL::numeric)
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
  v_fair_total decimal;
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

  IF p_distance_km IS NOT NULL THEN
    v_fair_total := (fare_band_for('route', p_distance_km)->>'fair')::decimal;
    IF v_fair_total IS NOT NULL THEN
      IF p_total_fare_pkr IS NULL THEN
        p_total_fare_pkr := round(v_fair_total);
      ELSIF round(p_total_fare_pkr) > round(v_fair_total) THEN
        RAISE EXCEPTION 'The fair total fare for this distance is ₨% — you can list that or less, not more.', round(v_fair_total) USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  IF p_total_fare_pkr IS NULL OR p_total_fare_pkr <= 0 THEN
    RAISE EXCEPTION 'Enter the total fare';
  END IF;

  v_per_seat := round(p_total_fare_pkr / greatest(1, coalesce(v_seats, 1)));

  INSERT INTO vehicle_routes (
    vehicle_id, tenant_id, origin, origin_ur, destination, destination_ur,
    classification, fare_mode, total_fare_pkr, fare_per_seat_pkr,
    departure_time, days_of_week, is_active,
    origin_lat, origin_lng, destination_lat, destination_lng, distance_km
  ) VALUES (
    p_vehicle_id, v_tenant_id, trim(p_origin), nullif(trim(coalesce(p_origin_ur, '')), ''), trim(p_destination), nullif(trim(coalesce(p_destination_ur, '')), ''),
    p_classification, p_fare_mode, p_total_fare_pkr, v_per_seat,
    p_departure_time, p_days_of_week, true,
    p_origin_lat, p_origin_lng, p_destination_lat, p_destination_lng, p_distance_km
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.place_trip_offer(p_vehicle_id uuid, p_trip_type character varying, p_origin character varying, p_origin_ur character varying, p_destination character varying, p_destination_ur character varying, p_classification character varying, p_travel_date date, p_departure_time_estimate time without time zone, p_seats_available integer, p_listed_fare_per_seat_pkr numeric DEFAULT NULL::numeric, p_distance_km numeric DEFAULT NULL::numeric, p_dest_lat numeric DEFAULT NULL::numeric, p_dest_lng numeric DEFAULT NULL::numeric)
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

  INSERT INTO vehicle_trip_offers (vehicle_id, trip_type, origin, origin_ur, destination, destination_ur, classification, travel_date, departure_time_estimate, seats_available, listed_fare_per_seat_pkr, distance_km, dest_lat, dest_lng)
  VALUES (p_vehicle_id, p_trip_type, p_origin, NULLIF(p_origin_ur, ''), p_destination, NULLIF(p_destination_ur, ''), p_classification, p_travel_date, p_departure_time_estimate, p_seats_available, p_listed_fare_per_seat_pkr, p_distance_km, p_dest_lat, p_dest_lng)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;
