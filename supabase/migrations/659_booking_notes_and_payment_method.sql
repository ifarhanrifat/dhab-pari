-- Real gaps found auditing the booking sheet against the design's own
-- `fm` object: no notes field, no payment-method selector anywhere in
-- hourly/equipment/rental booking. Additive, nullable columns; every
-- read RPC below is a straight copy of its latest prior definition
-- (652 for hourly/equipment, 653 for rental) with notes/payment_method
-- added — no other field dropped or changed.

ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS payment_method varchar DEFAULT 'cash' CHECK (payment_method IN ('cash', 'jazzcash', 'easypaisa'));

ALTER TABLE equipment_bookings ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE equipment_bookings ADD COLUMN IF NOT EXISTS payment_method varchar DEFAULT 'cash' CHECK (payment_method IN ('cash', 'jazzcash', 'easypaisa'));

ALTER TABLE rental_bookings ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE rental_bookings ADD COLUMN IF NOT EXISTS payment_method varchar DEFAULT 'cash' CHECK (payment_method IN ('cash', 'jazzcash', 'easypaisa'));

-- ── hourly ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_hourly_booking(
  p_vehicle_id uuid, p_hours int, p_pickup_address text, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL,
  p_notes text DEFAULT NULL, p_payment_method varchar DEFAULT 'cash'
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v vehicles%ROWTYPE;
  v_booking_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_hours IS NULL OR p_hours <= 0 THEN RAISE EXCEPTION 'Enter how many hours you need.' USING ERRCODE = 'P0001'; END IF;
  IF p_pickup_address IS NULL OR trim(p_pickup_address) = '' THEN RAISE EXCEPTION 'Enter a pickup address.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active AND offers_hourly FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available for hourly booking.' USING ERRCODE = 'P0001'; END IF;
  IF v.hourly_rate_pkr IS NULL THEN RAISE EXCEPTION 'This vehicle has no rate set yet.' USING ERRCODE = 'P0001'; END IF;
  IF v.portal_user_id = v_portal_user_id THEN RAISE EXCEPTION 'You cannot book your own vehicle.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO hourly_bookings (portal_user_id, vehicle_id, hours, pickup_address, pickup_lat, pickup_lng, hourly_rate_pkr, included_km, overage_per_km_pkr, base_amount_pkr, pin, notes, payment_method)
  VALUES (v_portal_user_id, p_vehicle_id, p_hours, trim(p_pickup_address), p_pickup_lat, p_pickup_lng, v.hourly_rate_pkr, COALESCE(v.hourly_included_km, 0) * p_hours, COALESCE(v.hourly_overage_per_km_pkr, 0), v.hourly_rate_pkr * p_hours, lpad(floor(random() * 10000)::text, 4, '0'), NULLIF(trim(p_notes), ''), COALESCE(p_payment_method, 'cash'))
  RETURNING id INTO v_booking_id;

  PERFORM ensure_booking_thread('hourly_booking', v_booking_id, p_vehicle_id, v_portal_user_id, trim(coalesce(v.model, v.vehicle_type)) || ' — ' || p_hours || 'h');

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'hourly_booking_requested', 'Hourly rental request',
      p_hours || ' hour(s) — Rs ' || round(v.hourly_rate_pkr * p_hours), '/portal/my-vehicle/hourly');
  END IF;

  RETURN v_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION my_hourly_bookings() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'hours', b.hours, 'status', b.status, 'pickup_address', b.pickup_address, 'pickup_lat', b.pickup_lat, 'pickup_lng', b.pickup_lng, 'decline_reason', b.decline_reason,
    'base_amount_pkr', b.base_amount_pkr, 'total_amount_pkr', b.total_amount_pkr, 'distance_km', b.distance_km, 'pin', b.pin,
    'notes', b.notes, 'payment_method', b.payment_method,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'vehicle_id', b.vehicle_id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color
  ) ORDER BY b.requested_at DESC), '[]'::jsonb)
  FROM hourly_bookings b JOIN vehicles v ON v.id = b.vehicle_id
  WHERE b.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_hourly_bookings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_hourly_bookings() TO authenticated;

