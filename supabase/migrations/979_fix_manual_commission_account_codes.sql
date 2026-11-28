-- Migration 979: urgent fix — 977 (minutes ago) added commission posting
-- to record_manual_booking/record_manual_return_booking using the
-- system='donors_projects' / code='DP-4050' account, copied from the
-- confirm_ride_booking body visible in migration 394. That body is stale:
-- migration 661/662 moved the whole marketplace accounting system onto
-- its own system='marketplace', re-coded DP-4050 → MKT-4050, and made the
-- account per-tenant (one MKT-4050 row per tenant, not a single global
-- one) — confirmed live, querying for a `donors_projects`/`DP-4050`
-- account now returns zero rows in every tenant. The real, current
-- confirm_ride_booking (662) already uses system='marketplace', code=
-- 'MKT-4050', scoped by tenant_id — this migration brings the two manual
-- functions in line with that, using the vehicle's own tenant_id (manual_
-- ride_bookings has no tenant_id column of its own to read, unlike
-- ride_bookings).
--
-- Caught immediately while verification-testing 977 on a real per_order
-- bus before any real counter sale hit it: record_manual_booking raised
-- "null value in column from_account_id violates not-null constraint" —
-- the whole booking insert rolled back with it (same transaction), so no
-- live ticket sale was actually broken, but it would have started
-- failing the moment any per_order-mode vehicle's counter tried to sell
-- a seat. No test data was left behind by the failed attempt (the
-- transaction never committed).

CREATE OR REPLACE FUNCTION record_manual_booking(
  p_route_id uuid, p_travel_date date, p_seats int, p_passenger_name varchar, p_total_amount_pkr decimal,
  p_counter_id uuid DEFAULT NULL, p_passenger_mobile varchar DEFAULT NULL, p_payment_method varchar DEFAULT 'cash',
  p_board_stop_id uuid DEFAULT NULL, p_alight_stop_id uuid DEFAULT NULL, p_seat_numbers int[] DEFAULT NULL,
  p_emergency_contact_phone varchar DEFAULT NULL, p_passengers jsonb DEFAULT NULL,
  p_pickup_lat numeric DEFAULT NULL, p_pickup_lng numeric DEFAULT NULL, p_pickup_point varchar DEFAULT NULL,
  p_return_leg_of uuid DEFAULT NULL, p_discount_pct decimal DEFAULT 0, p_discount_value decimal DEFAULT 0
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
  v_commission_pct decimal; v_commission_amount decimal; v_commission_account uuid; v_vehicle_account uuid; v_commission_voucher_id uuid;
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
  IF p_discount_pct < 0 OR p_discount_pct > 100 THEN RAISE EXCEPTION 'Discount percentage must be between 0 and 100.' USING ERRCODE = 'P0001'; END IF;
  IF p_discount_value < 0 THEN RAISE EXCEPTION 'Discount amount cannot be negative.' USING ERRCODE = 'P0001'; END IF;

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
    total_amount_pkr, payment_method, ticket_no, emergency_contact_phone, pickup_lat, pickup_lng, pickup_point, pickup_approval_status, return_leg_of,
    discount_pct, discount_value
  )
  VALUES (
    p_route_id, p_counter_id, v_portal_user_id, p_travel_date, p_seats, trim(p_passenger_name), nullif(trim(coalesce(p_passenger_mobile, '')), ''), p_board_stop_id, p_alight_stop_id,
    p_total_amount_pkr, p_payment_method, v_ticket_no, nullif(trim(coalesce(p_emergency_contact_phone, '')), ''), p_pickup_lat, p_pickup_lng, nullif(trim(coalesce(p_pickup_point, '')), ''), v_pickup_approval, p_return_leg_of,
    p_discount_pct, p_discount_value
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

  IF v_vehicle.commission_mode != 'monthly_lumpsum' THEN
    v_commission_pct := vehicle_commission_pct(v_vehicle.vehicle_type, v_route.classification);
    v_commission_amount := round(p_total_amount_pkr * v_commission_pct / 100, 2);
    IF v_commission_amount > 0 THEN
      v_vehicle_account := ensure_vehicle_account(v_vehicle.id);
      SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050' AND tenant_id = v_vehicle.tenant_id;
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — ' || v_route.origin || ' → ' || v_route.destination || ' counter seat sale (ticket ' || v_ticket_no || ')',
        v_commission_amount, v_commission_account, v_vehicle_account, v_vehicle.owner_name)
      RETURNING id INTO v_commission_voucher_id;
      UPDATE manual_ride_bookings SET commission_voucher_id = v_commission_voucher_id WHERE id = v_id;
      PERFORM check_seller_balance_notify('vehicle', v_vehicle.id);
    END IF;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'ticket_no', v_ticket_no, 'pickup_approval_status', v_pickup_approval);
