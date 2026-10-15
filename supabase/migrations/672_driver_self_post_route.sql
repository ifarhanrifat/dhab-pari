-- Migration 672: drivers can post their own city/sharing route.
--
-- Today vehicle_routes is only ever inserted by the committee admin
-- (vehicle_routes_write requires current_admin_permission('manage_parties'),
-- which no portal_user ever has) -- confirmed live, not assumed, before
-- writing this. This adds a self-serve SECURITY DEFINER path for a
-- vehicle's own owner, mirroring the admin composer's own payload
-- fields exactly (src/app/admin/(dashboard)/vehicles/page.tsx's
-- saveRoute()), so the row this produces is indistinguishable from one
-- the committee posted. Needed as the attachment point for the
-- immediately-after-posting "advertise this ride" prompt.

CREATE OR REPLACE FUNCTION public.create_vehicle_route_self(
  p_vehicle_id uuid,
  p_origin varchar,
  p_destination varchar,
  p_classification varchar,
  p_fare_mode varchar,
  p_total_fare_pkr decimal,
  p_departure_time time DEFAULT NULL,
  p_days_of_week int[] DEFAULT '{}',
  p_origin_ur varchar DEFAULT NULL,
  p_destination_ur varchar DEFAULT NULL,
  p_origin_lat decimal DEFAULT NULL,
  p_origin_lng decimal DEFAULT NULL,
  p_destination_lat decimal DEFAULT NULL,
  p_destination_lng decimal DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
$$;
