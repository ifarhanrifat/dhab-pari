-- Real gap found live, 2026-10-26, comparing the reference design's own
-- machinery/loader booking screens against ours: both ask "تاریخ اور
-- وقت" (date and time) before submitting — when the work should
-- actually happen — and equipment_bookings has no such column at all.
-- A request today was implicitly "whenever the owner gets to it," with
-- no way for a rider to ask for a specific day/time up front.
ALTER TABLE equipment_bookings ADD COLUMN IF NOT EXISTS scheduled_date date;
ALTER TABLE equipment_bookings ADD COLUMN IF NOT EXISTS scheduled_time time;

DROP FUNCTION IF EXISTS create_equipment_booking(uuid, varchar, varchar, int, text, varchar, decimal, decimal, text, varchar, uuid, text, decimal, decimal, int);

CREATE OR REPLACE FUNCTION create_equipment_booking(
  p_vehicle_id uuid, p_kind varchar, p_service_key varchar, p_hours int, p_site_address text, p_material varchar,
  p_site_lat decimal DEFAULT NULL, p_site_lng decimal DEFAULT NULL, p_notes text DEFAULT NULL, p_payment_method varchar DEFAULT 'cash',
  p_accepted_offer_id uuid DEFAULT NULL,
  p_pickup_address text DEFAULT NULL, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL, p_trip_count int DEFAULT 1,
  p_scheduled_date date DEFAULT NULL, p_scheduled_time time DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v vehicles%ROWTYPE;
  v_rate decimal;
  v_mobilization decimal := 0;
  v_booking_id uuid;
  v_offer machinery_rate_offers%ROWTYPE;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_kind NOT IN ('machinery', 'tractor', 'loader') THEN RAISE EXCEPTION 'Unknown booking kind.' USING ERRCODE = 'P0001'; END IF;
  IF p_site_address IS NULL OR trim(p_site_address) = '' THEN RAISE EXCEPTION 'Enter the site address.' USING ERRCODE = 'P0001'; END IF;
  IF p_scheduled_date IS NULL THEN RAISE EXCEPTION 'Pick a date for this job.' USING ERRCODE = 'P0001'; END IF;
  IF p_scheduled_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date that has not already passed.' USING ERRCODE = 'P0001'; END IF;
  IF p_kind = 'loader' THEN
    IF p_pickup_address IS NULL OR trim(p_pickup_address) = '' THEN RAISE EXCEPTION 'Enter where to pick the goods up from.' USING ERRCODE = 'P0001'; END IF;
    IF p_trip_count IS NULL OR p_trip_count <= 0 THEN RAISE EXCEPTION 'Enter how many trips you need.' USING ERRCODE = 'P0001'; END IF;
  END IF;

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

    IF p_accepted_offer_id IS NOT NULL THEN
      SELECT * INTO v_offer FROM machinery_rate_offers
        WHERE id = p_accepted_offer_id AND vehicle_id = p_vehicle_id AND portal_user_id = v_portal_user_id AND status = 'accepted' AND equipment_booking_id IS NULL
        FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'This negotiated rate is no longer available.' USING ERRCODE = 'P0001'; END IF;
      v_rate := COALESCE(v_offer.counter_rate_pkr, v_offer.proposed_rate_pkr);
    END IF;
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

  INSERT INTO equipment_bookings (
    portal_user_id, vehicle_id, kind, service_key, site_address, site_lat, site_lng, material, requested_hours,
    rate_pkr, mobilization_fee_pkr, pin, notes, payment_method, pickup_address, pickup_lat, pickup_lng, trip_count,
    scheduled_date, scheduled_time
  )
  VALUES (
    v_portal_user_id, p_vehicle_id, p_kind, p_service_key, trim(p_site_address), p_site_lat, p_site_lng, p_material, p_hours,
    v_rate, v_mobilization, lpad(floor(random() * 10000)::text, 4, '0'), NULLIF(trim(p_notes), ''), COALESCE(p_payment_method, 'cash'),
    NULLIF(trim(coalesce(p_pickup_address, '')), ''), p_pickup_lat, p_pickup_lng, GREATEST(COALESCE(p_trip_count, 1), 1),
    p_scheduled_date, p_scheduled_time
  )
  RETURNING id INTO v_booking_id;

  IF p_accepted_offer_id IS NOT NULL THEN
    UPDATE machinery_rate_offers SET equipment_booking_id = v_booking_id WHERE id = p_accepted_offer_id;
  END IF;

  PERFORM ensure_booking_thread('equipment_booking', v_booking_id, p_vehicle_id, v_portal_user_id, trim(coalesce(v.model, v.vehicle_type)) || ' — ' || p_kind);

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'equipment_booking_requested', 'New ' || p_kind || ' request', trim(p_site_address), '/portal/my-vehicle/equipment');
  END IF;

  RETURN v_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_equipment_booking(uuid, varchar, varchar, int, text, varchar, decimal, decimal, text, varchar, uuid, text, decimal, decimal, int, date, time) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_equipment_booking(uuid, varchar, varchar, int, text, varchar, decimal, decimal, text, varchar, uuid, text, decimal, decimal, int, date, time) TO authenticated;

-- my_equipment_bookings / vehicle_equipment_bookings: surface the new
-- columns (both build their rows field-by-field, so they need it added
-- explicitly or it'd never reach either side).
CREATE OR REPLACE FUNCTION my_equipment_bookings() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'kind', b.kind, 'service_key', b.service_key, 'site_address', b.site_address, 'site_lat', b.site_lat, 'site_lng', b.site_lng, 'material', b.material,
    'requested_hours', b.requested_hours, 'status', b.status, 'decline_reason', b.decline_reason, 'rate_pkr', b.rate_pkr, 'mobilization_fee_pkr', b.mobilization_fee_pkr, 'pin', b.pin,
    'actual_hours', b.actual_hours, 'total_amount_pkr', b.total_amount_pkr,
    'notes', b.notes, 'payment_method', b.payment_method,
    'pickup_address', b.pickup_address, 'pickup_lat', b.pickup_lat, 'pickup_lng', b.pickup_lng, 'trip_count', b.trip_count,
    'scheduled_date', b.scheduled_date, 'scheduled_time', b.scheduled_time,
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
    'pickup_address', b.pickup_address, 'pickup_lat', b.pickup_lat, 'pickup_lng', b.pickup_lng, 'trip_count', b.trip_count,
    'scheduled_date', b.scheduled_date, 'scheduled_time', b.scheduled_time,
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
