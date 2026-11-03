-- Migration 788: real ask, 2026-11-03 — a direct Bykea fare comparison
-- on a real ~113km outstation route (Fateh Jang/Taxila area → Chakwal)
-- surfaced two real, concrete gaps:
--
-- 1. "Car", "Small Car" and "SUV" all quoted the SAME fare for that
--    113km trip. Not a display bug — small_car_ac/suv/luxury were
--    cloned straight from the generic 'car' row at creation (749) and
--    never actually differentiated since, so every car-tier category
--    has genuinely been charging the identical rate since day one.
-- 2. This app has never had outstation pricing at all — the exact same
--    per_km_pkr is used for a 2km in-village hop and a 113km cross-
--    district trip. Bykea's own numbers on that real route (bike
--    ~24/km, rickshaw ~41/km, small car ~48/km, AC car ~63/km) are
--    roughly 4-6x their in-city rate — a driver taking a 100km+ job at
--    our flat in-city rate is a real loss for them, which is exactly
--    why nobody would accept one.
--
-- Fix: real, distinct per-category rates (no longer identical clones),
-- plus a genuine out_of_city_per_km_pkr used only when the DESTINATION
-- is actually outside the rider's home city (ride_dispatch_requests.
-- is_out_of_city) — landing deliberately below Bykea's own range
-- (~2-2.2x in-city vs their observed ~4-6x): this is a community co-op,
-- not a margin-maximizing commercial platform, and staying noticeably
-- cheaper than Bykea is a real trust advantage worth keeping. The
-- village-detour fee (how far the DRIVER has to travel from the
-- village center to reach the pickup point) stays at the plain in-city
-- rate throughout — that's the driver's own local repositioning cost,
-- unrelated to how far the eventual ride destination is.
--
-- Also: "what is bykea doing... no drivers, increase your offer... what
-- do we need to do here?" — Bykea's rider-driven bidding war is
-- exactly the "whoever games the system best wins" dynamic the
-- category-vs-catalog fix (787) deliberately moved away from. Instead:
-- if a broadcast request gets no acceptance within a few minutes, the
-- SYSTEM automatically raises the fare by a fixed, transparent step and
-- re-broadcasts to the same everyone-gets-an-equal-shot pool — same
-- fairness guarantee, same real problem solved (nobody wants this job
-- at this price) without a rider-vs-rider bidding auction.

ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS out_of_city_per_km_pkr decimal;

-- small_car group — all members set to the identical real rate (not
-- just the generic 'car' row) so ride_group_quote's AVG stays exact,
-- and so the fare quoted to the rider always matches what the specific
-- accepting vehicle's own category actually charges (accept_ride_dispatch
-- reads the ACCEPTING vehicle's own category, not a group average).
UPDATE vehicle_categories SET base_fare_pkr = 60, per_km_pkr = 14, out_of_city_per_km_pkr = 31
  WHERE key IN ('small_car_ac', 'small_car_non_ac', 'suzuki_mehran_ac', 'suzuki_mehran_non_ac', 'suzuki_alto');

-- car group — 'luxury' is deliberately kept at the SAME rate as the
-- rest of this group here: it's folded into the one "Car" point-to-
-- point tile (781, to keep the rider-facing grid at 5 tiles, not 6), so
-- giving it a wildly different per-km would make that tile's quoted
-- price inaccurate for whichever vehicle actually accepts. Luxury's
-- real premium already lives in rental_tier_fare_guides (786) for the
-- Hourly/Rental verticals, where it IS its own distinct tile.
UPDATE vehicle_categories SET base_fare_pkr = 80, per_km_pkr = 16, out_of_city_per_km_pkr = 35
  WHERE key IN ('big_car_ac', 'big_car_non_ac', 'toyota_corolla', 'luxury');

UPDATE vehicle_categories SET base_fare_pkr = 100, per_km_pkr = 20, out_of_city_per_km_pkr = 44
  WHERE key = 'suv';

