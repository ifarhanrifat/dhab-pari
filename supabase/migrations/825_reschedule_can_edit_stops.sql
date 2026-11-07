-- Migration 825: real bug, 2026-11-07 — the rider tried to "edit" their
-- existing Dhab Pari → Mangwal booking to board from a different stop,
-- but the only place a board/alight stop picker existed was the
-- "book a new seat" form — so instead of changing their existing ₨70
-- booking, it silently created a SECOND, separate ₨37 booking on a
-- different date, leaving the first one untouched. Two real bookings,
-- two real charges, for what the rider experienced as one edit.
--
-- Root cause: reschedule_ride_booking (821) could only ever change the
-- travel date — there was no way to edit a booking's stops at all, so
-- "book new" was the only path a rider could reach for that. This
-- extends it to also accept an optional new board/alight stop pair (or
-- an explicit "clear back to full route"), recomputing the fare with
-- the exact same segment math place_ride_booking (822/823) already
-- uses. Scoped to a still-'announced' (not yet driver-confirmed)
-- booking when the stops actually change — once a driver has confirmed
-- a booking, its fare is treated as locked, same as the existing
-- flex-fare rule just below it ("cancel and rebook instead").

DROP FUNCTION IF EXISTS reschedule_ride_booking(uuid, date);
CREATE OR REPLACE FUNCTION reschedule_ride_booking(
  p_booking_id uuid, p_new_travel_date date,
  p_board_stop_id uuid DEFAULT NULL, p_alight_stop_id uuid DEFAULT NULL, p_clear_stops boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v_available int; v_weekday int;
  v_board_stop route_stops%ROWTYPE; v_alight_stop route_stops%ROWTYPE;
  v_segment_fraction numeric := 1; v_new_total numeric;
  v_use_board_stop_id uuid; v_use_alight_stop_id uuid;
  v_changing_stops boolean := p_clear_stops OR p_board_stop_id IS NOT NULL OR p_alight_stop_id IS NOT NULL;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id AND portal_user_id = current_portal_user_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'That is not your booking.' USING ERRCODE = 'P0001'; END IF;
  IF b.status NOT IN ('announced', 'confirmed') THEN RAISE EXCEPTION 'This booking can no longer be rescheduled.' USING ERRCODE = 'P0001'; END IF;
  IF b.route_id IS NULL THEN RAISE EXCEPTION 'This booking cannot be rescheduled.' USING ERRCODE = 'P0001'; END IF;
  IF p_new_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
  IF v_changing_stops AND b.status != 'announced' THEN
    RAISE EXCEPTION 'Your seat is already confirmed by the driver — cancel and book again to change your boarding stop.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO r FROM vehicle_routes WHERE id = b.route_id;
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
    -- No stop change requested (the ordinary "just move my date" case) —
    -- keep whatever the booking already had, recomputed fresh so the
    -- stored total always matches its own stops exactly.
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

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'route_booking_rescheduled', 'A rider rescheduled their seat',
    r.origin || ' → ' || r.destination || ' — moved to ' || to_char(p_new_travel_date, 'DD Mon') || '.', '/portal/my-vehicle/routes'
  FROM vehicles v WHERE v.id = r.vehicle_id AND v.portal_user_id IS NOT NULL;
END;
$$;
GRANT EXECUTE ON FUNCTION reschedule_ride_booking(uuid, date, uuid, uuid, boolean) TO authenticated;
