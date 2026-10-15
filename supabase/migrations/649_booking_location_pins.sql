-- Real gap found during a full re-audit against the design file
-- (dhab-pari-mobility.html): every one of its booking sheets resolves
-- "from"/"to"/"site"/"venue" through a real map-tap location picker
-- (openPicker, storing lat/lng), never a typed address alone. Our own
-- hourly/shadi/equipment bookings only ever stored a free-text address —
-- no coordinates at all, so a driver had nothing but a sentence to find
-- the pickup/venue/site by. This adds optional lat/lng alongside the
-- existing address text (kept, since a label still helps) for all
-- three, and threads it through create + both read RPCs each.

ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS pickup_lat decimal;
ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS pickup_lng decimal;
ALTER TABLE shadi_events ADD COLUMN IF NOT EXISTS venue_lat decimal;
ALTER TABLE shadi_events ADD COLUMN IF NOT EXISTS venue_lng decimal;
ALTER TABLE equipment_bookings ADD COLUMN IF NOT EXISTS site_lat decimal;
ALTER TABLE equipment_bookings ADD COLUMN IF NOT EXISTS site_lng decimal;

-- ── hourly ───────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS create_hourly_booking(uuid, int, text);
CREATE OR REPLACE FUNCTION create_hourly_booking(p_vehicle_id uuid, p_hours int, p_pickup_address text, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL) RETURNS uuid AS $$
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

  INSERT INTO hourly_bookings (portal_user_id, vehicle_id, hours, pickup_address, pickup_lat, pickup_lng, hourly_rate_pkr, included_km, overage_per_km_pkr, base_amount_pkr)
  VALUES (v_portal_user_id, p_vehicle_id, p_hours, trim(p_pickup_address), p_pickup_lat, p_pickup_lng, v.hourly_rate_pkr, COALESCE(v.hourly_included_km, 0) * p_hours, COALESCE(v.hourly_overage_per_km_pkr, 0), v.hourly_rate_pkr * p_hours)
  RETURNING id INTO v_booking_id;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'hourly_booking_requested', 'Hourly rental request',
      p_hours || ' hour(s) — Rs ' || round(v.hourly_rate_pkr * p_hours), '/portal/my-vehicle/hourly');
  END IF;

  RETURN v_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_hourly_booking(uuid, int, text, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_hourly_booking(uuid, int, text, decimal, decimal) TO authenticated;

CREATE OR REPLACE FUNCTION my_hourly_bookings() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'hours', b.hours, 'status', b.status, 'pickup_address', b.pickup_address, 'pickup_lat', b.pickup_lat, 'pickup_lng', b.pickup_lng, 'decline_reason', b.decline_reason,
    'base_amount_pkr', b.base_amount_pkr, 'total_amount_pkr', b.total_amount_pkr, 'distance_km', b.distance_km,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color
  ) ORDER BY b.requested_at DESC), '[]'::jsonb)
  FROM hourly_bookings b JOIN vehicles v ON v.id = b.vehicle_id
  WHERE b.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

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
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at, 'status_confirmed', b.status_confirmed,
    'customer_name', pu.full_name, 'customer_mobile', pu.mobile, 'customer_trust', portal_user_trust(pu.id)
  ) ORDER BY b.requested_at DESC), '[]'::jsonb) INTO v_result
  FROM hourly_bookings b JOIN portal_users pu ON pu.id = b.portal_user_id
  WHERE b.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ── shadi ────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS create_shadi_event(date, text, decimal, text, uuid[]);
