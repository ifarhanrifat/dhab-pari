-- Migration 796: real ask, 2026-11-03, following straight from the
-- "one-way Rental is a garbage feature, nobody will drive back empty"
-- conversation.
--
-- The fix isn't pricing the deadhead leg away, it's giving the driver
-- a real reason to want it: the moment a driver accepts a long one-way
-- Rental job, this creates a bookable, discounted "return leg" seat
-- offer on that exact vehicle/run, and notifies riders who already have
-- an open outstation request heading the opposite way that a vehicle
-- is on its way. Riders can book a seat in advance; the offer only
-- "goes live" (driver + pre-booked riders both notified it's time) when
-- the ORIGINAL one-way trip is marked complete — that's the real-world
-- signal the vehicle has actually arrived, same as the rider asked.
--
-- Discount model, kept simple and honest rather than an arbitrary
-- percentage: a dedicated one-way Rental charges base + per_km×1.5.
-- This charges a returning rider per_km only, no base fare and no 1.5×
-- multiplier — because the vehicle's run is already paid for by the
-- original rider; anything collected here is pure upside for the
-- driver, so there's no need to charge toward covering the base trip
-- at all. Committee can retune the multiplier later the same way every
-- other rate card here has been.
--
-- Scope: only for one-way bookings with km > 25 — the deadhead-economics
-- problem this exists to fix is specifically the long outstation case;
-- a short in-city one-way's empty return is cheap enough that none of
-- this machinery is worth it.

CREATE TABLE IF NOT EXISTS rental_return_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_booking_id uuid NOT NULL REFERENCES rental_bookings(id) UNIQUE,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  rental_tier varchar NOT NULL,
  from_address text NOT NULL, from_lat decimal NOT NULL, from_lng decimal NOT NULL,
  to_address text NOT NULL, to_lat decimal NOT NULL, to_lng decimal NOT NULL,
  km decimal NOT NULL,
  per_seat_fare_pkr decimal NOT NULL,
  total_seats int NOT NULL,
  expected_arrival_at timestamptz NOT NULL,
  status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'activated', 'completed', 'cancelled')),
  activated_at timestamptz, created_at timestamptz DEFAULT now()
);
ALTER TABLE rental_return_offers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rental_return_offers_read" ON rental_return_offers FOR SELECT TO authenticated USING (status IN ('pending', 'activated'));
CREATE POLICY "rental_return_offers_owner_read" ON rental_return_offers FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id()));

CREATE TABLE IF NOT EXISTS rental_return_offer_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id uuid NOT NULL REFERENCES rental_return_offers(id),
  portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  seats int NOT NULL DEFAULT 1 CHECK (seats > 0),
  fare_pkr decimal NOT NULL,
  pin varchar NOT NULL,
  status varchar NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'picked_up', 'cancelled')),
  booked_at timestamptz DEFAULT now()
);
ALTER TABLE rental_return_offer_bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rental_return_offer_bookings_own_read" ON rental_return_offer_bookings FOR SELECT TO authenticated
  USING (portal_user_id = current_portal_user_id()
    OR EXISTS (SELECT 1 FROM rental_return_offers o JOIN vehicles v ON v.id = o.vehicle_id WHERE o.id = offer_id AND v.portal_user_id = current_portal_user_id()));

-- Rough capacity once the vehicle is empty again (the original rider's
-- own leg is already finished by the time this can be booked at all) —
-- a starting assumption, not a measured fact; easy to retune in one
-- place if it's wrong.
CREATE OR REPLACE FUNCTION rental_tier_seat_capacity(p_tier_key varchar) RETURNS int AS $$
  SELECT CASE p_tier_key
    WHEN 'van' THEN 6 WHEN 'hiace' THEN 10 WHEN 'coaster' THEN 20 WHEN 'bus' THEN 30
    WHEN 'suv' THEN 4 ELSE 3
  END;
$$ LANGUAGE sql IMMUTABLE;

