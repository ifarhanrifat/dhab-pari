-- Migration 686: real bugs found live testing the one-off trip-share
-- system, 2026-10-17 — confirmed directly against live data (vehicle
-- owned by رضوان اقبال, trip 3d10e1b0-a848-45c8-951f-784a113c039a has
-- a real stuck 'pending' fare offer that can never be rejected).
--
-- Bug 1 — respond_trip_fare_offer()'s "enough free seats" guard runs
-- BEFORE branching on p_action, so it blocks 'reject' too, not just
-- 'accept'/'counter'. Once a trip closes (e.g. another offer filled
-- every seat), every OTHER still-pending offer on it becomes
-- permanently stuck — the driver can't even decline it, and every
-- attempt throws "This trip no longer has enough free seats," which
-- read like "no seat left" to a driver just trying to clear a request.
-- A reject never needs seats, so it should always be allowed.
--
-- Bug 2 — there has never been a way to cancel a CONFIRMED trip
-- booking at all (only complete_trip_booking exists). The driver's
-- only "cancel" button on that screen was "Cancel Trip"
-- (close_trip_offer), which closes the whole trip offer and does
-- nothing to the booking row or the rider — no status change, no
-- notification. New cancel_trip_booking() actually cancels the
-- booking, restores the seats it held, reopens the trip if it's still
-- in the future, and notifies the rider — same shape as the older,
-- more mature cancel_ride_booking() (weekly-commute system).

CREATE OR REPLACE FUNCTION public.respond_trip_fare_offer(p_fare_offer_id uuid, p_action character varying, p_counter_fare_per_seat_pkr numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  f vehicle_trip_fare_offers%ROWTYPE; o vehicle_trip_offers%ROWTYPE;
  v_booking_id uuid; v_band jsonb;
BEGIN
  SELECT * INTO f FROM vehicle_trip_fare_offers WHERE id = p_fare_offer_id FOR UPDATE;
  IF NOT FOUND OR f.status <> 'pending' THEN RAISE EXCEPTION 'This offer is no longer pending.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO o FROM vehicle_trip_offers WHERE id = f.trip_offer_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = o.vehicle_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this trip.' USING ERRCODE = 'P0001';
  END IF;

  IF p_action = 'reject' THEN
    -- Declining never needs seats -- always allowed, even on a trip
    -- that's since closed or filled by someone else's accepted offer.
    UPDATE vehicle_trip_fare_offers SET status = 'rejected', responded_at = now() WHERE id = p_fare_offer_id;
  ELSIF p_action = 'counter' THEN
    IF o.status <> 'open' OR f.seats_requested > o.seats_available THEN
      RAISE EXCEPTION 'This trip no longer has enough free seats.' USING ERRCODE = 'P0001';
    END IF;
    IF p_counter_fare_per_seat_pkr IS NULL OR p_counter_fare_per_seat_pkr < 0 THEN RAISE EXCEPTION 'Enter a counter-offer amount.' USING ERRCODE = 'P0001'; END IF;
    IF o.distance_km IS NOT NULL THEN
      v_band := fare_band_for('trip_share', o.distance_km);
      IF p_counter_fare_per_seat_pkr < (v_band->>'min')::decimal OR p_counter_fare_per_seat_pkr > (v_band->>'max')::decimal THEN
        RAISE EXCEPTION 'Counter must be between % and % per seat.', (v_band->>'min')::decimal, (v_band->>'max')::decimal USING ERRCODE = 'P0001';
      END IF;
    END IF;
    UPDATE vehicle_trip_fare_offers SET status = 'countered', counter_fare_per_seat_pkr = p_counter_fare_per_seat_pkr, responded_at = now() WHERE id = p_fare_offer_id;
  ELSIF p_action = 'accept' THEN
    IF o.status <> 'open' OR f.seats_requested > o.seats_available THEN
      RAISE EXCEPTION 'This trip no longer has enough free seats.' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO vehicle_trip_bookings (trip_offer_id, fare_offer_id, vehicle_id, portal_user_id, seats, agreed_fare_per_seat_pkr, total_amount_pkr)
    VALUES (o.id, f.id, o.vehicle_id, f.portal_user_id, f.seats_requested, f.proposed_fare_per_seat_pkr, f.seats_requested * f.proposed_fare_per_seat_pkr)
    RETURNING id INTO v_booking_id;
    UPDATE vehicle_trip_fare_offers SET status = 'accepted', responded_at = now() WHERE id = p_fare_offer_id;
    UPDATE vehicle_trip_offers SET seats_available = o.seats_available - f.seats_requested,
      status = CASE WHEN o.seats_available - f.seats_requested <= 0 THEN 'closed' ELSE status END
      WHERE id = o.id;
  ELSE
    RAISE EXCEPTION 'Invalid action.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (f.portal_user_id,
    CASE p_action WHEN 'accept' THEN 'trip_fare_offer_accepted' WHEN 'counter' THEN 'trip_fare_offer_countered' ELSE 'trip_fare_offer_rejected' END,
    CASE p_action WHEN 'accept' THEN 'Fare offer accepted!' WHEN 'counter' THEN 'Driver countered your offer' ELSE 'Fare offer declined' END,
    CASE p_action
      WHEN 'accept' THEN 'Your offer for ' || o.origin || ' → ' || o.destination || ' was accepted.'
      WHEN 'counter' THEN 'The driver offered ' || p_counter_fare_per_seat_pkr || '/seat instead — review and accept or move on.'
      ELSE 'The driver declined your fare offer.' END,
    '/portal/marketplace');

  RETURN jsonb_build_object('booking_id', v_booking_id);
