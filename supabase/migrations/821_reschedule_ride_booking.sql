-- Migration 821: real ask, 2026-11-06 — "book, cancel, reschedule the
-- seat." cancel_ride_booking (436) already supported a rider
-- cancelling their own booking; confirmed nothing resembling
-- "reschedule" exists anywhere in this codebase for any booking type.
-- Scoped to fixed-fare ad-hoc route seat bookings only — a flex-split
-- fare depends on who else books that specific date and isn't safe to
-- silently recompute here; adda bookings have no forward date concept
-- at all (always booked for "today").
CREATE OR REPLACE FUNCTION reschedule_ride_booking(p_booking_id uuid, p_new_travel_date date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v_available int; v_weekday int;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id AND portal_user_id = current_portal_user_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'That is not your booking.' USING ERRCODE = 'P0001'; END IF;
  IF b.status NOT IN ('announced', 'confirmed') THEN RAISE EXCEPTION 'This booking can no longer be rescheduled.' USING ERRCODE = 'P0001'; END IF;
  IF b.route_id IS NULL THEN RAISE EXCEPTION 'This booking cannot be rescheduled.' USING ERRCODE = 'P0001'; END IF;
  IF p_new_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO r FROM vehicle_routes WHERE id = b.route_id;
  IF r.fare_mode = 'flex' THEN RAISE EXCEPTION 'This route''s fare depends on the date it''s booked for — cancel and rebook instead.' USING ERRCODE = 'P0001'; END IF;

  v_weekday := extract(dow FROM p_new_travel_date)::int;
  IF NOT (v_weekday = ANY(r.days_of_week)) THEN RAISE EXCEPTION 'This route does not run on that day.' USING ERRCODE = 'P0001'; END IF;

  v_available := route_seats_available(b.route_id, p_new_travel_date);
  IF b.seats > v_available THEN RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001'; END IF;

  UPDATE ride_bookings SET travel_date = p_new_travel_date WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'route_booking_rescheduled', 'A rider rescheduled their seat',
    r.origin || ' → ' || r.destination || ' — moved to ' || to_char(p_new_travel_date, 'DD Mon') || '.', '/portal/my-vehicle/routes'
  FROM vehicles v WHERE v.id = r.vehicle_id AND v.portal_user_id IS NOT NULL;
END;
$$;
GRANT EXECUTE ON FUNCTION reschedule_ride_booking(uuid, date) TO authenticated;
