-- Migration 760: real bug, 2026-10-28 — "I selected Talagang and bikes
-- and electric bikes and rickshaws are displaying there which were
-- only bound to intercity use only." The app already has a real,
-- proven out-of-city gate (429: vehicles.allows_out_of_city, admin-set
-- per vehicle, already seeded false for bike/rickshaw, already
-- enforced in place_trip_offer/vehicle_check_in_city/weekend_share_
-- offers/request_pro_service/invite_dispatch_tier) — the brand-new
-- ride-dispatch cascade (746-759) just never checked it at all.
--
-- Adds the category-level control asked for on TOP of the existing
-- per-vehicle flag, not instead of it: vehicle_categories.
-- out_of_city_eligible is the quick admin-facing "this whole class
-- never does out-of-station work" switch (seeded false for the same
-- bike/rickshaw keys 429 already flagged); the real per-vehicle flag
-- still gets the final say for an individual vehicle within an
-- eligible category. "Out of city" itself is the exact same test
-- every other flow already uses — cities.is_home_city.

ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS out_of_city_eligible boolean NOT NULL DEFAULT true;
UPDATE vehicle_categories SET out_of_city_eligible = false WHERE key IN ('bike', 'electric_bike', 'rickshaw', 'rickshaw_loading');

ALTER TABLE ride_dispatch_requests ADD COLUMN IF NOT EXISTS is_out_of_city boolean NOT NULL DEFAULT false;

DROP FUNCTION IF EXISTS ride_dispatch_quote(uuid, decimal, decimal, decimal);

CREATE OR REPLACE FUNCTION ride_dispatch_quote(p_category_id uuid, p_pickup_lat decimal, p_pickup_lng decimal, p_distance_km decimal, p_dropoff_city_id uuid DEFAULT NULL) RETURNS jsonb AS $$
DECLARE
  v_category vehicle_categories%ROWTYPE;
  v_own_tenant uuid := my_tenant_id();
  v_own_tenant_name varchar;
  v_is_out_of_city boolean := false;
  v_online_in_city int; v_active_total int;
  v_base_fare decimal; v_village_lat decimal; v_village_lng decimal; v_village_detour decimal;
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

  SELECT count(*) INTO v_online_in_city FROM vehicles v
  WHERE v.category_id = p_category_id AND v.is_active AND v.is_online AND v.current_lat IS NOT NULL
    AND v.current_location_updated_at > now() - interval '30 minutes'
    AND haversine_km(v.current_lat, v.current_lng, p_pickup_lat, p_pickup_lng) <= 6
    AND (NOT v_is_out_of_city OR v.allows_out_of_city);

  SELECT count(*) INTO v_active_total FROM vehicles v
  WHERE v.category_id = p_category_id AND v.is_active AND (NOT v_is_out_of_city OR v.allows_out_of_city);

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

