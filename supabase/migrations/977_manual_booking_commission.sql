-- Migration 977: real question from the fleet owner, 2026-11-28 — "the bus
-- fleet owner will set their own fares, it has nothing to do with the
-- backend's committee cut; the seat commission is set by the backend for
-- online booking only, admin-set (1-2%/seat) — should we charge the same
-- commission on manual/counter bookings too?"
--
-- Answer implemented here: yes, same mechanism, both channels. The real
-- gap this closes: vehicle_commission_pct() + the DP-4050 commission
-- voucher (394) already fire for every ONLINE ride_bookings confirmation
-- (confirm_ride_booking) — but manual_ride_bookings (the counter/staff
-- path, which is the dominant real-world sales channel for buses) never
-- went through that mechanism at all. Left alone, that's a standing
-- incentive to sell every seat at the counter instead of the app purely
-- to dodge the fee. Fare itself is untouched either way — the fleet owner
-- still sets fare_per_seat_pkr with zero platform markup, same as today;
-- the commission is drawn from the vehicle's own wallet afterward, same
-- model as every other per_order seller in this codebase.
--
-- Deliberately NOT adding a pre-booking wallet-balance hard-gate here
-- (unlike place_ride_booking's own gate on the online path) — a manual
-- counter sale is a live, already-happened cash transaction at a real bus
-- stand; until today nothing has ever required these wallets to carry a
-- balance, so most are likely at zero, and hard-blocking a sale because of
-- that would stop a bus from selling tickets outright. Instead this mirrors
-- confirm_ride_booking's own actual commission-posting step, which also
-- never re-checks balance before drawing the commission — it just posts,
-- letting the wallet go negative if it must, and check_seller_balance_notify
-- (394) keeps nudging the owner to top up. A hard gate can be added later
-- if the committee decides unpaid commission is enough of a problem to
-- justify blocking sales over it — a bigger, deliberate call, not a side
-- effect of this migration.

ALTER TABLE manual_ride_bookings ADD COLUMN IF NOT EXISTS commission_voucher_id uuid REFERENCES vouchers(id);

-- record_manual_booking (final body: 976) — true-replace, same signature.
-- Only change: once the booking is recorded, a per_order vehicle's
-- commission is drawn from its wallet into DP-4050, computed off
-- p_total_amount_pkr (the actual amount collected — already whatever the
-- staff typed after any discount, same authoritative-total model 976
-- already established). monthly_lumpsum vehicles are skipped, same as
-- every other commission site in this codebase — they already prepaid.
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

  -- Platform commission (new, 977) — same vehicle_commission_pct() lookup
  -- and DP-4050 voucher confirm_ride_booking already posts for the online
  -- path, now also fired here so a counter sale pays it exactly like an
  -- app sale does. Unrelated to fleet_staff_commissions just above, which
  -- is the fleet owner's own internal booking-officer sales incentive,
  -- paid out of the fleet's own money, not the committee's.
  IF v_vehicle.commission_mode != 'monthly_lumpsum' THEN
    v_commission_pct := vehicle_commission_pct(v_vehicle.vehicle_type, v_route.classification);
    v_commission_amount := round(p_total_amount_pkr * v_commission_pct / 100, 2);
    IF v_commission_amount > 0 THEN
      v_vehicle_account := ensure_vehicle_account(v_vehicle.id);
      SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050';
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
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

-- record_manual_return_booking (final body: 976) — true-replace, same
-- signature, same commission addition — computed off v_total, which
-- already carries this leg's own discount applied.
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
      SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050';
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
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

-- cancel_manual_booking (final body: 855) — true-replace, same signature.
-- A cancelled counter sale that already had its commission posted (just
-- above) now has that commission reversed — a mirrored-swap voucher, same
-- shape reverse_voucher (207) uses for every other reversal in this
-- codebase, inlined here rather than calling that RPC directly because it
-- gates on an admin session (current_admin_permission) and this cancel is
-- triggered by the fleet's own staff, not an admin.
CREATE OR REPLACE FUNCTION cancel_manual_booking(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_booking manual_ride_bookings%ROWTYPE;
  v_commission_voucher vouchers%ROWTYPE;
  v_reversal_id uuid;
BEGIN
  SELECT * INTO v_booking FROM manual_ride_bookings WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicle_routes vr WHERE vr.id = v_booking.route_id AND can_manage_vehicle(vr.vehicle_id)) THEN
    RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE manual_ride_bookings SET status = 'cancelled' WHERE id = p_id;
  DELETE FROM ride_booking_seat_numbers WHERE manual_ride_booking_id = p_id;

  IF v_booking.commission_voucher_id IS NOT NULL THEN
    SELECT * INTO v_commission_voucher FROM vouchers WHERE id = v_booking.commission_voucher_id;
    IF FOUND AND v_commission_voucher.reversed_by_voucher_id IS NULL THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name, reverses_voucher_id, reversal_reason)
      VALUES (v_commission_voucher.system, v_commission_voucher.voucher_type, (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Reversal of ' || COALESCE(v_commission_voucher.voucher_no, 'voucher') || ' — counter booking cancelled',
        v_commission_voucher.amount_pkr, v_commission_voucher.to_account_id, v_commission_voucher.from_account_id, v_commission_voucher.party_name,
        v_commission_voucher.id, 'Counter booking cancelled')
      RETURNING id INTO v_reversal_id;
      UPDATE vouchers SET reversed_by_voucher_id = v_reversal_id WHERE id = v_commission_voucher.id;
    END IF;
  END IF;
END;
$$;