-- respond_rental_booking: on accepting an open long one-way job, spin
-- up the return offer and notify riders who already have a matching
-- open outstation request going the opposite way (pickup near this
-- destination, dropoff near this vehicle's own home city) — real,
-- existing demand, not a guess.
CREATE OR REPLACE FUNCTION respond_rental_booking(p_booking_id uuid, p_accept boolean, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE
  b rental_bookings%ROWTYPE; v vehicles%ROWTYPE; g rental_tier_fare_guides%ROWTYPE;
  v_offer_id uuid; v_home_lat decimal; v_home_lng decimal;
BEGIN
  SELECT * INTO b FROM rental_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;

  IF b.vehicle_id IS NULL THEN
    IF NOT p_accept THEN RAISE EXCEPTION 'This request is open to every matching driver — there is nothing to decline, just leave it to someone else.' USING ERRCODE = 'P0001'; END IF;
    IF b.status <> 'requested' THEN RAISE EXCEPTION 'Someone else already accepted this request.' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO v FROM vehicles WHERE portal_user_id = current_portal_user_id() AND rental_tier = b.rental_tier AND is_active AND offers_rental;
    IF NOT FOUND THEN RAISE EXCEPTION 'This request is not for your vehicle category.' USING ERRCODE = 'P0001'; END IF;

    UPDATE rental_bookings SET vehicle_id = v.id, status = 'accepted', responded_at = now(), pin = lpad(floor(random() * 10000)::text, 4, '0')
    WHERE id = p_booking_id AND vehicle_id IS NULL AND status = 'requested';
    IF NOT FOUND THEN RAISE EXCEPTION 'Someone else already accepted this request.' USING ERRCODE = 'P0001'; END IF;

    PERFORM ensure_booking_thread('rental_booking', p_booking_id, v.id, b.portal_user_id, trim(coalesce(v.model, v.vehicle_type)) || ' — ' || b.to_address);
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (b.portal_user_id, 'rental_booking_accepted', 'Booking accepted', v.owner_name || ' will pick you up.', '/portal/marketplace');

    IF b.trip_type = 'one' AND b.km > 25 THEN
      SELECT * INTO g FROM rental_tier_fare_guides WHERE tier_key = b.rental_tier AND tenant_id = v.tenant_id;
      INSERT INTO rental_return_offers (
        source_booking_id, vehicle_id, tenant_id, rental_tier, from_address, from_lat, from_lng,
        to_address, to_lat, to_lng, km, per_seat_fare_pkr, total_seats, expected_arrival_at
      ) VALUES (
        b.id, v.id, v.tenant_id, b.rental_tier, b.to_address, b.to_lat, b.to_lng,
        b.from_address, b.from_lat, b.from_lng, b.km, round(COALESCE(g.rental_per_km_pkr, 0) * b.km),
        rental_tier_seat_capacity(b.rental_tier), now() + (b.km / 45.0) * interval '1 hour'
      ) RETURNING id INTO v_offer_id;

      SELECT lat, lng INTO v_home_lat, v_home_lng FROM cities WHERE tenant_id = v.tenant_id AND is_home_city LIMIT 1;
      IF v_home_lat IS NOT NULL THEN
        INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
        SELECT DISTINCT r.initiator_portal_user_id, 'rental_return_offer_available',
          '🔄 A vehicle is heading your way', 'A ' || b.rental_tier || ' will reach ' || b.to_address || ' around ' ||
          to_char(now() + (b.km / 45.0) * interval '1 hour', 'HH12:MI AM') || ' — book a discounted ride back.',
          '/portal/marketplace/travel?goHomeOffer=' || v_offer_id
        FROM ride_dispatch_requests r
        WHERE r.status = 'open' AND r.is_out_of_city
          AND haversine_km(r.pickup_lat, r.pickup_lng, b.to_lat, b.to_lng) < 15
          AND haversine_km(r.dropoff_lat, r.dropoff_lng, v_home_lat, v_home_lng) < 15
        LIMIT 20;
      END IF;
    END IF;
    RETURN;
  END IF;

  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'requested' THEN RAISE EXCEPTION 'This booking has already been responded to.' USING ERRCODE = 'P0001'; END IF;

  UPDATE rental_bookings SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END,
    responded_at = now(), decline_reason = CASE WHEN p_accept THEN NULL ELSE p_reason END
  WHERE id = p_booking_id;
  IF NOT p_accept THEN PERFORM close_booking_thread('rental_booking', p_booking_id, 'declined'); END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, CASE WHEN p_accept THEN 'rental_booking_accepted' ELSE 'rental_booking_declined' END,
    CASE WHEN p_accept THEN 'Booking accepted' ELSE 'Booking declined' END,
    CASE WHEN p_accept THEN v.owner_name || ' will pick you up.'
      ELSE 'This vehicle is not available for your booking.' || COALESCE(' — ' || p_reason, '') END,
    '/portal/marketplace');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- book_rental_return_seat: the public entry point, surfaced through
-- the existing Go Home search (find_rides_home, extended below) — no
-- new discovery screen needed.
CREATE OR REPLACE FUNCTION book_rental_return_seat(p_offer_id uuid, p_seats int DEFAULT 1) RETURNS jsonb AS $$
DECLARE
  o rental_return_offers%ROWTYPE; v_portal_user_id uuid := current_portal_user_id();
  v_booked int; v_pin varchar; v_fare decimal; v_booking_id uuid; v vehicles%ROWTYPE;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_seats IS NULL OR p_seats < 1 THEN p_seats := 1; END IF;

  SELECT * INTO o FROM rental_return_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This return seat is no longer available.' USING ERRCODE = 'P0001'; END IF;
  IF o.status NOT IN ('pending', 'activated') THEN RAISE EXCEPTION 'This return seat is no longer available.' USING ERRCODE = 'P0001'; END IF;

  SELECT COALESCE(sum(seats), 0) INTO v_booked FROM rental_return_offer_bookings WHERE offer_id = p_offer_id AND status <> 'cancelled';
  IF v_booked + p_seats > o.total_seats THEN RAISE EXCEPTION 'Not enough seats left on this return trip.' USING ERRCODE = 'P0001'; END IF;

  v_fare := o.per_seat_fare_pkr * p_seats;
  v_pin := lpad(floor(random() * 10000)::text, 4, '0');
  INSERT INTO rental_return_offer_bookings (offer_id, portal_user_id, seats, fare_pkr, pin)
  VALUES (p_offer_id, v_portal_user_id, p_seats, v_fare, v_pin)
  RETURNING id INTO v_booking_id;

  SELECT * INTO v FROM vehicles WHERE id = o.vehicle_id;
  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'rental_return_seat_booked', 'A return passenger booked your trip back',
      p_seats || ' seat(s) — Rs ' || round(v_fare), '/portal/my-vehicle/rental');
  END IF;

  RETURN jsonb_build_object('id', v_booking_id, 'pin', v_pin, 'fare_per_seat', o.per_seat_fare_pkr, 'total', v_fare, 'from_address', o.from_address, 'expected_arrival_at', o.expected_arrival_at);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION book_rental_return_seat(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION book_rental_return_seat(uuid, int) TO authenticated;

-- end_rental_trip: activating the offer IS the "fire" moment the
-- rider asked for — the vehicle has actually arrived, so now tell the
-- driver who's waiting for them and tell every pre-booked rider it's
-- time to come to the pickup point.
CREATE OR REPLACE FUNCTION end_rental_trip(p_booking_id uuid) RETURNS jsonb AS $$
DECLARE b rental_bookings%ROWTYPE; v vehicles%ROWTYPE; o rental_return_offers%ROWTYPE; v_seat_count int;
BEGIN
  SELECT * INTO b FROM rental_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'in_progress' THEN RAISE EXCEPTION 'This trip is not in progress.' USING ERRCODE = 'P0001'; END IF;

  UPDATE rental_bookings SET status = 'completed', ended_at = now() WHERE id = p_booking_id;
  PERFORM close_booking_thread('rental_booking', p_booking_id, 'agreed');

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'rental_booking_completed', 'Trip completed', 'Total: Rs ' || round(b.total_amount_pkr), '/portal/marketplace');

  SELECT * INTO o FROM rental_return_offers WHERE source_booking_id = p_booking_id AND status = 'pending' FOR UPDATE;
  IF FOUND THEN
    UPDATE rental_return_offers SET status = 'activated', activated_at = now() WHERE id = o.id;
    SELECT COALESCE(sum(seats), 0) INTO v_seat_count FROM rental_return_offer_bookings WHERE offer_id = o.id AND status <> 'cancelled';

    IF v.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (v.portal_user_id, 'rental_return_offer_activated',
        CASE WHEN v_seat_count > 0 THEN v_seat_count || ' return passenger(s) are waiting' ELSE 'Your return trip is open for booking' END,
        'You dropped off at ' || o.from_address || ' — ' || CASE WHEN v_seat_count > 0 THEN 'head to the pickup point when ready.' ELSE 'riders can still book a seat back with you.' END,
        '/portal/my-vehicle/rental');
    END IF;

    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT ob.portal_user_id, 'rental_return_offer_activated', 'Your driver has arrived',
      'Meet at ' || o.from_address || ' now.', '/portal/marketplace/travel'
    FROM rental_return_offer_bookings ob WHERE ob.offer_id = o.id AND ob.status = 'booked';
  END IF;

  RETURN jsonb_build_object('total_amount_pkr', b.total_amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- cancel_rental_booking: a source one-way booking can only be
-- cancelled before it starts (status check below unchanged), which is
-- always before any offer could have activated — so this only ever
-- needs to quietly withdraw a still-'pending' offer, and tell anyone
-- who had already pre-booked a seat on it that it fell through.
CREATE OR REPLACE FUNCTION cancel_rental_booking(p_booking_id uuid) RETURNS void AS $$
DECLARE b rental_bookings%ROWTYPE; v vehicles%ROWTYPE; v_is_customer boolean; v_is_owner boolean; v_notify_id uuid; o rental_return_offers%ROWTYPE;
BEGIN
  SELECT * INTO b FROM rental_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  v_is_customer := b.portal_user_id = current_portal_user_id();
  v_is_owner := v.portal_user_id = current_portal_user_id();
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v_is_customer OR v_is_owner) THEN
    RAISE EXCEPTION 'You are not part of this booking.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status IN ('in_progress', 'completed', 'cancelled') THEN
    RAISE EXCEPTION 'This booking can no longer be cancelled.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE rental_bookings SET status = 'cancelled' WHERE id = p_booking_id;
  PERFORM close_booking_thread('rental_booking', p_booking_id, 'cancelled');

  v_notify_id := CASE WHEN v_is_customer THEN v.portal_user_id ELSE b.portal_user_id END;
  IF v_notify_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_notify_id, 'rental_booking_cancelled', 'Booking cancelled', 'A rental booking was cancelled.', '/portal/marketplace');
  END IF;

  SELECT * INTO o FROM rental_return_offers WHERE source_booking_id = p_booking_id AND status = 'pending' FOR UPDATE;
  IF FOUND THEN
    UPDATE rental_return_offers SET status = 'cancelled' WHERE id = o.id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT ob.portal_user_id, 'rental_return_offer_cancelled', 'Return seat cancelled',
      'The original trip to ' || o.from_address || ' was cancelled, so this return seat fell through too.', '/portal/marketplace'
    FROM rental_return_offer_bookings ob WHERE ob.offer_id = o.id AND ob.status = 'booked';
    UPDATE rental_return_offer_bookings SET status = 'cancelled' WHERE offer_id = o.id AND status = 'booked';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- find_rides_home: a third source alongside routes/trips — a
