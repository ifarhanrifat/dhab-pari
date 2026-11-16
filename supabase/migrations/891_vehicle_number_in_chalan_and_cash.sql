-- Migration 891: continuing the registration-number-first fix — two
-- more real places (Cash, Chalan) show the driver's personal name as
-- a vehicle's identity because their own RPCs never returned
-- vehicle_number at all, unlike fleet_dashboard_summary (854, backs
-- Reports) which already had it. True replace of each function's exact
-- live body, adding the one missing field.

CREATE OR REPLACE FUNCTION route_departure_chalan(p_route_id uuid, p_travel_date date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_date date := COALESCE(p_travel_date, (now() AT TIME ZONE 'Asia/Karachi')::date);
  v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE;
  v_run route_runs%ROWTYPE;
  v_result jsonb;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_run FROM route_runs WHERE route_id = p_route_id AND direction = 'outbound' AND (started_at AT TIME ZONE 'Asia/Karachi')::date = v_date ORDER BY started_at DESC LIMIT 1;

  WITH rows AS (
    SELECT
      mb.id, 'manual'::varchar AS source, mb.passenger_name, mb.passenger_mobile, mb.seats, mb.total_amount_pkr AS amount,
      mb.payment_method, true AS is_confirmed, mb.board_stop_id,
      (SELECT array_agg(sn.seat_number ORDER BY sn.seat_number) FROM ride_booking_seat_numbers sn WHERE sn.manual_ride_booking_id = mb.id) AS seat_numbers
    FROM manual_ride_bookings mb
    WHERE mb.route_id = p_route_id AND mb.travel_date = v_date AND mb.status = 'confirmed'
    UNION ALL
    SELECT
      rb.id, 'app'::varchar AS source, pu.full_name, pu.mobile, rb.seats, rb.total_amount_pkr AS amount,
      rb.announced_method, rb.status = 'confirmed' AS is_confirmed, rb.board_stop_id,
      (SELECT array_agg(sn.seat_number ORDER BY sn.seat_number) FROM ride_booking_seat_numbers sn WHERE sn.ride_booking_id = rb.id) AS seat_numbers
    FROM ride_bookings rb JOIN portal_users pu ON pu.id = rb.portal_user_id
    WHERE rb.route_id = p_route_id AND rb.travel_date = v_date AND rb.status IN ('announced', 'confirmed') AND NOT rb.is_mid_route_catch
  ),
  onboard AS (
    SELECT jsonb_build_object('id', id, 'source', source, 'passenger_name', passenger_name, 'passenger_mobile', passenger_mobile,
      'seats', seats, 'seat_numbers', seat_numbers, 'amount', amount, 'payment_method', payment_method, 'is_confirmed', is_confirmed) AS row
    FROM rows WHERE board_stop_id IS NULL
  ),
  next_stop AS (
    SELECT rs.label, rs.stop_order, jsonb_build_object('id', rows.id, 'source', rows.source, 'passenger_name', rows.passenger_name, 'passenger_mobile', rows.passenger_mobile,
      'seats', rows.seats, 'seat_numbers', rows.seat_numbers, 'amount', rows.amount, 'payment_method', rows.payment_method, 'is_confirmed', rows.is_confirmed) AS row
    FROM rows JOIN route_stops rs ON rs.id = rows.board_stop_id
  )
  SELECT jsonb_build_object(
    'route_id', p_route_id, 'origin', v_route.origin, 'destination', v_route.destination, 'travel_date', v_date,
    'owner_name', v_vehicle.owner_name, 'vehicle_type', v_vehicle.vehicle_type, 'vehicle_number', v_vehicle.vehicle_number,
    'run_started_at', v_run.started_at, 'run_ended_at', v_run.ended_at,
    'onboard_now', (SELECT COALESCE(jsonb_agg(row), '[]'::jsonb) FROM onboard),
    'next_stops', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', label, 'passengers', passengers) ORDER BY stop_order), '[]'::jsonb)
      FROM (SELECT label, stop_order, jsonb_agg(row) AS passengers FROM next_stop GROUP BY label, stop_order) g
    ),
    'total_confirmed_count', (SELECT COALESCE(SUM(seats), 0) FROM rows WHERE is_confirmed),
    'total_unconfirmed_count', (SELECT COALESCE(SUM(seats), 0) FROM rows WHERE NOT is_confirmed),
    'cash_collected_pkr', (SELECT COALESCE(SUM(amount), 0) FROM rows WHERE is_confirmed AND payment_method = 'cash')
  ) INTO v_result;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION fleet_vehicle_cash_positions(p_fleet_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'vehicle_id', v.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
    'total_collected_pkr', COALESCE(collected.amt, 0), 'total_remitted_pkr', COALESCE(remitted.amt, 0),
    'cash_in_hand_pkr', COALESCE(collected.amt, 0) - COALESCE(remitted.amt, 0)
  ) ORDER BY v.owner_name), '[]'::jsonb) INTO v_result
  FROM vehicles v
  LEFT JOIN LATERAL (
    SELECT SUM(rb.total_amount_pkr) AS amt FROM ride_bookings rb JOIN vehicle_routes vr ON vr.id = rb.route_id
    WHERE vr.vehicle_id = v.id AND rb.announced_method = 'cash' AND rb.status = 'confirmed'
  ) collected ON true
  LEFT JOIN LATERAL (SELECT SUM(r.amount_pkr) AS amt FROM vehicle_cash_remittances r WHERE r.vehicle_id = v.id) remitted ON true
  WHERE v.fleet_id = p_fleet_id AND v.is_active;
  RETURN v_result;
END;
$$;
