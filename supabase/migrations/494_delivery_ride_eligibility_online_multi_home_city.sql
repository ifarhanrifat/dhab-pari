-- Migration 494: three real gaps from live use of the vehicle marketplace.
--
-- 1. Delivery/ride class eligibility, admin-controlled. Today ANY active
--    vehicle can self-toggle `delivers` on regardless of type (a Car AC
--    could turn on delivery and do grocery runs a bike would do better),
--    and ANY active vehicle can check into an adda queue or post its own
--    trip offer regardless of type (a Suzuki Dala loading truck could
--    check into a passenger adda). The committee wants to restrict both
--    by vehicle class ("only bikes for delivery", e.g.) from the admin
--    panel, same class taxonomy service_classes (420) already is.
--
--    Reuses the existing admin-controlled vehicle→class assignment
--    (vehicle_service_offers, admin-only since 492/493 — literally "the
--    selected vehicles" mechanism already built) instead of adding a
--    third, redundant per-vehicle field: a class carries two new admin
--    flags (delivery_eligible, ride_eligible); a vehicle's eligibility is
--    whether ANY of its assigned classes carry that flag. A vehicle with
--    NO class assigned at all (pre-492 vehicles, or ones the committee
--    hasn't gotten to yet) is grandfathered as unrestricted — this ships
--    live, and locking out an existing driver's delivery/rides by default
--    the moment this migration runs would be a silent behaviour change,
--    not a deliberate committee decision. Both flags default true (no
--    change in behaviour day one); an admin narrows them down from the
--    marketplace-reference screen.
--
--    Enforced where a driver *initiates* the capability (delivers toggle,
--    posting a trip, checking into adda) so the block is a clear message
--    at the moment they try, AND in every existing "who gets this work"
--    read/broadcast query keyed off `delivers`, so narrowing a class's
--    eligibility takes effect immediately for vehicles that already had
--    delivers=true set before this shipped — not just for future toggles.
--
-- 2. Driver online/offline — a plain real-time "accepting new work right
--    now" switch, the one genuinely missing must-have from the reference
--    design (its driver header has a standing online/offline pill; this
--    build never wired one up to anything). Gates exactly the surfaces
--    that hand a driver *new* real-time work: dispatch/shop-delivery
--    invitations, being listed as present-and-requestable for city-fetch,
--    checking into an adda queue, posting a new trip offer. Does not
--    touch anything already in flight (an accepted booking, a live queue
--    turn, a running negotiation) — going offline mid-job doesn't cancel
--    it, exactly like every ride-hailing app's own "offline" behaves.
--    Defaults false (a freshly-approved vehicle is offline until the
--    driver actively goes online), self-toggled via a narrow RPC, same
--    ownership-check shape as every other vehicles.* self-service RPC
--    this session already built.
--
-- 3. Multiple home cities. cities.is_home_city (429) already exists and
--    already every gate reads it as a plain boolean — the only thing
--    stopping more than one being true was a one-row-only unique index,
--    added when the village only had one realistic "short local run".
--    Dropping the index is the entire fix; every existing EXISTS/boolean
--    check (place_trip_offer, vehicle_check_in_city, weekend_share_offers,
--    request_pro_service, invite_dispatch_tier, vehicles_available_for_city)
--    already treats "is this a home city" as a per-row fact, not a
--    global singleton, so nothing downstream needs to change. The admin
--    screen (marketplace-reference) already renders is_home_city as a
--    plain checkbox per city — it was the database that silently refused
--    a second one.

-- ── 3. Multiple home cities ─────────────────────────────────────────────
DROP INDEX IF EXISTS cities_one_home_city;

-- ── 1. Delivery/ride class eligibility ──────────────────────────────────
ALTER TABLE service_classes ADD COLUMN IF NOT EXISTS delivery_eligible boolean NOT NULL DEFAULT true;
ALTER TABLE service_classes ADD COLUMN IF NOT EXISTS ride_eligible boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION vehicle_delivery_eligible(p_vehicle_id uuid) RETURNS boolean AS $$
  SELECT NOT EXISTS (SELECT 1 FROM vehicle_service_offers WHERE vehicle_id = p_vehicle_id AND is_active)
    OR EXISTS (
      SELECT 1 FROM vehicle_service_offers o JOIN service_classes sc ON sc.id = o.service_class_id
      WHERE o.vehicle_id = p_vehicle_id AND o.is_active AND sc.delivery_eligible
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_delivery_eligible(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_delivery_eligible(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION vehicle_ride_eligible(p_vehicle_id uuid) RETURNS boolean AS $$
  SELECT NOT EXISTS (SELECT 1 FROM vehicle_service_offers WHERE vehicle_id = p_vehicle_id AND is_active)
    OR EXISTS (
      SELECT 1 FROM vehicle_service_offers o JOIN service_classes sc ON sc.id = o.service_class_id
      WHERE o.vehicle_id = p_vehicle_id AND o.is_active AND sc.ride_eligible
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_ride_eligible(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_ride_eligible(uuid) TO authenticated;

-- ── 2. Online/offline ────────────────────────────────────────────────────
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS is_online boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION set_vehicle_online_status(p_vehicle_id uuid, p_is_online boolean) RETURNS void AS $$
DECLARE v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND OR v.portal_user_id IS DISTINCT FROM current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE vehicles SET is_online = p_is_online WHERE id = p_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION set_vehicle_online_status(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_vehicle_online_status(uuid, boolean) TO authenticated;

-- ── Enforce delivery eligibility at the point a driver turns it on ─────
-- (490's version, verbatim, with one new guard.)
CREATE OR REPLACE FUNCTION set_vehicle_delivery_prefs(p_vehicle_id uuid, p_delivers boolean, p_per_km_pkr decimal DEFAULT NULL)
RETURNS void AS $$
DECLARE v vehicles%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF p_per_km_pkr IS NOT NULL THEN
    IF NOT v_is_admin THEN RAISE EXCEPTION 'Only the committee can set the per-km rate.' USING ERRCODE = 'P0001'; END IF;
    IF p_per_km_pkr < 0 THEN RAISE EXCEPTION 'Rate cannot be negative.' USING ERRCODE = 'P0001'; END IF;
  END IF;
  IF p_delivers AND NOT v_is_admin AND NOT vehicle_delivery_eligible(p_vehicle_id) THEN
    RAISE EXCEPTION 'Your vehicle''s class is not enabled for intercity delivery — ask the committee.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicles SET delivers = p_delivers, per_km_pkr = COALESCE(p_per_km_pkr, per_km_pkr) WHERE id = p_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION set_vehicle_delivery_prefs(uuid, boolean, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_vehicle_delivery_prefs(uuid, boolean, decimal) TO authenticated;

-- ── Ride eligibility + online required to check into an adda queue ─────
-- (416's version, verbatim, with two new guards right after ownership.)
CREATE OR REPLACE FUNCTION adda_check_in(
  p_adda_id uuid, p_vehicle_id uuid, p_fare_mode varchar DEFAULT 'fixed',
  p_share_location_on_depart boolean DEFAULT false,
  p_lat decimal DEFAULT NULL, p_lng decimal DEFAULT NULL, p_seats_available int DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  a addas%ROWTYPE; ap addas%ROWTYPE; v vehicles%ROWTYPE; v_portal_user_id uuid := current_portal_user_id();
  v_queue_date date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_now_time time := (now() AT TIME ZONE 'Asia/Karachi')::time;
  v_next_position int; v_entry_id uuid; v_trip_offer_id uuid; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
  v_distance_km decimal; v_seats int; v_fare decimal;
BEGIN
  SELECT * INTO a FROM addas WHERE id = p_adda_id AND is_active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This adda is not available.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND OR NOT v.is_active THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (v_is_admin OR v.portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT v_is_admin AND NOT v.is_online THEN
    RAISE EXCEPTION 'Go online first — you can''t check in to the queue while offline.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT v_is_admin AND NOT vehicle_ride_eligible(p_vehicle_id) THEN
    RAISE EXCEPTION 'Your vehicle''s class is not enabled for rides — ask the committee.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT vehicle_bookable(p_vehicle_id) THEN
    RAISE EXCEPTION 'This vehicle''s wallet balance is too low to join the queue — top up first.' USING ERRCODE = 'P0001';
  END IF;
  IF v.commission_mode = 'per_order' AND seller_account_balance(ensure_vehicle_account(p_vehicle_id)) <= 0 THEN
    RAISE EXCEPTION 'Top up your wallet before checking in — an adda slot needs a positive balance.' USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_is_admin AND a.operating_start_time IS NOT NULL AND a.operating_end_time IS NOT NULL THEN
    IF v_now_time < a.operating_start_time OR v_now_time > a.operating_end_time THEN
      RAISE EXCEPTION 'This adda only runs % to % — check in during those hours, or ask the committee about night service.',
        to_char(a.operating_start_time, 'HH12:MI AM'), to_char(a.operating_end_time, 'HH12:MI AM') USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NOT v_is_admin AND a.lat IS NOT NULL AND a.lng IS NOT NULL THEN
    IF p_lat IS NULL OR p_lng IS NULL THEN
      RAISE EXCEPTION 'Turn on your location to check in — we need to confirm you''re at the adda.' USING ERRCODE = 'P0001';
    END IF;
    v_distance_km := 6371 * acos(least(1, greatest(-1,
      cos(radians(p_lat)) * cos(radians(a.lat)) * cos(radians(p_lng) - radians(a.lng))
      + sin(radians(p_lat)) * sin(radians(a.lat)))));
    IF v_distance_km > 0.3 THEN
      RAISE EXCEPTION 'You need to be at the adda to check in — you appear to be % km away.', round(v_distance_km::numeric, 1) USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM adda_queue_entries WHERE vehicle_id = p_vehicle_id AND queue_date = v_queue_date AND status IN ('waiting', 'current')) THEN
    RAISE EXCEPTION 'This vehicle is already in a queue today.' USING ERRCODE = 'P0001';
  END IF;

  IF p_fare_mode NOT IN ('fixed', 'request') THEN RAISE EXCEPTION 'Invalid fare mode.' USING ERRCODE = 'P0001'; END IF;
  IF p_fare_mode = 'fixed' THEN
    IF a.fixed_fare_per_seat_pkr IS NULL THEN
      RAISE EXCEPTION 'This adda has no fare set yet — ask the committee to set one first.' USING ERRCODE = 'P0001';
    END IF;
    v_fare := a.fixed_fare_per_seat_pkr;
  ELSE
    v_fare := NULL;
  END IF;

  v_seats := COALESCE(p_seats_available, v.total_seats);
  IF v_seats <= 0 OR v_seats > v.total_seats THEN
    RAISE EXCEPTION 'Enter how many seats are actually free (1 to %).', v.total_seats USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(MAX(position), 0) + 1 INTO v_next_position FROM adda_queue_entries
    WHERE adda_id = p_adda_id AND queue_date = v_queue_date AND status IN ('waiting', 'current');

  SELECT * INTO ap FROM addas WHERE id = a.pair_adda_id;
  INSERT INTO vehicle_trip_offers (vehicle_id, origin, origin_ur, destination, destination_ur, classification, travel_date, seats_available, listed_fare_per_seat_pkr)
  VALUES (p_vehicle_id, a.name, a.name_ur, COALESCE(ap.name, 'destination'), ap.name_ur, a.classification, v_queue_date, v_seats, COALESCE(v_fare, 0))
  RETURNING id INTO v_trip_offer_id;

  INSERT INTO adda_queue_entries (adda_id, vehicle_id, queue_date, position, status, fare_mode, fixed_fare_per_seat_pkr, trip_offer_id, seats_total, share_location_on_depart, checked_in_by_admin)
  VALUES (p_adda_id, p_vehicle_id, v_queue_date, v_next_position, 'waiting', p_fare_mode, v_fare, v_trip_offer_id, v_seats, p_share_location_on_depart,
    CASE WHEN v_is_admin AND v.portal_user_id IS DISTINCT FROM v_portal_user_id THEN current_admin_user_id() ELSE NULL END)
  RETURNING id INTO v_entry_id;

  PERFORM adda_promote_next(p_adda_id, v_queue_date);

  RETURN jsonb_build_object('entry_id', v_entry_id, 'trip_offer_id', v_trip_offer_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── Ride eligibility + online required to post a trip offer ────────────
-- (429's version, verbatim, with two new guards.)
CREATE OR REPLACE FUNCTION place_trip_offer(
  p_vehicle_id uuid, p_origin varchar, p_origin_ur varchar, p_destination varchar, p_destination_ur varchar,
  p_classification varchar, p_travel_date date, p_departure_time_estimate time, p_seats_available int, p_listed_fare_per_seat_pkr decimal
) RETURNS uuid AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid; v_allows_out_of_city boolean; v_is_online boolean;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT allows_out_of_city, is_online INTO v_allows_out_of_city, v_is_online FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF NOT v_is_online THEN RAISE EXCEPTION 'Go online first — you can''t post a new trip while offline.' USING ERRCODE = 'P0001'; END IF;
  IF NOT vehicle_ride_eligible(p_vehicle_id) THEN
    RAISE EXCEPTION 'Your vehicle''s class is not enabled for rides — ask the committee.' USING ERRCODE = 'P0001';
  END IF;
  IF p_classification = 'out_of_city' AND NOT v_allows_out_of_city THEN
    RAISE EXCEPTION 'This vehicle is only set up for trips within the home city — ask the committee if you need out-of-station enabled.' USING ERRCODE = 'P0001';
  END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
  IF p_seats_available IS NULL OR p_seats_available <= 0 THEN RAISE EXCEPTION 'Enter how many seats are free.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicle_trip_offers (vehicle_id, origin, origin_ur, destination, destination_ur, classification, travel_date, departure_time_estimate, seats_available, listed_fare_per_seat_pkr)
  VALUES (p_vehicle_id, p_origin, NULLIF(p_origin_ur, ''), p_destination, NULLIF(p_destination_ur, ''), p_classification, p_travel_date, p_departure_time_estimate, p_seats_available, p_listed_fare_per_seat_pkr)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── Delivery eligibility + online, applied live to every existing
-- "who gets this work" query keyed off `delivers` — so narrowing a
-- class's eligibility (or a driver going offline) takes effect
-- immediately, not just for the next toggle-on. ────────────────────────

-- invite_dispatch_tier (429's version — the authoritative one; 430 never
-- redefined it, only added the read-side vehicles_available_for_city).
CREATE OR REPLACE FUNCTION invite_dispatch_tier(p_call_id uuid, p_tier int) RETURNS int AS $$
DECLARE v_city_id uuid; v_city_is_home boolean; v_count int;
BEGIN
  SELECT s.city_id, ci.is_home_city INTO v_city_id, v_city_is_home
  FROM dispatch_calls c JOIN city_shops s ON s.id = c.city_shop_id JOIN cities ci ON ci.id = s.city_id
  WHERE c.id = p_call_id;

  INSERT INTO dispatch_invitations (call_id, vehicle_id, tier)
  SELECT p_call_id, v.id, p_tier
  FROM vehicles v
  WHERE v.is_active AND v.delivers AND v.is_online AND vehicle_delivery_eligible(v.id)
    AND (v_city_is_home OR v.allows_out_of_city)
    AND NOT EXISTS (SELECT 1 FROM dispatch_invitations i WHERE i.call_id = p_call_id AND i.vehicle_id = v.id)
    AND (
      (p_tier = 1 AND EXISTS (SELECT 1 FROM vehicle_city_presence p WHERE p.vehicle_id = v.id AND p.city_id = v_city_id AND p.is_active))
      OR
      (p_tier = 2 AND NOT EXISTS (SELECT 1 FROM vehicle_city_presence p WHERE p.vehicle_id = v.id AND p.city_id = v_city_id AND p.is_active))
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- vehicles_present_in_city (421) — city-fetch's "who's in this city right now" list.
CREATE OR REPLACE FUNCTION vehicles_present_in_city(p_city_id uuid)
RETURNS TABLE(vehicle_id uuid, owner_name varchar, owner_mobile varchar, vehicle_type varchar, vehicle_number varchar, checked_in_at timestamptz, expected_return_at timestamptz) AS $$
  SELECT v.id, v.owner_name, v.owner_mobile, v.vehicle_type, v.vehicle_number, p.checked_in_at, p.expected_return_at
  FROM vehicle_city_presence p
  JOIN vehicles v ON v.id = p.vehicle_id
  WHERE p.city_id = p_city_id AND p.is_active AND v.is_active AND v.delivers AND v.is_online AND vehicle_delivery_eligible(v.id)
  ORDER BY p.checked_in_at ASC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- vehicles_available_for_city (430) — the merged "Order from City" screen's two-section list.
CREATE OR REPLACE FUNCTION vehicles_available_for_city(p_city_id uuid) RETURNS jsonb AS $$
DECLARE v_is_home boolean;
BEGIN
  SELECT is_home_city INTO v_is_home FROM cities WHERE id = p_city_id;
  RETURN jsonb_build_object(
    'present', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'vehicle_id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number
      ) ORDER BY p.checked_in_at)
      FROM vehicle_city_presence p JOIN vehicles v ON v.id = p.vehicle_id
      WHERE p.city_id = p_city_id AND p.is_active AND v.is_active AND v.delivers AND v.is_online AND vehicle_delivery_eligible(v.id)
    ), '[]'::jsonb),
    'village', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'vehicle_id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number
      ) ORDER BY v.owner_name)
      FROM vehicles v
      WHERE v.is_active AND v.delivers AND v.is_online AND vehicle_delivery_eligible(v.id) AND (v_is_home OR v.allows_out_of_city)
        AND NOT EXISTS (SELECT 1 FROM vehicle_city_presence p WHERE p.vehicle_id = v.id AND p.city_id = p_city_id AND p.is_active)
    ), '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- start_shop_delivery_ring (473) — village shop order delivery ring, the
-- same `delivers` capability applied to in-village orders.
CREATE OR REPLACE FUNCTION start_shop_delivery_ring(p_order_id uuid) RETURNS void AS $$
DECLARE
  o shop_orders%ROWTYPE;
  v_is_home boolean;
  v_count int;
BEGIN
  SELECT * INTO o FROM shop_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR user_manages_shop(o.shop_id)) THEN
    RAISE EXCEPTION 'You do not manage this shop.' USING ERRCODE = 'P0001';
  END IF;
  IF o.fulfillment_mode <> 'delivery' THEN RETURN; END IF;

  SELECT v.is_home_village INTO v_is_home FROM villages v WHERE v.id = o.village_id;

  INSERT INTO shop_delivery_invitations (order_id, vehicle_id)
  SELECT p_order_id, veh.id FROM vehicles veh
  WHERE veh.is_active AND veh.delivers AND veh.is_online AND vehicle_delivery_eligible(veh.id)
    AND NOT EXISTS (SELECT 1 FROM shop_delivery_invitations i WHERE i.order_id = p_order_id AND i.vehicle_id = veh.id)
    AND (COALESCE(v_is_home, true) OR veh.allows_out_of_city);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count = 0 THEN
    UPDATE shop_orders SET delivery_ring_status = 'no_answer' WHERE id = p_order_id;
    RETURN;
  END IF;

  UPDATE shop_orders SET delivery_ring_status = 'ringing' WHERE id = p_order_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT veh.portal_user_id, 'shop_delivery_invited', 'Delivery request',
    'A delivery job is available' || CASE WHEN v_is_home THEN '' ELSE ' (out of village)' END || '.',
    '/portal/my-vehicle/deliveries'
  FROM shop_delivery_invitations i JOIN vehicles veh ON veh.id = i.vehicle_id
  WHERE i.order_id = p_order_id AND i.status = 'ringing' AND veh.portal_user_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
