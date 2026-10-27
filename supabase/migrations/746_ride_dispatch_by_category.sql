-- Real ask, 2026-10-27: "there is no regular rides are listed like
-- catagory wise list... when user will chose one catagory then the
-- request will go to all the catagory drivers" — a real gap: today a
-- rider can only book a SPECIFIC driver's already-posted trip offer
-- (Adda/Shared) or a weekly Route. There's no "I don't care which
-- driver, just send my request to every car/bike/van driver right now"
-- option, the way the existing goods-dispatch (dispatch_calls, 423;
-- city_purchase_requests, 732) already works for buying something from
-- a city. This is that same broadcast shape, for a passenger ride
-- instead of goods — a new table because dispatch_calls is genuinely
-- shaped around a shop/item/round-trip-fetch, not a point-to-point
-- passenger pickup.
--
-- Deliberate design choice: accepting a request doesn't invent a third
-- parallel booking record. It spawns a real vehicle_trip_offers row
-- (closed immediately, one rider) + vehicle_trip_fare_offers +
-- vehicle_trip_bookings — the exact same tables book_trip_offer()
-- already writes — so the live tracking page, the ongoing-ride
-- floating button (my_ongoing_ride, 745), and the trip group chat all
-- work for this automatically, with zero extra integration.

CREATE TABLE IF NOT EXISTS ride_dispatch_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  initiator_portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  category_id uuid NOT NULL REFERENCES vehicle_categories(id),
  pickup_label text NOT NULL, pickup_lat decimal NOT NULL, pickup_lng decimal NOT NULL,
  dropoff_label text NOT NULL, dropoff_lat decimal NOT NULL, dropoff_lng decimal NOT NULL,
  distance_km decimal NOT NULL CHECK (distance_km >= 0),
  fare_pkr decimal NOT NULL CHECK (fare_pkr >= 0),
  status varchar NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'cancelled', 'expired')),
  accepted_vehicle_id uuid REFERENCES vehicles(id),
  trip_offer_id uuid REFERENCES vehicle_trip_offers(id),
  created_at timestamptz DEFAULT now(),
  accepted_at timestamptz,
  cancelled_at timestamptz
);
CREATE INDEX IF NOT EXISTS ride_dispatch_requests_initiator_idx ON ride_dispatch_requests(initiator_portal_user_id);
CREATE INDEX IF NOT EXISTS ride_dispatch_requests_category_status_idx ON ride_dispatch_requests(category_id, status);

ALTER TABLE ride_dispatch_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ride_dispatch_requests_read" ON ride_dispatch_requests FOR SELECT TO authenticated
  USING (
    initiator_portal_user_id = current_portal_user_id()
    OR (status = 'open' AND EXISTS (SELECT 1 FROM vehicles v WHERE v.category_id = ride_dispatch_requests.category_id AND v.portal_user_id = current_portal_user_id()))
    OR (accepted_vehicle_id IS NOT NULL AND EXISTS (SELECT 1 FROM vehicles v WHERE v.id = accepted_vehicle_id AND v.portal_user_id = current_portal_user_id()))
    OR COALESCE(current_admin_permission('manage_parties'), false)
  );
-- Writes only via the RPCs below.

