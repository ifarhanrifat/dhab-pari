-- Migration 771: real bug found live, 2026-10-29 — "i have canceled
-- the ride as rider but the driver app is still showing floating
-- button ap ka safar is still displaying... what bug its?"
--
-- Confirmed directly against the real cancelled booking: cancel_trip_
-- booking (689, carried into 770) always reopens the parent
-- vehicle_trip_offers row to 'open' and bumps seats_available back up
-- — correct for an ordinary multi-seat route (another rider can take
-- the freed seat), wrong for a ride-dispatch 1:1 match, which is
-- always exactly 1 seat with nothing else to rebook. Reopening it to
-- 'open' is exactly why my_ongoing_ride()'s driver query (745/763,
-- `o.status = 'open'` matches unconditionally) kept treating a
-- cancelled ride-dispatch booking as still "ongoing" — confirmed live
-- on the real booking (93771e15-4566-4017-9f87-e6850a51735f): status
-- 'open', seats_available bumped from 1 to 2, zero real bookings left
-- on it.

CREATE OR REPLACE FUNCTION cancel_trip_booking(p_trip_booking_id uuid, p_reason text DEFAULT NULL) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  b vehicle_trip_bookings%ROWTYPE; v vehicles%ROWTYPE; o vehicle_trip_offers%ROWTYPE;
  v_is_rider boolean; v_is_driver boolean; v_is_admin boolean;
  v_fee decimal := 0; v_fee_note text := '';
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

  IF b.pin IS NOT NULL AND (v_is_rider OR v_is_driver) THEN
    IF b.status = 'in_progress' THEN v_fee := 200;
    ELSIF b.status = 'confirmed' THEN v_fee := 50;
    END IF;
    IF v_fee > 0 THEN v_fee_note := ' A cancellation fee of Rs ' || v_fee::text || ' applies — settle in person.'; END IF;
  END IF;

  UPDATE vehicle_trip_bookings SET status = 'cancelled', cancelled_at = now(),
    cancelled_by_portal_user_id = v_portal_user_id, cancellation_reason = trim(p_reason), cancellation_fee_pkr = NULLIF(v_fee, 0)
    WHERE id = p_trip_booking_id;

  -- A ride-dispatch booking (pin IS NOT NULL) is always exactly one
  -- seat with no other rider ever able to book the rest — reopening it
  -- would just leave a dead "open" trip offer no one can ever use and
  -- that a driver's own ongoing-ride FAB would wrongly keep matching.
  IF b.pin IS NULL THEN
    UPDATE vehicle_trip_offers SET seats_available = o.seats_available + b.seats,
      status = CASE WHEN status = 'closed' AND travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date THEN 'open' ELSE status END
      WHERE id = o.id;
  END IF;

  IF v.portal_user_id IS NOT NULL AND v.portal_user_id <> b.portal_user_id THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'trip_booking_cancelled',
      CASE WHEN v_is_driver THEN 'You cancelled a booking' ELSE 'A rider cancelled' END,
      (CASE WHEN v_is_driver
        THEN 'You cancelled the seat booking for ' || o.origin || ' → ' || o.destination || ' on ' || to_char(o.travel_date, 'DD Mon YYYY') || '.' || COALESCE(' ' || trim(p_reason), '')
        ELSE 'A seat booking for ' || o.origin || ' → ' || o.destination || ' on ' || to_char(o.travel_date, 'DD Mon YYYY') || ' was cancelled.' || COALESCE(' ' || trim(p_reason), '') END) || v_fee_note,
      '/portal/my-vehicle/trips');
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'trip_booking_cancelled',
    CASE WHEN v_is_rider THEN 'You cancelled your booking' ELSE 'Your booking was cancelled' END,
    (CASE WHEN v_is_rider
      THEN 'You cancelled your seat booking for ' || o.origin || ' → ' || o.destination || ' on ' || to_char(o.travel_date, 'DD Mon YYYY') || '.'
      ELSE 'Your seat booking for ' || o.origin || ' → ' || o.destination || ' on ' || to_char(o.travel_date, 'DD Mon YYYY') || ' was cancelled by the driver.' || COALESCE(' ' || trim(p_reason), '') END) || v_fee_note,
    '/portal/marketplace/shared');

  RETURN jsonb_build_object('status', 'cancelled', 'fee_pkr', v_fee);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Retroactive fix for the real booking this was found on — the driver's
-- floating button is stuck on this exact row right now.
UPDATE vehicle_trip_offers SET status = 'closed', seats_available = 1
WHERE id = '93771e15-4566-4017-9f87-e6850a51735f' AND status = 'open';
