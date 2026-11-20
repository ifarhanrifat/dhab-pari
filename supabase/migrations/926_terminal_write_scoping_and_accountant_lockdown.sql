-- Migration 926: real staff roles & permissions, part 2 — confirmed
-- directly with the user that `fleet_staff.role` is read almost
-- nowhere today (every booking/boarding RPC gates on can_manage_vehicle,
-- role-blind), and the only counter-scoping anywhere is 924's
-- is_my_counter_or_admin, applied solely to closing a stop challan.
--
-- Two deliberate extensions, both confirmed directly:
-- 1. Terminal-write scoping: a counter-assigned staff member can only
--    MANAGE (cancel/reschedule/board/no-show/alight) a booking tied to
--    their own terminal. Viewing/searching stays fleet-wide on purpose
--    (preserves the existing "any terminal can sell for any route"
--    behavior) — nothing here touches route_departure_chalan,
--    fleet_search_bookings, or record_manual_booking's own ability to
--    sell for any counter.
-- 2. Accountant lockdown: the accountant role is blocked from booking
--    writes by default — the first RESTRICTIVE role check anywhere in
--    this schema (885's permission matrix only ever widened access).
--    Reuses that exact matrix (a new 'bookings' module) so an owner
--    whose accountant already handles bookings can re-enable it in one
--    toggle — no existing fleet silently breaks.

-- ═════════════════════════════════════════════════════════════════════
-- 1. Widen the permission matrix (885) to a third module. Same 3 spots
-- that migration's own comment flagged as a closed, hardcoded design.
-- ═════════════════════════════════════════════════════════════════════
ALTER TABLE fleet_role_permissions DROP CONSTRAINT IF EXISTS fleet_role_permissions_module_check;
ALTER TABLE fleet_role_permissions ADD CONSTRAINT fleet_role_permissions_module_check
  CHECK (module IN ('staff_payroll', 'cash', 'bookings'));

CREATE OR REPLACE FUNCTION set_fleet_role_permission(p_fleet_id uuid, p_role varchar, p_module varchar, p_can_edit boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id AND owning_portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_role NOT IN ('staff', 'booking_officer', 'terminal_manager', 'accountant', 'other') THEN RAISE EXCEPTION 'Unknown role.' USING ERRCODE = 'P0001'; END IF;
  IF p_module NOT IN ('staff_payroll', 'cash', 'bookings') THEN RAISE EXCEPTION 'Unknown module.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO fleet_role_permissions (fleet_id, role, module, can_edit, granted_by_portal_user_id)
  VALUES (p_fleet_id, p_role, p_module, p_can_edit, v_portal_user_id)
  ON CONFLICT (fleet_id, role, module) DO UPDATE SET can_edit = EXCLUDED.can_edit, granted_at = now(), granted_by_portal_user_id = EXCLUDED.granted_by_portal_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION fleet_role_permissions_matrix(p_fleet_id uuid) RETURNS TABLE(role varchar, module varchar, can_edit boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.role, m.module, COALESCE(p.can_edit, false)
  FROM (VALUES ('staff'), ('booking_officer'), ('terminal_manager'), ('accountant'), ('other')) AS r(role)
  CROSS JOIN (VALUES ('staff_payroll'), ('cash'), ('bookings')) AS m(module)
  LEFT JOIN fleet_role_permissions p ON p.fleet_id = p_fleet_id AND p.role = r.role AND p.module = m.module
  WHERE EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id());
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 2. The accountant-lockdown helper. Owner and every non-accountant
-- role always return false (never blocked) — this can only narrow
-- behavior for a staff member explicitly tagged 'accountant'.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fleet_staff_accountant_blocked(p_vehicle_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM vehicles v JOIN fleet_staff fs ON fs.fleet_id = v.fleet_id
    WHERE v.id = p_vehicle_id AND fs.portal_user_id = current_portal_user_id() AND fs.role = 'accountant'
  ) AND NOT fleet_staff_role_has_permission((SELECT fleet_id FROM vehicles WHERE id = p_vehicle_id), 'accountant', 'bookings');
$$;
REVOKE ALL ON FUNCTION fleet_staff_accountant_blocked(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_staff_accountant_blocked(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 3. record_manual_booking (911) — true-replace, current body copied
-- verbatim plus one new accountant-lockdown check right after the
-- existing can_manage_vehicle gate. Selling for any counter stays
-- open — only managing an existing booking gets terminal-scoped below.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION record_manual_booking(
  p_route_id uuid, p_travel_date date, p_seats int, p_passenger_name varchar, p_total_amount_pkr decimal,
  p_counter_id uuid DEFAULT NULL, p_passenger_mobile varchar DEFAULT NULL, p_payment_method varchar DEFAULT 'cash',
  p_board_stop_id uuid DEFAULT NULL, p_alight_stop_id uuid DEFAULT NULL, p_seat_numbers int[] DEFAULT NULL,
  p_emergency_contact_phone varchar DEFAULT NULL, p_passengers jsonb DEFAULT NULL,
  p_pickup_lat numeric DEFAULT NULL, p_pickup_lng numeric DEFAULT NULL, p_pickup_point varchar DEFAULT NULL,
  p_return_leg_of uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE; v_vehicle_kind varchar;
  v_available int; v_id uuid; v_ticket_no varchar;
  v_passenger jsonb; v_paid_idx int := 0; v_free_count int := 0;
  v_lo int; v_hi int; v_sn int;
  v_fleet_staff fleet_staff%ROWTYPE;
  v_pickup_approval varchar;
  v_payroll_settings fleet_payroll_settings%ROWTYPE; v_commission_rate decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF fleet_staff_accountant_blocked(v_route.vehicle_id) THEN RAISE EXCEPTION 'Accountants do not handle bookings on this fleet.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  IF p_board_stop_id IS NULL
     AND p_travel_date = (now() AT TIME ZONE 'Asia/Karachi')::date
     AND EXISTS (SELECT 1 FROM route_runs WHERE route_id = p_route_id AND direction = 'outbound' AND ended_at IS NULL AND (started_at AT TIME ZONE 'Asia/Karachi')::date = p_travel_date)
  THEN
    RAISE EXCEPTION 'This bus has already left % today — sell a seat for a stop further along the route, or a different date.', v_route.origin USING ERRCODE = 'P0001';
  END IF;

  IF p_counter_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_counters WHERE id = p_counter_id AND fleet_id = v_vehicle.fleet_id) THEN
    RAISE EXCEPTION 'That counter is not part of this vehicle''s fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_seats IS NULL OR p_seats <= 0 THEN RAISE EXCEPTION 'Enter at least one seat.' USING ERRCODE = 'P0001'; END IF;
  IF trim(coalesce(p_passenger_name, '')) = '' THEN RAISE EXCEPTION 'Enter the passenger''s name.' USING ERRCODE = 'P0001'; END IF;
  IF p_total_amount_pkr IS NULL OR p_total_amount_pkr < 0 THEN RAISE EXCEPTION 'Enter the fare collected.' USING ERRCODE = 'P0001'; END IF;

  IF p_pickup_lat IS NOT NULL OR p_pickup_lng IS NOT NULL THEN
    IF p_pickup_lat IS NULL OR p_pickup_lng IS NULL THEN
      RAISE EXCEPTION 'Enter both pickup coordinates, or neither.' USING ERRCODE = 'P0001';
    END IF;
    IF p_pickup_lat < -90 OR p_pickup_lat > 90 OR p_pickup_lng < -180 OR p_pickup_lng > 180 THEN
      RAISE EXCEPTION 'Enter valid GPS coordinates for the pickup pin.' USING ERRCODE = 'P0001';
    END IF;
    v_pickup_approval := 'pending';
  END IF;

  IF p_return_leg_of IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM manual_ride_bookings mb JOIN vehicle_routes vr ON vr.id = mb.route_id
      WHERE mb.id = p_return_leg_of AND mb.return_leg_of IS NULL AND can_manage_vehicle(vr.vehicle_id)
    ) THEN
      RAISE EXCEPTION 'The outbound booking for this return leg was not found.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_available := route_seats_available(p_route_id, p_travel_date);
  IF p_seats > v_available THEN RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001'; END IF;

  SELECT vc.vehicle_kind INTO v_vehicle_kind FROM vehicle_categories vc WHERE vc.id = v_vehicle.category_id;
  IF v_vehicle_kind = 'van' THEN
    IF p_seat_numbers IS NULL OR array_length(p_seat_numbers, 1) IS DISTINCT FROM p_seats THEN
      RAISE EXCEPTION 'Pick exactly % seat(s).', p_seats USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_seat_numbers) sn WHERE sn < 1 OR sn > route_effective_seats_for_date(p_route_id, p_travel_date)) THEN
      RAISE EXCEPTION 'That seat doesn''t exist on this vehicle.' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_seat_numbers IS NOT NULL THEN
    RAISE EXCEPTION 'This vehicle doesn''t use seat numbers.' USING ERRCODE = 'P0001';
  END IF;

  IF p_passengers IS NOT NULL THEN
    FOR v_passenger IN SELECT * FROM jsonb_array_elements(p_passengers) LOOP
      IF COALESCE((v_passenger->>'is_free_child')::boolean, false) THEN
        v_free_count := v_free_count + 1;
        IF p_seats = 1 AND COALESCE((v_passenger->>'age')::int, 99) > 2 THEN
          RAISE EXCEPTION 'With a single paid seat, only an infant (2 years or younger) can travel free — this child needs their own seat.' USING ERRCODE = 'P0001';
        END IF;
      END IF;
    END LOOP;
  END IF;

  v_ticket_no := generate_ticket_no();

  INSERT INTO manual_ride_bookings (
    route_id, counter_id, recorded_by_portal_user_id, travel_date, seats, passenger_name, passenger_mobile, board_stop_id, alight_stop_id,
    total_amount_pkr, payment_method, ticket_no, emergency_contact_phone, pickup_lat, pickup_lng, pickup_point, pickup_approval_status, return_leg_of
  )
  VALUES (
    p_route_id, p_counter_id, v_portal_user_id, p_travel_date, p_seats, trim(p_passenger_name), nullif(trim(coalesce(p_passenger_mobile, '')), ''), p_board_stop_id, p_alight_stop_id,
    p_total_amount_pkr, p_payment_method, v_ticket_no, nullif(trim(coalesce(p_emergency_contact_phone, '')), ''), p_pickup_lat, p_pickup_lng, nullif(trim(coalesce(p_pickup_point, '')), ''), v_pickup_approval, p_return_leg_of
  )
  RETURNING id INTO v_id;

  IF p_seat_numbers IS NOT NULL THEN
    v_lo := seat_stop_order(p_board_stop_id, -1);
    v_hi := seat_stop_order(p_alight_stop_id, 2000000000);
    FOREACH v_sn IN ARRAY (SELECT array_agg(x ORDER BY x) FROM unnest(p_seat_numbers) x) LOOP
      PERFORM assert_seat_segment_free(p_route_id, p_travel_date, 'outbound', v_sn, v_lo, v_hi);
      INSERT INTO ride_booking_seat_numbers (manual_ride_booking_id, route_id, travel_date, direction, seat_number, board_order, alight_order)
      VALUES (v_id, p_route_id, p_travel_date, 'outbound', v_sn, v_lo, v_hi);
    END LOOP;
  END IF;

  IF p_passengers IS NOT NULL THEN
    FOR v_passenger IN SELECT * FROM jsonb_array_elements(p_passengers) LOOP
      IF COALESCE((v_passenger->>'is_free_child')::boolean, false) THEN
        INSERT INTO manual_ride_booking_passengers (manual_ride_booking_id, full_name, gender, age, is_free_child, seat_number)
        VALUES (v_id, v_passenger->>'full_name', nullif(v_passenger->>'gender', ''), (v_passenger->>'age')::int, true, NULL);
      ELSE
        v_paid_idx := v_paid_idx + 1;
        INSERT INTO manual_ride_booking_passengers (manual_ride_booking_id, full_name, gender, age, is_free_child, seat_number)
        VALUES (v_id, v_passenger->>'full_name', nullif(v_passenger->>'gender', ''), (v_passenger->>'age')::int, false,
          CASE WHEN p_seat_numbers IS NOT NULL AND array_length(p_seat_numbers, 1) >= v_paid_idx THEN p_seat_numbers[v_paid_idx] ELSE NULL END);
      END IF;
    END LOOP;
  END IF;

  SELECT * INTO v_fleet_staff FROM fleet_staff WHERE portal_user_id = v_portal_user_id AND fleet_id = v_vehicle.fleet_id;
  IF FOUND THEN
    SELECT * INTO v_payroll_settings FROM fleet_payroll_settings WHERE fleet_id = v_vehicle.fleet_id;
    v_commission_rate := COALESCE(v_fleet_staff.commission_amount_pkr, v_payroll_settings.default_commission_per_seat_pkr);
    IF v_commission_rate IS NOT NULL AND v_commission_rate > 0 AND COALESCE(v_payroll_settings.commission_eligibility, 'confirmed_paid') = 'confirmed_paid' THEN
      INSERT INTO fleet_staff_commissions (fleet_staff_id, manual_ride_booking_id, seats, amount_pkr)
      VALUES (v_fleet_staff.id, v_id, p_seats, v_commission_rate * p_seats);
    END IF;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'ticket_no', v_ticket_no, 'pickup_approval_status', v_pickup_approval);
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 4. board_manual_ticket (911) — true-replace, current body copied
-- verbatim plus accountant-lockdown and terminal-write scoping. Scoped
-- by the PHYSICAL boarding location (board_stop_id's own counter_id),
-- not the sale's counter_id — a ticket can be sold at one terminal and
-- board at another; the terminal handling the passenger is the one
-- gated. board_stop_id IS NULL (origin) resolves to a NULL counter_id,
-- which is_my_counter_or_admin already treats as open to anyone.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION board_manual_ticket(p_id uuid, p_luggage_note varchar DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  mb manual_ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE;
  v_fleet_staff fleet_staff%ROWTYPE; v_payroll_settings fleet_payroll_settings%ROWTYPE; v_commission_rate decimal;
  v_board_counter_id uuid;
BEGIN
  SELECT * INTO mb FROM manual_ride_bookings WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ticket not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_routes WHERE id = mb.route_id;
  IF NOT can_manage_vehicle(r.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF fleet_staff_accountant_blocked(r.vehicle_id) THEN RAISE EXCEPTION 'Accountants do not handle bookings on this fleet.' USING ERRCODE = 'P0001'; END IF;
  SELECT counter_id INTO v_board_counter_id FROM route_stops WHERE id = mb.board_stop_id;
  IF NOT is_my_counter_or_admin(v_board_counter_id) THEN RAISE EXCEPTION 'You can only board passengers at your own terminal.' USING ERRCODE = 'P0001'; END IF;
  IF mb.status != 'confirmed' THEN RAISE EXCEPTION 'This ticket is not valid for boarding.' USING ERRCODE = 'P0001'; END IF;
  IF mb.boarded_at IS NOT NULL THEN RAISE EXCEPTION 'This ticket has already boarded.' USING ERRCODE = 'P0001'; END IF;
  UPDATE manual_ride_bookings SET boarded_at = now(), luggage_note = COALESCE(nullif(trim(coalesce(p_luggage_note, '')), ''), luggage_note) WHERE id = p_id;

  SELECT * INTO v_vehicle FROM vehicles WHERE id = r.vehicle_id;
  SELECT * INTO v_payroll_settings FROM fleet_payroll_settings WHERE fleet_id = v_vehicle.fleet_id;
  IF FOUND AND v_payroll_settings.commission_eligibility = 'completed_journey' THEN
    SELECT * INTO v_fleet_staff FROM fleet_staff WHERE portal_user_id = mb.recorded_by_portal_user_id AND fleet_id = v_vehicle.fleet_id;
    IF FOUND THEN
      v_commission_rate := COALESCE(v_fleet_staff.commission_amount_pkr, v_payroll_settings.default_commission_per_seat_pkr);
      IF v_commission_rate IS NOT NULL AND v_commission_rate > 0 THEN
        INSERT INTO fleet_staff_commissions (fleet_staff_id, manual_ride_booking_id, seats, amount_pkr)
        VALUES (v_fleet_staff.id, p_id, mb.seats, v_commission_rate * mb.seats)
        ON CONFLICT (manual_ride_booking_id) DO NOTHING;
      END IF;
    END IF;
  END IF;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 5. cancel_manual_booking (885) — true-replace, current body copied
-- verbatim plus accountant-lockdown and terminal-write scoping, scoped
-- by the booking's own counter_id (the SOLD-AT terminal — managing a
-- sale is the selling terminal's job).
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION cancel_manual_booking(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route_id uuid; v_fleet_id uuid; v_vehicle_id uuid; v_counter_id uuid;
BEGIN
  SELECT route_id, counter_id INTO v_route_id, v_counter_id FROM manual_ride_bookings WHERE id = p_id FOR UPDATE;
  IF v_route_id IS NULL THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT vr.vehicle_id INTO v_vehicle_id FROM vehicle_routes vr WHERE vr.id = v_route_id;
  IF NOT can_manage_vehicle(v_vehicle_id) THEN
    RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001';
  END IF;
  IF fleet_staff_accountant_blocked(v_vehicle_id) THEN RAISE EXCEPTION 'Accountants do not handle bookings on this fleet.' USING ERRCODE = 'P0001'; END IF;
  IF NOT is_my_counter_or_admin(v_counter_id) THEN RAISE EXCEPTION 'You can only manage bookings sold at your own terminal.' USING ERRCODE = 'P0001'; END IF;

  UPDATE manual_ride_bookings SET status = 'cancelled' WHERE id = p_id;
  DELETE FROM ride_booking_seat_numbers WHERE manual_ride_booking_id = p_id;
  UPDATE fleet_staff_commissions SET status = 'reversed', reversed_at = now() WHERE manual_ride_booking_id = p_id AND status = 'earned';
  SELECT v.fleet_id INTO v_fleet_id FROM vehicles v WHERE v.id = v_vehicle_id;
  IF v_fleet_id IS NOT NULL THEN
    PERFORM log_fleet_action(v_fleet_id, 'manual_booking_cancelled', jsonb_build_object('manual_ride_booking_id', p_id));
  END IF;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 6. reschedule_manual_booking (878) — true-replace, current body
-- copied verbatim plus accountant-lockdown and terminal-write scoping
-- (sold-at counter_id, same reasoning as cancel above).
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION reschedule_manual_booking(p_id uuid, p_new_travel_date date, p_seat_numbers int[] DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE mb manual_ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v_available int; v_weekday int; v_lo int; v_hi int; v_sn int;
BEGIN
  SELECT * INTO mb FROM manual_ride_bookings WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_routes WHERE id = mb.route_id;
  IF NOT can_manage_vehicle(r.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF fleet_staff_accountant_blocked(r.vehicle_id) THEN RAISE EXCEPTION 'Accountants do not handle bookings on this fleet.' USING ERRCODE = 'P0001'; END IF;
  IF NOT is_my_counter_or_admin(mb.counter_id) THEN RAISE EXCEPTION 'You can only manage bookings sold at your own terminal.' USING ERRCODE = 'P0001'; END IF;
  IF mb.status != 'confirmed' THEN RAISE EXCEPTION 'This booking can no longer be rescheduled.' USING ERRCODE = 'P0001'; END IF;
  IF p_new_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;

  v_weekday := extract(dow FROM p_new_travel_date)::int;
  IF NOT (v_weekday = ANY(r.days_of_week)) THEN RAISE EXCEPTION 'This route does not run on that day.' USING ERRCODE = 'P0001'; END IF;

  v_available := route_seats_available(mb.route_id, p_new_travel_date);
  IF mb.seats > v_available THEN RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001'; END IF;

  UPDATE manual_ride_bookings SET travel_date = p_new_travel_date WHERE id = p_id;

  v_lo := seat_stop_order(mb.board_stop_id, -1);
  v_hi := seat_stop_order(mb.alight_stop_id, 2000000000);

  IF p_seat_numbers IS NOT NULL THEN
    IF array_length(p_seat_numbers, 1) IS DISTINCT FROM mb.seats THEN
      RAISE EXCEPTION 'Pick exactly % seat(s).', mb.seats USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_seat_numbers) sn WHERE sn < 1 OR sn > route_effective_seats_for_date(mb.route_id, p_new_travel_date)) THEN
      RAISE EXCEPTION 'That seat doesn''t exist on this vehicle.' USING ERRCODE = 'P0001';
    END IF;
    DELETE FROM ride_booking_seat_numbers WHERE manual_ride_booking_id = p_id;
    FOREACH v_sn IN ARRAY (SELECT array_agg(x ORDER BY x) FROM unnest(p_seat_numbers) x) LOOP
      PERFORM assert_seat_segment_free(mb.route_id, p_new_travel_date, 'outbound', v_sn, v_lo, v_hi);
      INSERT INTO ride_booking_seat_numbers (manual_ride_booking_id, route_id, travel_date, direction, seat_number, board_order, alight_order)
      VALUES (p_id, mb.route_id, p_new_travel_date, 'outbound', v_sn, v_lo, v_hi);
    END LOOP;
  ELSE
    PERFORM assert_seat_segment_free(mb.route_id, p_new_travel_date, 'outbound', sn.seat_number, v_lo, v_hi)
      FROM ride_booking_seat_numbers sn WHERE sn.manual_ride_booking_id = p_id ORDER BY sn.seat_number;
    UPDATE ride_booking_seat_numbers SET travel_date = p_new_travel_date WHERE manual_ride_booking_id = p_id;
  END IF;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 7. mark_manual_ticket_no_show (925) — true-replace, current body
-- copied verbatim plus accountant-lockdown and terminal-write scoping
-- (physical boarding location, same reasoning as board_manual_ticket).
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION mark_manual_ticket_no_show(p_id uuid, p_reason text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route_id uuid; v_fleet_id uuid; v_vehicle_id uuid; v_board_stop_id uuid; v_board_counter_id uuid;
BEGIN
  SELECT route_id, board_stop_id INTO v_route_id, v_board_stop_id FROM manual_ride_bookings WHERE id = p_id AND status = 'confirmed' FOR UPDATE;
  IF v_route_id IS NULL THEN RAISE EXCEPTION 'Booking not found or not eligible for no-show.' USING ERRCODE = 'P0001'; END IF;
  SELECT vr.vehicle_id INTO v_vehicle_id FROM vehicle_routes vr WHERE vr.id = v_route_id;
  IF NOT can_manage_vehicle(v_vehicle_id) THEN
    RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001';
  END IF;
  IF fleet_staff_accountant_blocked(v_vehicle_id) THEN RAISE EXCEPTION 'Accountants do not handle bookings on this fleet.' USING ERRCODE = 'P0001'; END IF;
  SELECT counter_id INTO v_board_counter_id FROM route_stops WHERE id = v_board_stop_id;
  IF NOT is_my_counter_or_admin(v_board_counter_id) THEN RAISE EXCEPTION 'You can only manage passengers at your own terminal.' USING ERRCODE = 'P0001'; END IF;

  UPDATE manual_ride_bookings SET status = 'no_show' WHERE id = p_id;
  DELETE FROM ride_booking_seat_numbers WHERE manual_ride_booking_id = p_id;
  UPDATE fleet_staff_commissions SET status = 'reversed', reversed_at = now() WHERE manual_ride_booking_id = p_id AND status = 'earned';

  SELECT v.fleet_id INTO v_fleet_id FROM vehicles v WHERE v.id = v_vehicle_id;
  IF v_fleet_id IS NOT NULL THEN
    PERFORM log_fleet_action(v_fleet_id, 'manual_booking_no_show', jsonb_build_object('manual_ride_booking_id', p_id, 'reason', p_reason));
  END IF;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 8. mark_manual_ticket_alighted (924) — true-replace, current body
-- copied verbatim plus accountant-lockdown and terminal-write scoping
-- (physical boarding location — alighting is handled wherever the
-- passenger physically gets off, same dimension as boarding).
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION mark_manual_ticket_alighted(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE mb manual_ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v_board_counter_id uuid;
BEGIN
  SELECT * INTO mb FROM manual_ride_bookings WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ticket not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_routes WHERE id = mb.route_id;
  IF NOT can_manage_vehicle(r.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF fleet_staff_accountant_blocked(r.vehicle_id) THEN RAISE EXCEPTION 'Accountants do not handle bookings on this fleet.' USING ERRCODE = 'P0001'; END IF;
  SELECT counter_id INTO v_board_counter_id FROM route_stops WHERE id = mb.board_stop_id;
  IF NOT is_my_counter_or_admin(v_board_counter_id) THEN RAISE EXCEPTION 'You can only manage passengers at your own terminal.' USING ERRCODE = 'P0001'; END IF;
  IF mb.status != 'confirmed' THEN RAISE EXCEPTION 'This ticket is not valid for alighting.' USING ERRCODE = 'P0001'; END IF;
  IF mb.boarded_at IS NULL THEN RAISE EXCEPTION 'This passenger has not boarded yet.' USING ERRCODE = 'P0001'; END IF;
  IF mb.dropped_off_at IS NOT NULL THEN RAISE EXCEPTION 'This passenger has already alighted.' USING ERRCODE = 'P0001'; END IF;
  UPDATE manual_ride_bookings SET dropped_off_at = now() WHERE id = p_id;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 9. close_route_stop_challan (924) — true-replace, current body
-- copied verbatim plus ONLY the accountant-lockdown check (terminal
-- scoping already existed there via is_my_counter_or_admin).
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION close_route_stop_challan(
  p_route_id uuid, p_travel_date date, p_direction varchar, p_stop_id uuid DEFAULT NULL,
  p_driver_advance_pkr decimal DEFAULT 0, p_other_cash_pkr decimal DEFAULT 0, p_note text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_route vehicle_routes%ROWTYPE; v_stop route_stops%ROWTYPE; v_counter_id uuid;
  v_expected int; v_boarded int; v_no_show int; v_cash decimal; v_digital decimal;
  v_id uuid; v_board_filter_null boolean := p_stop_id IS NULL;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF fleet_staff_accountant_blocked(v_route.vehicle_id) THEN RAISE EXCEPTION 'Accountants do not handle bookings on this fleet.' USING ERRCODE = 'P0001'; END IF;
  IF p_direction NOT IN ('outbound', 'return') THEN RAISE EXCEPTION 'Invalid direction.' USING ERRCODE = 'P0001'; END IF;

  IF p_stop_id IS NOT NULL THEN
    SELECT * INTO v_stop FROM route_stops WHERE id = p_stop_id AND route_id = p_route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'That stop does not belong to this route.' USING ERRCODE = 'P0001'; END IF;
    v_counter_id := v_stop.counter_id;
  END IF;

  IF NOT is_my_counter_or_admin(v_counter_id) THEN
    RAISE EXCEPTION 'You can only close boarding for your own assigned terminal.' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM route_stop_challans WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction
      AND ((p_stop_id IS NULL AND stop_id IS NULL) OR stop_id = p_stop_id)) THEN
    RAISE EXCEPTION 'This stop has already been closed for this departure.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE manual_ride_bookings mb SET status = 'no_show'
  WHERE mb.route_id = p_route_id AND mb.travel_date = p_travel_date AND mb.direction = p_direction
    AND mb.status = 'confirmed' AND mb.boarded_at IS NULL
    AND ((v_board_filter_null AND mb.board_stop_id IS NULL) OR mb.board_stop_id = p_stop_id);
  UPDATE fleet_staff_commissions fsc SET status = 'reversed', reversed_at = now()
  WHERE fsc.status = 'earned' AND fsc.manual_ride_booking_id IN (
    SELECT id FROM manual_ride_bookings WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction AND status = 'no_show'
      AND ((v_board_filter_null AND board_stop_id IS NULL) OR board_stop_id = p_stop_id)
  );
  DELETE FROM ride_booking_seat_numbers sn WHERE sn.manual_ride_booking_id IN (
    SELECT id FROM manual_ride_bookings WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction AND status = 'no_show'
      AND ((v_board_filter_null AND board_stop_id IS NULL) OR board_stop_id = p_stop_id)
  );

  SELECT
    COUNT(*) FILTER (WHERE boarded_at IS NOT NULL) AS boarded,
    COUNT(*) FILTER (WHERE status = 'no_show') AS no_show,
    COUNT(*) AS expected
  INTO v_boarded, v_no_show, v_expected
  FROM (
    SELECT boarded_at, status FROM manual_ride_bookings
    WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction
      AND ((v_board_filter_null AND board_stop_id IS NULL) OR board_stop_id = p_stop_id)
      AND status != 'cancelled'
    UNION ALL
    SELECT boarded_at, CASE WHEN status = 'announced' THEN 'confirmed' ELSE status END FROM ride_bookings
    WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction AND NOT is_mid_route_catch
      AND ((v_board_filter_null AND board_stop_id IS NULL) OR board_stop_id = p_stop_id)
      AND status IN ('announced', 'confirmed')
  ) combined;

  SELECT
    COALESCE(SUM(total_amount_pkr) FILTER (WHERE payment_method = 'cash'), 0),
    COALESCE(SUM(total_amount_pkr) FILTER (WHERE payment_method != 'cash'), 0)
  INTO v_cash, v_digital
  FROM manual_ride_bookings
  WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction
    AND status IN ('confirmed', 'no_show') AND counter_id IS NOT DISTINCT FROM v_counter_id;

  INSERT INTO route_stop_challans (
    route_id, travel_date, direction, stop_id, expected_count, boarded_count, no_show_count,
    cash_collected_pkr, digital_collected_pkr, driver_advance_pkr, other_cash_pkr, note, closed_by
  ) VALUES (
    p_route_id, p_travel_date, p_direction, p_stop_id, v_expected, v_boarded, v_no_show,
    v_cash, v_digital, COALESCE(p_driver_advance_pkr, 0), COALESCE(p_other_cash_pkr, 0), nullif(trim(coalesce(p_note, '')), ''), current_portal_user_id()
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 10. my_fleet_staff_context — lets the Bookings/Chalan pages grey out
-- actions the server will reject, instead of a raw error. Read-only,
-- same owner-or-any-staff gate as fleet_search_bookings.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION my_fleet_staff_context(p_fleet_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_is_owner boolean; v_role varchar; v_counter_id uuid;
BEGIN
  v_is_owner := EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id());
  SELECT role, counter_id INTO v_role, v_counter_id FROM fleet_staff WHERE fleet_id = p_fleet_id AND portal_user_id = current_portal_user_id();
  IF NOT v_is_owner AND v_role IS NULL THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object(
    'is_owner', v_is_owner, 'role', v_role, 'counter_id', v_counter_id,
    'bookings_unlocked', fleet_staff_role_has_permission(p_fleet_id, 'accountant', 'bookings')
  );
END;
$$;
REVOKE ALL ON FUNCTION my_fleet_staff_context(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_fleet_staff_context(uuid) TO authenticated;
