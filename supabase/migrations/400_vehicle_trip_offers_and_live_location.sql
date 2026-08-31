-- Migration 400: one-off return-trip ride-share with a negotiated fare —
-- distinct from vehicle_routes' recurring weekly schedule. A driver
-- heading back from a city empty posts a single trip for a specific
-- date; a rider who happens to be there proposes their own price rather
-- than paying a fixed fare; the driver accepts, rejects, or counters
-- once; once agreed, both sides can share live location (via Leaflet/
-- OpenStreetMap client-side — nothing here is Google-Maps-specific,
-- this table just stores plain lat/lng) to find each other in person.
--
-- Payment is the same direct-to-driver model per_order already uses
-- (money never touches the committee) — the only ledger event is the
-- commission, drawn from the driver's wallet once the trip is marked
-- complete, using the exact same vehicle_commission_pct()/wallet
-- machinery 394 already built. A monthly_lumpsum vehicle pays no
-- commission here either, same as everywhere else.

-- ═════════════════════════════════════════════════════════════════════════
-- 1. The trip posting itself.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vehicle_trip_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  origin varchar NOT NULL,
  origin_ur varchar,
  destination varchar NOT NULL,
  destination_ur varchar,
  classification varchar NOT NULL CHECK (classification IN ('intercity', 'out_of_city')),
  travel_date date NOT NULL,
  departure_time_estimate time,
  seats_available int NOT NULL CHECK (seats_available > 0),
  listed_fare_per_seat_pkr decimal NOT NULL CHECK (listed_fare_per_seat_pkr >= 0),
  status varchar NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicle_trip_offers_vehicle_id_idx ON vehicle_trip_offers(vehicle_id);

ALTER TABLE vehicle_trip_offers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_open_trip_offers" ON vehicle_trip_offers FOR SELECT USING (status = 'open' OR
  EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id()));
-- Writes only ever happen through the SECURITY DEFINER RPCs below.

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Fare negotiation — one counter-round, not an open-ended chat: rider
--    proposes, driver accepts/rejects/counters once, rider accepts the
--    counter or walks away. Every state transition is one explicit RPC
--    call, never a raw UPDATE, so a rider can never silently "accept
--    their own offer" or a driver "accept someone else's".
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vehicle_trip_fare_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_offer_id uuid NOT NULL REFERENCES vehicle_trip_offers(id) ON DELETE CASCADE,
  portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  seats_requested int NOT NULL CHECK (seats_requested > 0),
  proposed_fare_per_seat_pkr decimal NOT NULL CHECK (proposed_fare_per_seat_pkr >= 0),
  counter_fare_per_seat_pkr decimal CHECK (counter_fare_per_seat_pkr IS NULL OR counter_fare_per_seat_pkr >= 0),
  status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'countered', 'accepted', 'rejected', 'withdrawn')),
  created_at timestamptz DEFAULT now(),
  responded_at timestamptz
);
CREATE INDEX IF NOT EXISTS vehicle_trip_fare_offers_trip_offer_id_idx ON vehicle_trip_fare_offers(trip_offer_id);

ALTER TABLE vehicle_trip_fare_offers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "trip_fare_offers_rider_read" ON vehicle_trip_fare_offers FOR SELECT TO authenticated
  USING (portal_user_id = current_portal_user_id());
CREATE POLICY "trip_fare_offers_driver_read" ON vehicle_trip_fare_offers FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id WHERE o.id = trip_offer_id AND v.portal_user_id = current_portal_user_id()));