END;
$$;

CREATE OR REPLACE FUNCTION record_manual_return_booking(
  p_route_id uuid, p_travel_date date, p_seats int, p_passenger_name varchar, p_total_amount_pkr decimal DEFAULT NULL,
  p_counter_id uuid DEFAULT NULL, p_passenger_mobile varchar DEFAULT NULL, p_payment_method varchar DEFAULT 'cash',
  p_board_stop_id uuid DEFAULT NULL, p_seat_numbers int[] DEFAULT NULL,
  p_emergency_contact_phone varchar DEFAULT NULL, p_passengers jsonb DEFAULT NULL, p_outbound_leg_of uuid DEFAULT NULL,
  p_discount_pct decimal DEFAULT 0, p_discount_value decimal DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE; v_vehicle_kind varchar;
  v_stop route_stops%ROWTYPE; v_forward_fraction numeric; v_weekday int; v_available int;
  v_total decimal; v_id uuid; v_ticket_no varchar;
  v_passenger jsonb; v_paid_idx int := 0;
  v_sn int;
  v_board_city varchar; v_origin_city varchar;
  v_commission_pct decimal; v_commission_amount decimal; v_commission_account uuid; v_vehicle_account uuid; v_commission_voucher_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF NOT v_route.is_two_way THEN RAISE EXCEPTION 'This route does not run a separate return leg.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;
  IF p_discount_pct < 0 OR p_discount_pct > 100 THEN RAISE EXCEPTION 'Discount percentage must be between 0 and 100.' USING ERRCODE = 'P0001'; END IF;
  IF p_discount_value < 0 THEN RAISE EXCEPTION 'Discount amount cannot be negative.' USING ERRCODE = 'P0001'; END IF;

  v_weekday := extract(dow FROM p_travel_date)::int;
  IF NOT (v_weekday = ANY(COALESCE(v_route.return_days_of_week, v_route.days_of_week))) THEN
    RAISE EXCEPTION 'The return leg does not run on that day.' USING ERRCODE = 'P0001';
  END IF;

  IF p_counter_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_counters WHERE id = p_counter_id AND fleet_id = v_vehicle.fleet_id) THEN
    RAISE EXCEPTION 'That counter is not part of this vehicle''s fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_seats IS NULL OR p_seats <= 0 THEN RAISE EXCEPTION 'Enter at least one seat.' USING ERRCODE = 'P0001'; END IF;
  IF trim(coalesce(p_passenger_name, '')) = '' THEN RAISE EXCEPTION 'Enter the passenger''s name.' USING ERRCODE = 'P0001'; END IF;

  IF p_outbound_leg_of IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM manual_ride_bookings mb JOIN vehicle_routes vr ON vr.id = mb.route_id
      WHERE mb.id = p_outbound_leg_of AND mb.direction = 'outbound' AND mb.return_leg_of IS NULL AND can_manage_vehicle(vr.vehicle_id)
    ) THEN
      RAISE EXCEPTION 'The outbound booking for this return leg was not found.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_board_stop_id IS NOT NULL THEN
    SELECT * INTO v_stop FROM route_stops WHERE id = p_board_stop_id AND route_id = p_route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real stop on this route.' USING ERRCODE = 'P0001'; END IF;
    v_forward_fraction := 1 - route_fraction_remaining(p_route_id, v_stop.lat, v_stop.lng);
  ELSE
    v_forward_fraction := 1;
  END IF;

  IF v_route.fare_mode = 'terminal_zone' THEN
    IF p_board_stop_id IS NOT NULL THEN
      SELECT fc.city INTO v_board_city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id WHERE rs.id = p_board_stop_id;
    ELSE
      SELECT fc.city INTO v_board_city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id WHERE rs.route_id = p_route_id ORDER BY rs.stop_order DESC LIMIT 1;
    END IF;
    SELECT fc.city INTO v_origin_city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id WHERE rs.route_id = p_route_id ORDER BY rs.stop_order ASC LIMIT 1;
    v_total := COALESCE(p_total_amount_pkr, route_zone_fare_by_city(p_route_id, v_board_city, v_origin_city) * p_seats);
  ELSE
    v_total := COALESCE(p_total_amount_pkr, round(coalesce(v_route.fare_per_seat_pkr, 0) * p_seats * v_forward_fraction));
  END IF;
  v_total := GREATEST(0, round(v_total * (1 - p_discount_pct / 100.0) - p_discount_value));
  IF v_total IS NULL OR v_total < 0 THEN RAISE EXCEPTION 'Enter the fare collected.' USING ERRCODE = 'P0001'; END IF;

  v_available := return_seats_available(p_route_id, p_travel_date);
  IF p_seats > v_available THEN RAISE EXCEPTION 'Only % seat(s) left on the return leg for that date.', v_available USING ERRCODE = 'P0001'; END IF;

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

  v_ticket_no := generate_ticket_no();

  INSERT INTO manual_ride_bookings (
    route_id, counter_id, recorded_by_portal_user_id, travel_date, seats, passenger_name, passenger_mobile, board_stop_id,
    total_amount_pkr, payment_method, ticket_no, emergency_contact_phone, direction, return_leg_of, discount_pct, discount_value
  )
  VALUES (
    p_route_id, p_counter_id, v_portal_user_id, p_travel_date, p_seats, trim(p_passenger_name), nullif(trim(coalesce(p_passenger_mobile, '')), ''), p_board_stop_id,
    v_total, p_payment_method, v_ticket_no, nullif(trim(coalesce(p_emergency_contact_phone, '')), ''), 'return', p_outbound_leg_of, p_discount_pct, p_discount_value
  )
  RETURNING id INTO v_id;

  IF p_seat_numbers IS NOT NULL THEN
    FOREACH v_sn IN ARRAY (SELECT array_agg(x ORDER BY x) FROM unnest(p_seat_numbers) x) LOOP
      PERFORM assert_seat_segment_free(p_route_id, p_travel_date, 'return', v_sn, -1, 2000000000);
      INSERT INTO ride_booking_seat_numbers (manual_ride_booking_id, route_id, travel_date, direction, seat_number, board_order, alight_order)
      VALUES (v_id, p_route_id, p_travel_date, 'return', v_sn, -1, 2000000000);
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

  IF v_vehicle.commission_mode != 'monthly_lumpsum' THEN
    v_commission_pct := vehicle_commission_pct(v_vehicle.vehicle_type, v_route.classification);
    v_commission_amount := round(v_total * v_commission_pct / 100, 2);
    IF v_commission_amount > 0 THEN
      v_vehicle_account := ensure_vehicle_account(v_vehicle.id);
      SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050' AND tenant_id = v_vehicle.tenant_id;
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — ' || v_route.destination || ' → ' || v_route.origin || ' return counter seat sale (ticket ' || v_ticket_no || ')',
        v_commission_amount, v_commission_account, v_vehicle_account, v_vehicle.owner_name)
      RETURNING id INTO v_commission_voucher_id;
      UPDATE manual_ride_bookings SET commission_voucher_id = v_commission_voucher_id WHERE id = v_id;
      PERFORM check_seller_balance_notify('vehicle', v_vehicle.id);
    END IF;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'ticket_no', v_ticket_no, 'total_amount_pkr', v_total);
END;
$$;
