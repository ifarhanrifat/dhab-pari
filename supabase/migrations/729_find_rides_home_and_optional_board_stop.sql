-- ═════════════════════════════════════════════════════════════════════════
-- Real ask, 2026-10-21: the rider home page gets a "Go Home" quick
-- action — confirmed with the user: "find a ride back to the village,"
-- reusing the return-leg booking work just shipped (727/728), not a
-- new booking system. A rider using this is, by definition, physically
-- at the OTHER end already (the city) — boarding right at the route's
-- own destination endpoint, not partway down a configured via-stop —
-- so book_standalone_return_seat needs to work with no stop at all
-- (full one-way fare, fraction = 1), which it never supported.
-- ═════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION book_standalone_return_seat(p_route_id uuid, p_travel_date date, p_board_stop_id uuid DEFAULT NULL, p_method varchar DEFAULT 'cash', p_proof_url text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE;
  v_vehicle vehicles%ROWTYPE;
  v_stop route_stops%ROWTYPE;
  v_available int;
  v_forward_fraction numeric;
  v_total decimal;
  v_booking_id uuid;
  v_commission_pct decimal;
  v_expected_commission decimal;
  v_stop_label text;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND is_active;
  IF NOT FOUND OR NOT v_route.is_two_way THEN RAISE EXCEPTION 'This route does not run a separate return leg.' USING ERRCODE = 'P0001'; END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;

  IF p_board_stop_id IS NOT NULL THEN
    SELECT * INTO v_stop FROM route_stops WHERE id = p_board_stop_id AND route_id = p_route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real stop on this route.' USING ERRCODE = 'P0001'; END IF;
    v_forward_fraction := 1 - route_fraction_remaining(p_route_id, v_stop.lat, v_stop.lng);
    v_stop_label := v_stop.label;
  ELSE
    -- No stop given — boarding right at the route's own destination
    -- endpoint (the "Go Home" case), which is the full return journey.
    v_forward_fraction := 1;
    v_stop_label := v_route.destination;
  END IF;

  v_available := return_seats_available(p_route_id, p_travel_date);
  IF v_available <= 0 THEN RAISE EXCEPTION 'No seats are free on the return leg for that date.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;
  v_total := round(coalesce(v_route.fare_per_seat_pkr, 0) * v_forward_fraction);

  IF v_vehicle.commission_mode = 'monthly_lumpsum' THEN
    IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  ELSE
    IF NOT v_vehicle.is_active THEN
      RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings.' USING ERRCODE = 'P0001';
    END IF;
    v_commission_pct := vehicle_commission_pct(v_vehicle.vehicle_type, v_route.classification);
    v_expected_commission := round(v_total * v_commission_pct / 100, 2);
    IF seller_account_balance(ensure_vehicle_account(v_vehicle.id)) < v_expected_commission THEN
      RAISE EXCEPTION 'This vehicle''s wallet balance is too low to cover this booking''s commission — the driver needs to top up first.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO ride_bookings (route_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at, direction)
  VALUES (p_route_id, v_portal_user_id, p_travel_date, 1, v_total, 'announced', v_total, p_method, p_proof_url, now(), 'return')
  RETURNING id INTO v_booking_id;

  IF v_vehicle.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_vehicle.portal_user_id, 'route_return_seat_booked', 'Return-only seat booked',
      'A rider joined just the return leg from ' || v_stop_label || ' — Rs ' || round(v_total), '/portal/my-vehicle/routes');
  END IF;

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total);
END;
$$;
GRANT EXECUTE ON FUNCTION book_standalone_return_seat(uuid, date, uuid, varchar, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- "Go Home": today's open return-leg seats (Routes + Trip Offers) whose
-- destination matches the city the rider says they're currently in —
-- the reverse of the normal "pick a city, find a ride there" search.
-- Scoped to today only, same as the rest of the wait-window/offboard
-- model — this serves "I'm stuck in [city] right now, get me home,"
-- not a future-dated booking.
-- ═════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION find_rides_home(p_city_key text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date; v_dow int := extract(dow FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
BEGIN
  RETURN (
    SELECT COALESCE(jsonb_agg(row_data), '[]'::jsonb) FROM (
      SELECT 'route' AS kind, r.id, v.owner_name, v.vehicle_type, v.vehicle_number,
        r.origin, r.origin_ur, r.destination, r.destination_ur,
        round(coalesce(r.fare_per_seat_pkr, 0) / 2) AS approx_fare_pkr,
        return_seats_available(r.id, v_today) AS seats_available,
        r.return_departure_time AS departure_time, v_today AS travel_date
      FROM vehicle_routes r JOIN vehicles v ON v.id = r.vehicle_id
      WHERE r.is_active AND r.is_two_way AND lower(trim(r.destination)) = lower(trim(p_city_key))
        AND v_dow = ANY(r.days_of_week) AND return_seats_available(r.id, v_today) > 0
      UNION ALL
      SELECT 'trip' AS kind, o.id, v.owner_name, v.vehicle_type, v.vehicle_number,
        o.origin, o.origin_ur, o.destination, o.destination_ur,
        round(o.listed_fare_per_seat_pkr / 2) AS approx_fare_pkr,
        trip_return_seats_available(o.id) AS seats_available,
        o.return_departure_time_estimate AS departure_time, o.travel_date
      FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id
      WHERE o.trip_type = 'return' AND o.travel_date = v_today AND lower(trim(o.destination)) = lower(trim(p_city_key))
        AND trip_return_seats_available(o.id) > 0
    ) row_data
  );
END;
$$;
GRANT EXECUTE ON FUNCTION find_rides_home(text) TO authenticated;
