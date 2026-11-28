-- Migration 980: machinery fleet operational layer, requested 2026-11-28 —
-- "the fleet admin will be one and he can add the drivers and he will
-- manage his own fleet and will have one fleet manager staff as well,
-- who can do the admin job... can get the booking requests on his
-- window and then allot the machinery driver after the agreement of the
-- rent with customer... admin of the machinery and manager will fully
-- aware of their booked machinery and when the machine will be free...
-- if incase the machine will not free on time it can send the rider
-- actual issue and information about the machine is busy."
--
-- The fleets/fleet_staff/can_manage_vehicle() system (844/854) already
-- structurally applies to machinery (852 — "equipment fleet parity"),
-- and a real two-way chat already exists on every equipment booking
-- (negotiation_threads/negotiation_messages, 422/658/700/711). What was
-- actually missing, confirmed by reading every current RPC: (1) a
-- request notification only ever reaches the one specific vehicle's own
-- bound driver account — never the fleet owner, never any staff — so a
-- manager genuinely cannot see requests today; (2) no fleet-wide list of
-- pending requests exists, only a per-vehicle one; (3) zero availability/
-- busy-until computation exists for equipment anywhere; (4) no way to
-- swap a request to a different free machine in the same fleet; (5) no
-- structured way to push a delay update into the existing chat; (6) the
-- self-service "add my own vehicle, no committee approval" flow that bus
-- fleet owners already use (create_fleet_vehicle_direct, 928) is hard-
-- restricted to Bus/Coaster and never sets any machinery field.
--
-- Scope decision confirmed with the user: "allotting the driver" means
-- picking which machine (and therefore which already-registered driver,
-- since every vehicle has exactly one permanently-bound driver today)
-- services a job — not a decoupled driver roster. Nothing here touches
-- that 1-vehicle-1-driver model.

-- ═════════════════════════════════════════════════════════════════════
-- 1. fleet_staff.role gains 'manager' — purely a label, same as every
--    other role value (883's own stated design: fleet_staff is flat/
--    full-access by default, so no permission-matrix change is needed
--    for a manager to already "do the admin job").
-- ═════════════════════════════════════════════════════════════════════
ALTER TABLE fleet_staff DROP CONSTRAINT fleet_staff_role_check;
ALTER TABLE fleet_staff ADD CONSTRAINT fleet_staff_role_check
  CHECK (role IN ('staff', 'booking_officer', 'terminal_manager', 'accountant', 'other', 'driver', 'manager'));

-- set_fleet_staff_role (final body: 888) — true-replace, same signature,
-- only the inline role list widened to match.
CREATE OR REPLACE FUNCTION set_fleet_staff_role(p_fleet_staff_id uuid, p_role varchar) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fleet_id uuid;
BEGIN
  SELECT fs.fleet_id INTO v_fleet_id FROM fleet_staff fs JOIN fleets f ON f.id = fs.fleet_id WHERE fs.id = p_fleet_staff_id AND f.owning_portal_user_id = current_portal_user_id();
  IF v_fleet_id IS NULL THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_role NOT IN ('staff', 'booking_officer', 'terminal_manager', 'accountant', 'other', 'driver', 'manager') THEN
    RAISE EXCEPTION 'Unknown role.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE fleet_staff SET role = p_role WHERE id = p_fleet_staff_id;
  PERFORM log_fleet_action(v_fleet_id, 'staff_role_set', jsonb_build_object('fleet_staff_id', p_fleet_staff_id, 'role', p_role));
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 2. create_equipment_booking (final body: 731, 17-arg) — true-replace,
--    same signature. Only change: the request notification used to fire
--    only to v.portal_user_id (the vehicle's own bound driver). Now fans
--    out to that driver + the fleet owner + every fleet_staff member of
--    that fleet (deduped), when the vehicle belongs to a fleet — a solo
--    owner-operator with no fleet keeps today's exact single-recipient
--    behavior.
-- ═════════════════════════════════════════════════════════════════════
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
  v_notify_id uuid;
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

  -- Fan-out (980): the vehicle's own driver + the fleet owner + every
  -- fleet_staff member, deduped — not just the one bound driver account.
  FOR v_notify_id IN
    SELECT DISTINCT portal_user_id FROM (
      SELECT v.portal_user_id
      UNION
      SELECT f.owning_portal_user_id FROM fleets f WHERE f.id = v.fleet_id
      UNION
      SELECT fs.portal_user_id FROM fleet_staff fs WHERE fs.fleet_id = v.fleet_id
    ) recipients WHERE portal_user_id IS NOT NULL
  LOOP
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_notify_id, 'equipment_booking_requested', 'New ' || p_kind || ' request', trim(p_site_address), '/portal/my-vehicle/equipment');
  END LOOP;

  RETURN v_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════
