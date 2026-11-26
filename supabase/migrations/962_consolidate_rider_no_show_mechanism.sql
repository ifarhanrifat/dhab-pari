-- Migration 962: real duplicate caught before shipping — 960 added
-- mark_ride_booking_no_show without first finding that a no-show
-- mechanism for app bookings ALREADY existed: mark_rider_no_show
-- (828, last true-replaced in 898), wired into RouteGroupPanel.tsx's
-- own ad-hoc bookings list. That existing one had two real gaps of
-- its own though: it never released the seat (no DELETE FROM
-- ride_booking_seat_numbers, unlike every other close-out path in
-- this codebase), and its gate was is_route_operator alone — an
-- ordinary fleet_staff booking officer (not the driver/owner/co-
-- driver) couldn't use it at all, which is exactly who needs it from
-- the fleet bookings search page. Consolidates onto ONE function:
-- same name/behavior RouteGroupPanel.tsx already calls (so it needs
-- no frontend change), widened gate, seat release added, and the same
-- status='no_show'/no_show_at signal 960 introduced instead of
-- overloading 'cancelled'. mark_ride_booking_no_show (960) is dropped
-- — it was never called from anywhere outside this session's own new
-- code, which now calls this one instead.

CREATE OR REPLACE FUNCTION mark_rider_no_show(p_booking_id uuid, p_reason text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b ride_bookings%ROWTYPE; v_owner_ok boolean;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF b.status NOT IN ('announced', 'confirmed') THEN RAISE EXCEPTION 'This booking is not active.' USING ERRCODE = 'P0001'; END IF;
  IF b.boarded_at IS NOT NULL THEN RAISE EXCEPTION 'This rider has already boarded.' USING ERRCODE = 'P0001'; END IF;

  IF b.route_id IS NOT NULL THEN
    v_owner_ok := is_route_owner(b.route_id) OR is_route_operator(b.route_id);
  ELSE
    SELECT EXISTS (SELECT 1 FROM adda_queue_entries e JOIN vehicles v ON v.id = e.vehicle_id WHERE e.id = b.adda_queue_entry_id AND v.portal_user_id = current_portal_user_id()) INTO v_owner_ok;
  END IF;
  IF NOT v_owner_ok THEN RAISE EXCEPTION 'You do not manage this booking''s vehicle.' USING ERRCODE = 'P0001'; END IF;

  UPDATE ride_bookings SET status = 'no_show', no_show_at = now(), rejected_reason = p_reason WHERE id = p_booking_id;
  DELETE FROM ride_booking_seat_numbers WHERE ride_booking_id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'ride_booking_no_show', 'Marked as a no-show',
    'The driver marked you absent for this ride and closed the booking.' || COALESCE(' ' || p_reason, ''),
    CASE WHEN b.route_id IS NOT NULL THEN '/portal/marketplace/route/' || b.route_id ELSE '/portal/marketplace' END);
END;
$$;
GRANT EXECUTE ON FUNCTION mark_rider_no_show(uuid, text) TO authenticated;

DROP FUNCTION IF EXISTS mark_ride_booking_no_show(uuid, text);