CREATE OR REPLACE FUNCTION ride_dispatch_fare_estimate(p_category_id uuid, p_distance_km decimal) RETURNS decimal AS $$
  SELECT round(base_fare_pkr + per_km_pkr * p_distance_km) FROM vehicle_categories WHERE id = p_category_id AND is_active;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION ride_dispatch_fare_estimate(uuid, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ride_dispatch_fare_estimate(uuid, decimal) TO authenticated;

CREATE OR REPLACE FUNCTION create_ride_dispatch_request(
  p_category_id uuid, p_pickup_label text, p_pickup_lat decimal, p_pickup_lng decimal,
  p_dropoff_label text, p_dropoff_lat decimal, p_dropoff_lng decimal, p_distance_km decimal
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_fare decimal; v_request_id uuid; v_category vehicle_categories%ROWTYPE;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_category FROM vehicle_categories WHERE id = p_category_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That vehicle category is not available.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM ride_dispatch_requests WHERE initiator_portal_user_id = v_portal_user_id AND status = 'open') THEN
    RAISE EXCEPTION 'You already have a ride request waiting for a driver.' USING ERRCODE = 'P0001';
  END IF;

  v_fare := ride_dispatch_fare_estimate(p_category_id, p_distance_km);

  INSERT INTO ride_dispatch_requests (initiator_portal_user_id, category_id, pickup_label, pickup_lat, pickup_lng, dropoff_label, dropoff_lat, dropoff_lng, distance_km, fare_pkr)
  VALUES (v_portal_user_id, p_category_id, p_pickup_label, p_pickup_lat, p_pickup_lng, p_dropoff_label, p_dropoff_lat, p_dropoff_lng, p_distance_km, v_fare)
  RETURNING id INTO v_request_id;

  -- Broadcast to every online, active vehicle of this exact category —
  -- same "ring everyone who qualifies" shape dispatch_calls already uses.
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'ride_dispatch_requested', v_category.emoji || ' ' || v_category.name || ' ride requested',
    p_pickup_label || ' → ' || p_dropoff_label || ' — Rs ' || v_fare::text, '/portal/marketplace/ride-dispatch/' || v_request_id
  FROM vehicles v
  WHERE v.category_id = p_category_id AND v.is_active AND v.is_online AND v.portal_user_id IS NOT NULL;

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_ride_dispatch_request(uuid, text, decimal, decimal, text, decimal, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_ride_dispatch_request(uuid, text, decimal, decimal, text, decimal, decimal, decimal) TO authenticated;

CREATE OR REPLACE FUNCTION ride_dispatch_request_detail(p_request_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'status', r.status, 'pickup_label', r.pickup_label, 'dropoff_label', r.dropoff_label,
    'pickup_lat', r.pickup_lat, 'pickup_lng', r.pickup_lng, 'dropoff_lat', r.dropoff_lat, 'dropoff_lng', r.dropoff_lng,
    'distance_km', r.distance_km, 'fare_pkr', r.fare_pkr, 'created_at', r.created_at,
    'category_name', c.name, 'category_name_ur', c.name_ur, 'category_emoji', c.emoji,
    'is_mine_as_rider', r.initiator_portal_user_id = current_portal_user_id(),
    'trip_offer_id', r.trip_offer_id
  )
  FROM ride_dispatch_requests r JOIN vehicle_categories c ON c.id = r.category_id
  WHERE r.id = p_request_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION ride_dispatch_request_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ride_dispatch_request_detail(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION cancel_ride_dispatch_request(p_request_id uuid) RETURNS void AS $$
DECLARE r ride_dispatch_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM ride_dispatch_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.initiator_portal_user_id != current_portal_user_id() THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  IF r.status != 'open' THEN RAISE EXCEPTION 'This request is no longer open.' USING ERRCODE = 'P0001'; END IF;
  UPDATE ride_dispatch_requests SET status = 'cancelled', cancelled_at = now() WHERE id = p_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION cancel_ride_dispatch_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancel_ride_dispatch_request(uuid) TO authenticated;

-- First driver of the matching category to accept wins — same
-- FOR UPDATE race-safe pattern every other accept-one-of-many RPC in
-- this app already uses (book_trip_offer, accept_negotiation, etc.).
CREATE OR REPLACE FUNCTION accept_ride_dispatch(p_request_id uuid) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  r ride_dispatch_requests%ROWTYPE; v vehicles%ROWTYPE;
  v_trip_offer_id uuid; v_fare_offer_id uuid;
BEGIN
  SELECT * INTO r FROM ride_dispatch_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  IF r.status != 'open' THEN RAISE EXCEPTION 'Someone else already accepted this ride.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE portal_user_id = v_portal_user_id AND category_id = r.category_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'This ride is not for your vehicle category.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicle_trip_offers (vehicle_id, origin, destination, classification, travel_date, seats_available, listed_fare_per_seat_pkr, trip_type, status, dest_lat, dest_lng, distance_km)
  VALUES (v.id, r.pickup_label, r.dropoff_label, 'intercity', (now() AT TIME ZONE 'Asia/Karachi')::date, 1, r.fare_pkr, 'oneway', 'closed', r.dropoff_lat, r.dropoff_lng, r.distance_km)
  RETURNING id INTO v_trip_offer_id;

  INSERT INTO vehicle_trip_fare_offers (trip_offer_id, portal_user_id, seats_requested, proposed_fare_per_seat_pkr, status, responded_at)
  VALUES (v_trip_offer_id, r.initiator_portal_user_id, 1, r.fare_pkr, 'accepted', now())
  RETURNING id INTO v_fare_offer_id;

  INSERT INTO vehicle_trip_bookings (trip_offer_id, fare_offer_id, vehicle_id, portal_user_id, seats, agreed_fare_per_seat_pkr, total_amount_pkr, leg)
  VALUES (v_trip_offer_id, v_fare_offer_id, v.id, r.initiator_portal_user_id, 1, r.fare_pkr, r.fare_pkr, 'oneway');

  UPDATE ride_dispatch_requests SET status = 'accepted', accepted_vehicle_id = v.id, trip_offer_id = v_trip_offer_id, accepted_at = now() WHERE id = p_request_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (r.initiator_portal_user_id, 'ride_dispatch_accepted', 'A driver accepted your ride',
    v.owner_name || ' (' || v.vehicle_type || COALESCE(' · ' || v.vehicle_number, '') || ') is on the way.', '/portal/marketplace/ride-dispatch/' || p_request_id);

  RETURN v_trip_offer_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION accept_ride_dispatch(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_ride_dispatch(uuid) TO authenticated;
