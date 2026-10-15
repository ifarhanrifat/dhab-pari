-- Real gap found auditing the design: hourly/equipment(machinery,
-- tractor, loader)/rental/shadi bookings have zero messaging — the only
-- chat system (negotiation_threads/negotiation_messages, 422) only
-- covers city-fetch/commuter-share/order-city-pro. Extends that same
-- generic system with a 4th kind, 'booking', dispatched by ref_type/
-- ref_id (the same convention already used for ratings/disputes, 650) —
-- instead of the free-text item/qty/budget a rider types for fetch/
-- share, a booking-kind thread is auto-created the moment the booking
-- itself is created, carrying no offer/negotiation affordance (this
-- session's flat committee-rate decision stands — chat is for
-- coordination, not price haggling).

ALTER TABLE negotiation_threads DROP CONSTRAINT IF EXISTS negotiation_threads_kind_check;
ALTER TABLE negotiation_threads ADD CONSTRAINT negotiation_threads_kind_check CHECK (kind IN ('fetch', 'share', 'pro', 'booking'));
ALTER TABLE negotiation_threads ADD COLUMN IF NOT EXISTS ref_type varchar CHECK (ref_type IS NULL OR ref_type IN ('hourly_booking', 'equipment_booking', 'rental_booking', 'shadi_vehicle_request'));
ALTER TABLE negotiation_threads ADD COLUMN IF NOT EXISTS ref_id uuid;
-- Partial unique index (not a table constraint) since most existing rows
-- have ref_type/ref_id both NULL and a plain UNIQUE constraint would be
-- fine with that anyway (NULLs never conflict) — spelled out as a
-- partial index for clarity that it only governs booking-kind rows.
CREATE UNIQUE INDEX IF NOT EXISTS negotiation_threads_ref_unique ON negotiation_threads(ref_type, ref_id) WHERE ref_type IS NOT NULL;

-- Idempotent: a retried booking-creation call (or a claim racing a
-- second claim attempt) never creates two threads for the same booking —
-- INSERT ... ON CONFLICT DO NOTHING then re-select.
CREATE OR REPLACE FUNCTION ensure_booking_thread(
  p_ref_type varchar, p_ref_id uuid, p_vehicle_id uuid, p_initiator_portal_user_id uuid, p_item text
) RETURNS uuid AS $$
DECLARE v_thread_id uuid;
BEGIN
  INSERT INTO negotiation_threads (kind, initiator_portal_user_id, vehicle_id, item, ref_type, ref_id)
  VALUES ('booking', p_initiator_portal_user_id, p_vehicle_id, p_item, p_ref_type, p_ref_id)
  ON CONFLICT (ref_type, ref_id) WHERE ref_type IS NOT NULL DO NOTHING
  RETURNING id INTO v_thread_id;
  IF v_thread_id IS NULL THEN
    SELECT id INTO v_thread_id FROM negotiation_threads WHERE ref_type = p_ref_type AND ref_id = p_ref_id;
  END IF;
  RETURN v_thread_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION ensure_booking_thread(varchar, uuid, uuid, uuid, text) FROM PUBLIC, anon;

-- ── hourly ───────────────────────────────────────────────────────────
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

  INSERT INTO hourly_bookings (portal_user_id, vehicle_id, hours, pickup_address, pickup_lat, pickup_lng, hourly_rate_pkr, included_km, overage_per_km_pkr, base_amount_pkr, pin)
  VALUES (v_portal_user_id, p_vehicle_id, p_hours, trim(p_pickup_address), p_pickup_lat, p_pickup_lng, v.hourly_rate_pkr, COALESCE(v.hourly_included_km, 0) * p_hours, COALESCE(v.hourly_overage_per_km_pkr, 0), v.hourly_rate_pkr * p_hours, lpad(floor(random() * 10000)::text, 4, '0'))
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

