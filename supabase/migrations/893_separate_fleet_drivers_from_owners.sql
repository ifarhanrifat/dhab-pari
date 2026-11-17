-- Migration 893: the real fix for "the driver can create a route, edit
-- a route" — confirmed live, every route/vehicle-configuration RPC
-- gates on can_manage_vehicle() (854), which returns true for a fleet's
-- hired employee-driver exactly the same as for the fleet owner. That
-- was correct for a solo owner-operator (monthly-fix/regular-sharing,
-- where the driver really is the business) and wrong for a fleet
-- vehicle (where the driver is just staff). This migration does NOT
-- touch can_manage_vehicle itself or any solo-vehicle behavior — it
-- adds two new helpers and swaps the gate on exactly 9 configuration
-- RPCs, each a true-replace of its exact current live body (re-read
-- directly from its latest migration file first) with only the
-- permission condition changed.

-- 1. Two new helpers. is_fleet_employee_driver is false whenever the
-- vehicle has no fleet_id, so can_administer_vehicle is byte-identical
-- to can_manage_vehicle for every solo owner-operator — zero behavior
-- change there.
CREATE OR REPLACE FUNCTION is_fleet_employee_driver(p_vehicle_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.fleet_id IS NOT NULL AND v.portal_user_id = current_portal_user_id()
  ) OR EXISTS (
    SELECT 1 FROM vehicles v JOIN fleet_staff fs ON fs.fleet_id = v.fleet_id
    WHERE v.id = p_vehicle_id AND fs.role = 'driver' AND fs.portal_user_id = current_portal_user_id()
  );
$$;