-- 3. fleet_equipment_bookings — same jsonb shape vehicle_equipment_
--    bookings (852) already returns, aggregated across every vehicle in
--    the fleet instead of one at a time, so a manager isn't clicking
--    into each machine separately to see what's pending.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fleet_equipment_bookings(p_fleet_id uuid, p_status varchar DEFAULT NULL) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (
    COALESCE(current_admin_permission('manage_parties'), false)
    OR EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
    OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())
  ) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'vehicle_id', b.vehicle_id, 'vehicle_label', trim(coalesce(v.model, v.vehicle_type)) || coalesce(' · ' || v.vehicle_number, ''),
    'kind', b.kind, 'service_key', b.service_key, 'site_address', b.site_address, 'site_lat', b.site_lat, 'site_lng', b.site_lng, 'material', b.material,
    'requested_hours', b.requested_hours, 'status', b.status, 'decline_reason', b.decline_reason, 'rate_pkr', b.rate_pkr, 'mobilization_fee_pkr', b.mobilization_fee_pkr,
    'actual_hours', b.actual_hours, 'total_amount_pkr', b.total_amount_pkr, 'status_confirmed', b.status_confirmed,
    'notes', b.notes, 'payment_method', b.payment_method,
    'pickup_address', b.pickup_address, 'pickup_lat', b.pickup_lat, 'pickup_lng', b.pickup_lng, 'trip_count', b.trip_count,
    'scheduled_date', b.scheduled_date, 'scheduled_time', b.scheduled_time,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'customer_portal_user_id', pu.id, 'customer_name', pu.full_name, 'customer_mobile', pu.mobile
  ) ORDER BY b.requested_at DESC), '[]'::jsonb) INTO v_result
  FROM equipment_bookings b
  JOIN vehicles v ON v.id = b.vehicle_id
  JOIN portal_users pu ON pu.id = b.portal_user_id
  WHERE v.fleet_id = p_fleet_id AND (p_status IS NULL OR b.status = p_status);
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION fleet_equipment_bookings(uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_equipment_bookings(uuid, varchar) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 4. equipment_fleet_availability — the real gap: zero availability/
--    busy-until computation exists for equipment anywhere. Deliberately
--    honest rather than precise: an in-progress job gets an estimated
--    finish time (duration-based, loader excluded — it has no duration
--    field); an accepted-but-not-started job only ever reports its own
--    scheduled date/time as "next commitment," never a projected
--    free-at — that's exactly the kind of overclaimed certainty the
--    delay-report RPC below exists to correct when it turns out wrong.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION equipment_fleet_availability(p_fleet_id uuid, p_kind varchar DEFAULT NULL) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (
    COALESCE(current_admin_permission('manage_parties'), false)
    OR EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
    OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())
  ) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'vehicle_id', v.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'model', v.model, 'vehicle_number', v.vehicle_number,
    'offers_machinery', v.offers_machinery, 'offers_tractor', v.offers_tractor, 'offers_loader', v.offers_loader,
    'status', CASE WHEN cur.id IS NOT NULL THEN 'in_progress' WHEN nxt.id IS NOT NULL THEN 'committed' ELSE 'free' END,
    'current_booking', CASE WHEN cur.id IS NOT NULL THEN jsonb_build_object(
      'id', cur.id, 'kind', cur.kind, 'site_address', cur.site_address, 'customer_name', cur_pu.full_name, 'started_at', cur.started_at,
      'estimated_free_at', CASE WHEN cur.kind = 'loader' THEN NULL ELSE cur.started_at + (GREATEST(COALESCE(cur.requested_hours, 0), 1) * interval '1 hour') END
    ) ELSE NULL END,
    'next_scheduled', CASE WHEN cur.id IS NULL AND nxt.id IS NOT NULL THEN jsonb_build_object(
      'id', nxt.id, 'kind', nxt.kind, 'site_address', nxt.site_address, 'customer_name', nxt_pu.full_name,
      'scheduled_date', nxt.scheduled_date, 'scheduled_time', nxt.scheduled_time
    ) ELSE NULL END
  ) ORDER BY v.owner_name), '[]'::jsonb) INTO v_result
  FROM vehicles v
  LEFT JOIN LATERAL (
    SELECT * FROM equipment_bookings eb WHERE eb.vehicle_id = v.id AND eb.status = 'in_progress' ORDER BY eb.started_at DESC LIMIT 1
  ) cur ON true
  LEFT JOIN portal_users cur_pu ON cur_pu.id = cur.portal_user_id
  LEFT JOIN LATERAL (
    SELECT * FROM equipment_bookings eb WHERE eb.vehicle_id = v.id AND eb.status = 'accepted'
      ORDER BY eb.scheduled_date ASC NULLS LAST, eb.scheduled_time ASC NULLS LAST LIMIT 1
  ) nxt ON true
  LEFT JOIN portal_users nxt_pu ON nxt_pu.id = nxt.portal_user_id
  WHERE v.fleet_id = p_fleet_id AND v.is_active
    AND (v.offers_machinery OR v.offers_tractor OR v.offers_loader)
    AND (p_kind IS NULL
      OR (p_kind = 'machinery' AND v.offers_machinery)
      OR (p_kind = 'tractor' AND v.offers_tractor)
      OR (p_kind = 'loader' AND v.offers_loader));
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION equipment_fleet_availability(uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION equipment_fleet_availability(uuid, varchar) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 5. reassign_equipment_booking — the actual "allot the machinery"
--    action: swap a request to a different free machine (and therefore
--    driver) in the same fleet, instead of only accept/decline.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION reassign_equipment_booking(p_booking_id uuid, p_new_vehicle_id uuid, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE b equipment_bookings%ROWTYPE; v_old vehicles%ROWTYPE; v_new vehicles%ROWTYPE; v_thread_id uuid;
BEGIN
  SELECT * INTO b FROM equipment_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF b.status NOT IN ('requested', 'accepted') THEN
    RAISE EXCEPTION 'This booking can no longer be reassigned.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_old FROM vehicles WHERE id = b.vehicle_id;
  SELECT * INTO v_new FROM vehicles WHERE id = p_new_vehicle_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That machine is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR (can_manage_vehicle(v_old.id) AND can_manage_vehicle(v_new.id))) THEN
    RAISE EXCEPTION 'You do not manage both machines.' USING ERRCODE = 'P0001';
  END IF;
  IF (b.kind = 'machinery' AND NOT v_new.offers_machinery) OR (b.kind = 'tractor' AND NOT v_new.offers_tractor) OR (b.kind = 'loader' AND NOT v_new.offers_loader) THEN
    RAISE EXCEPTION 'That machine does not offer % hire.', b.kind USING ERRCODE = 'P0001';
  END IF;
  IF p_new_vehicle_id = b.vehicle_id THEN RAISE EXCEPTION 'That is already the assigned machine.' USING ERRCODE = 'P0001'; END IF;

  UPDATE equipment_bookings SET vehicle_id = p_new_vehicle_id WHERE id = p_booking_id;

  v_thread_id := booking_thread_id('equipment_booking', p_booking_id);
  IF v_thread_id IS NOT NULL THEN
    UPDATE negotiation_threads SET vehicle_id = p_new_vehicle_id WHERE id = v_thread_id;
    INSERT INTO negotiation_messages (thread_id, sender_role, kind, body)
    VALUES (v_thread_id, 'driver', 'system', 'This job has been reassigned to a different machine' || COALESCE(' — ' || trim(p_reason), '') || '.');
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'equipment_booking_reassigned', 'Your booking was reassigned',
    'Your ' || b.kind || ' job has been assigned to a different available machine.' || COALESCE(' ' || trim(p_reason), ''), '/portal/marketplace');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION reassign_equipment_booking(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reassign_equipment_booking(uuid, uuid, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 6. report_equipment_delay — "if the machine isn't free on time, send
--    the rider the actual issue and info" — posts straight into the
--    existing chat thread the customer already has open, no new
--    customer-facing surface needed.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION report_equipment_delay(p_booking_id uuid, p_new_eta_date date, p_new_eta_time time DEFAULT NULL, p_reason_text text DEFAULT NULL) RETURNS void AS $$
DECLARE b equipment_bookings%ROWTYPE; v vehicles%ROWTYPE; v_thread_id uuid;
BEGIN
  IF p_reason_text IS NULL OR trim(p_reason_text) = '' THEN RAISE EXCEPTION 'Explain the delay for the customer.' USING ERRCODE = 'P0001'; END IF;
  IF p_new_eta_date IS NULL THEN RAISE EXCEPTION 'Give a new date.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO b FROM equipment_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF b.status NOT IN ('accepted', 'in_progress') THEN RAISE EXCEPTION 'This booking is not active.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR can_manage_vehicle(v.id)) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE equipment_bookings SET scheduled_date = p_new_eta_date, scheduled_time = p_new_eta_time WHERE id = p_booking_id;

  v_thread_id := booking_thread_id('equipment_booking', p_booking_id);
  IF v_thread_id IS NOT NULL THEN
    INSERT INTO negotiation_messages (thread_id, sender_role, kind, body)
    VALUES (v_thread_id, 'driver', 'system', 'Running late: ' || trim(p_reason_text) || '. New estimate: ' || to_char(p_new_eta_date, 'DD Mon YYYY')
      || COALESCE(' ' || to_char(p_new_eta_time, 'HH12:MI AM'), '') || '.');
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'equipment_booking_delayed', 'Your machine is running late',
    trim(p_reason_text) || ' — new estimate ' || to_char(p_new_eta_date, 'DD Mon YYYY') || COALESCE(' ' || to_char(p_new_eta_time, 'HH12:MI AM'), '') || '.', '/portal/marketplace');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION report_equipment_delay(uuid, date, time, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION report_equipment_delay(uuid, date, time, text) TO authenticated;

-- notification_preferences was re-keyed to (tenant_id, event_type) in
-- migration 590 — one row per tenant per event type, not global.
INSERT INTO notification_preferences (tenant_id, event_type, label, whatsapp_enabled, popup_enabled)
SELECT t.id, e.event_type, e.label, false, true
FROM tenants t CROSS JOIN (VALUES
  ('equipment_booking_reassigned', 'An equipment booking was reassigned to a different machine'),
  ('equipment_booking_delayed', 'An equipment booking was reported running late')
) AS e(event_type, label)
ON CONFLICT (tenant_id, event_type) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════
-- 7. create_fleet_vehicle_direct (final body: 928, 9-arg) — true-
--    replace, same core args + 7 new trailing optional params so the
--    fleet admin can self-add his own machines, the same no-approval-
--    step way he already self-adds a bus — today hard-restricted to
--    Bus/Coaster with no machinery fields exposed at all.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION create_fleet_vehicle_direct(
  p_fleet_id uuid, p_category_id uuid, p_model varchar DEFAULT NULL, p_color varchar DEFAULT NULL,
  p_vehicle_number varchar DEFAULT NULL, p_total_seats int DEFAULT 0, p_has_ac boolean DEFAULT false,
  p_model_year int DEFAULT NULL, p_primary_driver_fleet_staff_id uuid DEFAULT NULL,
  p_offers_machinery boolean DEFAULT false, p_machinery_hourly_rate_pkr decimal DEFAULT NULL,
  p_machinery_min_hours int DEFAULT NULL, p_machinery_mobilization_fee_pkr decimal DEFAULT NULL,
  p_offers_tractor boolean DEFAULT false, p_offers_loader boolean DEFAULT false, p_loader_trip_rate_pkr decimal DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id(); v_driver_portal_user_id uuid; v_owner_name varchar;
  v_vehicle_type varchar; v_category_key varchar; v_is_machinery_kind boolean; v_id uuid; v_commission_mode varchar;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id AND owning_portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;

  SELECT name, key INTO v_vehicle_type, v_category_key FROM vehicle_categories WHERE id = p_category_id;
  IF v_vehicle_type IS NULL THEN RAISE EXCEPTION 'Unknown vehicle category.' USING ERRCODE = 'P0001'; END IF;
  v_is_machinery_kind := v_category_key IN ('machinery', 'tractor', 'loader');

  -- Seats are meaningless for a bulldozer — only passenger categories
  -- need a real count, same as every booking RPC already assumes.
  IF v_is_machinery_kind THEN
    p_total_seats := 1;
  ELSIF p_total_seats IS NULL OR p_total_seats <= 0 THEN
    RAISE EXCEPTION 'Enter a real seat count.' USING ERRCODE = 'P0001';
  END IF;
  IF p_model_year IS NOT NULL AND (p_model_year < 1980 OR p_model_year > extract(year FROM now())::int + 1) THEN
    RAISE EXCEPTION 'Enter a real model year.' USING ERRCODE = 'P0001';
  END IF;
  IF v_is_machinery_kind AND p_offers_machinery AND (p_machinery_hourly_rate_pkr IS NULL OR p_machinery_hourly_rate_pkr <= 0) THEN
    RAISE EXCEPTION 'Enter an hourly rate for this machine.' USING ERRCODE = 'P0001';
  END IF;
  IF v_is_machinery_kind AND p_offers_loader AND (p_loader_trip_rate_pkr IS NULL OR p_loader_trip_rate_pkr <= 0) THEN
    RAISE EXCEPTION 'Enter a per-trip rate for this loader.' USING ERRCODE = 'P0001';
  END IF;

  v_driver_portal_user_id := v_portal_user_id;
  IF p_primary_driver_fleet_staff_id IS NOT NULL THEN
    SELECT fs.portal_user_id INTO v_driver_portal_user_id FROM fleet_staff fs WHERE fs.id = p_primary_driver_fleet_staff_id AND fs.fleet_id = p_fleet_id AND fs.role = 'driver';
    IF v_driver_portal_user_id IS NULL THEN RAISE EXCEPTION 'That driver is not part of this fleet.' USING ERRCODE = 'P0001'; END IF;
  END IF;

  SELECT full_name INTO v_owner_name FROM portal_users WHERE id = v_driver_portal_user_id;

  -- Machinery needs per_order so the committee's own category commission
  -- (vehicle_categories.intercity_commission_pct, already read by
  -- confirm_equipment_booking) actually fires — unlike a self-added bus,
  -- which 928 deliberately defaults to monthly_lumpsum.
  v_commission_mode := CASE WHEN v_is_machinery_kind THEN 'per_order' ELSE 'monthly_lumpsum' END;

  INSERT INTO vehicles (
    owner_name, vehicle_type, vehicle_number, total_seats, portal_user_id, fleet_id, category_id, model, color, has_ac, model_year, commission_mode,
    offers_machinery, machinery_hourly_rate_pkr, machinery_min_hours, machinery_mobilization_fee_pkr, offers_tractor, offers_loader, loader_trip_rate_pkr
  )
  VALUES (
    v_owner_name, v_vehicle_type, nullif(trim(coalesce(p_vehicle_number, '')), ''), p_total_seats, v_driver_portal_user_id, p_fleet_id, p_category_id,
    nullif(trim(coalesce(p_model, '')), ''), nullif(trim(coalesce(p_color, '')), ''), p_has_ac, p_model_year, v_commission_mode,
    v_is_machinery_kind AND p_offers_machinery, p_machinery_hourly_rate_pkr, p_machinery_min_hours, p_machinery_mobilization_fee_pkr,
    v_is_machinery_kind AND p_offers_tractor, v_is_machinery_kind AND p_offers_loader, p_loader_trip_rate_pkr
  )
  RETURNING id INTO v_id;

  PERFORM log_fleet_action(p_fleet_id, 'vehicle_added', jsonb_build_object('vehicle_id', v_id, 'vehicle_number', p_vehicle_number));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION create_fleet_vehicle_direct(uuid, uuid, varchar, varchar, varchar, int, boolean, int, uuid, boolean, decimal, int, decimal, boolean, boolean, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_fleet_vehicle_direct(uuid, uuid, varchar, varchar, varchar, int, boolean, int, uuid, boolean, decimal, int, decimal, boolean, boolean, decimal) TO authenticated;

-- Old 9-arg overload must be dropped explicitly — true-replace with new
-- trailing params creates a second overload otherwise (same class of bug
-- caught live in migration 978 for record_manual_booking).
DROP FUNCTION IF EXISTS create_fleet_vehicle_direct(uuid, uuid, varchar, varchar, varchar, int, boolean, int, uuid);
