-- Migration 922: real gaps found live on the Routes & stops screen,
-- 2026-11-19 — "why displaying garbage", button-by-button re-audit
-- against the SAFAR mockup's Route editor / Fare configuration panel.
--
-- 1. Real regression bug, unrelated to this session's own earlier work:
--    848 made fare_mode driver-chosen for every vehicle kind alike
--    (v_fare_mode := p_fare_mode). 893's gate-swap (driver/owner
--    permission split) silently reverted this back to the OLD
--    hardcoded "van=fixed, else=flex" logic while copying the rest of
--    848's body — so p_fare_mode has been a dead parameter since 893,
--    and every route created on this page has silently ignored
--    whatever fare mode the driver picked on screen. 895 copied 893's
--    buggy body verbatim when it re-created every overload. True-
--    replacing from 895's exact current body, restoring v_fare_mode :=
--    p_fare_mode (validated), and widening to accept 'terminal_zone'
--    with a direct per-seat base fare (p_fare_per_seat_pkr) — a
--    terminal-zone bus route has no "total vehicle fare" concept at
--    all, the per-seat base fare over the WHOLE route is the only
--    number entered, every intermediate city-pair price is derived
--    from it via route_fare_zones (920/921).
--
-- 2. New set_route_base_fare — lets a fleet owner/staff edit a
--    terminal_zone route's base per-seat fare after creation (the
--    mockup's "Fare configuration" panel implies this is editable,
--    not fixed forever at creation time), re-triggering
--    recompute_route_fare_zones so every zone price stays in sync.
--
-- 3. New my_vehicle_route_bookings — the "Bookings" list on this page
--    (ride_bookings, rider-self-announced seats awaiting driver
--    confirmation) never joined portal_users at all, so a real
--    passenger always showed with no name — not fabricated data, a
--    real display gap. SECURITY DEFINER, same ownership gate the
--    existing inline query implicitly relied on via RLS.

CREATE OR REPLACE FUNCTION assert_route_fare_mode_ok(p_fare_mode varchar) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_fare_mode NOT IN ('fixed', 'flex', 'terminal_zone') THEN
    RAISE EXCEPTION 'Fare mode must be fixed, flex, or terminal_zone.' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'create_vehicle_route_self'
  LOOP
    EXECUTE format('DROP FUNCTION %s', r.sig);
  END LOOP;
END $$;

