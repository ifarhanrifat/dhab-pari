-- Migration 689: cancel_trip_booking (686) only notified "the other
-- side" -- the person who actually clicked cancel got no confirmation
-- of their own action, no log entry they can see later. Real ask:
-- both the driver and the rider get an alert, and the cancellation is
-- visible in a dedicated Cancelled view on both sides (the view side
-- is a frontend change; this migration just makes sure both people
-- actually get notified in the first place).

CREATE OR REPLACE FUNCTION public.cancel_trip_booking(p_trip_booking_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  b vehicle_trip_bookings%ROWTYPE; v vehicles%ROWTYPE; o vehicle_trip_offers%ROWTYPE;
  v_is_rider boolean; v_is_driver boolean; v_is_admin boolean;
BEGIN
  SELECT * INTO b FROM vehicle_trip_bookings WHERE id = p_trip_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status = 'cancelled' THEN RAISE EXCEPTION 'This booking is already cancelled.' USING ERRCODE = 'P0001'; END IF;
  IF b.status = 'completed' THEN RAISE EXCEPTION 'This trip is already complete — it can''t be cancelled.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  SELECT * INTO o FROM vehicle_trip_offers WHERE id = b.trip_offer_id FOR UPDATE;

  v_is_rider := v_portal_user_id IS NOT NULL AND b.portal_user_id = v_portal_user_id;
  v_is_driver := v.portal_user_id IS NOT NULL AND v.portal_user_id = v_portal_user_id;
  v_is_admin := COALESCE(current_admin_permission('post_transactions'), false);
  IF NOT (v_is_rider OR v_is_driver OR v_is_admin) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicle_trip_bookings SET status = 'cancelled', cancelled_at = now(),
    cancelled_by_portal_user_id = v_portal_user_id, cancellation_reason = trim(p_reason)
    WHERE id = p_trip_booking_id;

  UPDATE vehicle_trip_offers SET seats_available = o.seats_available + b.seats,
    status = CASE WHEN status = 'closed' AND travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date THEN 'open' ELSE status END
    WHERE id = o.id;

  -- Both sides get a record of this -- not just "the other side". The
  -- canceller sees their own action confirmed; the other person is
  -- told why their trip plan changed.
  IF v.portal_user_id IS NOT NULL AND v.portal_user_id <> b.portal_user_id THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'trip_booking_cancelled',
      CASE WHEN v_is_driver THEN 'You cancelled a booking' ELSE 'A rider cancelled' END,
      CASE WHEN v_is_driver
        THEN 'You cancelled the seat booking for ' || o.origin || ' → ' || o.destination || ' on ' || to_char(o.travel_date, 'DD Mon YYYY') || '.' || COALESCE(' ' || trim(p_reason), '')
        ELSE 'A seat booking for ' || o.origin || ' → ' || o.destination || ' on ' || to_char(o.travel_date, 'DD Mon YYYY') || ' was cancelled.' || COALESCE(' ' || trim(p_reason), '') END,
      '/portal/my-vehicle/trips');
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'trip_booking_cancelled',
    CASE WHEN v_is_rider THEN 'You cancelled your booking' ELSE 'Your booking was cancelled' END,
    CASE WHEN v_is_rider
      THEN 'You cancelled your seat booking for ' || o.origin || ' → ' || o.destination || ' on ' || to_char(o.travel_date, 'DD Mon YYYY') || '.'
      ELSE 'Your seat booking for ' || o.origin || ' → ' || o.destination || ' on ' || to_char(o.travel_date, 'DD Mon YYYY') || ' was cancelled by the driver.' || COALESCE(' ' || trim(p_reason), '') END,
    '/portal/marketplace/shared');

  RETURN jsonb_build_object('status', 'cancelled');
END;
$function$;