CREATE OR REPLACE FUNCTION vehicle_hourly_bookings(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'hours', b.hours, 'status', b.status, 'pickup_address', b.pickup_address, 'pickup_lat', b.pickup_lat, 'pickup_lng', b.pickup_lng, 'decline_reason', b.decline_reason,
    'base_amount_pkr', b.base_amount_pkr, 'total_amount_pkr', b.total_amount_pkr, 'distance_km', b.distance_km,
    'included_km', b.included_km, 'overage_km', b.overage_km, 'overage_amount_pkr', b.overage_amount_pkr,
    'notes', b.notes, 'payment_method', b.payment_method,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at, 'status_confirmed', b.status_confirmed,
    'customer_portal_user_id', pu.id, 'customer_name', pu.full_name, 'customer_mobile', pu.mobile, 'customer_trust', portal_user_trust(pu.id)
  ) ORDER BY b.requested_at DESC), '[]'::jsonb) INTO v_result
  FROM hourly_bookings b JOIN portal_users pu ON pu.id = b.portal_user_id
  WHERE b.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_hourly_bookings(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_hourly_bookings(uuid) TO authenticated;

-- ── equipment ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_equipment_booking(
  p_vehicle_id uuid, p_kind varchar, p_service_key varchar, p_hours int, p_site_address text, p_material varchar,
  p_site_lat decimal DEFAULT NULL, p_site_lng decimal DEFAULT NULL, p_notes text DEFAULT NULL, p_payment_method varchar DEFAULT 'cash'
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v vehicles%ROWTYPE;
  v_rate decimal;
  v_mobilization decimal := 0;
  v_booking_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_kind NOT IN ('machinery', 'tractor', 'loader') THEN RAISE EXCEPTION 'Unknown booking kind.' USING ERRCODE = 'P0001'; END IF;
  IF p_site_address IS NULL OR trim(p_site_address) = '' THEN RAISE EXCEPTION 'Enter the site address.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF v.portal_user_id = v_portal_user_id THEN RAISE EXCEPTION 'You cannot book your own vehicle.' USING ERRCODE = 'P0001'; END IF;

  IF p_kind = 'machinery' THEN
    IF NOT v.offers_machinery OR v.machinery_hourly_rate_pkr IS NULL THEN
      RAISE EXCEPTION 'This vehicle is not available for machinery booking.' USING ERRCODE = 'P0001';
    END IF;
    IF p_hours IS NULL OR p_hours <= 0 THEN RAISE EXCEPTION 'Enter how many hours you need.' USING ERRCODE = 'P0001'; END IF;
    IF v.machinery_min_hours IS NOT NULL AND p_hours < v.machinery_min_hours THEN
      RAISE EXCEPTION 'This machine has a minimum of % hours.', v.machinery_min_hours USING ERRCODE = 'P0001';
    END IF;
    v_rate := v.machinery_hourly_rate_pkr;
    v_mobilization := COALESCE(v.machinery_mobilization_fee_pkr, 0);
  ELSIF p_kind = 'tractor' THEN
    IF NOT v.offers_tractor THEN RAISE EXCEPTION 'This vehicle is not available for tractor booking.' USING ERRCODE = 'P0001'; END IF;
    IF p_hours IS NULL OR p_hours <= 0 THEN RAISE EXCEPTION 'Enter how many hours you need.' USING ERRCODE = 'P0001'; END IF;
    SELECT rate_pkr INTO v_rate FROM tractor_services WHERE vehicle_id = p_vehicle_id AND service_key = p_service_key;
    IF v_rate IS NULL THEN RAISE EXCEPTION 'Choose a valid service for this tractor.' USING ERRCODE = 'P0001'; END IF;
  ELSE
    IF NOT v.offers_loader OR v.loader_trip_rate_pkr IS NULL THEN
      RAISE EXCEPTION 'This vehicle is not available for loader booking.' USING ERRCODE = 'P0001';
    END IF;
    v_rate := v.loader_trip_rate_pkr;
  END IF;

  INSERT INTO equipment_bookings (portal_user_id, vehicle_id, kind, service_key, site_address, site_lat, site_lng, material, requested_hours, rate_pkr, mobilization_fee_pkr, pin, notes, payment_method)
  VALUES (v_portal_user_id, p_vehicle_id, p_kind, p_service_key, trim(p_site_address), p_site_lat, p_site_lng, p_material, p_hours, v_rate, v_mobilization, lpad(floor(random() * 10000)::text, 4, '0'), NULLIF(trim(p_notes), ''), COALESCE(p_payment_method, 'cash'))
  RETURNING id INTO v_booking_id;

  PERFORM ensure_booking_thread('equipment_booking', v_booking_id, p_vehicle_id, v_portal_user_id, trim(coalesce(v.model, v.vehicle_type)) || ' — ' || p_kind);

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'equipment_booking_requested', 'New ' || p_kind || ' request', trim(p_site_address), '/portal/my-vehicle/equipment');
  END IF;

  RETURN v_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION my_equipment_bookings() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'kind', b.kind, 'service_key', b.service_key, 'site_address', b.site_address, 'site_lat', b.site_lat, 'site_lng', b.site_lng, 'material', b.material,
    'requested_hours', b.requested_hours, 'status', b.status, 'decline_reason', b.decline_reason, 'rate_pkr', b.rate_pkr, 'mobilization_fee_pkr', b.mobilization_fee_pkr, 'pin', b.pin,
    'actual_hours', b.actual_hours, 'total_amount_pkr', b.total_amount_pkr,
    'notes', b.notes, 'payment_method', b.payment_method,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'vehicle_id', b.vehicle_id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color
  ) ORDER BY b.requested_at DESC), '[]'::jsonb)
  FROM equipment_bookings b JOIN vehicles v ON v.id = b.vehicle_id
  WHERE b.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_equipment_bookings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_equipment_bookings() TO authenticated;