UPDATE vehicle_categories SET base_fare_pkr = 30, per_km_pkr = 10, out_of_city_per_km_pkr = 20
  WHERE key IN ('bike', 'electric_bike');

UPDATE vehicle_categories SET base_fare_pkr = 40, per_km_pkr = 12, out_of_city_per_km_pkr = 24
  WHERE key IN ('rickshaw', 'electric_rickshaw');

-- ride_dispatch_quote (single-category preview, used by the "no driver
-- anywhere" fallback picker) — same signature, only the fare line
-- changes: use out_of_city_per_km_pkr for the ride-distance component
-- when the destination is genuinely out of city, falling back to the
-- normal rate if a category has none set. The village-detour fee below
-- is untouched — still the driver's own in-city repositioning cost.
CREATE OR REPLACE FUNCTION ride_dispatch_quote(p_category_id uuid, p_pickup_lat decimal, p_pickup_lng decimal, p_distance_km decimal, p_dropoff_city_id uuid DEFAULT NULL) RETURNS jsonb AS $$
DECLARE
  v_category vehicle_categories%ROWTYPE;
  v_own_tenant uuid := my_tenant_id();
  v_own_tenant_name varchar;
  v_is_out_of_city boolean := false;
  v_online_in_city int; v_active_total int;
  v_base_fare decimal; v_effective_per_km decimal; v_village_lat decimal; v_village_lng decimal; v_village_detour decimal;
  v_partner jsonb;
BEGIN
  SELECT * INTO v_category FROM vehicle_categories WHERE id = p_category_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That vehicle category is not available.' USING ERRCODE = 'P0001'; END IF;
  SELECT name INTO v_own_tenant_name FROM tenants WHERE id = v_own_tenant;

  IF p_dropoff_city_id IS NOT NULL THEN
    SELECT NOT COALESCE(is_home_city, true) INTO v_is_out_of_city FROM cities WHERE id = p_dropoff_city_id;
  END IF;
  IF v_is_out_of_city AND NOT v_category.out_of_city_eligible THEN
    RAISE EXCEPTION 'This vehicle type is only set up for trips within the home city.' USING ERRCODE = 'P0001';
  END IF;
  v_effective_per_km := COALESCE(CASE WHEN v_is_out_of_city THEN v_category.out_of_city_per_km_pkr END, v_category.per_km_pkr);

  SELECT count(*) INTO v_online_in_city FROM vehicles v
  WHERE v.category_id = p_category_id AND v.is_active AND v.is_online AND v.current_lat IS NOT NULL
    AND v.current_location_updated_at > now() - interval '30 minutes'
    AND haversine_km(v.current_lat, v.current_lng, p_pickup_lat, p_pickup_lng) <= 6
    AND (NOT v_is_out_of_city OR v.allows_out_of_city);

  SELECT count(*) INTO v_active_total FROM vehicles v
  WHERE v.category_id = p_category_id AND v.is_active AND (NOT v_is_out_of_city OR v.allows_out_of_city);

  v_base_fare := round(v_category.base_fare_pkr + v_effective_per_km * p_distance_km);

  SELECT center_lat, center_lng INTO v_village_lat, v_village_lng
  FROM tenant_service_zones WHERE tenant_id = v_own_tenant AND zone_kind = 'village' AND is_active LIMIT 1;
  IF v_village_lat IS NULL THEN
    SELECT lat, lng INTO v_village_lat, v_village_lng FROM cities WHERE is_home_city LIMIT 1;
  END IF;
  v_village_detour := CASE WHEN v_village_lat IS NOT NULL
    THEN round(v_category.per_km_pkr * haversine_km(v_village_lat, v_village_lng, p_pickup_lat, p_pickup_lng) * 2)
    ELSE 0 END;

  v_partner := NULL;
  IF v_active_total = 0 THEN
    SELECT jsonb_build_object(
      'tenant_id', t.id, 'tenant_name', t.name, 'active_count', cnt.n,
      'detour_pkr', COALESCE(round(vc2.per_km_pkr * haversine_km(z.center_lat, z.center_lng, p_pickup_lat, p_pickup_lng) * 2), 0)
    ) INTO v_partner
    FROM marketplace_share_agreements sa
    JOIN tenants t ON t.id = sa.owner_tenant_id
    JOIN vehicle_categories vc2 ON vc2.tenant_id = t.id AND vc2.key = v_category.key AND vc2.is_active
      AND (NOT v_is_out_of_city OR vc2.out_of_city_eligible)
    JOIN LATERAL (SELECT count(*) AS n FROM vehicles vv WHERE vv.category_id = vc2.id AND vv.is_active AND (NOT v_is_out_of_city OR vv.allows_out_of_city)) cnt ON cnt.n > 0
    LEFT JOIN tenant_service_zones z ON z.tenant_id = t.id AND z.zone_kind = 'village' AND z.is_active
    WHERE sa.target_tenant_id = v_own_tenant AND sa.category = 'ride_dispatch' AND sa.is_active
    ORDER BY (z.center_lat IS NULL), haversine_km(COALESCE(z.center_lat, p_pickup_lat), COALESCE(z.center_lng, p_pickup_lng), p_pickup_lat, p_pickup_lng)
    LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'online_in_city', v_online_in_city, 'active_total', v_active_total,
    'base_fare_pkr', v_base_fare, 'village_detour_pkr', v_village_detour, 'total_with_village_pkr', v_base_fare + v_village_detour,
    'cross_tenant', v_partner, 'own_tenant_name', v_own_tenant_name
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION ride_dispatch_quote(uuid, decimal, decimal, decimal, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ride_dispatch_quote(uuid, decimal, decimal, decimal, uuid) TO authenticated;

-- ride_group_quote (781, the real rider-facing preview for the 5 tiles)
-- — same fix, averaged across the group's own members (every member
-- within a group was just set to the identical rate above, so the
-- AVG is exact, not an approximation).
CREATE OR REPLACE FUNCTION ride_group_quote(
  p_ride_group varchar, p_pickup_lat decimal, p_pickup_lng decimal, p_distance_km decimal,
  p_variant_filter varchar DEFAULT NULL, p_dropoff_city_id uuid DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_ids uuid[];
  v_own_tenant uuid := my_tenant_id();
  v_own_tenant_name varchar;
  v_is_out_of_city boolean := false;
  v_online_in_city int; v_active_total int;
  v_base_fare decimal; v_per_km decimal; v_effective_per_km decimal; v_village_lat decimal; v_village_lng decimal; v_village_detour decimal;
  v_out_of_city_eligible boolean;
  v_partner jsonb;
  v_rep_key varchar;
BEGIN
  SELECT array_agg(id ORDER BY display_order) INTO v_ids FROM vehicle_categories
  WHERE tenant_id = v_own_tenant AND is_active AND ride_group = p_ride_group AND (p_variant_filter IS NULL OR variant_filter = p_variant_filter);
  IF v_ids IS NULL OR array_length(v_ids, 1) = 0 THEN RAISE EXCEPTION 'That vehicle category is not available.' USING ERRCODE = 'P0001'; END IF;

  SELECT name INTO v_own_tenant_name FROM tenants WHERE id = v_own_tenant;

  IF p_dropoff_city_id IS NOT NULL THEN
    SELECT NOT COALESCE(is_home_city, true) INTO v_is_out_of_city FROM cities WHERE id = p_dropoff_city_id;
  END IF;

  SELECT avg(base_fare_pkr), avg(per_km_pkr), avg(COALESCE(CASE WHEN v_is_out_of_city THEN out_of_city_per_km_pkr END, per_km_pkr)), bool_and(out_of_city_eligible), min(key)
  INTO v_base_fare, v_per_km, v_effective_per_km, v_out_of_city_eligible, v_rep_key
  FROM vehicle_categories WHERE id = ANY(v_ids);

  IF v_is_out_of_city AND NOT v_out_of_city_eligible THEN
    RAISE EXCEPTION 'This vehicle type is only set up for trips within the home city.' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_online_in_city FROM vehicles v
  WHERE v.category_id = ANY(v_ids) AND v.is_active AND v.is_online AND v.current_lat IS NOT NULL
    AND v.current_location_updated_at > now() - interval '30 minutes'
    AND haversine_km(v.current_lat, v.current_lng, p_pickup_lat, p_pickup_lng) <= 6
    AND (NOT v_is_out_of_city OR v.allows_out_of_city);

  SELECT count(*) INTO v_active_total FROM vehicles v
  WHERE v.category_id = ANY(v_ids) AND v.is_active AND (NOT v_is_out_of_city OR v.allows_out_of_city);

  v_base_fare := round(v_base_fare + v_effective_per_km * p_distance_km);

  SELECT center_lat, center_lng INTO v_village_lat, v_village_lng
  FROM tenant_service_zones WHERE tenant_id = v_own_tenant AND zone_kind = 'village' AND is_active LIMIT 1;
  IF v_village_lat IS NULL THEN
    SELECT lat, lng INTO v_village_lat, v_village_lng FROM cities WHERE is_home_city LIMIT 1;
  END IF;
  v_village_detour := CASE WHEN v_village_lat IS NOT NULL
    THEN round(v_per_km * haversine_km(v_village_lat, v_village_lng, p_pickup_lat, p_pickup_lng) * 2)
    ELSE 0 END;

  v_partner := NULL;
  IF v_active_total = 0 THEN
    SELECT jsonb_build_object(
      'tenant_id', t.id, 'tenant_name', t.name, 'active_count', cnt.n,
      'detour_pkr', COALESCE(round(vc2.per_km_pkr * haversine_km(z.center_lat, z.center_lng, p_pickup_lat, p_pickup_lng) * 2), 0)
    ) INTO v_partner
    FROM marketplace_share_agreements sa
    JOIN tenants t ON t.id = sa.owner_tenant_id
    JOIN vehicle_categories vc2 ON vc2.tenant_id = t.id AND vc2.key = v_rep_key AND vc2.is_active
      AND (NOT v_is_out_of_city OR vc2.out_of_city_eligible)
    JOIN LATERAL (SELECT count(*) AS n FROM vehicles vv WHERE vv.category_id = vc2.id AND vv.is_active AND (NOT v_is_out_of_city OR vv.allows_out_of_city)) cnt ON cnt.n > 0
    LEFT JOIN tenant_service_zones z ON z.tenant_id = t.id AND z.zone_kind = 'village' AND z.is_active
    WHERE sa.target_tenant_id = v_own_tenant AND sa.category = 'ride_dispatch' AND sa.is_active
    ORDER BY (z.center_lat IS NULL), haversine_km(COALESCE(z.center_lat, p_pickup_lat), COALESCE(z.center_lng, p_pickup_lng), p_pickup_lat, p_pickup_lng)
    LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'online_in_city', v_online_in_city, 'active_total', v_active_total,
    'base_fare_pkr', v_base_fare, 'village_detour_pkr', v_village_detour, 'total_with_village_pkr', v_base_fare + v_village_detour,
    'cross_tenant', v_partner, 'own_tenant_name', v_own_tenant_name
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION ride_group_quote(varchar, decimal, decimal, decimal, varchar, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ride_group_quote(varchar, decimal, decimal, decimal, varchar, uuid) TO authenticated;

-- create_ride_dispatch_request: the fare_pkr stored at request creation
-- (shown on the waiting screen before anyone accepts) needs the same
-- fix — v_is_out_of_city is already computed in this function before
-- the INSERT, just reused here.
CREATE OR REPLACE FUNCTION create_ride_dispatch_request(
  p_category_id uuid, p_pickup_label text, p_pickup_lat decimal, p_pickup_lng decimal,
  p_dropoff_label text, p_dropoff_lat decimal, p_dropoff_lng decimal, p_distance_km decimal,
  p_category_ids uuid[] DEFAULT NULL, p_include_cross_tenant boolean DEFAULT true, p_scheduled_for timestamptz DEFAULT NULL,
  p_dropoff_city_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_own_tenant uuid; v_category vehicle_categories%ROWTYPE;
  v_category_ids uuid[] := COALESCE(p_category_ids, ARRAY[p_category_id]);
  v_request_id uuid; v_is_future boolean; v_is_out_of_city boolean := false;
  v_effective_per_km decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT tenant_id INTO v_own_tenant FROM portal_users WHERE id = v_portal_user_id;
  SELECT * INTO v_category FROM vehicle_categories WHERE id = p_category_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That vehicle category is not available.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM ride_dispatch_requests WHERE initiator_portal_user_id = v_portal_user_id AND status = 'open') THEN
    RAISE EXCEPTION 'You already have a ride request waiting for a driver.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM vehicle_categories vc WHERE vc.id = ANY(v_category_ids) AND vc.tenant_id <> v_own_tenant) THEN
    RAISE EXCEPTION 'Invalid category selection.' USING ERRCODE = 'P0001';
  END IF;
  IF p_scheduled_for IS NOT NULL AND p_scheduled_for > now() + interval '7 days' THEN
    RAISE EXCEPTION 'Please schedule within the next 7 days.' USING ERRCODE = 'P0001';
  END IF;

  IF p_dropoff_city_id IS NOT NULL THEN
    SELECT NOT COALESCE(is_home_city, true) INTO v_is_out_of_city FROM cities WHERE id = p_dropoff_city_id;
  END IF;
  IF v_is_out_of_city AND EXISTS (SELECT 1 FROM vehicle_categories WHERE id = ANY(v_category_ids) AND NOT out_of_city_eligible) THEN
    RAISE EXCEPTION 'This vehicle type is only set up for trips within the home city.' USING ERRCODE = 'P0001';
  END IF;
  v_effective_per_km := COALESCE(CASE WHEN v_is_out_of_city THEN v_category.out_of_city_per_km_pkr END, v_category.per_km_pkr);

  v_is_future := p_scheduled_for IS NOT NULL AND p_scheduled_for > now();

  INSERT INTO ride_dispatch_requests (initiator_portal_user_id, category_id, category_ids, pickup_label, pickup_lat, pickup_lng, dropoff_label, dropoff_lat, dropoff_lng, distance_km, fare_pkr, scheduled_for, is_out_of_city)
  VALUES (v_portal_user_id, p_category_id, v_category_ids, p_pickup_label, p_pickup_lat, p_pickup_lng, p_dropoff_label, p_dropoff_lat, p_dropoff_lng, p_distance_km,
    round(v_category.base_fare_pkr + v_effective_per_km * p_distance_km), CASE WHEN v_is_future THEN p_scheduled_for ELSE NULL END, v_is_out_of_city)
  RETURNING id INTO v_request_id;

  IF NOT v_is_future THEN
    PERFORM broadcast_ride_dispatch_request(v_request_id);
  END IF;

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_ride_dispatch_request(uuid, text, decimal, decimal, text, decimal, decimal, decimal, uuid[], boolean, timestamptz, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_ride_dispatch_request(uuid, text, decimal, decimal, text, decimal, decimal, decimal, uuid[], boolean, timestamptz, uuid) TO authenticated;

-- accept_ride_dispatch: the REAL fare actually charged. v_in_city here
-- is "is the accepting vehicle already near the pickup point" (driver
-- proximity) — a different question from r.is_out_of_city ("is the
-- destination actually outside the rider's home city", set once at
-- request creation). Both branches below price the RIDE DISTANCE
-- itself (r.distance_km) at the outstation rate when r.is_out_of_city
-- is true; the village-detour fee (how far the driver has to travel
-- from the village center to reach the pickup) stays at the plain
-- in-city per-km rate in both — that's the driver's own local
-- repositioning cost, not the length of the ride itself.
CREATE OR REPLACE FUNCTION accept_ride_dispatch(p_request_id uuid) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  r ride_dispatch_requests%ROWTYPE; v vehicles%ROWTYPE; v_cat vehicle_categories%ROWTYPE;
  v_initiator_tenant_id uuid;
  v_in_city boolean; v_village_lat decimal; v_village_lng decimal; v_village_detour decimal; v_fare decimal; v_tier varchar;
  v_reference_village_fare decimal; v_effective_per_km decimal;
  v_trip_offer_id uuid; v_fare_offer_id uuid;
BEGIN
  SELECT * INTO r FROM ride_dispatch_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  IF r.status != 'open' THEN RAISE EXCEPTION 'Someone else already accepted this ride.' USING ERRCODE = 'P0001'; END IF;

  SELECT tenant_id INTO v_initiator_tenant_id FROM portal_users WHERE id = r.initiator_portal_user_id;

  SELECT v2.* INTO v FROM vehicles v2
  WHERE v2.portal_user_id = v_portal_user_id AND v2.is_active
    AND (NOT r.is_out_of_city OR v2.allows_out_of_city)
    AND (
      (v2.category_id = ANY(r.category_ids) AND (NOT r.is_out_of_city OR EXISTS (SELECT 1 FROM vehicle_categories WHERE id = v2.category_id AND out_of_city_eligible)))
      OR EXISTS (
        SELECT 1 FROM vehicle_categories vc_mine, vehicle_categories vc_req
        WHERE vc_mine.id = v2.category_id AND vc_req.id = r.category_id AND vc_mine.key = vc_req.key
          AND (NOT r.is_out_of_city OR vc_mine.out_of_city_eligible)
          AND EXISTS (
            SELECT 1 FROM marketplace_share_agreements sa
            WHERE sa.owner_tenant_id = v2.tenant_id AND sa.target_tenant_id = v_initiator_tenant_id
              AND sa.category = 'ride_dispatch' AND sa.is_active
          )
      )
    )
  ORDER BY (v2.category_id = ANY(r.category_ids)) DESC
  LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'This ride is not for your vehicle category.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_cat FROM vehicle_categories WHERE id = v.category_id;
  v_effective_per_km := COALESCE(CASE WHEN r.is_out_of_city THEN v_cat.out_of_city_per_km_pkr END, v_cat.per_km_pkr);

  v_in_city := v.is_online AND v.current_lat IS NOT NULL
    AND v.current_location_updated_at > now() - interval '30 minutes'
    AND haversine_km(v.current_lat, v.current_lng, r.pickup_lat, r.pickup_lng) <= 6;

  SELECT center_lat, center_lng INTO v_village_lat, v_village_lng
  FROM tenant_service_zones WHERE tenant_id = v.tenant_id AND zone_kind = 'village' AND is_active LIMIT 1;
  IF v_village_lat IS NULL THEN
    SELECT lat, lng INTO v_village_lat, v_village_lng FROM cities WHERE is_home_city LIMIT 1;
  END IF;
  v_village_detour := CASE WHEN v_village_lat IS NOT NULL
    THEN round(v_cat.per_km_pkr * haversine_km(v_village_lat, v_village_lng, r.pickup_lat, r.pickup_lng) * 2)
    ELSE 0 END;
  v_reference_village_fare := round(v_cat.base_fare_pkr + v_effective_per_km * r.distance_km) + v_village_detour;

  IF v_in_city THEN
    v_fare := round(v_cat.base_fare_pkr + v_effective_per_km * r.distance_km);
    v_tier := CASE WHEN v.tenant_id = v_initiator_tenant_id THEN 'in_city' ELSE 'cross_tenant_in_city' END;
  ELSE
    v_fare := v_reference_village_fare;
    v_tier := CASE WHEN v.tenant_id = v_initiator_tenant_id THEN 'in_village' ELSE 'cross_tenant_in_village' END;
  END IF;

  UPDATE vehicle_trip_offers SET share_live_location = false WHERE vehicle_id = v.id AND share_live_location;
  DELETE FROM vehicle_trip_offer_locations WHERE trip_offer_id IN (SELECT id FROM vehicle_trip_offers WHERE vehicle_id = v.id);

  INSERT INTO vehicle_trip_offers (vehicle_id, origin, destination, classification, travel_date, seats_available, listed_fare_per_seat_pkr, trip_type, status, dest_lat, dest_lng, distance_km, share_live_location, live_location_started_at)
  VALUES (v.id, r.pickup_label, r.dropoff_label, 'intercity', (now() AT TIME ZONE 'Asia/Karachi')::date, 1, v_fare, 'oneway', 'closed', r.dropoff_lat, r.dropoff_lng, r.distance_km, true, now())
  RETURNING id INTO v_trip_offer_id;

  INSERT INTO vehicle_trip_fare_offers (trip_offer_id, portal_user_id, seats_requested, proposed_fare_per_seat_pkr, status, responded_at)
  VALUES (v_trip_offer_id, r.initiator_portal_user_id, 1, v_fare, 'accepted', now())
  RETURNING id INTO v_fare_offer_id;

  INSERT INTO vehicle_trip_bookings (trip_offer_id, fare_offer_id, vehicle_id, portal_user_id, seats, agreed_fare_per_seat_pkr, total_amount_pkr, leg, pin)
  VALUES (v_trip_offer_id, v_fare_offer_id, v.id, r.initiator_portal_user_id, 1, v_fare, v_fare, 'oneway', lpad(floor(random() * 10000)::text, 4, '0'));

  UPDATE ride_dispatch_requests SET status = 'accepted', accepted_vehicle_id = v.id, trip_offer_id = v_trip_offer_id,
    accepted_at = now(), fare_pkr = v_fare, matched_tenant_id = v.tenant_id, tier_used = v_tier, reference_village_fare_pkr = v_reference_village_fare
  WHERE id = p_request_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (r.initiator_portal_user_id, 'ride_dispatch_accepted', 'A driver accepted your ride',
    v.owner_name || ' (' || v.vehicle_type || COALESCE(' · ' || v.vehicle_number, '') || ') is on the way — Rs ' || v_fare::text,
    '/portal/marketplace/ride-dispatch/' || p_request_id);

  RETURN v_trip_offer_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Real ask: "bykea keeps saying no drivers are busy so increase your
-- offer so driver will accept... what do we need to do here?" A rider-
-- driven bidding auction reintroduces exactly the "whoever games the
-- system best wins" problem 787 moved away from. This is the fairer
-- alternative: the SYSTEM steps the fare up automatically — same
-- everyone-gets-notified broadcast pool each time, nothing for one
-- rider to manipulate over another. Capped at 3 steps (+15% each,
-- compounding) over the request's 20-minute window (748/759's own
-- existing expiry), so it settles rather than climbing forever.
ALTER TABLE ride_dispatch_requests ADD COLUMN IF NOT EXISTS escalation_count int NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION escalate_stale_ride_dispatch_requests() RETURNS void AS $$
DECLARE r RECORD; v_new_fare decimal;
BEGIN
  FOR r IN
    SELECT * FROM ride_dispatch_requests
    WHERE status = 'open' AND activated_at IS NOT NULL AND escalation_count < 3
      AND activated_at < now() - (escalation_count + 1) * interval '4 minutes'
    FOR UPDATE SKIP LOCKED
  LOOP
    v_new_fare := round(r.fare_pkr * 1.15);
    UPDATE ride_dispatch_requests SET fare_pkr = v_new_fare, escalation_count = escalation_count + 1 WHERE id = r.id;

    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT v.portal_user_id, 'ride_dispatch_requested', 'Fare increased — ride still needs a driver',
      r.pickup_label || ' → ' || r.dropoff_label || ' — now Rs ' || v_new_fare::text,
      '/portal/marketplace/ride-dispatch/' || r.id
    FROM vehicles v
    WHERE v.category_id = ANY(r.category_ids) AND v.is_active AND v.portal_user_id IS NOT NULL
      AND (NOT r.is_out_of_city OR v.allows_out_of_city);
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

SELECT cron.schedule('escalate-stale-ride-dispatch-requests', '*/2 * * * *', $$SELECT escalate_stale_ride_dispatch_requests()$$);
