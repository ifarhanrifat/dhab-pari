-- Migration 895: HOTFIX — the same overload-duplication bug class as
-- 894, confirmed live on a second function (update_vehicle_route_
-- schedule: 6-param and 7-param versions both still callable).
-- Rather than discover and fix these one at a time via repeated round
-- trips, this drops EVERY existing overload of all 9 functions 893
-- touched, then recreates each as the single correct version (893's
-- body, unchanged) — guaranteeing no stale pre-893 overload (with the
-- old can_manage_vehicle gate) is still reachable under any of these
-- names.

DO $$
DECLARE r record; v_names text[] := ARRAY[
  'create_vehicle_route_self', 'update_vehicle_route_schedule', 'close_vehicle_route', 'set_route_seat_override',
  'set_route_service_class', 'set_route_amenities', 'set_route_co_driver', 'set_vehicle_document'
];
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY(v_names)
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

CREATE FUNCTION update_vehicle_route_schedule(
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

CREATE FUNCTION public.close_vehicle_route(p_route_id uuid, p_reason text)
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

CREATE FUNCTION set_route_seat_override(p_route_id uuid, p_seat_override int) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vehicle_routes vr WHERE vr.id = p_route_id AND can_administer_vehicle(vr.vehicle_id)) THEN
    RAISE EXCEPTION 'You can only edit your own route.' USING ERRCODE = 'P0001';
  END IF;
  IF p_seat_override IS NOT NULL AND p_seat_override <= 0 THEN RAISE EXCEPTION 'Seat count must be at least 1.' USING ERRCODE = 'P0001'; END IF;
  UPDATE vehicle_routes SET seat_override = p_seat_override WHERE id = p_route_id;
END;
$$;

CREATE FUNCTION set_route_service_class(p_route_id uuid, p_service_class varchar DEFAULT NULL) RETURNS void
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

CREATE FUNCTION set_route_amenities(p_route_id uuid, p_amenities varchar[]) RETURNS void
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

CREATE FUNCTION set_route_co_driver(p_route_id uuid, p_co_driver_mobile varchar DEFAULT NULL, p_min_shift_hours int DEFAULT 8) RETURNS void
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

CREATE FUNCTION set_vehicle_document(p_vehicle_id uuid, p_document_type varchar, p_expiry_date date, p_file_url text DEFAULT NULL) RETURNS void
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

GRANT EXECUTE ON FUNCTION create_vehicle_route_self(uuid, varchar, varchar, varchar, varchar, numeric, time, integer[], varchar, varchar, numeric, numeric, numeric, numeric, numeric, jsonb, numeric, time, boolean, numeric, boolean, int, date, varchar, integer[]) TO authenticated;
GRANT EXECUTE ON FUNCTION update_vehicle_route_schedule(uuid, time, int[], time, boolean, int, int[]) TO authenticated;
GRANT EXECUTE ON FUNCTION close_vehicle_route(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION set_route_seat_override(uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION set_route_service_class(uuid, varchar) TO authenticated;
GRANT EXECUTE ON FUNCTION set_route_amenities(uuid, varchar[]) TO authenticated;
GRANT EXECUTE ON FUNCTION set_route_co_driver(uuid, varchar, int) TO authenticated;
GRANT EXECUTE ON FUNCTION set_vehicle_document(uuid, varchar, date, text) TO authenticated;