CREATE OR REPLACE FUNCTION vehicle_equipment_bookings(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'kind', b.kind, 'service_key', b.service_key, 'site_address', b.site_address, 'site_lat', b.site_lat, 'site_lng', b.site_lng, 'material', b.material,
    'requested_hours', b.requested_hours, 'status', b.status, 'decline_reason', b.decline_reason, 'rate_pkr', b.rate_pkr, 'mobilization_fee_pkr', b.mobilization_fee_pkr,
    'actual_hours', b.actual_hours, 'total_amount_pkr', b.total_amount_pkr, 'status_confirmed', b.status_confirmed,
    'notes', b.notes, 'payment_method', b.payment_method,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'customer_portal_user_id', pu.id, 'customer_name', pu.full_name, 'customer_mobile', pu.mobile
  ) ORDER BY b.requested_at DESC), '[]'::jsonb) INTO v_result
  FROM equipment_bookings b JOIN portal_users pu ON pu.id = b.portal_user_id
  WHERE b.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_equipment_bookings(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_equipment_bookings(uuid) TO authenticated;

-- ── rental ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_rental_booking(
  p_vehicle_id uuid, p_from_address text, p_from_lat decimal, p_from_lng decimal,
  p_to_address text, p_to_lat decimal, p_to_lng decimal, p_trip_type varchar, p_wait_hours int DEFAULT 0,
  p_notes text DEFAULT NULL, p_payment_method varchar DEFAULT 'cash'
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v vehicles%ROWTYPE;
  v_km decimal; v_trip_amount decimal; v_wait_amount decimal; v_total decimal;
  v_booking_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_trip_type NOT IN ('one', 'return') THEN RAISE EXCEPTION 'Choose one-way or return.' USING ERRCODE = 'P0001'; END IF;
  IF p_from_address IS NULL OR trim(p_from_address) = '' THEN RAISE EXCEPTION 'Enter a pickup location.' USING ERRCODE = 'P0001'; END IF;
  IF p_to_address IS NULL OR trim(p_to_address) = '' THEN RAISE EXCEPTION 'Enter a destination.' USING ERRCODE = 'P0001'; END IF;
  IF p_from_lat IS NULL OR p_from_lng IS NULL OR p_to_lat IS NULL OR p_to_lng IS NULL THEN
    RAISE EXCEPTION 'Pin both the pickup and destination on the map.' USING ERRCODE = 'P0001';
  END IF;
  IF p_wait_hours IS NULL OR p_wait_hours < 0 THEN p_wait_hours := 0; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active AND offers_rental FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available for rental.' USING ERRCODE = 'P0001'; END IF;
  IF v.rental_base_pkr IS NULL OR v.rental_per_km_pkr IS NULL THEN RAISE EXCEPTION 'This vehicle has no rate set yet.' USING ERRCODE = 'P0001'; END IF;
  IF v.portal_user_id = v_portal_user_id THEN RAISE EXCEPTION 'You cannot book your own vehicle.' USING ERRCODE = 'P0001'; END IF;

  v_km := greatest(1, round(haversine_km(p_from_lat, p_from_lng, p_to_lat, p_to_lng) * 1.3));
  v_trip_amount := round(CASE WHEN p_trip_type = 'return' THEN v_km * 2 * v.rental_per_km_pkr ELSE v_km * v.rental_per_km_pkr * 1.5 END, 2);
  v_wait_amount := CASE WHEN p_trip_type = 'return' THEN p_wait_hours * COALESCE(v.rental_wait_hour_pkr, 0) ELSE 0 END;
  v_total := v.rental_base_pkr + v_trip_amount + v_wait_amount;

  INSERT INTO rental_bookings (
    portal_user_id, vehicle_id, from_address, from_lat, from_lng, to_address, to_lat, to_lng,
    trip_type, wait_hours, km, base_amount_pkr, trip_amount_pkr, wait_amount_pkr, total_amount_pkr, pin, notes, payment_method
  ) VALUES (
    v_portal_user_id, p_vehicle_id, trim(p_from_address), p_from_lat, p_from_lng, trim(p_to_address), p_to_lat, p_to_lng,
    p_trip_type, p_wait_hours, v_km, v.rental_base_pkr, v_trip_amount, v_wait_amount, v_total, lpad(floor(random() * 10000)::text, 4, '0'), NULLIF(trim(p_notes), ''), COALESCE(p_payment_method, 'cash')
  ) RETURNING id INTO v_booking_id;

  PERFORM ensure_booking_thread('rental_booking', v_booking_id, p_vehicle_id, v_portal_user_id, trim(coalesce(v.model, v.vehicle_type)) || ' — ' || trim(p_to_address));

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'rental_booking_requested', 'Vehicle rental request',
      round(v_km) || 'km ' || (CASE WHEN p_trip_type = 'return' THEN 'return' ELSE 'one-way' END) || ' — Rs ' || round(v_total), '/portal/my-vehicle/rental');
  END IF;

  RETURN v_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION my_rental_bookings() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'from_address', b.from_address, 'from_lat', b.from_lat, 'from_lng', b.from_lng,
    'to_address', b.to_address, 'to_lat', b.to_lat, 'to_lng', b.to_lng, 'trip_type', b.trip_type, 'wait_hours', b.wait_hours,
    'km', b.km, 'status', b.status, 'decline_reason', b.decline_reason, 'pin', b.pin,
    'base_amount_pkr', b.base_amount_pkr, 'trip_amount_pkr', b.trip_amount_pkr, 'wait_amount_pkr', b.wait_amount_pkr, 'total_amount_pkr', b.total_amount_pkr,
    'notes', b.notes, 'payment_method', b.payment_method,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'vehicle_id', b.vehicle_id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color
  ) ORDER BY b.requested_at DESC), '[]'::jsonb)
  FROM rental_bookings b JOIN vehicles v ON v.id = b.vehicle_id
  WHERE b.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_rental_bookings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_rental_bookings() TO authenticated;

CREATE OR REPLACE FUNCTION vehicle_rental_bookings(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'from_address', b.from_address, 'from_lat', b.from_lat, 'from_lng', b.from_lng,
    'to_address', b.to_address, 'to_lat', b.to_lat, 'to_lng', b.to_lng, 'trip_type', b.trip_type, 'wait_hours', b.wait_hours,
    'km', b.km, 'status', b.status, 'decline_reason', b.decline_reason,
    'base_amount_pkr', b.base_amount_pkr, 'trip_amount_pkr', b.trip_amount_pkr, 'wait_amount_pkr', b.wait_amount_pkr, 'total_amount_pkr', b.total_amount_pkr, 'status_confirmed', b.status_confirmed,
    'notes', b.notes, 'payment_method', b.payment_method,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'customer_portal_user_id', pu.id, 'customer_name', pu.full_name, 'customer_mobile', pu.mobile, 'customer_trust', portal_user_trust(pu.id)
  ) ORDER BY b.requested_at DESC), '[]'::jsonb) INTO v_result
  FROM rental_bookings b JOIN portal_users pu ON pu.id = b.portal_user_id
  WHERE b.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_rental_bookings(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_rental_bookings(uuid) TO authenticated;
