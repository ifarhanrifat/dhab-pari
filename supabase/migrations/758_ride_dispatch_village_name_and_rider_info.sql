-- Migration 758: three real gaps found live, 2026-10-28.
--
-- 1. "it said no driver in the city do you like to call the vehicle
--    from your village, there was no village name" — askVillageDriverNote
--    never said WHICH village. ride_dispatch_quote now returns the
--    rider's own tenant name so the frontend can interpolate it.
--
-- 2. "the list which appeared was containing machinery and loading
--    rakshas vehicals etc" — ride_dispatch_category_options (the
--    nothing-anywhere fallback) offered every other active category
--    regardless of category_group (756), mixing equipment into a
--    passenger rider's fallback list and vice versa. Now scoped to the
--    same group as the category the rider actually picked.
--
-- 3. "when driver will get the invitation then there will be clearly
--    mentioned the rider is verified or not, in which village he
--    belongs too... how much his saving will be" — reuses the real,
--    already-live portal_user_trust() (497) rather than inventing a
--    second verification concept, adds the rider's own tenant name,
--    and stores a reference "what this would have cost as a two-way
--    village trip" fare at accept time (even when the actual tier
--    didn't need it) so both sides can see the savings when a nearby
--    driver accepted instead.

ALTER TABLE ride_dispatch_requests ADD COLUMN IF NOT EXISTS reference_village_fare_pkr decimal;

CREATE OR REPLACE FUNCTION ride_dispatch_quote(p_category_id uuid, p_pickup_lat decimal, p_pickup_lng decimal, p_distance_km decimal) RETURNS jsonb AS $$
DECLARE
  v_category vehicle_categories%ROWTYPE;
  v_own_tenant uuid := my_tenant_id();
  v_own_tenant_name varchar;
  v_online_in_city int; v_active_total int;
  v_base_fare decimal; v_village_lat decimal; v_village_lng decimal; v_village_detour decimal;
  v_partner jsonb;
BEGIN
  SELECT * INTO v_category FROM vehicle_categories WHERE id = p_category_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That vehicle category is not available.' USING ERRCODE = 'P0001'; END IF;
  SELECT name INTO v_own_tenant_name FROM tenants WHERE id = v_own_tenant;

  SELECT count(*) INTO v_online_in_city FROM vehicles v
  WHERE v.category_id = p_category_id AND v.is_active AND v.is_online AND v.current_lat IS NOT NULL
    AND v.current_location_updated_at > now() - interval '30 minutes'
    AND haversine_km(v.current_lat, v.current_lng, p_pickup_lat, p_pickup_lng) <= 6;

  SELECT count(*) INTO v_active_total FROM vehicles v WHERE v.category_id = p_category_id AND v.is_active;

  v_base_fare := round(v_category.base_fare_pkr + v_category.per_km_pkr * p_distance_km);

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
    JOIN LATERAL (SELECT count(*) AS n FROM vehicles vv WHERE vv.category_id = vc2.id AND vv.is_active) cnt ON cnt.n > 0
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

