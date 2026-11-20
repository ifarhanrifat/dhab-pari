-- Migration 928: 3 real bugs found + 1 real gap confirmed while
-- actually building and running a full Rawalpindi->Karachi route live
-- this session (new route, 2 drivers, 5 terminals, real dispatch,
-- boarding, stop challans, ride completion).

-- ═════════════════════════════════════════════════════════════════════
-- 1. is_route_operator (898) — true-replace, current body copied
-- verbatim plus one new OR EXISTS clause, symmetric with the existing
-- primary-driver check. Confirmed live: route_group_detail gave the
-- primary driver can_run_ride=true but the assigned co-driver
-- can_run_ride=false — RouteGroupPanel.tsx gates Start/Attendance/
-- Arrived/End/Board/No-Show on exactly this flag, so a co-driver
-- assigned for a long route had no way to actually operate it outside
-- a live mid-route handover.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION is_route_operator(p_route_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id
    WHERE vr.id = p_route_id AND v.portal_user_id = current_portal_user_id()
  ) OR EXISTS (
    SELECT 1 FROM vehicle_routes vr WHERE vr.id = p_route_id AND vr.co_driver_portal_user_id = current_portal_user_id()
  ) OR EXISTS (
    SELECT 1 FROM route_run_substitutions s JOIN vehicles v ON v.id = s.substitute_vehicle_id
    WHERE s.route_id = p_route_id AND s.run_date = (now() AT TIME ZONE 'Asia/Karachi')::date
      AND s.status = 'active' AND v.portal_user_id = current_portal_user_id()
  ) OR EXISTS (
    SELECT 1 FROM route_runs rr JOIN route_run_driver_shifts sh ON sh.route_run_id = rr.id
    WHERE rr.route_id = p_route_id AND rr.ended_at IS NULL AND sh.ended_at IS NULL AND sh.driver_portal_user_id = current_portal_user_id()
  );
