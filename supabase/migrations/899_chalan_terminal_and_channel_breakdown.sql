-- Migration 899: real gap confirmed by deep audit, 2026-11-17 — a
-- booking officer had no way to see, for a given route+date, how many
-- seats were booked online vs. at a counter vs. by the driver on the
-- road, let alone which TERMINAL sold which seats. Each passenger row
-- was already tagged source: 'manual'|'app' and manual rows already
-- carried counter_id — none of it was ever aggregated or surfaced.
-- True replace of route_departure_chalan (891)'s exact current body:
-- added counter_id to the manual branch (NULL for online, same as
-- the column itself), and two new summary keys, by_source and
-- by_counter (counter_id NULL within manual = driver walk-up).
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
      mb.payment_method, true AS is_confirmed, mb.board_stop_id, mb.counter_id,
      (SELECT array_agg(sn.seat_number ORDER BY sn.seat_number) FROM ride_booking_seat_numbers sn WHERE sn.manual_ride_booking_id = mb.id) AS seat_numbers
    FROM manual_ride_bookings mb
    WHERE mb.route_id = p_route_id AND mb.travel_date = v_date AND mb.status = 'confirmed'
    UNION ALL
    SELECT
      rb.id, 'app'::varchar AS source, pu.full_name, pu.mobile, rb.seats, rb.total_amount_pkr AS amount,
      rb.announced_method, rb.status = 'confirmed' AS is_confirmed, rb.board_stop_id, NULL::uuid AS counter_id,
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
    'cash_collected_pkr', (SELECT COALESCE(SUM(amount), 0) FROM rows WHERE is_confirmed AND payment_method = 'cash'),
    'by_source', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('source', source, 'seats', total_seats) ORDER BY source), '[]'::jsonb)
      FROM (SELECT source, SUM(seats) AS total_seats FROM rows WHERE is_confirmed GROUP BY source) g
    ),
    'by_counter', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'counter_id', counter_id, 'counter_name', counter_name, 'city', city, 'seats', total_seats
      ) ORDER BY total_seats DESC), '[]'::jsonb)
      FROM (
        SELECT r.counter_id, c.name AS counter_name, c.city, SUM(r.seats) AS total_seats
        FROM rows r LEFT JOIN fleet_counters c ON c.id = r.counter_id
        WHERE r.is_confirmed AND r.source = 'manual'
        GROUP BY r.counter_id, c.name, c.city
      ) g
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;