CREATE OR REPLACE FUNCTION create_shadi_event(
  p_event_date date, p_venue_address text, p_distance_km decimal, p_notes text, p_vehicle_ids uuid[],
  p_venue_lat decimal DEFAULT NULL, p_venue_lng decimal DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_event_id uuid;
  v_vehicle_id uuid;
  v vehicles%ROWTYPE;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_event_date IS NULL OR p_event_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN
    RAISE EXCEPTION 'Pick a wedding date that has not already passed.' USING ERRCODE = 'P0001';
  END IF;
  IF p_venue_address IS NULL OR trim(p_venue_address) = '' THEN RAISE EXCEPTION 'Enter the venue address.' USING ERRCODE = 'P0001'; END IF;
  IF p_distance_km IS NULL OR p_distance_km < 0 THEN RAISE EXCEPTION 'Enter the approximate distance.' USING ERRCODE = 'P0001'; END IF;
  IF p_vehicle_ids IS NULL OR array_length(p_vehicle_ids, 1) IS NULL OR array_length(p_vehicle_ids, 1) = 0 THEN
    RAISE EXCEPTION 'Select at least one vehicle.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO shadi_events (portal_user_id, event_date, venue_address, venue_lat, venue_lng, distance_km, notes)
  VALUES (v_portal_user_id, p_event_date, trim(p_venue_address), p_venue_lat, p_venue_lng, p_distance_km, NULLIF(trim(p_notes), ''))
  RETURNING id INTO v_event_id;

  FOREACH v_vehicle_id IN ARRAY p_vehicle_ids LOOP
    SELECT * INTO v FROM vehicles WHERE id = v_vehicle_id AND is_active AND offers_shadi;
    IF NOT FOUND OR v.shadi_full_day_rate_pkr IS NULL THEN
      RAISE EXCEPTION 'One of the selected vehicles is no longer available for wedding booking.' USING ERRCODE = 'P0001';
    END IF;
    IF v.portal_user_id = v_portal_user_id THEN RAISE EXCEPTION 'You cannot book your own vehicle.' USING ERRCODE = 'P0001'; END IF;

    INSERT INTO shadi_vehicle_requests (event_id, vehicle_id, full_day_rate_pkr) VALUES (v_event_id, v_vehicle_id, v.shadi_full_day_rate_pkr);
  END LOOP;

  RETURN v_event_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_shadi_event(date, text, decimal, text, uuid[], decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_shadi_event(date, text, decimal, text, uuid[], decimal, decimal) TO authenticated;

CREATE OR REPLACE FUNCTION my_shadi_events() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', e.id, 'event_date', e.event_date, 'venue_address', e.venue_address, 'venue_lat', e.venue_lat, 'venue_lng', e.venue_lng, 'distance_km', e.distance_km, 'notes', e.notes,
    'status', e.status, 'advance_pct', e.advance_pct, 'advance_amount_pkr', e.advance_amount_pkr, 'advance_rejected_reason', e.advance_rejected_reason,
    'created_at', e.created_at,
    'requests', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', r.id, 'vehicle_id', r.vehicle_id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile,
        'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color,
        'full_day_rate_pkr', r.full_day_rate_pkr, 'status', r.status, 'decline_reason', r.decline_reason, 'advance_share_pkr', r.advance_share_pkr,
        'paid_out_at', r.paid_out_at, 'withdrawn_at', r.withdrawn_at, 'replaces_request_id', r.replaces_request_id
      ) ORDER BY r.created_at), '[]'::jsonb)
      FROM shadi_vehicle_requests r JOIN vehicles v ON v.id = r.vehicle_id WHERE r.event_id = e.id
    )
  ) ORDER BY e.event_date DESC), '[]'::jsonb)
  FROM shadi_events e WHERE e.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION vehicle_shadi_requests(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'status', r.status, 'decline_reason', r.decline_reason, 'full_day_rate_pkr', r.full_day_rate_pkr, 'advance_share_pkr', r.advance_share_pkr,
    'paid_out_at', r.paid_out_at, 'withdrawn_at', r.withdrawn_at, 'replaces_request_id', r.replaces_request_id,
    'event_id', e.id, 'event_date', e.event_date, 'venue_address', e.venue_address, 'venue_lat', e.venue_lat, 'venue_lng', e.venue_lng, 'distance_km', e.distance_km, 'notes', e.notes, 'event_status', e.status,
    'customer_name', pu.full_name, 'customer_mobile', pu.mobile, 'customer_trust', portal_user_trust(pu.id)
  ) ORDER BY e.event_date), '[]'::jsonb) INTO v_result
  FROM shadi_vehicle_requests r JOIN shadi_events e ON e.id = r.event_id JOIN portal_users pu ON pu.id = e.portal_user_id
  WHERE r.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ── equipment ────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS create_equipment_booking(uuid, varchar, varchar, int, text, varchar);
CREATE OR REPLACE FUNCTION create_equipment_booking(
  p_vehicle_id uuid, p_kind varchar, p_service_key varchar, p_hours int, p_site_address text, p_material varchar,
  p_site_lat decimal DEFAULT NULL, p_site_lng decimal DEFAULT NULL
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

  INSERT INTO equipment_bookings (portal_user_id, vehicle_id, kind, service_key, site_address, site_lat, site_lng, material, requested_hours, rate_pkr, mobilization_fee_pkr)
  VALUES (v_portal_user_id, p_vehicle_id, p_kind, p_service_key, trim(p_site_address), p_site_lat, p_site_lng, p_material, p_hours, v_rate, v_mobilization)
  RETURNING id INTO v_booking_id;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'equipment_booking_requested', 'New ' || p_kind || ' request', trim(p_site_address), '/portal/my-vehicle/equipment');
  END IF;

  RETURN v_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_equipment_booking(uuid, varchar, varchar, int, text, varchar, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_equipment_booking(uuid, varchar, varchar, int, text, varchar, decimal, decimal) TO authenticated;

CREATE OR REPLACE FUNCTION my_equipment_bookings() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'kind', b.kind, 'service_key', b.service_key, 'site_address', b.site_address, 'site_lat', b.site_lat, 'site_lng', b.site_lng, 'material', b.material,
    'requested_hours', b.requested_hours, 'status', b.status, 'decline_reason', b.decline_reason, 'rate_pkr', b.rate_pkr, 'mobilization_fee_pkr', b.mobilization_fee_pkr,
    'actual_hours', b.actual_hours, 'total_amount_pkr', b.total_amount_pkr,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color
  ) ORDER BY b.requested_at DESC), '[]'::jsonb)
  FROM equipment_bookings b JOIN vehicles v ON v.id = b.vehicle_id
  WHERE b.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

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
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'customer_name', pu.full_name, 'customer_mobile', pu.mobile
  ) ORDER BY b.requested_at DESC), '[]'::jsonb) INTO v_result
  FROM equipment_bookings b JOIN portal_users pu ON pu.id = b.portal_user_id
  WHERE b.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
