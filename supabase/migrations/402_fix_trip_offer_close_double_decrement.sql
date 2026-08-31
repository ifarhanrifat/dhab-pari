-- Migration 402: both places a trip booking gets created had the same
-- bug — "should this offer close now?" was checked as
-- `seats_available - f.seats_requested <= 0` AFTER the seats_available
-- column had already been decremented by that same amount one statement
-- earlier, double-subtracting the just-booked seats and closing a trip
-- offer that still had free seats left. Caught live: a 3-seat offer with
-- a 2-seat booking accepted closed immediately instead of leaving 1 seat
-- open. Fixed to compare against the ORIGINAL count captured in `o`
-- before either UPDATE ran, in both functions.
CREATE OR REPLACE FUNCTION respond_trip_fare_offer(p_fare_offer_id uuid, p_action varchar, p_counter_fare_per_seat_pkr decimal DEFAULT NULL) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  f vehicle_trip_fare_offers%ROWTYPE; o vehicle_trip_offers%ROWTYPE;
  v_booking_id uuid;
BEGIN
  SELECT * INTO f FROM vehicle_trip_fare_offers WHERE id = p_fare_offer_id FOR UPDATE;
  IF NOT FOUND OR f.status <> 'pending' THEN RAISE EXCEPTION 'This offer is no longer pending.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO o FROM vehicle_trip_offers WHERE id = f.trip_offer_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = o.vehicle_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this trip.' USING ERRCODE = 'P0001';
  END IF;
  IF o.status <> 'open' OR f.seats_requested > o.seats_available THEN
    RAISE EXCEPTION 'This trip no longer has enough free seats.' USING ERRCODE = 'P0001';
  END IF;

  IF p_action = 'reject' THEN
    UPDATE vehicle_trip_fare_offers SET status = 'rejected', responded_at = now() WHERE id = p_fare_offer_id;
  ELSIF p_action = 'counter' THEN
    IF p_counter_fare_per_seat_pkr IS NULL OR p_counter_fare_per_seat_pkr < 0 THEN RAISE EXCEPTION 'Enter a counter-offer amount.' USING ERRCODE = 'P0001'; END IF;
    UPDATE vehicle_trip_fare_offers SET status = 'countered', counter_fare_per_seat_pkr = p_counter_fare_per_seat_pkr, responded_at = now() WHERE id = p_fare_offer_id;
  ELSIF p_action = 'accept' THEN
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION accept_trip_fare_counter(p_fare_offer_id uuid) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  f vehicle_trip_fare_offers%ROWTYPE; o vehicle_trip_offers%ROWTYPE; v_booking_id uuid;
BEGIN
  SELECT * INTO f FROM vehicle_trip_fare_offers WHERE id = p_fare_offer_id FOR UPDATE;
  IF NOT FOUND OR f.status <> 'countered' OR f.portal_user_id <> v_portal_user_id THEN
    RAISE EXCEPTION 'This counter-offer is no longer available.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO o FROM vehicle_trip_offers WHERE id = f.trip_offer_id FOR UPDATE;
  IF o.status <> 'open' OR f.seats_requested > o.seats_available THEN
    RAISE EXCEPTION 'This trip no longer has enough free seats.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO vehicle_trip_bookings (trip_offer_id, fare_offer_id, vehicle_id, portal_user_id, seats, agreed_fare_per_seat_pkr, total_amount_pkr)
  VALUES (o.id, f.id, o.vehicle_id, f.portal_user_id, f.seats_requested, f.counter_fare_per_seat_pkr, f.seats_requested * f.counter_fare_per_seat_pkr)
  RETURNING id INTO v_booking_id;
  UPDATE vehicle_trip_fare_offers SET status = 'accepted', responded_at = now() WHERE id = p_fare_offer_id;
  UPDATE vehicle_trip_offers SET seats_available = o.seats_available - f.seats_requested,
    status = CASE WHEN o.seats_available - f.seats_requested <= 0 THEN 'closed' ELSE status END
    WHERE id = o.id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'trip_fare_offer_accepted', 'Counter-offer accepted', 'Your counter for ' || o.origin || ' → ' || o.destination || ' was accepted.', '/portal/my-vehicle'
  FROM vehicles v WHERE v.id = o.vehicle_id AND v.portal_user_id IS NOT NULL;

  RETURN jsonb_build_object('booking_id', v_booking_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
