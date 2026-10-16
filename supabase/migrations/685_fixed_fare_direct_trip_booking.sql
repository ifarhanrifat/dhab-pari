-- Migration 685: real ask, 2026-10-17 — "these vehicles will have fix
-- fares, make their fare fixed in the backend so it will run without
-- any offer." Today EVERY booking, even tapping "book at listed
-- price," goes through propose_trip_fare() -> a pending fare offer ->
-- the driver manually accepting it (respond_trip_fare_offer). One-off
-- trip-share seats should book instantly at the driver's own listed
-- price, with no negotiation round-trip at all.
--
-- This does NOT touch propose_trip_fare/respond_trip_fare_offer/
-- accept_trip_fare_counter/withdraw_trip_fare_offer or the
-- vehicle_trip_fare_offers table -- there are 2 real pending and 1
-- real accepted row live right now (confirmed via query), and the
-- driver-side trips page still needs to resolve those. This migration
-- only adds a new, separate direct-booking path; the rider UI change
-- (separate commit) stops creating NEW offers, so the negotiation
-- table naturally drains to zero rather than being cut off mid-use.
--
-- vehicle_trip_bookings.fare_offer_id is NOT NULL (an existing schema
-- constraint, left alone rather than migrated), so a fixed-price
-- booking still inserts a vehicle_trip_fare_offers row to satisfy the
-- FK -- just pre-stamped status='accepted' in the same statement,
-- never passing through 'pending'.

CREATE OR REPLACE FUNCTION public.book_trip_offer(p_trip_offer_id uuid, p_seats_requested integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  o vehicle_trip_offers%ROWTYPE;
  v_fare_offer_id uuid;
  v_booking_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO o FROM vehicle_trip_offers WHERE id = p_trip_offer_id FOR UPDATE;
  IF NOT FOUND OR o.status <> 'open' THEN RAISE EXCEPTION 'This trip is no longer available.' USING ERRCODE = 'P0001'; END IF;
  IF p_seats_requested IS NULL OR p_seats_requested <= 0 OR p_seats_requested > o.seats_available THEN
    RAISE EXCEPTION 'Only % seat(s) available on this trip.', o.seats_available USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO vehicle_trip_fare_offers (trip_offer_id, portal_user_id, seats_requested, proposed_fare_per_seat_pkr, status, responded_at)
  VALUES (p_trip_offer_id, v_portal_user_id, p_seats_requested, o.listed_fare_per_seat_pkr, 'accepted', now())
  RETURNING id INTO v_fare_offer_id;

  INSERT INTO vehicle_trip_bookings (trip_offer_id, fare_offer_id, vehicle_id, portal_user_id, seats, agreed_fare_per_seat_pkr, total_amount_pkr)
  VALUES (o.id, v_fare_offer_id, o.vehicle_id, v_portal_user_id, p_seats_requested, o.listed_fare_per_seat_pkr, p_seats_requested * o.listed_fare_per_seat_pkr)
  RETURNING id INTO v_booking_id;

  -- Same single-UPDATE seat-decrement/auto-close pattern proven in
  -- respond_trip_fare_offer()'s 'accept' branch (migration 402 fix).
  UPDATE vehicle_trip_offers SET seats_available = o.seats_available - p_seats_requested,
    status = CASE WHEN o.seats_available - p_seats_requested <= 0 THEN 'closed' ELSE status END
    WHERE id = o.id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'trip_booked', 'Seat booked',
    p_seats_requested || ' seat(s) booked at ' || o.listed_fare_per_seat_pkr || '/seat for your ' || o.origin || ' → ' || o.destination || ' trip.', '/portal/my-vehicle/trips'
  FROM vehicles v WHERE v.id = o.vehicle_id AND v.portal_user_id IS NOT NULL;

  RETURN jsonb_build_object('booking_id', v_booking_id);
END;
$function$;