-- Same group-match it already had, plus: never offer an out-of-city-
-- ineligible category as a fallback for an out-of-city request.
DROP FUNCTION IF EXISTS ride_dispatch_category_options(uuid, decimal);
CREATE OR REPLACE FUNCTION ride_dispatch_category_options(p_exclude_category_id uuid, p_distance_km decimal, p_is_out_of_city boolean DEFAULT false) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'name', c.name, 'name_ur', c.name_ur, 'emoji', c.emoji,
    'fare_pkr', round(c.base_fare_pkr + c.per_km_pkr * p_distance_km),
    'active_count', (SELECT count(*) FROM vehicles v WHERE v.category_id = c.id AND v.is_active AND (NOT p_is_out_of_city OR v.allows_out_of_city))
  ) ORDER BY c.display_order), '[]'::jsonb)
  FROM vehicle_categories c
  WHERE c.tenant_id = my_tenant_id() AND c.is_active AND c.id <> p_exclude_category_id
    AND c.category_group = (SELECT category_group FROM vehicle_categories WHERE id = p_exclude_category_id)
    AND (NOT p_is_out_of_city OR c.out_of_city_eligible)
    AND EXISTS (SELECT 1 FROM vehicles v WHERE v.category_id = c.id AND v.is_active AND (NOT p_is_out_of_city OR v.allows_out_of_city));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION ride_dispatch_category_options(uuid, decimal, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ride_dispatch_category_options(uuid, decimal, boolean) TO authenticated;

DROP FUNCTION IF EXISTS create_ride_dispatch_request(uuid, text, decimal, decimal, text, decimal, decimal, decimal, uuid[], boolean, timestamptz);

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

  v_is_future := p_scheduled_for IS NOT NULL AND p_scheduled_for > now();

  INSERT INTO ride_dispatch_requests (initiator_portal_user_id, category_id, category_ids, pickup_label, pickup_lat, pickup_lng, dropoff_label, dropoff_lat, dropoff_lng, distance_km, fare_pkr, scheduled_for, is_out_of_city)
  VALUES (v_portal_user_id, p_category_id, v_category_ids, p_pickup_label, p_pickup_lat, p_pickup_lng, p_dropoff_label, p_dropoff_lat, p_dropoff_lng, p_distance_km,
    round(v_category.base_fare_pkr + v_category.per_km_pkr * p_distance_km), CASE WHEN v_is_future THEN p_scheduled_for ELSE NULL END, v_is_out_of_city)
  RETURNING id INTO v_request_id;

  IF NOT v_is_future THEN
    PERFORM broadcast_ride_dispatch_request(v_request_id);
  END IF;

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_ride_dispatch_request(uuid, text, decimal, decimal, text, decimal, decimal, decimal, uuid[], boolean, timestamptz, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_ride_dispatch_request(uuid, text, decimal, decimal, text, decimal, decimal, decimal, uuid[], boolean, timestamptz, uuid) TO authenticated;

-- Broadcast now excludes any vehicle that can't do out-of-station work
-- (category-level AND per-vehicle, same precedence everywhere else
-- already uses) whenever the request itself is out-of-city.
CREATE OR REPLACE FUNCTION broadcast_ride_dispatch_request(p_request_id uuid) RETURNS void AS $$
DECLARE
  r ride_dispatch_requests%ROWTYPE; v_category vehicle_categories%ROWTYPE; v_own_tenant uuid;
  v_own_active_count int; v_partner_tenant_id uuid; v_partner_category_id uuid;
BEGIN
  SELECT * INTO r FROM ride_dispatch_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'open' OR r.activated_at IS NOT NULL THEN RETURN; END IF;

  SELECT * INTO v_category FROM vehicle_categories WHERE id = r.category_id;
  SELECT tenant_id INTO v_own_tenant FROM portal_users WHERE id = r.initiator_portal_user_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'ride_dispatch_requested', vc.emoji || ' ' || vc.name || ' ride requested',
    r.pickup_label || ' → ' || r.dropoff_label, '/portal/marketplace/ride-dispatch/' || r.id
  FROM vehicles v JOIN vehicle_categories vc ON vc.id = v.category_id
  WHERE v.category_id = ANY(r.category_ids) AND v.is_active AND v.tenant_id = v_own_tenant AND v.portal_user_id IS NOT NULL
    AND (NOT r.is_out_of_city OR v.allows_out_of_city);

  SELECT count(*) INTO v_own_active_count FROM vehicles
  WHERE category_id = ANY(r.category_ids) AND is_active AND tenant_id = v_own_tenant AND (NOT r.is_out_of_city OR allows_out_of_city);

  IF v_own_active_count = 0 AND array_length(r.category_ids, 1) = 1 THEN
    SELECT t.id, vc2.id INTO v_partner_tenant_id, v_partner_category_id
    FROM marketplace_share_agreements sa
    JOIN tenants t ON t.id = sa.owner_tenant_id
    JOIN vehicle_categories vc2 ON vc2.tenant_id = t.id AND vc2.key = v_category.key AND vc2.is_active
      AND (NOT r.is_out_of_city OR vc2.out_of_city_eligible)
    LEFT JOIN tenant_service_zones z ON z.tenant_id = t.id AND z.zone_kind = 'village' AND z.is_active
    WHERE sa.target_tenant_id = v_own_tenant AND sa.category = 'ride_dispatch' AND sa.is_active
      AND EXISTS (SELECT 1 FROM vehicles vv WHERE vv.category_id = vc2.id AND vv.is_active AND (NOT r.is_out_of_city OR vv.allows_out_of_city))
    ORDER BY (z.center_lat IS NULL), haversine_km(COALESCE(z.center_lat, r.pickup_lat), COALESCE(z.center_lng, r.pickup_lng), r.pickup_lat, r.pickup_lng)
    LIMIT 1;

    IF v_partner_tenant_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      SELECT v.portal_user_id, 'ride_dispatch_requested', vc.emoji || ' ' || vc.name || ' ride requested (nearby village)',
        r.pickup_label || ' → ' || r.dropoff_label, '/portal/marketplace/ride-dispatch/' || r.id
      FROM vehicles v JOIN vehicle_categories vc ON vc.id = v.category_id
      WHERE v.category_id = v_partner_category_id AND v.is_active AND v.portal_user_id IS NOT NULL
        AND (NOT r.is_out_of_city OR v.allows_out_of_city);
    END IF;
  END IF;

  UPDATE ride_dispatch_requests SET activated_at = now() WHERE id = p_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- accept_ride_dispatch: the accepting vehicle must itself be eligible
-- for out-of-station work when the request is out-of-city — defense in
-- depth for a stale notification or a direct link, not just trusting
-- that the broadcast already filtered correctly.
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