CREATE FUNCTION public.create_vehicle_route_self(
  p_vehicle_id uuid, p_origin character varying, p_destination character varying, p_classification character varying, p_fare_mode character varying,
  p_total_fare_pkr numeric DEFAULT NULL::numeric, p_departure_time time without time zone DEFAULT NULL::time without time zone,
  p_days_of_week integer[] DEFAULT '{}'::integer[], p_origin_ur character varying DEFAULT NULL::character varying, p_destination_ur character varying DEFAULT NULL::character varying,
  p_origin_lat numeric DEFAULT NULL::numeric, p_origin_lng numeric DEFAULT NULL::numeric, p_destination_lat numeric DEFAULT NULL::numeric, p_destination_lng numeric DEFAULT NULL::numeric,
  p_distance_km numeric DEFAULT NULL::numeric, p_route_path jsonb DEFAULT NULL::jsonb, p_route_duration_min numeric DEFAULT NULL::numeric,
  p_return_departure_time time without time zone DEFAULT NULL::time without time zone, p_is_monthly_fixed boolean DEFAULT false,
  p_monthly_reference_fee_pkr numeric DEFAULT NULL::numeric, p_is_two_way boolean DEFAULT false, p_return_wait_minutes int DEFAULT NULL,
  p_one_off_date date DEFAULT NULL::date, p_service_code character varying DEFAULT NULL::character varying,
  p_return_days_of_week integer[] DEFAULT NULL, p_fare_per_seat_pkr numeric DEFAULT NULL
)
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
  v_vehicle_kind varchar;
  v_fare_mode varchar;
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required';
  END IF;

  IF NOT can_administer_vehicle(p_vehicle_id) THEN
    RAISE EXCEPTION 'You can only post a route for your own vehicle, or one in a fleet you own';
  END IF;
  SELECT v.tenant_id, v.total_seats, vc.vehicle_kind INTO v_tenant_id, v_seats, v_vehicle_kind
    FROM vehicles v LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
    WHERE v.id = p_vehicle_id AND v.is_active = true;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'That vehicle is not available';
  END IF;

  PERFORM assert_route_fare_mode_ok(p_fare_mode);
  v_fare_mode := p_fare_mode;

  IF EXISTS (SELECT 1 FROM vehicle_routes WHERE vehicle_id = p_vehicle_id AND is_active = true) THEN
    RAISE EXCEPTION 'You already have an active route posted — close it before posting a new one.' USING ERRCODE = 'P0001';
  END IF;

  IF coalesce(trim(p_origin), '') = '' OR coalesce(trim(p_destination), '') = '' THEN
    RAISE EXCEPTION 'Origin and destination are required';
  END IF;
  IF p_days_of_week IS NULL OR array_length(p_days_of_week, 1) IS NULL THEN
    RAISE EXCEPTION 'Pick at least one day';
  END IF;
  IF p_return_days_of_week IS NOT NULL AND array_length(p_return_days_of_week, 1) IS NULL THEN
    RAISE EXCEPTION 'Pick at least one return day, or leave it blank to match the outbound days.' USING ERRCODE = 'P0001';
  END IF;

  PERFORM assert_no_route_conflict(p_vehicle_id, NULL, p_days_of_week, p_departure_time,
    CASE WHEN p_is_two_way THEN p_return_departure_time ELSE NULL END, p_route_duration_min);

  IF p_one_off_date IS NOT NULL THEN
    IF p_is_monthly_fixed THEN RAISE EXCEPTION 'A monthly-fixed route can''t also be a one-off date.' USING ERRCODE = 'P0001'; END IF;
    IF p_one_off_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
    IF NOT (extract(dow FROM p_one_off_date)::int = ANY(p_days_of_week)) THEN
      RAISE EXCEPTION 'That date does not fall on the day you picked.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_is_monthly_fixed THEN
    IF p_monthly_reference_fee_pkr IS NULL OR p_monthly_reference_fee_pkr <= 0 THEN
      RAISE EXCEPTION 'Enter the monthly reference fee';
    END IF;
    p_total_fare_pkr := 0;
    v_per_seat := 0;
  ELSIF v_fare_mode = 'terminal_zone' THEN
    -- A terminal-zone bus route has no "total vehicle fare" concept —
    -- the one number entered is the full origin-to-destination
    -- per-seat fare; every intermediate city-pair price is derived
    -- from it (route_fare_zones, 920/921), not from seats or distance
    -- fairness bands (those are village-carpool concepts).
    IF p_fare_per_seat_pkr IS NULL OR p_fare_per_seat_pkr <= 0 THEN
      RAISE EXCEPTION 'Enter the base fare for the full route.' USING ERRCODE = 'P0001';
    END IF;
    v_per_seat := p_fare_per_seat_pkr;
    p_total_fare_pkr := NULL;
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
    is_two_way, return_wait_minutes, one_off_date, service_code, return_days_of_week
  ) VALUES (
    p_vehicle_id, v_tenant_id, trim(p_origin), nullif(trim(coalesce(p_origin_ur, '')), ''), trim(p_destination), nullif(trim(coalesce(p_destination_ur, '')), ''),
    p_classification, v_fare_mode, p_total_fare_pkr, v_per_seat,
    p_departure_time, p_days_of_week, true,
    p_origin_lat, p_origin_lng, p_destination_lat, p_destination_lng, p_distance_km,
    p_route_path, p_route_duration_min, p_return_departure_time,
    p_is_monthly_fixed, p_monthly_reference_fee_pkr,
    p_is_two_way, p_return_wait_minutes, p_one_off_date, nullif(trim(coalesce(p_service_code, '')), ''),
    CASE WHEN p_is_two_way THEN p_return_days_of_week ELSE NULL END
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION create_vehicle_route_self(
  uuid, varchar, varchar, varchar, varchar, numeric, time, integer[], varchar, varchar, numeric, numeric, numeric, numeric,
  numeric, jsonb, numeric, time, boolean, numeric, boolean, int, date, varchar, integer[], numeric
) TO authenticated;

-- set_route_base_fare — editing a terminal_zone route's one real fare
-- input after creation; re-derives every zone price so they never go
-- stale relative to the edited base.
CREATE OR REPLACE FUNCTION set_route_base_fare(p_route_id uuid, p_fare_per_seat_pkr decimal) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_administer_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You can only manage your own route.' USING ERRCODE = 'P0001'; END IF;
  IF v_route.fare_mode != 'terminal_zone' THEN RAISE EXCEPTION 'This route does not use terminal fare zones.' USING ERRCODE = 'P0001'; END IF;
  IF p_fare_per_seat_pkr IS NULL OR p_fare_per_seat_pkr <= 0 THEN RAISE EXCEPTION 'Enter the base fare for the full route.' USING ERRCODE = 'P0001'; END IF;

  UPDATE vehicle_routes SET fare_per_seat_pkr = p_fare_per_seat_pkr WHERE id = p_route_id;
  PERFORM recompute_route_fare_zones(p_route_id);
END;
$$;
REVOKE ALL ON FUNCTION set_route_base_fare(uuid, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_route_base_fare(uuid, decimal) TO authenticated;

-- my_vehicle_route_bookings — real display gap: the rider-announced
-- Bookings list on this page read ride_bookings directly from the
-- client with no portal_users join at all, so a genuine rider booking
-- always showed with no name. SECURITY DEFINER with the same ownership
-- gate the old direct-table RLS read implicitly required.
CREATE OR REPLACE FUNCTION my_vehicle_route_bookings(p_vehicle_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', rb.id, 'status', rb.status, 'total_amount_pkr', rb.total_amount_pkr, 'seats', rb.seats,
    'travel_date', rb.travel_date, 'rejected_reason', rb.rejected_reason, 'seat_accepted_at', rb.seat_accepted_at,
    'passenger_name', COALESCE(pu.display_name, pu.full_name),
    'passenger_mobile', pu.mobile,
    'origin', vr.origin, 'origin_ur', vr.origin_ur, 'destination', vr.destination, 'destination_ur', vr.destination_ur
  ) ORDER BY rb.created_at DESC), '[]'::jsonb)
  FROM ride_bookings rb
  JOIN vehicle_routes vr ON vr.id = rb.route_id
  LEFT JOIN portal_users pu ON pu.id = rb.portal_user_id
  WHERE vr.vehicle_id = p_vehicle_id AND can_manage_vehicle(p_vehicle_id)
  LIMIT 20;
$$;
REVOKE ALL ON FUNCTION my_vehicle_route_bookings(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_vehicle_route_bookings(uuid) TO authenticated;
