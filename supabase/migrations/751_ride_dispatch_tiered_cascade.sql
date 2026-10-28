-- Migration 751: the real tiered ride-dispatch cascade discussed
-- 2026-10-28, now that tenant_service_zones (750) exists to answer
-- "is this vehicle actually in the city right now, or still at home in
-- the village" for real instead of guessing from is_online alone.
--
-- Order of preference, exactly as discussed:
--   1. Own village, a vehicle of the requested category ONLINE and
--      physically inside the tenant's own city zone right now (fresh
--      within 30 minutes — set_vehicle_online_status already captures
--      a fix on going online; the client-side 30-min refresh ping is
--      the other half of this, not a DB change) — one-way fare.
--   2. Own village, no one matched tier 1 — any ACTIVE vehicle of that
--      category gets notified anyway (today's only fallback, kept) —
--      two-way fare, since whoever accepts has to drive out from the
--      village to the pickup point first.
--   3. Own village has NO active vehicle of that category at all — a
--      neighbouring tenant with an active marketplace_share_agreements
--      row (category='ride_dispatch') gets rung instead, same two
--      tiers run again against THEIR fleet.
--   4. Nothing anywhere for this exact category — the caller is
--      expected to fall back to ride_dispatch_category_options() and
--      let the rider pick a different vehicle TYPE from their own
--      village instead (the checkbox-list idea).
--
-- Key simplification that keeps this tractable: who gets NOTIFIED and
-- what fare actually gets CHARGED are decoupled. Every active vehicle
-- of the matched category (own village, or the one neighbouring
-- village picked) gets the request — accept_ride_dispatch works out
-- the real one-way-vs-two-way fare from the ACCEPTING vehicle's own
-- live situation at the moment they accept, not from whatever tier the
-- quote preview guessed. ride_dispatch_quote is a preview for the
-- rider before they send the request, nothing more.

-- ── Cross-tenant opt-in for ride_dispatch specifically ──────────────
-- 667 deliberately made every category opt-in, admin-approved one at a
-- time. ride_dispatch is the one exception the user explicitly asked
-- for: every new tenant starts shared with every existing one (both
-- directions), and the admin turns off whichever neighbour they don't
-- trust — opt-OUT instead of opt-in, for this category only.
ALTER TABLE marketplace_share_agreements DROP CONSTRAINT IF EXISTS marketplace_share_agreements_category_check;
ALTER TABLE marketplace_share_agreements ADD CONSTRAINT marketplace_share_agreements_category_check
  CHECK (category IN ('hourly', 'shadi', 'rental', 'machinery', 'tractor', 'loader', 'ride_dispatch'));

-- Backfill: every existing active tenant pair, both directions.
INSERT INTO marketplace_share_agreements (owner_tenant_id, category, target_tenant_id, is_active)
SELECT a.id, 'ride_dispatch', b.id, true
FROM tenants a CROSS JOIN tenants b
WHERE a.id <> b.id AND a.is_active AND b.is_active
ON CONFLICT (owner_tenant_id, category, target_tenant_id) DO NOTHING;

CREATE OR REPLACE FUNCTION auto_share_ride_dispatch_with_new_tenant() RETURNS trigger AS $$
BEGIN
  INSERT INTO marketplace_share_agreements (owner_tenant_id, category, target_tenant_id, is_active)
  SELECT NEW.id, 'ride_dispatch', t.id, true FROM tenants t WHERE t.id <> NEW.id AND t.is_active
  ON CONFLICT (owner_tenant_id, category, target_tenant_id) DO NOTHING;
  INSERT INTO marketplace_share_agreements (owner_tenant_id, category, target_tenant_id, is_active)
  SELECT t.id, 'ride_dispatch', NEW.id, true FROM tenants t WHERE t.id <> NEW.id AND t.is_active
  ON CONFLICT (owner_tenant_id, category, target_tenant_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS auto_share_ride_dispatch_on_tenant_insert ON tenants;
CREATE TRIGGER auto_share_ride_dispatch_on_tenant_insert AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION auto_share_ride_dispatch_with_new_tenant();

-- ── ride_dispatch_requests: multi-category fan-out + what actually matched ──
ALTER TABLE ride_dispatch_requests ADD COLUMN IF NOT EXISTS category_ids uuid[] NOT NULL DEFAULT '{}';
UPDATE ride_dispatch_requests SET category_ids = ARRAY[category_id] WHERE category_ids = '{}';
ALTER TABLE ride_dispatch_requests ADD COLUMN IF NOT EXISTS matched_tenant_id uuid REFERENCES tenants(id);
ALTER TABLE ride_dispatch_requests ADD COLUMN IF NOT EXISTS tier_used varchar;

-- ── The preview shown before the rider sends the request ───────────
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

  SELECT count(*) INTO v_online_in_city FROM vehicles v
  WHERE v.category_id = p_category_id AND v.is_active AND v.is_online AND v.current_lat IS NOT NULL
    AND v.current_location_updated_at > now() - interval '30 minutes'
    AND point_in_tenant_zone(v.current_lat, v.current_lng, v_own_tenant, 'city');

  SELECT count(*) INTO v_active_total FROM vehicles v WHERE v.category_id = p_category_id AND v.is_active;

  v_base_fare := round(v_category.base_fare_pkr + v_category.per_km_pkr * p_distance_km);

  SELECT center_lat, center_lng INTO v_village_lat, v_village_lng
  FROM tenant_service_zones WHERE tenant_id = v_own_tenant AND zone_kind = 'village' AND is_active LIMIT 1;
  IF v_village_lat IS NULL THEN
    -- legacy fallback until this tenant has actually drawn its own zone (750)
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
REVOKE ALL ON FUNCTION ride_dispatch_quote(uuid, decimal, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ride_dispatch_quote(uuid, decimal, decimal, decimal) TO authenticated;

-- Other vehicle TYPES still active in the rider's own village, for the
-- "nothing anywhere for this exact category" checkbox fallback —
-- deliberately own-village only, cross-tenant + multi-category
-- combined is more than this needs to solve in one go.
CREATE OR REPLACE FUNCTION ride_dispatch_category_options(p_exclude_category_id uuid, p_distance_km decimal) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'name', c.name, 'name_ur', c.name_ur, 'emoji', c.emoji,
    'fare_pkr', round(c.base_fare_pkr + c.per_km_pkr * p_distance_km),
    'active_count', (SELECT count(*) FROM vehicles v WHERE v.category_id = c.id AND v.is_active)
  ) ORDER BY c.display_order), '[]'::jsonb)
  FROM vehicle_categories c
  WHERE c.tenant_id = my_tenant_id() AND c.is_active AND c.id <> p_exclude_category_id
    AND EXISTS (SELECT 1 FROM vehicles v WHERE v.category_id = c.id AND v.is_active);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION ride_dispatch_category_options(uuid, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ride_dispatch_category_options(uuid, decimal) TO authenticated;

DROP FUNCTION IF EXISTS create_ride_dispatch_request(uuid, text, decimal, decimal, text, decimal, decimal, decimal, boolean);

CREATE OR REPLACE FUNCTION create_ride_dispatch_request(
  p_category_id uuid, p_pickup_label text, p_pickup_lat decimal, p_pickup_lng decimal,
  p_dropoff_label text, p_dropoff_lat decimal, p_dropoff_lng decimal, p_distance_km decimal,
  p_category_ids uuid[] DEFAULT NULL, p_include_cross_tenant boolean DEFAULT true
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_own_tenant uuid; v_category vehicle_categories%ROWTYPE;
  v_category_ids uuid[] := COALESCE(p_category_ids, ARRAY[p_category_id]);
  v_request_id uuid; v_own_active_count int;
  v_partner_tenant_id uuid; v_partner_category_id uuid;
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

  INSERT INTO ride_dispatch_requests (initiator_portal_user_id, category_id, category_ids, pickup_label, pickup_lat, pickup_lng, dropoff_label, dropoff_lat, dropoff_lng, distance_km, fare_pkr)
  VALUES (v_portal_user_id, p_category_id, v_category_ids, p_pickup_label, p_pickup_lat, p_pickup_lng, p_dropoff_label, p_dropoff_lat, p_dropoff_lng, p_distance_km,
    round(v_category.base_fare_pkr + v_category.per_km_pkr * p_distance_km))
  RETURNING id INTO v_request_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'ride_dispatch_requested', vc.emoji || ' ' || vc.name || ' ride requested',
    p_pickup_label || ' → ' || p_dropoff_label, '/portal/marketplace/ride-dispatch/' || v_request_id
  FROM vehicles v JOIN vehicle_categories vc ON vc.id = v.category_id
  WHERE v.category_id = ANY(v_category_ids) AND v.is_active AND v.tenant_id = v_own_tenant AND v.portal_user_id IS NOT NULL;

  SELECT count(*) INTO v_own_active_count FROM vehicles WHERE category_id = ANY(v_category_ids) AND is_active AND tenant_id = v_own_tenant;

  -- Cross-tenant only for the focused single-category ask (not the
  -- multi-category checkbox fallback) and only when the own village
  -- truly has nothing of this type at all.
  IF v_own_active_count = 0 AND p_include_cross_tenant AND array_length(v_category_ids, 1) = 1 THEN
    SELECT t.id, vc2.id INTO v_partner_tenant_id, v_partner_category_id
    FROM marketplace_share_agreements sa
    JOIN tenants t ON t.id = sa.owner_tenant_id
    JOIN vehicle_categories vc2 ON vc2.tenant_id = t.id AND vc2.key = v_category.key AND vc2.is_active
    LEFT JOIN tenant_service_zones z ON z.tenant_id = t.id AND z.zone_kind = 'village' AND z.is_active
    WHERE sa.target_tenant_id = v_own_tenant AND sa.category = 'ride_dispatch' AND sa.is_active
      AND EXISTS (SELECT 1 FROM vehicles vv WHERE vv.category_id = vc2.id AND vv.is_active)
    ORDER BY (z.center_lat IS NULL), haversine_km(COALESCE(z.center_lat, p_pickup_lat), COALESCE(z.center_lng, p_pickup_lng), p_pickup_lat, p_pickup_lng)
    LIMIT 1;

    IF v_partner_tenant_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      SELECT v.portal_user_id, 'ride_dispatch_requested', vc.emoji || ' ' || vc.name || ' ride requested (nearby village)',
        p_pickup_label || ' → ' || p_dropoff_label, '/portal/marketplace/ride-dispatch/' || v_request_id
      FROM vehicles v JOIN vehicle_categories vc ON vc.id = v.category_id
      WHERE v.category_id = v_partner_category_id AND v.is_active AND v.portal_user_id IS NOT NULL;
    END IF;
  END IF;

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_ride_dispatch_request(uuid, text, decimal, decimal, text, decimal, decimal, decimal, uuid[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_ride_dispatch_request(uuid, text, decimal, decimal, text, decimal, decimal, decimal, uuid[], boolean) TO authenticated;

CREATE OR REPLACE FUNCTION ride_dispatch_request_detail(p_request_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'status', r.status, 'pickup_label', r.pickup_label, 'dropoff_label', r.dropoff_label,
    'pickup_lat', r.pickup_lat, 'pickup_lng', r.pickup_lng, 'dropoff_lat', r.dropoff_lat, 'dropoff_lng', r.dropoff_lng,
    'distance_km', r.distance_km, 'fare_pkr', r.fare_pkr, 'created_at', r.created_at,
    'category_name', c.name, 'category_name_ur', c.name_ur, 'category_emoji', c.emoji,
    'is_mine_as_rider', r.initiator_portal_user_id = current_portal_user_id(),
    'trip_offer_id', r.trip_offer_id, 'tier_used', r.tier_used, 'matched_tenant_name', mt.name
  )
  FROM ride_dispatch_requests r
  JOIN vehicle_categories c ON c.id = r.category_id
  LEFT JOIN tenants mt ON mt.id = r.matched_tenant_id
  WHERE r.id = p_request_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION ride_dispatch_request_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ride_dispatch_request_detail(uuid) TO authenticated;

-- Accepting resolves the REAL fare from the accepting vehicle's own
-- live situation — one-way if it's genuinely in-city right now,
-- two-way (from ITS OWN tenant's village zone, which is what makes
-- cross-tenant acceptance price correctly too) otherwise. Replaces the
-- exact-category-match-only lookup with one that also allows a
-- cross-tenant vehicle whose category KEY matches, gated by the same
-- active share agreement create_ride_dispatch_request already checked.
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
    AND point_in_tenant_zone(v.current_lat, v.current_lng, v.tenant_id, 'city');

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
REVOKE ALL ON FUNCTION accept_ride_dispatch(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_ride_dispatch(uuid) TO authenticated;