-- ═════════════════════════════════════════════════════════════════════════
-- 3. The actual booking, created the moment a fare is agreed (either the
--    rider's own proposal accepted outright, or the rider accepting the
--    driver's counter) — no separate payment-proof/confirm step, same as
--    every other per_order flow: the rider pays the driver directly.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vehicle_trip_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_offer_id uuid NOT NULL REFERENCES vehicle_trip_offers(id),
  fare_offer_id uuid NOT NULL REFERENCES vehicle_trip_fare_offers(id),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  seats int NOT NULL CHECK (seats > 0),
  agreed_fare_per_seat_pkr decimal NOT NULL,
  total_amount_pkr decimal NOT NULL,
  status varchar NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'completed', 'cancelled')),
  commission_voucher_id uuid REFERENCES vouchers(id),
  completed_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicle_trip_bookings_vehicle_id_idx ON vehicle_trip_bookings(vehicle_id);
CREATE INDEX IF NOT EXISTS vehicle_trip_bookings_portal_user_id_idx ON vehicle_trip_bookings(portal_user_id);

ALTER TABLE vehicle_trip_bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "trip_bookings_rider_read" ON vehicle_trip_bookings FOR SELECT TO authenticated
  USING (portal_user_id = current_portal_user_id());
CREATE POLICY "trip_bookings_driver_read" ON vehicle_trip_bookings FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id()));
CREATE POLICY "trip_bookings_admin_read" ON vehicle_trip_bookings FOR SELECT TO authenticated
  USING (can_access_system('donors_projects'));

-- ═════════════════════════════════════════════════════════════════════════
-- 4. Live location — plain lat/lng pings, one row per (booking, role),
--    upserted in place rather than a growing history (nobody needs to
--    replay a route, just "where are they right now"). Only readable by
--    the two matched parties for that specific confirmed booking — never
--    exposed more broadly, and only meaningful while status='confirmed'
--    (the frontend simply won't show the map for a completed/cancelled
--    trip; nothing here forces old pings to be deleted, they're just
--    inert once nobody's looking at that booking anymore).
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vehicle_trip_locations (
  trip_booking_id uuid NOT NULL REFERENCES vehicle_trip_bookings(id) ON DELETE CASCADE,
  role varchar NOT NULL CHECK (role IN ('driver', 'rider')),
  lat decimal NOT NULL,
  lng decimal NOT NULL,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (trip_booking_id, role)
);
ALTER TABLE vehicle_trip_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "trip_locations_matched_parties_read" ON vehicle_trip_locations FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM vehicle_trip_bookings b JOIN vehicles v ON v.id = b.vehicle_id
    WHERE b.id = trip_booking_id AND (b.portal_user_id = current_portal_user_id() OR v.portal_user_id = current_portal_user_id())
  ));
-- Writes only via ping_trip_location() below.