$$;
REVOKE ALL ON FUNCTION is_route_operator(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_route_operator(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 2. route_origin_counter_id — the route's lowest-stop_order terminal,
-- used ONLY to resolve terminal scoping when a booking boards at the
-- implicit origin (board_stop_id IS NULL). Never changes what's
-- stored or how route_departure_chalan's onboard_now grouping works
-- (still keyed on literal board_stop_id IS NULL) — purely closes the
-- real gap confirmed live: a Peshawar-assigned staff member could
-- board a Rawalpindi-origin passenger because board_stop_id IS NULL
-- resolved to no counter at all, even though a real Rawalpindi
-- terminal (with its own route_stops row) existed for that route.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION route_origin_counter_id(p_route_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT counter_id FROM route_stops WHERE route_id = p_route_id ORDER BY stop_order ASC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION route_origin_counter_id(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION route_origin_counter_id(uuid) TO authenticated;

-- board_manual_ticket (926) — true-replace, current body copied
-- verbatim, only the board-counter resolution widened with the origin
-- fallback.
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
  IF mb.board_stop_id IS NULL THEN v_board_counter_id := route_origin_counter_id(mb.route_id); END IF;
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

-- mark_manual_ticket_no_show (926) — true-replace, same origin
-- fallback added.
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
  IF v_board_stop_id IS NULL THEN v_board_counter_id := route_origin_counter_id(v_route_id); END IF;
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

-- mark_manual_ticket_alighted (926) — true-replace, same origin
-- fallback added.
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
  IF mb.board_stop_id IS NULL THEN v_board_counter_id := route_origin_counter_id(mb.route_id); END IF;
  IF NOT is_my_counter_or_admin(v_board_counter_id) THEN RAISE EXCEPTION 'You can only manage passengers at your own terminal.' USING ERRCODE = 'P0001'; END IF;
  IF mb.status != 'confirmed' THEN RAISE EXCEPTION 'This ticket is not valid for alighting.' USING ERRCODE = 'P0001'; END IF;
  IF mb.boarded_at IS NULL THEN RAISE EXCEPTION 'This passenger has not boarded yet.' USING ERRCODE = 'P0001'; END IF;
  IF mb.dropped_off_at IS NOT NULL THEN RAISE EXCEPTION 'This passenger has already alighted.' USING ERRCODE = 'P0001'; END IF;
  UPDATE manual_ride_bookings SET dropped_off_at = now() WHERE id = p_id;
END;
$$;

-- close_route_stop_challan (926) — true-replace, current body copied
-- verbatim, only the stop-counter resolution widened: closing the
-- origin (p_stop_id IS NULL) now resolves to the route's real origin
-- terminal for scoping, same as the 3 functions above.
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
  ELSE
    v_counter_id := route_origin_counter_id(p_route_id);
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
-- 3. create_fleet_vehicle_direct (888) — true-replace, current body
-- copied verbatim plus commission_mode='monthly_lumpsum' on the
-- INSERT. Confirmed live: every existing fleet vehicle (QA-BUS-01/02,
-- QA-COA-03) already uses monthly_lumpsum; a freshly-added bus
-- defaulted to the table's own 'per_order' and failed start_route_run
-- with a wallet-balance error the very first time it was dispatched.
-- Fleet vehicles don't go through the per-order marketplace commission
-- path, so this isn't a choice an owner needs to make.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION create_fleet_vehicle_direct(
  p_fleet_id uuid, p_category_id uuid, p_model varchar DEFAULT NULL, p_color varchar DEFAULT NULL,
  p_vehicle_number varchar DEFAULT NULL, p_total_seats int DEFAULT 0, p_has_ac boolean DEFAULT false,
  p_model_year int DEFAULT NULL, p_primary_driver_fleet_staff_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_driver_portal_user_id uuid; v_owner_name varchar; v_vehicle_type varchar; v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id AND owning_portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_total_seats IS NULL OR p_total_seats <= 0 THEN RAISE EXCEPTION 'Enter a real seat count.' USING ERRCODE = 'P0001'; END IF;
  IF p_model_year IS NOT NULL AND (p_model_year < 1980 OR p_model_year > extract(year FROM now())::int + 1) THEN
    RAISE EXCEPTION 'Enter a real model year.' USING ERRCODE = 'P0001';
  END IF;

  v_driver_portal_user_id := v_portal_user_id;
  IF p_primary_driver_fleet_staff_id IS NOT NULL THEN
    SELECT fs.portal_user_id INTO v_driver_portal_user_id FROM fleet_staff fs WHERE fs.id = p_primary_driver_fleet_staff_id AND fs.fleet_id = p_fleet_id AND fs.role = 'driver';
    IF v_driver_portal_user_id IS NULL THEN RAISE EXCEPTION 'That driver is not part of this fleet.' USING ERRCODE = 'P0001'; END IF;
  END IF;

  SELECT full_name INTO v_owner_name FROM portal_users WHERE id = v_driver_portal_user_id;
  SELECT name INTO v_vehicle_type FROM vehicle_categories WHERE id = p_category_id;
  IF v_vehicle_type IS NULL THEN RAISE EXCEPTION 'Unknown vehicle category.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicles (owner_name, vehicle_type, vehicle_number, total_seats, portal_user_id, fleet_id, category_id, model, color, has_ac, model_year, commission_mode)
  VALUES (v_owner_name, v_vehicle_type, nullif(trim(coalesce(p_vehicle_number, '')), ''), p_total_seats, v_driver_portal_user_id, p_fleet_id, p_category_id,
    nullif(trim(coalesce(p_model, '')), ''), nullif(trim(coalesce(p_color, '')), ''), p_has_ac, p_model_year, 'monthly_lumpsum')
  RETURNING id INTO v_id;

  PERFORM log_fleet_action(p_fleet_id, 'vehicle_added', jsonb_build_object('vehicle_id', v_id, 'vehicle_number', p_vehicle_number));
  RETURN v_id;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 4. fleet_passenger_history — repeat-passenger recognition for
-- manual/counter bookings, confirmed as a real gap directly: the
-- passenger name/mobile fields were plain retyped text every time,
-- with no lookup, autofill or history anywhere (unlike an online app
-- rider, who's already remembered forever via their portal_users
-- account). Reuses manual_ride_bookings as the historical record —
-- it already persists forever — rather than a new "customer" table.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fleet_passenger_history(p_fleet_id uuid, p_mobile varchar) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_mobile varchar := nullif(trim(coalesce(p_mobile, '')), ''); v_result jsonb;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF v_mobile IS NULL THEN RETURN jsonb_build_object('trip_count', 0); END IF;

  SELECT jsonb_build_object(
    'trip_count', COUNT(*),
    'last_full_name', (array_agg(mb.passenger_name ORDER BY mb.travel_date DESC, mb.created_at DESC))[1],
    'last_travel_date', (array_agg(mb.travel_date ORDER BY mb.travel_date DESC, mb.created_at DESC))[1],
    'last_origin', (array_agg(vr.origin ORDER BY mb.travel_date DESC, mb.created_at DESC))[1],
    'last_destination', (array_agg(vr.destination ORDER BY mb.travel_date DESC, mb.created_at DESC))[1]
  ) INTO v_result
  FROM manual_ride_bookings mb
  JOIN vehicle_routes vr ON vr.id = mb.route_id
  JOIN vehicles v ON v.id = vr.vehicle_id
  WHERE v.fleet_id = p_fleet_id AND mb.passenger_mobile = v_mobile AND mb.status != 'cancelled';

  RETURN COALESCE(v_result, jsonb_build_object('trip_count', 0));
END;
$$;
REVOKE ALL ON FUNCTION fleet_passenger_history(uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_passenger_history(uuid, varchar) TO authenticated;