-- discounted Rental return seat, matched by how close the offer's
-- pickup point is to the city the rider says they're in (free-text
-- Rental addresses don't match a city name the way route/trip
-- destinations do, so this one matches on distance instead).
CREATE OR REPLACE FUNCTION find_rides_home(p_city_key text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date; v_dow int := extract(dow FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
  v_city_lat decimal; v_city_lng decimal;
BEGIN
  SELECT lat, lng INTO v_city_lat, v_city_lng FROM cities WHERE lower(trim(name)) = lower(trim(p_city_key)) LIMIT 1;
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
      UNION ALL
      SELECT 'rental_return' AS kind, ro.id, v.owner_name, v.vehicle_type, v.vehicle_number,
        ro.from_address AS origin, NULL AS origin_ur, ro.to_address AS destination, NULL AS destination_ur,
        ro.per_seat_fare_pkr AS approx_fare_pkr,
        (ro.total_seats - (SELECT COALESCE(sum(seats), 0) FROM rental_return_offer_bookings b WHERE b.offer_id = ro.id AND b.status <> 'cancelled'))::int AS seats_available,
        (ro.expected_arrival_at AT TIME ZONE 'Asia/Karachi')::time AS departure_time, (ro.expected_arrival_at AT TIME ZONE 'Asia/Karachi')::date AS travel_date
      FROM rental_return_offers ro JOIN vehicles v ON v.id = ro.vehicle_id
      WHERE ro.status IN ('pending', 'activated') AND v_city_lat IS NOT NULL
        AND haversine_km(ro.from_lat, ro.from_lng, v_city_lat, v_city_lng) < 15
        AND ro.total_seats > (SELECT COALESCE(sum(seats), 0) FROM rental_return_offer_bookings b WHERE b.offer_id = ro.id AND b.status <> 'cancelled')
    ) row_data
  );