-- ═════════════════════════════════════════════════════════════════════════
-- 5. RPCs
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION place_trip_offer(
  p_vehicle_id uuid, p_origin varchar, p_origin_ur varchar, p_destination varchar, p_destination_ur varchar,
  p_classification varchar, p_travel_date date, p_departure_time_estimate time, p_seats_available int, p_listed_fare_per_seat_pkr decimal
) RETURNS uuid AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
  IF p_seats_available IS NULL OR p_seats_available <= 0 THEN RAISE EXCEPTION 'Enter how many seats are free.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicle_trip_offers (vehicle_id, origin, origin_ur, destination, destination_ur, classification, travel_date, departure_time_estimate, seats_available, listed_fare_per_seat_pkr)
  VALUES (p_vehicle_id, p_origin, NULLIF(p_origin_ur, ''), p_destination, NULLIF(p_destination_ur, ''), p_classification, p_travel_date, p_departure_time_estimate, p_seats_available, p_listed_fare_per_seat_pkr)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION place_trip_offer(uuid, varchar, varchar, varchar, varchar, varchar, date, time, int, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION place_trip_offer(uuid, varchar, varchar, varchar, varchar, varchar, date, time, int, decimal) TO authenticated;

CREATE OR REPLACE FUNCTION close_trip_offer(p_trip_offer_id uuid) RETURNS void AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id WHERE o.id = p_trip_offer_id AND v.portal_user_id = v_portal_user_id
  ) THEN RAISE EXCEPTION 'You do not manage this trip.' USING ERRCODE = 'P0001'; END IF;
  UPDATE vehicle_trip_offers SET status = 'closed' WHERE id = p_trip_offer_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION close_trip_offer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION close_trip_offer(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION propose_trip_fare(p_trip_offer_id uuid, p_seats_requested int, p_proposed_fare_per_seat_pkr decimal) RETURNS uuid AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_offer vehicle_trip_offers%ROWTYPE; v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_offer FROM vehicle_trip_offers WHERE id = p_trip_offer_id;
  IF NOT FOUND OR v_offer.status <> 'open' THEN RAISE EXCEPTION 'This trip is no longer available.' USING ERRCODE = 'P0001'; END IF;
  IF p_seats_requested IS NULL OR p_seats_requested <= 0 OR p_seats_requested > v_offer.seats_available THEN
    RAISE EXCEPTION 'Only % seat(s) available on this trip.', v_offer.seats_available USING ERRCODE = 'P0001';
  END IF;
  IF p_proposed_fare_per_seat_pkr IS NULL OR p_proposed_fare_per_seat_pkr < 0 THEN RAISE EXCEPTION 'Enter a fare to offer.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicle_trip_fare_offers (trip_offer_id, portal_user_id, seats_requested, proposed_fare_per_seat_pkr)
  VALUES (p_trip_offer_id, v_portal_user_id, p_seats_requested, p_proposed_fare_per_seat_pkr)
  RETURNING id INTO v_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'trip_fare_offer_received', 'New fare offer',
    'Someone offered ' || p_proposed_fare_per_seat_pkr || '/seat for your ' || v_offer.origin || ' → ' || v_offer.destination || ' trip.', '/portal/my-vehicle'
  FROM vehicles v WHERE v.id = v_offer.vehicle_id AND v.portal_user_id IS NOT NULL;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION propose_trip_fare(uuid, int, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION propose_trip_fare(uuid, int, decimal) TO authenticated;

-- p_action: 'accept' | 'reject' | 'counter'. Accepting creates the
-- booking immediately (decrementing the offer's free seats); countering
-- just records the driver's number and waits on the rider.
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
    UPDATE vehicle_trip_offers SET seats_available = seats_available - f.seats_requested WHERE id = o.id;
    UPDATE vehicle_trip_offers SET status = 'closed' WHERE id = o.id AND seats_available - f.seats_requested <= 0;
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
REVOKE ALL ON FUNCTION respond_trip_fare_offer(uuid, varchar, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION respond_trip_fare_offer(uuid, varchar, decimal) TO authenticated;

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
  UPDATE vehicle_trip_offers SET seats_available = seats_available - f.seats_requested WHERE id = o.id;
  UPDATE vehicle_trip_offers SET status = 'closed' WHERE id = o.id AND seats_available - f.seats_requested <= 0;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'trip_fare_offer_accepted', 'Counter-offer accepted', 'Your counter for ' || o.origin || ' → ' || o.destination || ' was accepted.', '/portal/my-vehicle'
  FROM vehicles v WHERE v.id = o.vehicle_id AND v.portal_user_id IS NOT NULL;

  RETURN jsonb_build_object('booking_id', v_booking_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION accept_trip_fare_counter(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_trip_fare_counter(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION withdraw_trip_fare_offer(p_fare_offer_id uuid) RETURNS void AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id();
BEGIN
  UPDATE vehicle_trip_fare_offers SET status = 'withdrawn'
  WHERE id = p_fare_offer_id AND portal_user_id = v_portal_user_id AND status IN ('pending', 'countered');
  IF NOT FOUND THEN RAISE EXCEPTION 'Nothing to withdraw.' USING ERRCODE = 'P0001'; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION withdraw_trip_fare_offer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION withdraw_trip_fare_offer(uuid) TO authenticated;

-- Driver marks the trip actually completed — the only ledger event here,
-- same shape as confirm_shop_order's per_order branch: commission drawn
-- from the driver's own wallet, nothing posted for the fare itself (the
-- rider already paid the driver directly).
CREATE OR REPLACE FUNCTION complete_trip_booking(p_trip_booking_id uuid) RETURNS jsonb AS $$
DECLARE
  b vehicle_trip_bookings%ROWTYPE; v vehicles%ROWTYPE; o vehicle_trip_offers%ROWTYPE;
  v_vehicle_account uuid; v_commission_account uuid; v_commission_pct decimal; v_commission_amount decimal := 0;
  v_commission_voucher_id uuid;
BEGIN
  SELECT * INTO b FROM vehicle_trip_bookings WHERE id = p_trip_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'confirmed' THEN RAISE EXCEPTION 'This trip is not awaiting completion.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  SELECT * INTO o FROM vehicle_trip_offers WHERE id = b.trip_offer_id;
  IF v.portal_user_id IS DISTINCT FROM current_portal_user_id() AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicle_trip_bookings SET status = 'completed', completed_at = now() WHERE id = p_trip_booking_id;

  IF v.commission_mode = 'per_order' THEN
    v_vehicle_account := ensure_vehicle_account(v.id);
    SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050';
    v_commission_pct := vehicle_commission_pct(v.vehicle_type, o.classification);
    v_commission_amount := round(b.total_amount_pkr * v_commission_pct / 100, 2);
    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — ' || o.origin || ' → ' || o.destination || ' return trip (paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
      RETURNING id INTO v_commission_voucher_id;
      UPDATE vehicle_trip_bookings SET commission_voucher_id = v_commission_voucher_id WHERE id = p_trip_booking_id;
    END IF;
    PERFORM check_seller_balance_notify('vehicle', v.id);
  END IF;

  RETURN jsonb_build_object('amount', b.total_amount_pkr, 'commission', v_commission_amount);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION complete_trip_booking(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION complete_trip_booking(uuid) TO authenticated;

-- Live location — upserted in place, one row per role per booking, only
-- while the booking is still 'confirmed' (a completed/cancelled trip has
-- nothing left to coordinate).
CREATE OR REPLACE FUNCTION ping_trip_location(p_trip_booking_id uuid, p_lat decimal, p_lng decimal) RETURNS void AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); b vehicle_trip_bookings%ROWTYPE; v_role varchar;
BEGIN
  SELECT * INTO b FROM vehicle_trip_bookings WHERE id = p_trip_booking_id;
  IF NOT FOUND OR b.status <> 'confirmed' THEN RAISE EXCEPTION 'This trip is not active.' USING ERRCODE = 'P0001'; END IF;

  IF b.portal_user_id = v_portal_user_id THEN v_role := 'rider';
  ELSIF EXISTS (SELECT 1 FROM vehicles WHERE id = b.vehicle_id AND portal_user_id = v_portal_user_id) THEN v_role := 'driver';
  ELSE RAISE EXCEPTION 'You are not part of this trip.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO vehicle_trip_locations (trip_booking_id, role, lat, lng, updated_at)
  VALUES (p_trip_booking_id, v_role, p_lat, p_lng, now())
  ON CONFLICT (trip_booking_id, role) DO UPDATE SET lat = p_lat, lng = p_lng, updated_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION ping_trip_location(uuid, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ping_trip_location(uuid, decimal, decimal) TO authenticated;

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('trip_fare_offer_received', 'A driver received a fare offer on their return-trip posting', false, true),
  ('trip_fare_offer_accepted', 'A rider''s fare offer was accepted', false, true),
  ('trip_fare_offer_countered', 'A driver countered a rider''s fare offer', false, true),
  ('trip_fare_offer_rejected', 'A driver declined a rider''s fare offer', false, true)
ON CONFLICT (event_type) DO NOTHING;
