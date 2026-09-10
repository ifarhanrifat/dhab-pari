-- Fare bands, ported from the v2 design handoff (§2.1) — the ONLY two
-- genuinely negotiated flows in the whole system (everything else is a
-- fixed price or a formula, confirmed against the actual pricing table
-- this app implements): one-off trip share, and the city-fetch direct-
-- message purchasing fee. v1 of the outside design banded everything;
-- that was wrong and is not repeated here — adda, routes, delivery,
-- hourly and shadi are untouched.
--
-- fair  = base + km * perKm
-- min   = round10(fair * (1 - spread))
-- max   = round10(fair * (1 + spread))
-- step  = max(10, round10((max - min) / 8))
-- steps = [min, min+step, ..., max]
--
-- Ported verbatim from the handoff's own logic class so the number a
-- rider sees, a driver's counter control offers, and the admin's own
-- table all agree exactly — one function, four callers.
--
-- Real adaptation, documented rather than silently guessed: the design
-- demo hardcoded km for its one worked example (78, which happens to be
-- Rawalpindi's cities.distance_km) rather than actually wiring a
-- distance source, since trip offers here have always been free-text
-- origin/destination with no real geo link (unlike city-fetch, which
-- already runs through a real cities.distance_km per request). Rather
-- than force every one-off trip onto one of the five reference cities —
-- a real narrowing of what this feature covers — vehicle_trip_offers
-- gets its own driver-entered distance_km, purely informational input
-- (same convention as shadi's own booker-entered distance_km), which
-- the band then reads.

CREATE TABLE IF NOT EXISTS fare_bands (
  flow varchar PRIMARY KEY CHECK (flow IN ('trip_share', 'city_fetch')),
  base_pkr decimal NOT NULL CHECK (base_pkr >= 0),
  per_km_pkr decimal NOT NULL CHECK (per_km_pkr >= 0),
  spread decimal NOT NULL DEFAULT 0.28 CHECK (spread > 0 AND spread < 1)
);
ALTER TABLE fare_bands ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_fare_bands" ON fare_bands FOR SELECT USING (true);
CREATE POLICY "fare_bands_write" ON fare_bands FOR INSERT TO authenticated WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "fare_bands_update" ON fare_bands FOR UPDATE TO authenticated USING (true) WITH CHECK (current_admin_permission('manage_parties'));

INSERT INTO fare_bands (flow, base_pkr, per_km_pkr, spread) VALUES
  ('trip_share', 150, 5, 0.28),
  ('city_fetch', 100, 4, 0.28)
ON CONFLICT (flow) DO NOTHING;

CREATE OR REPLACE FUNCTION fare_band(p_base decimal, p_per_km decimal, p_km decimal, p_spread decimal) RETURNS jsonb AS $$
DECLARE
  v_fair decimal; v_min decimal; v_max decimal; v_step decimal;
  v_steps decimal[] := ARRAY[]::decimal[];
  v_v decimal;
BEGIN
  v_fair := p_base + p_km * p_per_km;
  v_min := round((v_fair * (1 - p_spread)) / 10) * 10;
  v_max := round((v_fair * (1 + p_spread)) / 10) * 10;
  v_step := greatest(10, round(((v_max - v_min) / 8) / 10) * 10);
  v_v := v_min;
  WHILE v_v <= v_max + 1 LOOP
    v_steps := array_append(v_steps, v_v);
    v_v := v_v + v_step;
  END LOOP;
  IF v_steps[array_length(v_steps, 1)] <> v_max THEN v_steps := array_append(v_steps, v_max); END IF;
  RETURN jsonb_build_object('min', v_min, 'max', v_max, 'fair', round(v_fair / 10) * 10, 'steps', to_jsonb(v_steps));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Convenience wrapper — the two real callers only ever have a flow name
-- and a km figure, not the raw base/perKm/spread triple.
CREATE OR REPLACE FUNCTION fare_band_for(p_flow varchar, p_km decimal) RETURNS jsonb AS $$
  SELECT fare_band(base_pkr, per_km_pkr, p_km, spread) FROM fare_bands WHERE flow = p_flow;
$$ LANGUAGE sql STABLE;
GRANT EXECUTE ON FUNCTION fare_band_for(varchar, decimal) TO authenticated, anon;

ALTER TABLE vehicle_trip_offers ADD COLUMN IF NOT EXISTS distance_km decimal CHECK (distance_km IS NULL OR distance_km >= 0);

-- Real, separate bug found while checking this against the live schema
-- (not migration-file archaeology, which would have missed it): 401
-- added p_trip_type as a NEW 11-arg overload; 429 later tried to add
-- an out-of-city permission check but wrote it onto a plain
-- CREATE OR REPLACE of the OLD 10-arg signature (already dropped by
-- 401), which silently just created a second, orphaned overload
-- instead of replacing anything. The app always calls with p_trip_type
-- (matches vehicle_trip_offers.trip_type, added alongside 401), so
-- every real call has been resolving to the 11-arg version this whole
-- time — the one WITHOUT 429's allows_out_of_city check. That check has
-- never actually run. Both stale overloads are dropped here and merged
-- into one real function carrying trip_type, the out-of-city check,
-- and the new distance_km.
DROP FUNCTION IF EXISTS place_trip_offer(uuid, varchar, varchar, varchar, varchar, varchar, date, time, int, decimal);
DROP FUNCTION IF EXISTS place_trip_offer(uuid, varchar, varchar, varchar, varchar, varchar, varchar, date, time, int, decimal);

CREATE OR REPLACE FUNCTION place_trip_offer(
  p_vehicle_id uuid, p_trip_type varchar, p_origin varchar, p_origin_ur varchar, p_destination varchar, p_destination_ur varchar,
  p_classification varchar, p_travel_date date, p_departure_time_estimate time, p_seats_available int, p_listed_fare_per_seat_pkr decimal,
  p_distance_km decimal DEFAULT NULL
) RETURNS uuid AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid; v_allows_out_of_city boolean;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT allows_out_of_city INTO v_allows_out_of_city FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF p_trip_type NOT IN ('oneway', 'return') THEN RAISE EXCEPTION 'Pick one-way or return.' USING ERRCODE = 'P0001'; END IF;
  IF p_classification = 'out_of_city' AND NOT v_allows_out_of_city THEN
    RAISE EXCEPTION 'This vehicle is only set up for trips within the home city — ask the committee if you need out-of-station enabled.' USING ERRCODE = 'P0001';
  END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
  IF p_seats_available IS NULL OR p_seats_available <= 0 THEN RAISE EXCEPTION 'Enter how many seats are free.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicle_trip_offers (vehicle_id, trip_type, origin, origin_ur, destination, destination_ur, classification, travel_date, departure_time_estimate, seats_available, listed_fare_per_seat_pkr, distance_km)
  VALUES (p_vehicle_id, p_trip_type, p_origin, NULLIF(p_origin_ur, ''), p_destination, NULLIF(p_destination_ur, ''), p_classification, p_travel_date, p_departure_time_estimate, p_seats_available, p_listed_fare_per_seat_pkr, p_distance_km)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION place_trip_offer(uuid, varchar, varchar, varchar, varchar, varchar, varchar, date, time, int, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION place_trip_offer(uuid, varchar, varchar, varchar, varchar, varchar, varchar, date, time, int, decimal, decimal) TO authenticated;

-- Enforced only when the trip actually carries a distance — a trip
-- posted before this feature (or by a driver who skipped the optional
-- field) falls back to the old unbounded behaviour rather than being
-- silently un-negotiable with no band to show.
CREATE OR REPLACE FUNCTION propose_trip_fare(p_trip_offer_id uuid, p_seats_requested int, p_proposed_fare_per_seat_pkr decimal) RETURNS uuid AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_offer vehicle_trip_offers%ROWTYPE; v_id uuid; v_band jsonb;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_offer FROM vehicle_trip_offers WHERE id = p_trip_offer_id;
  IF NOT FOUND OR v_offer.status <> 'open' THEN RAISE EXCEPTION 'This trip is no longer available.' USING ERRCODE = 'P0001'; END IF;
  IF p_seats_requested IS NULL OR p_seats_requested <= 0 OR p_seats_requested > v_offer.seats_available THEN
    RAISE EXCEPTION 'Only % seat(s) available on this trip.', v_offer.seats_available USING ERRCODE = 'P0001';
  END IF;
  IF p_proposed_fare_per_seat_pkr IS NULL OR p_proposed_fare_per_seat_pkr < 0 THEN RAISE EXCEPTION 'Enter a fare to offer.' USING ERRCODE = 'P0001'; END IF;

  IF v_offer.distance_km IS NOT NULL THEN
    v_band := fare_band_for('trip_share', v_offer.distance_km);
    IF p_proposed_fare_per_seat_pkr < (v_band->>'min')::decimal OR p_proposed_fare_per_seat_pkr > (v_band->>'max')::decimal THEN
      RAISE EXCEPTION 'Offer must be between % and % per seat.', (v_band->>'min')::decimal, (v_band->>'max')::decimal USING ERRCODE = 'P0001';
    END IF;
  END IF;

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

CREATE OR REPLACE FUNCTION respond_trip_fare_offer(p_fare_offer_id uuid, p_action varchar, p_counter_fare_per_seat_pkr decimal DEFAULT NULL) RETURNS jsonb AS $$
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
  IF o.status <> 'open' OR f.seats_requested > o.seats_available THEN
    RAISE EXCEPTION 'This trip no longer has enough free seats.' USING ERRCODE = 'P0001';
  END IF;

  IF p_action = 'reject' THEN
    UPDATE vehicle_trip_fare_offers SET status = 'rejected', responded_at = now() WHERE id = p_fare_offer_id;
  ELSIF p_action = 'counter' THEN
    IF p_counter_fare_per_seat_pkr IS NULL OR p_counter_fare_per_seat_pkr < 0 THEN RAISE EXCEPTION 'Enter a counter-offer amount.' USING ERRCODE = 'P0001'; END IF;
    IF o.distance_km IS NOT NULL THEN
      v_band := fare_band_for('trip_share', o.distance_km);
      IF p_counter_fare_per_seat_pkr < (v_band->>'min')::decimal OR p_counter_fare_per_seat_pkr > (v_band->>'max')::decimal THEN
        RAISE EXCEPTION 'Counter must be between % and % per seat.', (v_band->>'min')::decimal, (v_band->>'max')::decimal USING ERRCODE = 'P0001';
      END IF;
    END IF;
    UPDATE vehicle_trip_fare_offers SET status = 'countered', counter_fare_per_seat_pkr = p_counter_fare_per_seat_pkr, responded_at = now() WHERE id = p_fare_offer_id;
  ELSIF p_action = 'accept' THEN
    INSERT INTO vehicle_trip_bookings (trip_offer_id, fare_offer_id, vehicle_id, portal_user_id, seats, agreed_fare_per_seat_pkr, total_amount_pkr)
    VALUES (o.id, f.id, o.vehicle_id, f.portal_user_id, f.seats_requested, f.proposed_fare_per_seat_pkr, f.seats_requested * f.proposed_fare_per_seat_pkr)
    RETURNING id INTO v_booking_id;
    UPDATE vehicle_trip_fare_offers SET status = 'accepted', responded_at = now() WHERE id = p_fare_offer_id;
    -- Single UPDATE comparing against `o.seats_available` captured
    -- before this statement runs (402's fix for the double-decrement
    -- bug — two sequential UPDATEs here closed a trip that still had
    -- free seats left, since the second one re-read the already-
    -- decremented column).
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

-- City-fetch: the direct-message negotiation already carries a city_id
-- (start_negotiation, 422) — enforced only for kind='fetch' threads.
-- share (weekend commute) and pro (charter, already formula-priced)
-- stay exactly as unbounded/formulaic as before. Everything else in
-- this function is unchanged from 422 — only the band check is new.
CREATE OR REPLACE FUNCTION propose_negotiation_offer(p_thread_id uuid, p_amount_pkr decimal) RETURNS uuid AS $$
DECLARE
  t negotiation_threads%ROWTYPE; v vehicles%ROWTYPE; v_portal_user_id uuid := current_portal_user_id();
  v_role varchar; v_msg_id uuid; v_notify_portal_user_id uuid;
  v_band jsonb; v_km decimal;
BEGIN
  IF p_amount_pkr IS NULL OR p_amount_pkr <= 0 THEN RAISE EXCEPTION 'Enter an amount.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO t FROM negotiation_threads WHERE id = p_thread_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Conversation not found.' USING ERRCODE = 'P0001'; END IF;
  IF t.status <> 'open' THEN RAISE EXCEPTION 'This conversation is closed.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = t.vehicle_id;

  IF t.initiator_portal_user_id = v_portal_user_id THEN
    v_role := 'user'; v_notify_portal_user_id := v.portal_user_id;
  ELSIF v.portal_user_id = v_portal_user_id THEN
    v_role := 'driver'; v_notify_portal_user_id := t.initiator_portal_user_id;
  ELSE
    RAISE EXCEPTION 'You are not part of this conversation.' USING ERRCODE = 'P0001';
  END IF;

  IF t.kind = 'fetch' AND t.city_id IS NOT NULL THEN
    SELECT distance_km INTO v_km FROM cities WHERE id = t.city_id;
    IF v_km IS NOT NULL THEN
      v_band := fare_band_for('city_fetch', v_km);
      IF p_amount_pkr < (v_band->>'min')::decimal OR p_amount_pkr > (v_band->>'max')::decimal THEN
        RAISE EXCEPTION 'Amount must be between % and %.', (v_band->>'min')::decimal, (v_band->>'max')::decimal USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  INSERT INTO negotiation_messages (thread_id, sender_role, kind, amount_pkr) VALUES (p_thread_id, v_role, 'offer', p_amount_pkr)
  RETURNING id INTO v_msg_id;

  IF v_notify_portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_notify_portal_user_id, 'negotiation_offer', 'New price offer', 'Rs ' || p_amount_pkr::text, '/portal/marketplace/negotiations/' || p_thread_id);
  END IF;
  RETURN v_msg_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