END;
$$;

-- New RPC the driver's my-vehicle/rental page (next commit) uses to
-- show pre-booked return passengers once an offer activates.
CREATE OR REPLACE FUNCTION vehicle_rental_return_offers(p_vehicle_id uuid) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', o.id, 'status', o.status, 'from_address', o.from_address, 'to_address', o.to_address,
    'per_seat_fare_pkr', o.per_seat_fare_pkr, 'total_seats', o.total_seats, 'expected_arrival_at', o.expected_arrival_at,
    'bookings', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', b.id, 'seats', b.seats, 'fare_pkr', b.fare_pkr, 'pin', b.pin, 'rider_name', pu.full_name, 'rider_mobile', pu.mobile)), '[]'::jsonb)
      FROM rental_return_offer_bookings b JOIN portal_users pu ON pu.id = b.portal_user_id
      WHERE b.offer_id = o.id AND b.status <> 'cancelled'
    )
  ) ORDER BY o.created_at DESC), '[]'::jsonb)
  FROM rental_return_offers o
  WHERE o.vehicle_id = p_vehicle_id AND o.status IN ('pending', 'activated')
    AND EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND (v.portal_user_id = current_portal_user_id() OR COALESCE(current_admin_permission('manage_parties'), false)));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_rental_return_offers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_rental_return_offers(uuid) TO authenticated;
