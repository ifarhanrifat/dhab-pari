-- Migration 866: real bug reported live — "re adjusting of the seats
-- is working without checking if on that date any vehicle seat is
-- vacant or not nor it can select the adjusted date seat." Confirmed:
-- the reschedule RPCs carried the booking's OLD seat numbers straight
-- onto the new date with no way to see which seats are actually free
-- that day or pick different ones — a clash just threw a flat "already
-- taken" error with no recovery path. fleet_search_bookings widened so
-- the frontend can show a seat picker when rescheduling a van-kind
-- booking; both reschedule RPCs gain an optional p_seat_numbers.

-- ═════════════════════════════════════════════════════════════════════
-- 1. fleet_search_bookings — add vehicle_id/is_van_kind/total_seats/
--    is_sleeper/seat_numbers so the Bookings UI knows whether to show a
--    seat picker on reschedule, and which seats this booking currently
--    holds. Same signature, true replace.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fleet_search_bookings(p_fleet_id uuid, p_query text DEFAULT NULL, p_travel_date date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result jsonb; v_q text := nullif(trim(coalesce(p_query, '')), '');
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'travel_date' DESC), '[]'::jsonb) INTO v_result FROM (
    SELECT jsonb_build_object(
      'id', mb.id, 'source', 'manual', 'passenger_name', mb.passenger_name, 'passenger_mobile', mb.passenger_mobile,
      'route_id', mb.route_id, 'origin', vr.origin, 'destination', vr.destination, 'owner_name', v.owner_name,
      'travel_date', mb.travel_date, 'seats', mb.seats, 'amount_pkr', mb.total_amount_pkr,
      'status', mb.status, 'payment_method', mb.payment_method,
      'vehicle_id', v.id, 'is_van_kind', vc.vehicle_kind = 'van', 'total_seats', v.total_seats, 'is_sleeper', v.is_sleeper,
      'seat_numbers', (SELECT array_agg(sn.seat_number ORDER BY sn.seat_number) FROM ride_booking_seat_numbers sn WHERE sn.manual_ride_booking_id = mb.id)
    ) AS row
    FROM manual_ride_bookings mb JOIN vehicle_routes vr ON vr.id = mb.route_id JOIN vehicles v ON v.id = vr.vehicle_id
    LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
    WHERE v.fleet_id = p_fleet_id AND mb.status = 'confirmed'
      AND (p_travel_date IS NULL OR mb.travel_date = p_travel_date)
      AND (v_q IS NULL OR mb.passenger_name ILIKE '%' || v_q || '%' OR mb.passenger_mobile ILIKE '%' || v_q || '%')

    UNION ALL

    SELECT jsonb_build_object(
      'id', rb.id, 'source', 'app', 'passenger_name', pu.full_name, 'passenger_mobile', pu.mobile,
      'route_id', rb.route_id, 'origin', vr.origin, 'destination', vr.destination, 'owner_name', v.owner_name,
      'travel_date', rb.travel_date, 'seats', rb.seats, 'amount_pkr', rb.total_amount_pkr,
      'status', rb.status, 'payment_method', rb.announced_method,
      'vehicle_id', v.id, 'is_van_kind', vc.vehicle_kind = 'van', 'total_seats', v.total_seats, 'is_sleeper', v.is_sleeper,
      'seat_numbers', (SELECT array_agg(sn.seat_number ORDER BY sn.seat_number) FROM ride_booking_seat_numbers sn WHERE sn.ride_booking_id = rb.id)
    ) AS row
    FROM ride_bookings rb JOIN vehicle_routes vr ON vr.id = rb.route_id JOIN vehicles v ON v.id = vr.vehicle_id
    LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
    JOIN portal_users pu ON pu.id = rb.portal_user_id
    WHERE v.fleet_id = p_fleet_id AND rb.status IN ('announced', 'confirmed')
      AND (p_travel_date IS NULL OR rb.travel_date = p_travel_date)
      AND (v_q IS NULL OR pu.full_name ILIKE '%' || v_q || '%' OR pu.mobile ILIKE '%' || v_q || '%')
  ) rows;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION fleet_search_bookings(uuid, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_search_bookings(uuid, text, date) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 2. reschedule_manual_booking — new trailing p_seat_numbers int[]
--    DEFAULT NULL changes the argument-type list, so the old 2-arg
--    signature is dropped explicitly first (same overload trap hit
--    before this session, 849/863/864).
-- ═════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.reschedule_manual_booking(uuid, date);

CREATE OR REPLACE FUNCTION reschedule_manual_booking(p_id uuid, p_new_travel_date date, p_seat_numbers int[] DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE mb manual_ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v_available int; v_weekday int;
BEGIN
  SELECT * INTO mb FROM manual_ride_bookings WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_routes WHERE id = mb.route_id;
  IF NOT can_manage_vehicle(r.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF mb.status != 'confirmed' THEN RAISE EXCEPTION 'This booking can no longer be rescheduled.' USING ERRCODE = 'P0001'; END IF;
  IF p_new_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;

  v_weekday := extract(dow FROM p_new_travel_date)::int;
  IF NOT (v_weekday = ANY(r.days_of_week)) THEN RAISE EXCEPTION 'This route does not run on that day.' USING ERRCODE = 'P0001'; END IF;

  v_available := route_seats_available(mb.route_id, p_new_travel_date);
  IF mb.seats > v_available THEN RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001'; END IF;

  UPDATE manual_ride_bookings SET travel_date = p_new_travel_date WHERE id = p_id;

  IF p_seat_numbers IS NOT NULL THEN
    IF array_length(p_seat_numbers, 1) IS DISTINCT FROM mb.seats THEN
      RAISE EXCEPTION 'Pick exactly % seat(s).', mb.seats USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_seat_numbers) sn WHERE sn < 1 OR sn > route_effective_seats_for_date(mb.route_id, p_new_travel_date)) THEN
      RAISE EXCEPTION 'That seat doesn''t exist on this vehicle.' USING ERRCODE = 'P0001';
    END IF;
    DELETE FROM ride_booking_seat_numbers WHERE manual_ride_booking_id = p_id;
    BEGIN
      INSERT INTO ride_booking_seat_numbers (manual_ride_booking_id, route_id, travel_date, direction, seat_number)
      SELECT p_id, mb.route_id, p_new_travel_date, 'outbound', sn FROM unnest(p_seat_numbers) sn;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'One of those seats is already taken on that date — pick again.' USING ERRCODE = 'P0001';
    END;
  ELSE
    BEGIN
      UPDATE ride_booking_seat_numbers SET travel_date = p_new_travel_date WHERE manual_ride_booking_id = p_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'That seat is already taken by someone else on that date — pick a different date or seat.' USING ERRCODE = 'P0001';
    END;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION reschedule_manual_booking(uuid, date, int[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reschedule_manual_booking(uuid, date, int[]) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 3. reschedule_ride_booking — same overload-drop pattern, new trailing
--    p_seat_numbers appended after 864's can_manage_vehicle widening
--    (body below is that same widened version, plus seat reassignment).
-- ═════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.reschedule_ride_booking(uuid, date, uuid, uuid, boolean);

CREATE OR REPLACE FUNCTION reschedule_ride_booking(
  p_booking_id uuid, p_new_travel_date date,
  p_board_stop_id uuid DEFAULT NULL, p_alight_stop_id uuid DEFAULT NULL, p_clear_stops boolean DEFAULT false,
  p_seat_numbers int[] DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v_available int; v_weekday int;
  v_board_stop route_stops%ROWTYPE; v_alight_stop route_stops%ROWTYPE;
  v_segment_fraction numeric := 1; v_new_total numeric;
  v_use_board_stop_id uuid; v_use_alight_stop_id uuid;
  v_changing_stops boolean := p_clear_stops OR p_board_stop_id IS NOT NULL OR p_alight_stop_id IS NOT NULL;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_routes WHERE id = b.route_id;
  IF NOT (b.portal_user_id = current_portal_user_id() OR can_manage_vehicle(r.vehicle_id)) THEN
    RAISE EXCEPTION 'That is not your booking.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status NOT IN ('announced', 'confirmed') THEN RAISE EXCEPTION 'This booking can no longer be rescheduled.' USING ERRCODE = 'P0001'; END IF;
  IF b.route_id IS NULL THEN RAISE EXCEPTION 'This booking cannot be rescheduled.' USING ERRCODE = 'P0001'; END IF;
  IF p_new_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
  IF v_changing_stops AND b.status != 'announced' THEN
    RAISE EXCEPTION 'Your seat is already confirmed by the driver — cancel and book again to change your boarding stop.' USING ERRCODE = 'P0001';
  END IF;

  IF r.fare_mode = 'flex' THEN RAISE EXCEPTION 'This route''s fare depends on the date it''s booked for — cancel and rebook instead.' USING ERRCODE = 'P0001'; END IF;

  v_weekday := extract(dow FROM p_new_travel_date)::int;
  IF NOT (v_weekday = ANY(r.days_of_week)) THEN RAISE EXCEPTION 'This route does not run on that day.' USING ERRCODE = 'P0001'; END IF;

  v_available := route_seats_available(b.route_id, p_new_travel_date);
  IF b.seats > v_available THEN RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001'; END IF;

  IF p_clear_stops THEN
    v_use_board_stop_id := NULL; v_use_alight_stop_id := NULL; v_segment_fraction := 1;
  ELSIF p_board_stop_id IS NOT NULL OR p_alight_stop_id IS NOT NULL THEN
    IF (p_board_stop_id IS NULL) != (p_alight_stop_id IS NULL) THEN
      RAISE EXCEPTION 'Pick both a board and an alight stop, or neither.' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_board_stop FROM route_stops WHERE id = p_board_stop_id AND route_id = b.route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real board stop on this route.' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO v_alight_stop FROM route_stops WHERE id = p_alight_stop_id AND route_id = b.route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real alight stop on this route.' USING ERRCODE = 'P0001'; END IF;
    v_segment_fraction := route_fraction_remaining(b.route_id, v_board_stop.lat, v_board_stop.lng) - route_fraction_remaining(b.route_id, v_alight_stop.lat, v_alight_stop.lng);
    IF v_segment_fraction <= 0 THEN RAISE EXCEPTION 'The alight stop must be further along the route than the board stop.' USING ERRCODE = 'P0001'; END IF;
    v_use_board_stop_id := p_board_stop_id; v_use_alight_stop_id := p_alight_stop_id;
  ELSE
    v_use_board_stop_id := b.board_stop_id; v_use_alight_stop_id := b.alight_stop_id;
    IF b.board_stop_id IS NOT NULL AND b.alight_stop_id IS NOT NULL THEN
      SELECT * INTO v_board_stop FROM route_stops WHERE id = b.board_stop_id;
      SELECT * INTO v_alight_stop FROM route_stops WHERE id = b.alight_stop_id;
      v_segment_fraction := route_fraction_remaining(b.route_id, v_board_stop.lat, v_board_stop.lng) - route_fraction_remaining(b.route_id, v_alight_stop.lat, v_alight_stop.lng);
    END IF;
  END IF;

  v_new_total := round(b.seats * r.fare_per_seat_pkr * v_segment_fraction);

  UPDATE ride_bookings SET travel_date = p_new_travel_date, board_stop_id = v_use_board_stop_id, alight_stop_id = v_use_alight_stop_id, total_amount_pkr = v_new_total
  WHERE id = p_booking_id;

  IF p_seat_numbers IS NOT NULL THEN
    IF array_length(p_seat_numbers, 1) IS DISTINCT FROM b.seats THEN
      RAISE EXCEPTION 'Pick exactly % seat(s).', b.seats USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_seat_numbers) sn WHERE sn < 1 OR sn > route_effective_seats_for_date(b.route_id, p_new_travel_date)) THEN
      RAISE EXCEPTION 'That seat doesn''t exist on this vehicle.' USING ERRCODE = 'P0001';
    END IF;
    DELETE FROM ride_booking_seat_numbers WHERE ride_booking_id = p_booking_id;
    BEGIN
      INSERT INTO ride_booking_seat_numbers (ride_booking_id, route_id, travel_date, direction, seat_number)
      SELECT p_booking_id, b.route_id, p_new_travel_date, 'outbound', sn FROM unnest(p_seat_numbers) sn;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'One of those seats is already taken on that date — pick again.' USING ERRCODE = 'P0001';
    END;
  ELSE
    BEGIN
      UPDATE ride_booking_seat_numbers SET travel_date = p_new_travel_date WHERE ride_booking_id = p_booking_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'Your seat is already taken by someone else on that date — pick a different date or seat.' USING ERRCODE = 'P0001';
    END;
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'route_booking_rescheduled', 'A rider rescheduled their seat',
    r.origin || ' → ' || r.destination || ' — moved to ' || to_char(p_new_travel_date, 'DD Mon') || '.', '/portal/my-vehicle/routes'
  FROM vehicles v WHERE v.id = r.vehicle_id AND v.portal_user_id IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION reschedule_ride_booking(uuid, date, uuid, uuid, boolean, int[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reschedule_ride_booking(uuid, date, uuid, uuid, boolean, int[]) TO authenticated;