-- ── equipment (machinery/tractor/loader) ────────────────────────────
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

  INSERT INTO equipment_bookings (portal_user_id, vehicle_id, kind, service_key, site_address, site_lat, site_lng, material, requested_hours, rate_pkr, mobilization_fee_pkr, pin)
  VALUES (v_portal_user_id, p_vehicle_id, p_kind, p_service_key, trim(p_site_address), p_site_lat, p_site_lng, p_material, p_hours, v_rate, v_mobilization, lpad(floor(random() * 10000)::text, 4, '0'))
  RETURNING id INTO v_booking_id;

  PERFORM ensure_booking_thread('equipment_booking', v_booking_id, p_vehicle_id, v_portal_user_id, trim(coalesce(v.model, v.vehicle_type)) || ' — ' || p_kind);

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'equipment_booking_requested', 'New ' || p_kind || ' request', trim(p_site_address), '/portal/my-vehicle/equipment');
  END IF;

  RETURN v_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── rental ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_rental_booking(
  p_vehicle_id uuid, p_from_address text, p_from_lat decimal, p_from_lng decimal,
  p_to_address text, p_to_lat decimal, p_to_lng decimal, p_trip_type varchar, p_wait_hours int DEFAULT 0
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
    trip_type, wait_hours, km, base_amount_pkr, trip_amount_pkr, wait_amount_pkr, total_amount_pkr, pin
  ) VALUES (
    v_portal_user_id, p_vehicle_id, trim(p_from_address), p_from_lat, p_from_lng, trim(p_to_address), p_to_lat, p_to_lng,
    p_trip_type, p_wait_hours, v_km, v.rental_base_pkr, v_trip_amount, v_wait_amount, v_total, lpad(floor(random() * 10000)::text, 4, '0')
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

-- ── shadi (hand-pick) ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_shadi_event(
  p_event_date date, p_venue_address text, p_distance_km decimal, p_notes text, p_vehicle_ids uuid[],
  p_venue_lat decimal DEFAULT NULL, p_venue_lng decimal DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_event_id uuid;
  v_vehicle_id uuid;
  v_request_id uuid;
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

    INSERT INTO shadi_vehicle_requests (event_id, vehicle_id, full_day_rate_pkr) VALUES (v_event_id, v_vehicle_id, v.shadi_full_day_rate_pkr)
    RETURNING id INTO v_request_id;
    PERFORM ensure_booking_thread('shadi_vehicle_request', v_request_id, v_vehicle_id, v_portal_user_id, trim(coalesce(v.model, v.vehicle_type)) || ' — ' || to_char(p_event_date, 'DD Mon'));
  END LOOP;

  RETURN v_event_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── shadi (fleet-by-type claim) — thread only makes sense once a real
-- driver has claimed the slot and a vehicle_id exists ──────────────────
CREATE OR REPLACE FUNCTION claim_shadi_slot(p_request_id uuid, p_vehicle_id uuid) RETURNS void AS $$
DECLARE r shadi_vehicle_requests%ROWTYPE; e shadi_events%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles vv WHERE vv.id = p_vehicle_id AND vv.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO r FROM shadi_vehicle_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'open' THEN RAISE EXCEPTION 'This slot is no longer available.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active AND offers_shadi;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available for wedding booking.' USING ERRCODE = 'P0001'; END IF;
  IF v.shadi_vehicle_class IS NULL OR v.shadi_vehicle_class <> r.class_key THEN
    RAISE EXCEPTION 'This vehicle is not the right type for this slot.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO e FROM shadi_events WHERE id = r.event_id;
  IF v.portal_user_id = e.portal_user_id THEN RAISE EXCEPTION 'You cannot book your own vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF e.status <> 'collecting' THEN RAISE EXCEPTION 'This booking is no longer accepting vehicles.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM shadi_vehicle_requests WHERE event_id = r.event_id AND vehicle_id = p_vehicle_id AND status NOT IN ('declined', 'withdrawn', 'cancelled')) THEN
    RAISE EXCEPTION 'This vehicle already has a live request for this event.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM shadi_vehicle_requests r2 JOIN shadi_events e2 ON e2.id = r2.event_id
    WHERE r2.vehicle_id = p_vehicle_id AND r2.status = 'accepted' AND e2.event_date = e.event_date AND e2.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'This vehicle is already booked for another wedding on that date.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE shadi_vehicle_requests SET vehicle_id = p_vehicle_id, status = 'accepted', responded_at = now() WHERE id = p_request_id;
  PERFORM ensure_booking_thread('shadi_vehicle_request', p_request_id, p_vehicle_id, e.portal_user_id, trim(coalesce(v.model, v.vehicle_type)) || ' — ' || to_char(e.event_date, 'DD Mon'));

  IF e.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (e.portal_user_id, 'shadi_request_accepted', 'A driver claimed a vehicle slot',
      v.owner_name || ' will be available on ' || to_char(e.event_date, 'DD Mon YYYY') || '.', '/portal/marketplace/shadi/' || e.id);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── a direct "open the chat for this booking" lookup, for the rider/
-- driver-side detail pages (they have the booking id, not the thread
-- id) ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION booking_thread_id(p_ref_type varchar, p_ref_id uuid) RETURNS uuid AS $$
  SELECT t.id FROM negotiation_threads t
  WHERE t.ref_type = p_ref_type AND t.ref_id = p_ref_id AND is_party_to_negotiation(t.id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION booking_thread_id(varchar, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION booking_thread_id(varchar, uuid) TO authenticated;
