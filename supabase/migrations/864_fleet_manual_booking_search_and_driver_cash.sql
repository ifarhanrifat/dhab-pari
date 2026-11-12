-- Migration 864: manual-booking station-manager workflow + driver cash
-- reconciliation + two small allow-list widenings for the fleet admin
-- restyle. Real asks, researched this session:
-- 1. A counter/fleet manager needs to find an existing booking (by
--    passenger name/mobile), reschedule or cancel it, see all of
--    today's bookings, and check a future-dated run's seat position.
--    Confirmed gaps: no search exists across either booking source, no
--    reschedule path exists for counter-sold (manual_ride_bookings)
--    bookings at all, and the counter Bookings tab is hardcoded to
--    today's date.
-- 2. Driver-collected cash (ride_bookings paid announced_method='cash'
--    — every regular app booking AND every mid-route "catch" booking)
--    has ZERO connection to the counter/remittance system built in
--    855 — confirmed live, no counter_id on ride_bookings at all, no
--    driver-level cash tracking anywhere. Mirrors fleet_counter_
--    remittances exactly, scoped to vehicle_id instead of counter_id.
-- 3. driver_photo_for_vehicle (768) and set_vehicle_catalog_prefs (838)
--    both gate on the vehicle's own portal_user_id directly — a fleet
--    owner/staff member can't see a driver's photo or edit a vehicle
--    they don't personally drive, through any screen. Both get one
--    narrow can_manage_vehicle() branch added, nothing else changed.

-- ═════════════════════════════════════════════════════════════════════
-- 1. service_code — optional, cosmetic/organizational route label.
-- ═════════════════════════════════════════════════════════════════════
ALTER TABLE vehicle_routes ADD COLUMN IF NOT EXISTS service_code varchar;

-- create_vehicle_route_self's real latest body (847) is considerably
-- different from an earlier draft of this migration assumed (server-
-- derived fare_mode by vehicle_kind, a one-active-route-per-vehicle
-- guard, fare-band auto-pricing) — verified against 847 directly before
-- writing this, not from memory. Adding one new trailing parameter
-- changes the argument-type signature, so CREATE OR REPLACE alone would
-- add a second overload rather than replace it (the same overload trap
-- already hit and fixed twice this session, 849/863) — the old 23-arg
-- signature is dropped explicitly first.
DROP FUNCTION IF EXISTS public.create_vehicle_route_self(
  uuid, character varying, character varying, character varying, character varying, numeric,
  time without time zone, integer[], character varying, character varying, numeric, numeric, numeric, numeric,
  numeric, jsonb, numeric, time without time zone, boolean, numeric, boolean, int, date
);