CREATE OR REPLACE FUNCTION can_administer_vehicle(p_vehicle_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT can_manage_vehicle(p_vehicle_id) AND NOT is_fleet_employee_driver(p_vehicle_id);
$$;

-- 2. create_vehicle_route_self (876) — true replace, gate swapped.
CREATE OR REPLACE FUNCTION public.create_vehicle_route_self(
  p_vehicle_id uuid, p_origin character varying, p_destination character varying, p_classification character varying, p_fare_mode character varying,
  p_total_fare_pkr numeric DEFAULT NULL::numeric, p_departure_time time without time zone DEFAULT NULL::time without time zone,
  p_days_of_week integer[] DEFAULT '{}'::integer[], p_origin_ur character varying DEFAULT NULL::character varying, p_destination_ur character varying DEFAULT NULL::character varying,
  p_origin_lat numeric DEFAULT NULL::numeric, p_origin_lng numeric DEFAULT NULL::numeric, p_destination_lat numeric DEFAULT NULL::numeric, p_destination_lng numeric DEFAULT NULL::numeric,
  p_distance_km numeric DEFAULT NULL::numeric, p_route_path jsonb DEFAULT NULL::jsonb, p_route_duration_min numeric DEFAULT NULL::numeric,
  p_return_departure_time time without time zone DEFAULT NULL::time without time zone, p_is_monthly_fixed boolean DEFAULT false,
  p_monthly_reference_fee_pkr numeric DEFAULT NULL::numeric, p_is_two_way boolean DEFAULT false, p_return_wait_minutes int DEFAULT NULL,
  p_one_off_date date DEFAULT NULL::date, p_service_code character varying DEFAULT NULL::character varying,
  p_return_days_of_week integer[] DEFAULT NULL
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

-- 3. update_vehicle_route_schedule (876) — was gated via is_route_owner
-- (which itself just calls can_manage_vehicle, plus a same-day
-- substitute-driver branch); inlined to can_administer_vehicle instead
-- of adding a parallel "is_route_administrator" helper, and the
-- substitute-driver branch is deliberately dropped here — a same-day
-- stand-in driver is exactly the kind of person who should NOT be
-- editing a route's schedule either.
CREATE OR REPLACE FUNCTION update_vehicle_route_schedule(
  p_route_id uuid, p_departure_time time, p_days_of_week int[], p_return_departure_time time DEFAULT NULL,
  p_is_two_way boolean DEFAULT NULL, p_return_wait_minutes int DEFAULT NULL, p_return_days_of_week int[] DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vehicle_routes vr WHERE vr.id = p_route_id AND can_administer_vehicle(vr.vehicle_id)) THEN
    RAISE EXCEPTION 'You can only edit your own route.' USING ERRCODE = 'P0001';
  END IF;
  IF p_days_of_week IS NULL OR array_length(p_days_of_week, 1) IS NULL THEN RAISE EXCEPTION 'Pick at least one day.' USING ERRCODE = 'P0001'; END IF;
  IF p_return_days_of_week IS NOT NULL AND array_length(p_return_days_of_week, 1) IS NULL THEN
    RAISE EXCEPTION 'Pick at least one return day, or leave it blank to match the outbound days.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicle_routes SET departure_time = p_departure_time, days_of_week = p_days_of_week, return_departure_time = p_return_departure_time,
    is_two_way = COALESCE(p_is_two_way, is_two_way), return_wait_minutes = CASE WHEN p_is_two_way IS NOT NULL THEN p_return_wait_minutes ELSE return_wait_minutes END,
    return_days_of_week = CASE WHEN p_is_two_way IS NOT NULL THEN (CASE WHEN p_is_two_way THEN p_return_days_of_week ELSE NULL END) ELSE return_days_of_week END
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

-- 4. close_vehicle_route (867) — true replace; dropped the redundant
-- "v.portal_user_id = caller" branch (can_administer_vehicle already
-- covers that exact case for a solo vehicle) so a fleet driver can no
-- longer close a route out from under the fleet.
CREATE OR REPLACE FUNCTION public.close_vehicle_route(p_route_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r vehicle_routes%ROWTYPE; v vehicles%ROWTYPE;
  v_portal_user_id uuid := current_portal_user_id();
  b RECORD;
  v_cancelled_count int := 0;
BEGIN
  SELECT * INTO r FROM vehicle_routes WHERE id = p_route_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = r.vehicle_id;

  IF NOT (can_administer_vehicle(r.vehicle_id) OR COALESCE(current_admin_permission('post_transactions'), false)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicle_routes SET is_active = false WHERE id = p_route_id;

  FOR b IN
    SELECT id FROM ride_bookings
    WHERE route_id = p_route_id AND status IN ('announced', 'confirmed') AND travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
  LOOP
    PERFORM cancel_ride_booking(b.id, COALESCE(trim(p_reason), 'Route closed by driver'));
    v_cancelled_count := v_cancelled_count + 1;
  END LOOP;

  UPDATE commercial_ilans SET status = 'rejected', rejection_reason = 'Route was closed by the driver before review.', reviewed_at = now()
    WHERE vehicle_route_id = p_route_id AND status = 'pending_approval';

  UPDATE commercial_ilans SET is_paused = true, ends_at = now()
    WHERE vehicle_route_id = p_route_id AND status = 'approved' AND (ends_at IS NULL OR ends_at > now());

  RETURN jsonb_build_object('route_id', p_route_id, 'bookings_cancelled', v_cancelled_count);
END;
$function$;

-- 5. set_route_seat_override (822) — same is_route_owner inlining as #3.
CREATE OR REPLACE FUNCTION set_route_seat_override(p_route_id uuid, p_seat_override int) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vehicle_routes vr WHERE vr.id = p_route_id AND can_administer_vehicle(vr.vehicle_id)) THEN
    RAISE EXCEPTION 'You can only edit your own route.' USING ERRCODE = 'P0001';
  END IF;
  IF p_seat_override IS NOT NULL AND p_seat_override <= 0 THEN RAISE EXCEPTION 'Seat count must be at least 1.' USING ERRCODE = 'P0001'; END IF;
  UPDATE vehicle_routes SET seat_override = p_seat_override WHERE id = p_route_id;
END;
$$;

-- 6. set_route_service_class (883) — gate swapped.
CREATE OR REPLACE FUNCTION set_route_service_class(p_route_id uuid, p_service_class varchar DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_administer_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF p_service_class IS NOT NULL AND p_service_class NOT IN ('economy', 'business', 'executive', 'sleeper', 'luxury') THEN
    RAISE EXCEPTION 'Unknown service class.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE vehicle_routes SET service_class = p_service_class WHERE id = p_route_id;
END;
$$;

-- 7. set_route_amenities (886) — gate swapped.
CREATE OR REPLACE FUNCTION set_route_amenities(p_route_id uuid, p_amenities varchar[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_administer_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (COALESCE(p_amenities, '{}') <@ ARRAY['ac', 'wifi', 'meal', 'charging', 'tv', 'toilet', 'water']::varchar[]) THEN
    RAISE EXCEPTION 'Unknown amenity.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE vehicle_routes SET amenities = COALESCE(p_amenities, '{}') WHERE id = p_route_id;
END;
$$;

-- 8. set_route_co_driver (879) — gate swapped. Assigning a co-driver is
-- a staffing decision, not something the primary driver should do
-- either, on a fleet vehicle.
CREATE OR REPLACE FUNCTION set_route_co_driver(p_route_id uuid, p_co_driver_mobile varchar DEFAULT NULL, p_min_shift_hours int DEFAULT 8) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE; v_co_driver_id uuid;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_administer_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  IF p_min_shift_hours IS NULL OR p_min_shift_hours < 1 THEN RAISE EXCEPTION 'Enter a real minimum shift length.' USING ERRCODE = 'P0001'; END IF;

  IF p_co_driver_mobile IS NOT NULL AND trim(p_co_driver_mobile) != '' THEN
    SELECT id INTO v_co_driver_id FROM portal_users WHERE mobile = trim(p_co_driver_mobile) AND is_active AND tenant_id = v_route.tenant_id;
    IF v_co_driver_id IS NULL THEN RAISE EXCEPTION 'No account found with that mobile number in your village.' USING ERRCODE = 'P0001'; END IF;
    IF v_co_driver_id = v_vehicle.portal_user_id THEN RAISE EXCEPTION 'The co-driver must be a different account than the vehicle''s own driver.' USING ERRCODE = 'P0001'; END IF;
  ELSE
    v_co_driver_id := NULL;
  END IF;

  UPDATE vehicle_routes SET co_driver_portal_user_id = v_co_driver_id, min_shift_hours = p_min_shift_hours WHERE id = p_route_id;

  IF v_co_driver_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_co_driver_id, 'route_co_driver_assigned', 'You were added as a co-driver',
      'You can now shuffle driving duty on ' || v_route.origin || ' → ' || v_route.destination || ' once you''re on duty.', '/portal/my-vehicle/routes');
  END IF;
END;
$$;

-- 9. set_vehicle_catalog_prefs (864) — true replace; dropped the
-- redundant "v.portal_user_id = caller" branch, same reasoning as #4.
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
  IF NOT (v_is_admin OR can_administer_vehicle(p_vehicle_id)) THEN
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

-- 10. set_vehicle_document (884) — gate swapped.
CREATE OR REPLACE FUNCTION set_vehicle_document(p_vehicle_id uuid, p_document_type varchar, p_expiry_date date, p_file_url text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_administer_vehicle(p_vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF p_document_type NOT IN ('route_permit', 'fitness_certificate', 'insurance', 'driver_licence') THEN
    RAISE EXCEPTION 'Unknown document type.' USING ERRCODE = 'P0001';
  END IF;
  IF p_expiry_date IS NULL THEN RAISE EXCEPTION 'Enter the expiry date.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicle_documents (vehicle_id, document_type, expiry_date, file_url, updated_by_portal_user_id)
  VALUES (p_vehicle_id, p_document_type, p_expiry_date, nullif(trim(coalesce(p_file_url, '')), ''), v_portal_user_id)
  ON CONFLICT (vehicle_id, document_type) DO UPDATE SET
    expiry_date = EXCLUDED.expiry_date,
    file_url = COALESCE(EXCLUDED.file_url, vehicle_documents.file_url),
    updated_by_portal_user_id = EXCLUDED.updated_by_portal_user_id,
    updated_at = now();
END;
$$;

-- 11. admin_approve_vehicle_registration (853) — true replace, adding
-- ONE new step at the end: when the approved vehicle belongs to a
-- fleet, also upsert a fleet_staff (role='driver') row for that same
-- person, carrying over their CNIC and photo already captured during
-- registration — unifying the two previously-disconnected "add a
-- driver" paths into one real roster.
CREATE OR REPLACE FUNCTION admin_approve_vehicle_registration(
  p_request_id uuid, p_is_village_resident boolean, p_category_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE r vehicle_registration_requests%ROWTYPE; vc vehicle_categories%ROWTYPE; v_vehicle_id uuid; v_category_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_registration_requests WHERE id = p_request_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'This request has already been reviewed.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM vehicles WHERE portal_user_id = r.portal_user_id) THEN
    RAISE EXCEPTION 'This driver already has a linked vehicle.' USING ERRCODE = 'P0001';
  END IF;

  v_category_id := COALESCE(p_category_id, r.category_id);
  IF v_category_id IS NULL THEN RAISE EXCEPTION 'This request has no category — reject it and ask the driver to resubmit.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO vc FROM vehicle_categories WHERE id = v_category_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Category not found.' USING ERRCODE = 'P0001'; END IF;

  IF r.wants_delivers AND (vc.per_km_pkr IS NULL OR vc.per_km_pkr <= 0) THEN
    RAISE EXCEPTION 'The % category has no delivery rate set yet — set it in Marketplace Reference before approving this driver for delivery.', vc.name USING ERRCODE = 'P0001';
  END IF;
  IF r.wants_hourly AND (vc.hourly_rate_pkr IS NULL OR vc.hourly_included_km IS NULL OR vc.hourly_overage_per_km_pkr IS NULL) THEN
    RAISE EXCEPTION 'The % category has no hourly rate set yet — set it in Marketplace Reference before approving this driver for hourly rental.', vc.name USING ERRCODE = 'P0001';
  END IF;
  IF r.wants_shadi AND (vc.shadi_full_day_rate_pkr IS NULL OR vc.shadi_full_day_rate_pkr <= 0) THEN
    RAISE EXCEPTION 'The % category has no shadi day-rate set yet — set it in Marketplace Reference before approving this driver for shadi bookings.', vc.name USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO vehicles (
    owner_name, vehicle_type, vehicle_number, model, color, has_ac, total_seats, portal_user_id, is_active,
    delivers, per_km_pkr, offers_hourly, hourly_rate_pkr, hourly_included_km, hourly_overage_per_km_pkr,
    offers_shadi, shadi_full_day_rate_pkr, allows_out_of_city, night_booking_enabled, category_id,
    engine_cc, is_electric, is_loader, is_luxury_declared, rental_tier, fleet_id
  ) VALUES (
    r.owner_name, r.vehicle_type, r.vehicle_number, r.model, r.color, r.has_ac, r.total_seats, r.portal_user_id, true,
    r.wants_delivers, CASE WHEN r.wants_delivers THEN vc.per_km_pkr ELSE NULL END,
    r.wants_hourly, CASE WHEN r.wants_hourly THEN vc.hourly_rate_pkr ELSE NULL END,
    CASE WHEN r.wants_hourly THEN vc.hourly_included_km ELSE NULL END, CASE WHEN r.wants_hourly THEN vc.hourly_overage_per_km_pkr ELSE NULL END,
    r.wants_shadi, CASE WHEN r.wants_shadi THEN vc.shadi_full_day_rate_pkr ELSE NULL END,
    r.wants_out_of_city, r.wants_night_booking, v_category_id,
    r.engine_cc, r.is_electric, r.is_loader, r.is_luxury_declared, vc.rental_tier_key, r.fleet_id
  ) RETURNING id INTO v_vehicle_id;

  UPDATE vehicle_registration_requests SET
    status = 'approved', is_village_resident = p_is_village_resident, reviewed_by = current_admin_user_id(), reviewed_at = now(), vehicle_id = v_vehicle_id
  WHERE id = p_request_id;

  UPDATE fleet_driver_invites SET vehicle_id = v_vehicle_id WHERE request_id = p_request_id;

  IF r.fleet_id IS NOT NULL THEN
    INSERT INTO fleet_staff (fleet_id, portal_user_id, role, cnic_number, photo_url)
    VALUES (r.fleet_id, r.portal_user_id, 'driver', r.cnic_number, r.driver_photo_url)
    ON CONFLICT (fleet_id, portal_user_id) DO UPDATE SET
      role = 'driver', cnic_number = COALESCE(fleet_staff.cnic_number, EXCLUDED.cnic_number), photo_url = COALESCE(fleet_staff.photo_url, EXCLUDED.photo_url);
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
  VALUES (r.portal_user_id, 'vehicle_registration_approved', 'Vehicle approved', r.owner_name || ' — ' || r.vehicle_type, '/portal/my-vehicle', r.tenant_id);

  RETURN v_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 12. New: owner/non-driver-staff can assign or reassign a vehicle's
-- primary driver at any time — the actual fix for "there is no way
-- the staff can add the driver for a route."
CREATE OR REPLACE FUNCTION set_vehicle_primary_driver(p_vehicle_id uuid, p_fleet_staff_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fleet_id uuid; v_driver_portal_user_id uuid;
BEGIN
  IF NOT can_administer_vehicle(p_vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  SELECT fleet_id INTO v_fleet_id FROM vehicles WHERE id = p_vehicle_id;
  IF v_fleet_id IS NULL THEN RAISE EXCEPTION 'This vehicle does not belong to a fleet.' USING ERRCODE = 'P0001'; END IF;

  SELECT portal_user_id INTO v_driver_portal_user_id FROM fleet_staff WHERE id = p_fleet_staff_id AND fleet_id = v_fleet_id AND role = 'driver';
  IF v_driver_portal_user_id IS NULL THEN RAISE EXCEPTION 'That driver is not part of this fleet.' USING ERRCODE = 'P0001'; END IF;

  UPDATE vehicles SET portal_user_id = v_driver_portal_user_id WHERE id = p_vehicle_id;
  PERFORM log_fleet_action(v_fleet_id, 'vehicle_driver_reassigned', jsonb_build_object('vehicle_id', p_vehicle_id, 'fleet_staff_id', p_fleet_staff_id));
END;
$$;

REVOKE ALL ON FUNCTION is_fleet_employee_driver(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_fleet_employee_driver(uuid) TO authenticated;
REVOKE ALL ON FUNCTION can_administer_vehicle(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION can_administer_vehicle(uuid) TO authenticated;
REVOKE ALL ON FUNCTION set_vehicle_primary_driver(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_vehicle_primary_driver(uuid, uuid) TO authenticated;