-- Scoped to the SAME category_group as the category the rider actually
-- picked — a car rider's fallback list must never offer a tractor.
CREATE OR REPLACE FUNCTION ride_dispatch_category_options(p_exclude_category_id uuid, p_distance_km decimal) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'name', c.name, 'name_ur', c.name_ur, 'emoji', c.emoji,
    'fare_pkr', round(c.base_fare_pkr + c.per_km_pkr * p_distance_km),
    'active_count', (SELECT count(*) FROM vehicles v WHERE v.category_id = c.id AND v.is_active)
  ) ORDER BY c.display_order), '[]'::jsonb)
  FROM vehicle_categories c
  WHERE c.tenant_id = my_tenant_id() AND c.is_active AND c.id <> p_exclude_category_id
    AND c.category_group = (SELECT category_group FROM vehicle_categories WHERE id = p_exclude_category_id)
    AND EXISTS (SELECT 1 FROM vehicles v WHERE v.category_id = c.id AND v.is_active);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION ride_dispatch_request_detail(p_request_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'status', r.status, 'pickup_label', r.pickup_label, 'dropoff_label', r.dropoff_label,
    'pickup_lat', r.pickup_lat, 'pickup_lng', r.pickup_lng, 'dropoff_lat', r.dropoff_lat, 'dropoff_lng', r.dropoff_lng,
    'distance_km', r.distance_km, 'fare_pkr', r.fare_pkr, 'reference_village_fare_pkr', r.reference_village_fare_pkr, 'created_at', r.created_at,
    'category_name', c.name, 'category_name_ur', c.name_ur, 'category_emoji', c.emoji,
    'is_mine_as_rider', r.initiator_portal_user_id = current_portal_user_id(),
    'trip_offer_id', r.trip_offer_id, 'tier_used', r.tier_used, 'matched_tenant_name', mt.name,
    'rider_trust', portal_user_trust(r.initiator_portal_user_id), 'rider_tenant_name', rt.name
  )
  FROM ride_dispatch_requests r
  JOIN vehicle_categories c ON c.id = r.category_id
  JOIN portal_users ipu ON ipu.id = r.initiator_portal_user_id
  JOIN tenants rt ON rt.id = ipu.tenant_id
  LEFT JOIN tenants mt ON mt.id = r.matched_tenant_id
  WHERE r.id = p_request_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION my_pending_ride_dispatch_requests(p_vehicle_id uuid) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'pickup_label', r.pickup_label, 'dropoff_label', r.dropoff_label, 'fare_pkr', r.fare_pkr,
    'category_name', c.name, 'category_name_ur', c.name_ur, 'category_emoji', c.emoji, 'created_at', r.created_at,
    'rider_trust', portal_user_trust(r.initiator_portal_user_id), 'rider_tenant_name', rt.name
  ) ORDER BY r.created_at), '[]'::jsonb)
  FROM ride_dispatch_requests r
  JOIN vehicle_categories c ON c.id = r.category_id
  JOIN vehicles v ON v.id = p_vehicle_id
  JOIN portal_users ipu ON ipu.id = r.initiator_portal_user_id
  JOIN tenants rt ON rt.id = ipu.tenant_id
  WHERE r.status = 'open' AND v.portal_user_id = current_portal_user_id() AND v.is_active
    AND (
      v.category_id = ANY(r.category_ids)
      OR EXISTS (
        SELECT 1 FROM vehicle_categories vc_mine, vehicle_categories vc_req
        WHERE vc_mine.id = v.category_id AND vc_req.id = r.category_id AND vc_mine.key = vc_req.key
          AND EXISTS (
            SELECT 1 FROM marketplace_share_agreements sa
            WHERE sa.owner_tenant_id = v.tenant_id AND sa.target_tenant_id = rt.id
              AND sa.category = 'ride_dispatch' AND sa.is_active
          )
      )
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- accept_ride_dispatch now always works out the two-way village
-- reference price too, regardless of which tier actually applied, so
-- "how much you saved" has something real to compare against.
CREATE OR REPLACE FUNCTION accept_ride_dispatch(p_request_id uuid) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  r ride_dispatch_requests%ROWTYPE; v vehicles%ROWTYPE; v_cat vehicle_categories%ROWTYPE;
  v_initiator_tenant_id uuid;
  v_in_city boolean; v_village_lat decimal; v_village_lng decimal; v_village_detour decimal; v_fare decimal; v_tier varchar;
  v_reference_village_fare decimal;
  v_trip_offer_id uuid; v_fare_offer_id uuid;
BEGIN
  SELECT * INTO r FROM ride_dispatch_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  IF r.status != 'open' THEN RAISE EXCEPTION 'Someone else already accepted this ride.' USING ERRCODE = 'P0001'; END IF;

  SELECT tenant_id INTO v_initiator_tenant_id FROM portal_users WHERE id = r.initiator_portal_user_id;

  SELECT v2.* INTO v FROM vehicles v2
  WHERE v2.portal_user_id = v_portal_user_id AND v2.is_active
    AND (
      v2.category_id = ANY(r.category_ids)
      OR EXISTS (
        SELECT 1 FROM vehicle_categories vc_mine, vehicle_categories vc_req
        WHERE vc_mine.id = v2.category_id AND vc_req.id = r.category_id AND vc_mine.key = vc_req.key
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
  v_reference_village_fare := round(v_cat.base_fare_pkr + v_cat.per_km_pkr * r.distance_km) + v_village_detour;

  IF v_in_city THEN
    v_fare := round(v_cat.base_fare_pkr + v_cat.per_km_pkr * r.distance_km);
    v_tier := CASE WHEN v.tenant_id = v_initiator_tenant_id THEN 'in_city' ELSE 'cross_tenant_in_city' END;
  ELSE
    v_fare := v_reference_village_fare;
    v_tier := CASE WHEN v.tenant_id = v_initiator_tenant_id THEN 'in_village' ELSE 'cross_tenant_in_village' END;
  END IF;

  INSERT INTO vehicle_trip_offers (vehicle_id, origin, destination, classification, travel_date, seats_available, listed_fare_per_seat_pkr, trip_type, status, dest_lat, dest_lng, distance_km)
  VALUES (v.id, r.pickup_label, r.dropoff_label, 'intercity', (now() AT TIME ZONE 'Asia/Karachi')::date, 1, v_fare, 'oneway', 'closed', r.dropoff_lat, r.dropoff_lng, r.distance_km)
  RETURNING id INTO v_trip_offer_id;

  INSERT INTO vehicle_trip_fare_offers (trip_offer_id, portal_user_id, seats_requested, proposed_fare_per_seat_pkr, status, responded_at)
  VALUES (v_trip_offer_id, r.initiator_portal_user_id, 1, v_fare, 'accepted', now())
  RETURNING id INTO v_fare_offer_id;

  INSERT INTO vehicle_trip_bookings (trip_offer_id, fare_offer_id, vehicle_id, portal_user_id, seats, agreed_fare_per_seat_pkr, total_amount_pkr, leg)
  VALUES (v_trip_offer_id, v_fare_offer_id, v.id, r.initiator_portal_user_id, 1, v_fare, v_fare, 'oneway');

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
