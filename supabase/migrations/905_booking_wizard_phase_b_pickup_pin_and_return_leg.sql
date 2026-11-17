-- Migration 905: Phase B of the booking-wizard rebuild (plan:
-- proud-tickling-glacier.md) — the two genuinely new concepts from
-- SAFAR_Admin_Dashboard_Professional_Booking-4.html: a free-GPS
-- pickup pin (not just a listed stop) with a dispatcher-approval
-- status, and a Return leg linked back to its Outbound sibling as
-- two real rows rather than a new junction table.
ALTER TABLE manual_ride_bookings
  ADD COLUMN IF NOT EXISTS pickup_lat numeric,
  ADD COLUMN IF NOT EXISTS pickup_lng numeric,
  ADD COLUMN IF NOT EXISTS pickup_point varchar,
  ADD COLUMN IF NOT EXISTS pickup_approval_status varchar CHECK (pickup_approval_status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS return_leg_of uuid REFERENCES manual_ride_bookings(id) ON DELETE SET NULL;

-- record_manual_booking (883) — true replace, only the new optional
-- params and the pickup/return-leg handling added; every existing
-- line is unchanged.
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
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
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

  -- 905: a map pickup pin needs both coordinates, in valid GPS range,
  -- and starts out pending dispatcher/route approval — matching the
  -- reference's own "requires dispatcher approval" behavior.
  IF p_pickup_lat IS NOT NULL OR p_pickup_lng IS NOT NULL THEN
    IF p_pickup_lat IS NULL OR p_pickup_lng IS NULL THEN
      RAISE EXCEPTION 'Enter both pickup coordinates, or neither.' USING ERRCODE = 'P0001';
    END IF;
    IF p_pickup_lat < -90 OR p_pickup_lat > 90 OR p_pickup_lng < -180 OR p_pickup_lng > 180 THEN
      RAISE EXCEPTION 'Enter valid GPS coordinates for the pickup pin.' USING ERRCODE = 'P0001';
    END IF;
    v_pickup_approval := 'pending';
  END IF;

  -- 905: a Return leg links back to its Outbound sibling — must be a
  -- real booking this caller manages, and not itself already a
  -- Return leg (no chaining more than one hop).
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

  -- 883: credit the recording staff member's commission, if they have
  -- one set — the fleet owner themselves never has a fleet_staff row
  -- in their own fleet, so this naturally no-ops for owner-recorded sales.
  SELECT * INTO v_fleet_staff FROM fleet_staff WHERE portal_user_id = v_portal_user_id AND fleet_id = v_vehicle.fleet_id;
  IF FOUND AND v_fleet_staff.commission_amount_pkr IS NOT NULL AND v_fleet_staff.commission_amount_pkr > 0 THEN
    INSERT INTO fleet_staff_commissions (fleet_staff_id, manual_ride_booking_id, seats, amount_pkr)
    VALUES (v_fleet_staff.id, v_id, p_seats, v_fleet_staff.commission_amount_pkr * p_seats);
  END IF;

  RETURN jsonb_build_object('id', v_id, 'ticket_no', v_ticket_no, 'pickup_approval_status', v_pickup_approval);
END;
$$;

-- New: approve/reject a pending map-pickup request. Gated on
-- can_administer_vehicle — a safety/dispatch decision, not a driving
-- one, same reasoning as the Phase F permission split earlier this
-- session (the driver who's actually on the road isn't the one who
-- should be clearing their own roadside pickup for themselves).
CREATE OR REPLACE FUNCTION approve_manual_booking_pickup(p_booking_id uuid, p_approve boolean, p_reason varchar DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_booking manual_ride_bookings%ROWTYPE; v_route vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO v_booking FROM manual_ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_route FROM vehicle_routes WHERE id = v_booking.route_id;
  IF NOT can_administer_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF v_booking.pickup_approval_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'This booking has no pending pickup request.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE manual_ride_bookings SET pickup_approval_status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
    status = CASE WHEN NOT p_approve THEN 'cancelled' ELSE status END
  WHERE id = p_booking_id;
END;
$$;
REVOKE ALL ON FUNCTION record_manual_booking(uuid, date, int, varchar, decimal, uuid, varchar, varchar, uuid, uuid, int[], varchar, jsonb, numeric, numeric, varchar, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_manual_booking(uuid, date, int, varchar, decimal, uuid, varchar, varchar, uuid, uuid, int[], varchar, jsonb, numeric, numeric, varchar, uuid) TO authenticated;
REVOKE ALL ON FUNCTION approve_manual_booking_pickup(uuid, boolean, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION approve_manual_booking_pickup(uuid, boolean, varchar) TO authenticated;