CREATE OR REPLACE FUNCTION public.create_vehicle_route_self(
  p_vehicle_id uuid, p_origin character varying, p_destination character varying, p_classification character varying, p_fare_mode character varying,
  p_total_fare_pkr numeric DEFAULT NULL::numeric, p_departure_time time without time zone DEFAULT NULL::time without time zone,
  p_days_of_week integer[] DEFAULT '{}'::integer[], p_origin_ur character varying DEFAULT NULL::character varying, p_destination_ur character varying DEFAULT NULL::character varying,
  p_origin_lat numeric DEFAULT NULL::numeric, p_origin_lng numeric DEFAULT NULL::numeric, p_destination_lat numeric DEFAULT NULL::numeric, p_destination_lng numeric DEFAULT NULL::numeric,
  p_distance_km numeric DEFAULT NULL::numeric, p_route_path jsonb DEFAULT NULL::jsonb, p_route_duration_min numeric DEFAULT NULL::numeric,
  p_return_departure_time time without time zone DEFAULT NULL::time without time zone, p_is_monthly_fixed boolean DEFAULT false,
  p_monthly_reference_fee_pkr numeric DEFAULT NULL::numeric, p_is_two_way boolean DEFAULT false, p_return_wait_minutes int DEFAULT NULL,
  p_one_off_date date DEFAULT NULL::date, p_service_code character varying DEFAULT NULL::character varying
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

  IF NOT can_manage_vehicle(p_vehicle_id) THEN
    RAISE EXCEPTION 'You can only post a route for your own vehicle, or one in a fleet you own';
  END IF;
  SELECT v.tenant_id, v.total_seats, vc.vehicle_kind INTO v_tenant_id, v_seats, v_vehicle_kind
    FROM vehicles v LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
    WHERE v.id = p_vehicle_id AND v.is_active = true;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'That vehicle is not available';
  END IF;

  v_fare_mode := CASE WHEN v_vehicle_kind = 'van' THEN 'fixed' ELSE 'flex' END;

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
    is_two_way, return_wait_minutes, one_off_date, service_code
  ) VALUES (
    p_vehicle_id, v_tenant_id, trim(p_origin), nullif(trim(coalesce(p_origin_ur, '')), ''), trim(p_destination), nullif(trim(coalesce(p_destination_ur, '')), ''),
    p_classification, v_fare_mode, p_total_fare_pkr, v_per_seat,
    p_departure_time, p_days_of_week, true,
    p_origin_lat, p_origin_lng, p_destination_lat, p_destination_lng, p_distance_km,
    p_route_path, p_route_duration_min, p_return_departure_time,
    p_is_monthly_fixed, p_monthly_reference_fee_pkr,
    p_is_two_way, p_return_wait_minutes, p_one_off_date, nullif(trim(coalesce(p_service_code, '')), '')
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_vehicle_route_self(
  uuid, character varying, character varying, character varying, character varying, numeric, time without time zone,
  integer[], character varying, character varying, numeric, numeric, numeric, numeric, numeric, jsonb, numeric,
  time without time zone, boolean, numeric, boolean, int, date, character varying
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_vehicle_route_self(
  uuid, character varying, character varying, character varying, character varying, numeric, time without time zone,
  integer[], character varying, character varying, numeric, numeric, numeric, numeric, numeric, jsonb, numeric,
  time without time zone, boolean, numeric, boolean, int, date, character varying
) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 2. Driver cash — mirrors fleet_counter_remittances/fleet_counter_
--    cash_positions/record_counter_remittance exactly, keyed to
--    vehicle_id instead of counter_id.
-- ═════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vehicle_cash_remittances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  note text,
  recorded_by_portal_user_id uuid REFERENCES portal_users(id),
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicle_cash_remittances_vehicle_id_idx ON vehicle_cash_remittances(vehicle_id);
ALTER TABLE vehicle_cash_remittances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vehicle_cash_remittances_manager_read" ON vehicle_cash_remittances FOR SELECT TO authenticated
  USING (can_manage_vehicle(vehicle_id) OR current_admin_permission('manage_parties'));

CREATE OR REPLACE FUNCTION record_vehicle_cash_remittance(p_vehicle_id uuid, p_amount_pkr decimal, p_note text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(p_vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF p_amount_pkr IS NULL OR p_amount_pkr <= 0 THEN RAISE EXCEPTION 'Enter a real amount.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicle_cash_remittances (vehicle_id, amount_pkr, note, recorded_by_portal_user_id)
  VALUES (p_vehicle_id, p_amount_pkr, nullif(trim(coalesce(p_note, '')), ''), v_portal_user_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION record_vehicle_cash_remittance(uuid, decimal, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_vehicle_cash_remittance(uuid, decimal, text) TO authenticated;

CREATE OR REPLACE FUNCTION fleet_vehicle_cash_positions(p_fleet_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'vehicle_id', v.id, 'owner_name', v.owner_name,
    'total_collected_pkr', COALESCE(collected.amt, 0), 'total_remitted_pkr', COALESCE(remitted.amt, 0),
    'cash_in_hand_pkr', COALESCE(collected.amt, 0) - COALESCE(remitted.amt, 0)
  ) ORDER BY v.owner_name), '[]'::jsonb) INTO v_result
  FROM vehicles v
  LEFT JOIN LATERAL (
    SELECT SUM(rb.total_amount_pkr) AS amt FROM ride_bookings rb JOIN vehicle_routes vr ON vr.id = rb.route_id
    WHERE vr.vehicle_id = v.id AND rb.announced_method = 'cash' AND rb.status = 'confirmed'
  ) collected ON true
  LEFT JOIN LATERAL (SELECT SUM(r.amount_pkr) AS amt FROM vehicle_cash_remittances r WHERE r.vehicle_id = v.id) remitted ON true
  WHERE v.fleet_id = p_fleet_id AND v.is_active;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION fleet_vehicle_cash_positions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_vehicle_cash_positions(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 3. Unified booking search across both sources (counter-sold +
--    rider-self-booked) — the backend for "find a booking" and for
--    "all of today's bookings," date-aware either way.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fleet_search_bookings(p_fleet_id uuid, p_query text DEFAULT NULL, p_travel_date date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result jsonb; v_q text := nullif(trim(coalesce(p_query, '')), '');
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'travel_date' DESC), '[]'::jsonb) INTO v_result FROM (
    SELECT jsonb_build_object(
      'id', mb.id, 'source', 'manual', 'passenger_name', mb.passenger_name, 'passenger_mobile', mb.passenger_mobile,
      'route_id', mb.route_id, 'origin', vr.origin, 'destination', vr.destination, 'owner_name', v.owner_name,
      'travel_date', mb.travel_date, 'seats', mb.seats, 'amount_pkr', mb.total_amount_pkr,
      'status', mb.status, 'payment_method', mb.payment_method
    ) AS row
    FROM manual_ride_bookings mb JOIN vehicle_routes vr ON vr.id = mb.route_id JOIN vehicles v ON v.id = vr.vehicle_id
    WHERE v.fleet_id = p_fleet_id AND mb.status = 'confirmed'
      AND (p_travel_date IS NULL OR mb.travel_date = p_travel_date)
      AND (v_q IS NULL OR mb.passenger_name ILIKE '%' || v_q || '%' OR mb.passenger_mobile ILIKE '%' || v_q || '%')

    UNION ALL

    SELECT jsonb_build_object(
      'id', rb.id, 'source', 'app', 'passenger_name', pu.full_name, 'passenger_mobile', pu.mobile,
      'route_id', rb.route_id, 'origin', vr.origin, 'destination', vr.destination, 'owner_name', v.owner_name,
      'travel_date', rb.travel_date, 'seats', rb.seats, 'amount_pkr', rb.total_amount_pkr,
      'status', rb.status, 'payment_method', rb.announced_method
    ) AS row
    FROM ride_bookings rb JOIN vehicle_routes vr ON vr.id = rb.route_id JOIN vehicles v ON v.id = vr.vehicle_id
    JOIN portal_users pu ON pu.id = rb.portal_user_id
    WHERE v.fleet_id = p_fleet_id AND rb.status IN ('announced', 'confirmed')
      AND (p_travel_date IS NULL OR rb.travel_date = p_travel_date)
      AND (v_q IS NULL OR pu.full_name ILIKE '%' || v_q || '%' OR pu.mobile ILIKE '%' || v_q || '%')
  ) rows;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION fleet_search_bookings(uuid, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_search_bookings(uuid, text, date) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 4. reschedule_manual_booking — no reschedule path existed for
--    counter-sold bookings at all; mirrors reschedule_ride_booking's
--    weekday + seat-availability constraints, simpler (no stop-segment
--    fare recompute — a manual sale's amount is staff-entered, not
--    formula-derived).
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION reschedule_manual_booking(p_id uuid, p_new_travel_date date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE mb manual_ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v_available int; v_weekday int;
BEGIN
  SELECT * INTO mb FROM manual_ride_bookings WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_routes WHERE id = mb.route_id;
  IF NOT can_manage_vehicle(r.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF mb.status != 'confirmed' THEN RAISE EXCEPTION 'This booking can no longer be rescheduled.' USING ERRCODE = 'P0001'; END IF;
  IF p_new_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;

  v_weekday := extract(dow FROM p_new_travel_date)::int;
  IF NOT (v_weekday = ANY(r.days_of_week)) THEN RAISE EXCEPTION 'This route does not run on that day.' USING ERRCODE = 'P0001'; END IF;

  v_available := route_seats_available(mb.route_id, p_new_travel_date);
  IF mb.seats > v_available THEN RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001'; END IF;

  UPDATE manual_ride_bookings SET travel_date = p_new_travel_date WHERE id = p_id;
  BEGIN
    UPDATE ride_booking_seat_numbers SET travel_date = p_new_travel_date WHERE manual_ride_booking_id = p_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'That seat is already taken by someone else on that date — pick a different date.' USING ERRCODE = 'P0001';
  END;
END;
$$;
REVOKE ALL ON FUNCTION reschedule_manual_booking(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reschedule_manual_booking(uuid, date) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 5. Two narrow allow-list widenings — a fleet owner/staff member is
--    that vehicle's own employer, structurally the same relationship
--    current_admin_permission('manage_parties') is already trusted
--    with on both functions; only a branch is added, nothing removed.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION driver_photo_for_vehicle(p_vehicle_id uuid) RETURNS text AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_photo text;
BEGIN
  IF v_portal_user_id IS NULL THEN RETURN NULL; END IF;
  IF NOT (
    EXISTS (SELECT 1 FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id)
    OR EXISTS (SELECT 1 FROM vehicle_trip_bookings WHERE vehicle_id = p_vehicle_id AND portal_user_id = v_portal_user_id)
    OR EXISTS (SELECT 1 FROM hourly_bookings WHERE vehicle_id = p_vehicle_id AND portal_user_id = v_portal_user_id)
    OR EXISTS (SELECT 1 FROM equipment_bookings WHERE vehicle_id = p_vehicle_id AND portal_user_id = v_portal_user_id)
    OR EXISTS (SELECT 1 FROM rental_bookings WHERE vehicle_id = p_vehicle_id AND portal_user_id = v_portal_user_id)
    OR can_manage_vehicle(p_vehicle_id)
    OR COALESCE(current_admin_permission('manage_parties'), false)
  ) THEN RETURN NULL; END IF;

  SELECT driver_photo_url INTO v_photo FROM vehicle_registration_requests
  WHERE vehicle_id = p_vehicle_id AND driver_photo_url IS NOT NULL
  ORDER BY created_at DESC LIMIT 1;
  RETURN v_photo;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION set_vehicle_catalog_prefs(
  p_vehicle_id uuid, p_color text, p_model text, p_has_ac boolean, p_offers_hourly boolean, p_offers_shadi boolean,
  p_offers_rental boolean DEFAULT NULL::boolean, p_shadi_vehicle_class character varying DEFAULT NULL::character varying,
  p_rental_tier character varying DEFAULT NULL::character varying, p_model_year int DEFAULT NULL,
  p_is_sleeper boolean DEFAULT NULL
) RETURNS void AS $$
DECLARE v vehicles%ROWTYPE; v_is_admin boolean; v_tier varchar;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  v_is_admin := COALESCE(current_admin_permission('manage_parties'), false);
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id() OR can_manage_vehicle(p_vehicle_id)) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;

  v_tier := v.rental_tier;
  IF v_is_admin AND p_rental_tier IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM rental_tier_fare_guides g WHERE g.tenant_id = v.tenant_id AND g.tier_key = p_rental_tier) THEN
      RAISE EXCEPTION 'Unknown rental category.' USING ERRCODE = 'P0001';
    END IF;
    v_tier := p_rental_tier;
  END IF;

  IF (p_offers_hourly OR COALESCE(p_offers_rental, false))
     AND (v_tier IS NULL OR NOT EXISTS (SELECT 1 FROM rental_tier_fare_guides g WHERE g.tenant_id = v.tenant_id AND g.tier_key = v_tier)) THEN
    RAISE EXCEPTION 'Ask the committee to set your rental category before turning this on — hourly and rental bookings are matched and priced by that category.' USING ERRCODE = 'P0001';
  END IF;
  IF p_offers_shadi AND v.shadi_full_day_rate_pkr IS NULL THEN
    RAISE EXCEPTION 'Ask the committee to set your full-day wedding rate before turning this on.' USING ERRCODE = 'P0001';
  END IF;
  IF p_shadi_vehicle_class IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM shadi_vehicle_classes WHERE class_key = p_shadi_vehicle_class AND is_active) THEN
      RAISE EXCEPTION 'Unknown vehicle type.' USING ERRCODE = 'P0001';
    END IF;
    IF (p_shadi_vehicle_class = 'hiace' AND v.vehicle_type NOT ILIKE '%hiace%')
      OR (p_shadi_vehicle_class = 'bolan' AND v.vehicle_type NOT ILIKE '%bolan%')
      OR (p_shadi_vehicle_class = 'sedan' AND (v.vehicle_type ILIKE '%hiace%' OR v.vehicle_type ILIKE '%bolan%'))
    THEN
      RAISE EXCEPTION 'This wedding-vehicle category doesn''t match your registered vehicle (%). Ask the committee if you think this is wrong.', v.vehicle_type USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE vehicles SET
    color = NULLIF(trim(p_color), ''), model = NULLIF(trim(p_model), ''),
    has_ac = p_has_ac, offers_hourly = p_offers_hourly, offers_shadi = p_offers_shadi,
    offers_rental = COALESCE(p_offers_rental, offers_rental),
    shadi_vehicle_class = CASE WHEN p_shadi_vehicle_class IS NOT NULL THEN p_shadi_vehicle_class ELSE shadi_vehicle_class END,
    rental_tier = v_tier,
    model_year = COALESCE(p_model_year, model_year),
    is_sleeper = COALESCE(p_is_sleeper, is_sleeper)
  WHERE id = p_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════
-- 6. Two new stat-card numbers for the Dashboard restyle.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fleet_departure_stats(p_fleet_id uuid, p_date date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_date date := COALESCE(p_date, (now() AT TIME ZONE 'Asia/Karachi')::date);
  v_dow int := extract(dow FROM v_date)::int;
  v_bookings_today int; v_runs_scheduled int; v_runs_departed int;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  SELECT
    (SELECT COUNT(*) FROM manual_ride_bookings mb JOIN vehicle_routes vr ON vr.id = mb.route_id JOIN vehicles v ON v.id = vr.vehicle_id
       WHERE v.fleet_id = p_fleet_id AND mb.travel_date = v_date AND mb.status = 'confirmed')
    + (SELECT COUNT(*) FROM ride_bookings rb JOIN vehicle_routes vr ON vr.id = rb.route_id JOIN vehicles v ON v.id = vr.vehicle_id
       WHERE v.fleet_id = p_fleet_id AND rb.travel_date = v_date AND rb.status IN ('announced', 'confirmed')),
    (SELECT COUNT(*) FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id
       WHERE v.fleet_id = p_fleet_id AND v.is_active AND vr.is_active AND v_dow = ANY(vr.days_of_week)),
    (SELECT COUNT(*) FROM route_runs run JOIN vehicle_routes vr ON vr.id = run.route_id JOIN vehicles v ON v.id = vr.vehicle_id
       WHERE v.fleet_id = p_fleet_id AND run.started_at::date = v_date AND run.direction = 'outbound')
  INTO v_bookings_today, v_runs_scheduled, v_runs_departed;

  RETURN jsonb_build_object('bookings_today_count', v_bookings_today, 'runs_scheduled', v_runs_scheduled, 'runs_departed', v_runs_departed);
END;
$$;
REVOKE ALL ON FUNCTION fleet_departure_stats(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_departure_stats(uuid, date) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 7. Real gap found while wiring the Cancel/Reschedule buttons onto
--    fleet_search_bookings' 'app'-source rows: cancel_ride_booking (850)
--    only recognizes the rider, the vehicle's own driver (v.portal_
--    user_id), or an admin — a fleet owner/staff member who doesn't
--    personally drive that vehicle would be rejected calling it on a
--    rider's booking. reschedule_ride_booking (846) is worse — it
--    filters the booking lookup itself to portal_user_id = caller, so
--    it 404s as "not your booking" before any fleet check could even
--    run. Both widened with one added can_manage_vehicle() branch,
--    same-signature CREATE OR REPLACE (true replace, no new overload).
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION cancel_ride_booking(p_booking_id uuid, p_reason text) RETURNS jsonb AS $$
DECLARE
  b ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v vehicles%ROWTYPE;
  v_portal_user_id uuid := current_portal_user_id();
  v_is_rider boolean; v_is_driver boolean; v_is_admin boolean; v_is_fleet_manager boolean;
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
  v_is_fleet_manager := can_manage_vehicle(r.vehicle_id);
  IF NOT (v_is_rider OR v_is_driver OR v_is_admin OR v_is_fleet_manager) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  IF v_is_rider AND NOT v_is_driver AND NOT v_is_admin AND NOT v_is_fleet_manager AND b.status = 'confirmed' THEN
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

CREATE OR REPLACE FUNCTION reschedule_ride_booking(
  p_booking_id uuid, p_new_travel_date date,
  p_board_stop_id uuid DEFAULT NULL, p_alight_stop_id uuid DEFAULT NULL, p_clear_stops boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v_available int; v_weekday int;
  v_board_stop route_stops%ROWTYPE; v_alight_stop route_stops%ROWTYPE;
  v_segment_fraction numeric := 1; v_new_total numeric;
  v_use_board_stop_id uuid; v_use_alight_stop_id uuid;
  v_changing_stops boolean := p_clear_stops OR p_board_stop_id IS NOT NULL OR p_alight_stop_id IS NOT NULL;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_routes WHERE id = b.route_id;
  IF NOT (b.portal_user_id = current_portal_user_id() OR can_manage_vehicle(r.vehicle_id)) THEN
    RAISE EXCEPTION 'That is not your booking.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status NOT IN ('announced', 'confirmed') THEN RAISE EXCEPTION 'This booking can no longer be rescheduled.' USING ERRCODE = 'P0001'; END IF;
  IF b.route_id IS NULL THEN RAISE EXCEPTION 'This booking cannot be rescheduled.' USING ERRCODE = 'P0001'; END IF;
  IF p_new_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
  IF v_changing_stops AND b.status != 'announced' THEN
    RAISE EXCEPTION 'Your seat is already confirmed by the driver — cancel and book again to change your boarding stop.' USING ERRCODE = 'P0001';
  END IF;

  IF r.fare_mode = 'flex' THEN RAISE EXCEPTION 'This route''s fare depends on the date it''s booked for — cancel and rebook instead.' USING ERRCODE = 'P0001'; END IF;

  v_weekday := extract(dow FROM p_new_travel_date)::int;
  IF NOT (v_weekday = ANY(r.days_of_week)) THEN RAISE EXCEPTION 'This route does not run on that day.' USING ERRCODE = 'P0001'; END IF;

  v_available := route_seats_available(b.route_id, p_new_travel_date);
  IF b.seats > v_available THEN RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001'; END IF;

  IF p_clear_stops THEN
    v_use_board_stop_id := NULL; v_use_alight_stop_id := NULL; v_segment_fraction := 1;
  ELSIF p_board_stop_id IS NOT NULL OR p_alight_stop_id IS NOT NULL THEN
    IF (p_board_stop_id IS NULL) != (p_alight_stop_id IS NULL) THEN
      RAISE EXCEPTION 'Pick both a board and an alight stop, or neither.' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_board_stop FROM route_stops WHERE id = p_board_stop_id AND route_id = b.route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real board stop on this route.' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO v_alight_stop FROM route_stops WHERE id = p_alight_stop_id AND route_id = b.route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real alight stop on this route.' USING ERRCODE = 'P0001'; END IF;
    v_segment_fraction := route_fraction_remaining(b.route_id, v_board_stop.lat, v_board_stop.lng) - route_fraction_remaining(b.route_id, v_alight_stop.lat, v_alight_stop.lng);
    IF v_segment_fraction <= 0 THEN RAISE EXCEPTION 'The alight stop must be further along the route than the board stop.' USING ERRCODE = 'P0001'; END IF;
    v_use_board_stop_id := p_board_stop_id; v_use_alight_stop_id := p_alight_stop_id;
  ELSE
    v_use_board_stop_id := b.board_stop_id; v_use_alight_stop_id := b.alight_stop_id;
    IF b.board_stop_id IS NOT NULL AND b.alight_stop_id IS NOT NULL THEN
      SELECT * INTO v_board_stop FROM route_stops WHERE id = b.board_stop_id;
      SELECT * INTO v_alight_stop FROM route_stops WHERE id = b.alight_stop_id;
      v_segment_fraction := route_fraction_remaining(b.route_id, v_board_stop.lat, v_board_stop.lng) - route_fraction_remaining(b.route_id, v_alight_stop.lat, v_alight_stop.lng);
    END IF;
  END IF;

  v_new_total := round(b.seats * r.fare_per_seat_pkr * v_segment_fraction);

  UPDATE ride_bookings SET travel_date = p_new_travel_date, board_stop_id = v_use_board_stop_id, alight_stop_id = v_use_alight_stop_id, total_amount_pkr = v_new_total
  WHERE id = p_booking_id;
  BEGIN
    UPDATE ride_booking_seat_numbers SET travel_date = p_new_travel_date WHERE ride_booking_id = p_booking_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Your seat is already taken by someone else on that date — pick a different date.' USING ERRCODE = 'P0001';
  END;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'route_booking_rescheduled', 'A rider rescheduled their seat',
    r.origin || ' → ' || r.destination || ' — moved to ' || to_char(p_new_travel_date, 'DD Mon') || '.', '/portal/my-vehicle/routes'
  FROM vehicles v WHERE v.id = r.vehicle_id AND v.portal_user_id IS NOT NULL;
END;
$$;
GRANT EXECUTE ON FUNCTION reschedule_ride_booking(uuid, date, uuid, uuid, boolean) TO authenticated;