END;
$function$;

ALTER TABLE vehicle_trip_bookings ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE vehicle_trip_bookings ADD COLUMN IF NOT EXISTS cancellation_reason text;
ALTER TABLE vehicle_trip_bookings ADD COLUMN IF NOT EXISTS cancelled_by_portal_user_id uuid REFERENCES portal_users(id);

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

  -- Give the seats back, and reopen the trip if it's still a real
  -- option (travel date hasn't passed) and isn't itself closed for
  -- some other reason than simply being full.
  UPDATE vehicle_trip_offers SET seats_available = o.seats_available + b.seats,
    status = CASE WHEN status = 'closed' AND travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date THEN 'open' ELSE status END
    WHERE id = o.id;

  IF v_is_driver AND NOT v_is_rider THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (b.portal_user_id, 'trip_booking_cancelled', 'Your booking was cancelled',
      'Your seat booking for ' || o.origin || ' → ' || o.destination || ' on ' || to_char(o.travel_date, 'DD Mon YYYY') || ' was cancelled by the driver.' || COALESCE(' ' || trim(p_reason), ''),
      '/portal/marketplace/shared');
  ELSIF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'trip_booking_cancelled', 'A rider cancelled',
      'A seat booking for ' || o.origin || ' → ' || o.destination || ' on ' || to_char(o.travel_date, 'DD Mon YYYY') || ' was cancelled.' || COALESCE(' ' || trim(p_reason), ''),
      '/portal/my-vehicle/trips');
  END IF;

  RETURN jsonb_build_object('status', 'cancelled');
END;
$function$;

-- Rider's own trip-booking history (My Bookings) -- this read never
-- existed at all before; a rider had no way to see whether a booking
-- was confirmed, completed or cancelled anywhere in the product.
CREATE OR REPLACE FUNCTION public.my_trip_bookings()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'status', b.status, 'seats', b.seats,
    'agreed_fare_per_seat_pkr', b.agreed_fare_per_seat_pkr, 'total_amount_pkr', b.total_amount_pkr,
    'created_at', b.created_at, 'cancellation_reason', b.cancellation_reason,
    'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
    'origin', o.origin, 'origin_ur', o.origin_ur, 'destination', o.destination, 'destination_ur', o.destination_ur,
    'travel_date', o.travel_date, 'departure_time_estimate', o.departure_time_estimate
  ) ORDER BY b.created_at DESC), '[]'::jsonb)
  FROM vehicle_trip_bookings b
  JOIN vehicle_trip_offers o ON o.id = b.trip_offer_id
  JOIN vehicles v ON v.id = b.vehicle_id
  WHERE b.portal_user_id = current_portal_user_id();
$function$;
