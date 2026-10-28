-- Migration 759: real ask, 2026-10-28 — "rider can schedule the ride."
-- A request for 3 hours from now can't broadcast to whoever happens to
-- be online RIGHT now — the whole tiered cascade (751) is a live,
-- current-moment read of who's online and nearby. So a scheduled
-- request is created immediately (locks in the rider's one-open-
-- request slot, same as today) but doesn't broadcast at all until its
-- own scheduled time arrives — a cron sweep activates it then, re-
-- running the exact same own-village-then-cross-tenant broadcast logic
-- create_ride_dispatch_request already had, factored out so both paths
-- share one real implementation instead of two copies that could drift.
--
-- The 20-minute auto-expiry (748) now counts from activation, not
-- creation — a request scheduled for tomorrow sitting unactivated
-- tonight must never expire before it even got its chance to ring
-- anyone.

ALTER TABLE ride_dispatch_requests ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;
ALTER TABLE ride_dispatch_requests ADD COLUMN IF NOT EXISTS activated_at timestamptz;

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
  WHERE v.category_id = ANY(r.category_ids) AND v.is_active AND v.tenant_id = v_own_tenant AND v.portal_user_id IS NOT NULL;

  SELECT count(*) INTO v_own_active_count FROM vehicles WHERE category_id = ANY(r.category_ids) AND is_active AND tenant_id = v_own_tenant;

  IF v_own_active_count = 0 AND array_length(r.category_ids, 1) = 1 THEN
    SELECT t.id, vc2.id INTO v_partner_tenant_id, v_partner_category_id
    FROM marketplace_share_agreements sa
    JOIN tenants t ON t.id = sa.owner_tenant_id
    JOIN vehicle_categories vc2 ON vc2.tenant_id = t.id AND vc2.key = v_category.key AND vc2.is_active
    LEFT JOIN tenant_service_zones z ON z.tenant_id = t.id AND z.zone_kind = 'village' AND z.is_active
    WHERE sa.target_tenant_id = v_own_tenant AND sa.category = 'ride_dispatch' AND sa.is_active
      AND EXISTS (SELECT 1 FROM vehicles vv WHERE vv.category_id = vc2.id AND vv.is_active)
    ORDER BY (z.center_lat IS NULL), haversine_km(COALESCE(z.center_lat, r.pickup_lat), COALESCE(z.center_lng, r.pickup_lng), r.pickup_lat, r.pickup_lng)
    LIMIT 1;

    IF v_partner_tenant_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      SELECT v.portal_user_id, 'ride_dispatch_requested', vc.emoji || ' ' || vc.name || ' ride requested (nearby village)',
        r.pickup_label || ' → ' || r.dropoff_label, '/portal/marketplace/ride-dispatch/' || r.id
      FROM vehicles v JOIN vehicle_categories vc ON vc.id = v.category_id
      WHERE v.category_id = v_partner_category_id AND v.is_active AND v.portal_user_id IS NOT NULL;
    END IF;
  END IF;

  UPDATE ride_dispatch_requests SET activated_at = now() WHERE id = p_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS create_ride_dispatch_request(uuid, text, decimal, decimal, text, decimal, decimal, decimal, uuid[], boolean);

CREATE OR REPLACE FUNCTION create_ride_dispatch_request(
  p_category_id uuid, p_pickup_label text, p_pickup_lat decimal, p_pickup_lng decimal,
  p_dropoff_label text, p_dropoff_lat decimal, p_dropoff_lng decimal, p_distance_km decimal,
  p_category_ids uuid[] DEFAULT NULL, p_include_cross_tenant boolean DEFAULT true, p_scheduled_for timestamptz DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_own_tenant uuid; v_category vehicle_categories%ROWTYPE;
  v_category_ids uuid[] := COALESCE(p_category_ids, ARRAY[p_category_id]);
  v_request_id uuid; v_is_future boolean;
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

  v_is_future := p_scheduled_for IS NOT NULL AND p_scheduled_for > now();

  INSERT INTO ride_dispatch_requests (initiator_portal_user_id, category_id, category_ids, pickup_label, pickup_lat, pickup_lng, dropoff_label, dropoff_lat, dropoff_lng, distance_km, fare_pkr, scheduled_for)
  VALUES (v_portal_user_id, p_category_id, v_category_ids, p_pickup_label, p_pickup_lat, p_pickup_lng, p_dropoff_label, p_dropoff_lat, p_dropoff_lng, p_distance_km,
    round(v_category.base_fare_pkr + v_category.per_km_pkr * p_distance_km), CASE WHEN v_is_future THEN p_scheduled_for ELSE NULL END)
  RETURNING id INTO v_request_id;

  IF NOT v_is_future THEN
    PERFORM broadcast_ride_dispatch_request(v_request_id);
  END IF;

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_ride_dispatch_request(uuid, text, decimal, decimal, text, decimal, decimal, decimal, uuid[], boolean, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_ride_dispatch_request(uuid, text, decimal, decimal, text, decimal, decimal, decimal, uuid[], boolean, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION activate_scheduled_ride_dispatch_requests() RETURNS void AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM ride_dispatch_requests WHERE status = 'open' AND activated_at IS NULL AND scheduled_for IS NOT NULL AND scheduled_for <= now()
  LOOP
    PERFORM broadcast_ride_dispatch_request(r.id);
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION activate_scheduled_ride_dispatch_requests() FROM PUBLIC, anon;

SELECT cron.schedule('activate-scheduled-ride-dispatch-requests', '* * * * *', $$SELECT activate_scheduled_ride_dispatch_requests()$$);

-- Only an activated request's clock can run out -- a still-scheduled
-- one hasn't rung anyone yet, so there's nothing to time out.
CREATE OR REPLACE FUNCTION expire_stale_ride_dispatch_requests() RETURNS void AS $$
  UPDATE ride_dispatch_requests SET status = 'expired'
  WHERE status = 'open' AND activated_at IS NOT NULL AND activated_at < now() - interval '20 minutes';
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION ride_dispatch_request_detail(p_request_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'status', r.status, 'pickup_label', r.pickup_label, 'dropoff_label', r.dropoff_label,
    'pickup_lat', r.pickup_lat, 'pickup_lng', r.pickup_lng, 'dropoff_lat', r.dropoff_lat, 'dropoff_lng', r.dropoff_lng,
    'distance_km', r.distance_km, 'fare_pkr', r.fare_pkr, 'reference_village_fare_pkr', r.reference_village_fare_pkr, 'created_at', r.created_at,
    'category_name', c.name, 'category_name_ur', c.name_ur, 'category_emoji', c.emoji,
    'is_mine_as_rider', r.initiator_portal_user_id = current_portal_user_id(),
    'trip_offer_id', r.trip_offer_id, 'tier_used', r.tier_used, 'matched_tenant_name', mt.name,
    'rider_trust', portal_user_trust(r.initiator_portal_user_id), 'rider_tenant_name', rt.name,
    'scheduled_for', r.scheduled_for, 'activated_at', r.activated_at
  )
  FROM ride_dispatch_requests r
  JOIN vehicle_categories c ON c.id = r.category_id
  JOIN portal_users ipu ON ipu.id = r.initiator_portal_user_id
  JOIN tenants rt ON rt.id = ipu.tenant_id
  LEFT JOIN tenants mt ON mt.id = r.matched_tenant_id
  WHERE r.id = p_request_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
