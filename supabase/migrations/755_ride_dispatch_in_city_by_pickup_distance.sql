-- Migration 755: real bug found explaining the zone-coverage-gap
-- question, 2026-10-28 — "online_in_city" never actually compared a
-- vehicle's position to the ride's own pickup point. It only checked
-- "is this vehicle inside ANY city zone this tenant has drawn,
-- anywhere" (point_in_tenant_zone(..., 'city')), which has two real
-- problems:
--
--   1. The question that started this: a city nobody's drawn a zone
--      for gets zero in-city detection, even with a real driver
--      standing right there.
--   2. Worse, found reading the code just now: a tenant with TWO city
--      zones (say Chakwal and Islamabad) could wrongly count a driver
--      sitting in the Islamabad zone as "already at the pickup" for a
--      ride request actually happening in Chakwal — the check never
--      looked at the pickup coordinates at all.
--
-- Fix: stop asking "is the driver inside a drawn zone" and ask "is the
-- driver actually near THIS pickup" — a plain haversine_km comparison
-- against the real p_pickup_lat/p_pickup_lng already passed into both
-- functions, no zone required. This is strictly more correct (fixes
-- #2) and incidentally also fixes #1 — in-city detection now works
-- for any pickup anywhere, without the admin needing to pre-draw a
-- zone for every city their fleet might ever be asked to reach.
--
-- Zones keep their other two real jobs unchanged: tenant_service_zones
-- 'village' rows still anchor the two-way detour-fare math (751, 752),
-- and the whole zone set still drives the platform fleet-map (750) —
-- the actual-territory visualization the super-admin uses to spot
-- overlaps before approving cross-tenant sharing. They just stop being
-- what gates the one-way fare tier.

CREATE OR REPLACE FUNCTION ride_dispatch_quote(p_category_id uuid, p_pickup_lat decimal, p_pickup_lng decimal, p_distance_km decimal) RETURNS jsonb AS $$
DECLARE
  v_category vehicle_categories%ROWTYPE;
  v_own_tenant uuid := my_tenant_id();
  v_online_in_city int; v_active_total int;
  v_base_fare decimal; v_village_lat decimal; v_village_lng decimal; v_village_km decimal; v_village_detour decimal;
  v_partner jsonb;
BEGIN
  SELECT * INTO v_category FROM vehicle_categories WHERE id = p_category_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That vehicle category is not available.' USING ERRCODE = 'P0001'; END IF;

  -- "Already at the pickup" is now a real distance check against the
  -- actual pickup point (6km — same ballpark as the city-zone radii
  -- already drawn), not zone membership.
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
    'cross_tenant', v_partner
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION accept_ride_dispatch(p_request_id uuid) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  r ride_dispatch_requests%ROWTYPE; v vehicles%ROWTYPE; v_cat vehicle_categories%ROWTYPE;
  v_initiator_tenant_id uuid;
  v_in_city boolean; v_village_lat decimal; v_village_lng decimal; v_village_detour decimal; v_fare decimal; v_tier varchar;
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

  IF v_in_city THEN
    v_fare := round(v_cat.base_fare_pkr + v_cat.per_km_pkr * r.distance_km);
    v_tier := CASE WHEN v.tenant_id = v_initiator_tenant_id THEN 'in_city' ELSE 'cross_tenant_in_city' END;
  ELSE
    SELECT center_lat, center_lng INTO v_village_lat, v_village_lng
    FROM tenant_service_zones WHERE tenant_id = v.tenant_id AND zone_kind = 'village' AND is_active LIMIT 1;
    IF v_village_lat IS NULL THEN
      SELECT lat, lng INTO v_village_lat, v_village_lng FROM cities WHERE is_home_city LIMIT 1;
    END IF;
    v_village_detour := CASE WHEN v_village_lat IS NOT NULL
      THEN round(v_cat.per_km_pkr * haversine_km(v_village_lat, v_village_lng, r.pickup_lat, r.pickup_lng) * 2)
      ELSE 0 END;
    v_fare := round(v_cat.base_fare_pkr + v_cat.per_km_pkr * r.distance_km) + v_village_detour;
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
    accepted_at = now(), fare_pkr = v_fare, matched_tenant_id = v.tenant_id, tier_used = v_tier
  WHERE id = p_request_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (r.initiator_portal_user_id, 'ride_dispatch_accepted', 'A driver accepted your ride',
    v.owner_name || ' (' || v.vehicle_type || COALESCE(' · ' || v.vehicle_number, '') || ') is on the way — Rs ' || v_fare::text,
    '/portal/marketplace/ride-dispatch/' || p_request_id);

  RETURN v_trip_offer_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
