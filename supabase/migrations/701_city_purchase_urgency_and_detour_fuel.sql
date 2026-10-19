-- Migration 701: Phase 3 of the vehicle-marketplace rebuild, part 1/2 —
-- City Purchase urgency tiers + driver tier-exclusivity + a detour-fuel
-- surcharge for a pickup point far from the city's own reference point.
-- Real ask: "he can select any time, within 1 hour, two hours, urgent
-- etc... if he chosen one product with urgent and now he cant choose
-- the product with 1 hour wait, if he selected 1 hour then he will get
-- all the 1 hour calls only" — and separately: "if the purchasing point
-- is far from the drive[r's] destination then the system will
-- calculate the fuel charges on that location and return to the
-- vehicle['s] destination."

ALTER TABLE city_purchase_requests ADD COLUMN IF NOT EXISTS urgency varchar NOT NULL DEFAULT 'standard' CHECK (urgency IN ('standard', '1hr', '2hr', 'urgent'));
ALTER TABLE city_purchase_requests ADD COLUMN IF NOT EXISTS detour_fuel_pkr decimal;

-- Same pattern as the existing addon min/max keys (495): one row for
-- the one tenant that currently seeds site_settings at all — every
-- reader already falls back to a literal default via COALESCE when a
-- tenant has no row, so this isn't a gap the way the fare_bands one was.
INSERT INTO site_settings (key, value, description) VALUES
  ('city_purchase_detour_free_km', '2', 'How many km a City Purchase pickup point can sit from the city''s own reference point before a detour-fuel surcharge kicks in')
ON CONFLICT (tenant_id, key) DO NOTHING;

-- Derived purely from existing city_purchase_requests rows — no new
-- sticky state on vehicles to keep in sync. A vehicle is "committed" to
-- a tier while it has any request accepted-but-not-yet-finished in that
-- tier; NULL means free to take any tier.
CREATE OR REPLACE FUNCTION vehicle_committed_urgency_tier(p_vehicle_id uuid)
RETURNS varchar
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $function$
  SELECT urgency FROM city_purchase_requests
  WHERE accepted_vehicle_id = p_vehicle_id AND status NOT IN ('delivered', 'completed', 'cancelled', 'no_answer')
  LIMIT 1;
$function$;
REVOKE ALL ON FUNCTION vehicle_committed_urgency_tier(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_committed_urgency_tier(uuid) TO authenticated;

-- city_purchase_candidate_vehicles / city_purchase_candidates gain a
-- trailing p_urgency param — adding it creates a new overload rather
-- than replacing in place, so the prior 3-arg signatures are dropped.
DROP FUNCTION IF EXISTS city_purchase_candidate_vehicles(uuid, decimal, decimal);
DROP FUNCTION IF EXISTS city_purchase_candidates(uuid, decimal, decimal);

CREATE OR REPLACE FUNCTION city_purchase_candidate_vehicles(p_city_id uuid, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL, p_urgency varchar DEFAULT NULL)
RETURNS TABLE(vehicle_id uuid, source varchar, reference_destination text, distance_km decimal, trust_score int, trust_tier varchar) AS $$
  WITH ci AS (SELECT * FROM cities WHERE id = p_city_id),
  today AS (SELECT (now() AT TIME ZONE 'Asia/Karachi')::date AS d),
  floor_score AS (SELECT COALESCE((SELECT value::int FROM site_settings WHERE key = 'vehicle_trust_floor_score'), 15) AS v),
  candidates AS (
    SELECT v.id AS vehicle_id, 'route'::varchar AS source,
      (r.destination || CASE WHEN r.destination_ur IS NOT NULL THEN ' / ' || r.destination_ur ELSE '' END) AS reference_destination,
      CASE WHEN p_pickup_lat IS NOT NULL AND r.destination_lat IS NOT NULL THEN haversine_km(p_pickup_lat, p_pickup_lng, r.destination_lat, r.destination_lng) END AS distance_km,
      1 AS priority
    FROM vehicle_routes r JOIN vehicles v ON v.id = r.vehicle_id, ci, today, floor_score
    WHERE r.is_active AND v.is_active AND v.is_online AND vehicle_delivery_eligible(v.id) AND vehicle_trust_score(v.id) >= floor_score.v
      AND (r.destination ILIKE '%' || ci.name || '%' OR (ci.name_ur IS NOT NULL AND r.destination_ur ILIKE '%' || ci.name_ur || '%'))
      AND (r.days_of_week && ARRAY[extract(dow FROM today.d)::int, extract(dow FROM today.d + 1)::int])
      AND (p_urgency IS NULL OR vehicle_committed_urgency_tier(v.id) IS NULL OR vehicle_committed_urgency_tier(v.id) = p_urgency)
    UNION ALL
    SELECT v.id, 'trip_offer',
      (o.destination || CASE WHEN o.destination_ur IS NOT NULL THEN ' / ' || o.destination_ur ELSE '' END),
      CASE WHEN p_pickup_lat IS NOT NULL AND o.dest_lat IS NOT NULL THEN haversine_km(p_pickup_lat, p_pickup_lng, o.dest_lat, o.dest_lng) END,
      1
    FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id, ci, today, floor_score
    WHERE o.status = 'open' AND v.is_active AND v.is_online AND vehicle_delivery_eligible(v.id) AND vehicle_trust_score(v.id) >= floor_score.v
      AND o.travel_date BETWEEN today.d AND today.d + 1
      AND (o.destination ILIKE '%' || ci.name || '%' OR (ci.name_ur IS NOT NULL AND o.destination_ur ILIKE '%' || ci.name_ur || '%'))
      AND (p_urgency IS NULL OR vehicle_committed_urgency_tier(v.id) IS NULL OR vehicle_committed_urgency_tier(v.id) = p_urgency)
    UNION ALL
    SELECT v.id, 'presence', NULL, NULL, 2
    FROM vehicle_city_presence p JOIN vehicles v ON v.id = p.vehicle_id, floor_score
    WHERE p.city_id = p_city_id AND p.is_active AND v.is_active AND v.is_online AND vehicle_delivery_eligible(v.id) AND vehicle_trust_score(v.id) >= floor_score.v
      AND (p_urgency IS NULL OR vehicle_committed_urgency_tier(v.id) IS NULL OR vehicle_committed_urgency_tier(v.id) = p_urgency)
  )
  SELECT DISTINCT ON (c.vehicle_id) c.vehicle_id, c.source, c.reference_destination, c.distance_km,
    vehicle_trust_score(c.vehicle_id), (vehicle_trust(c.vehicle_id)->>'tier')::varchar
  FROM candidates c
  ORDER BY c.vehicle_id, c.priority;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION city_purchase_candidate_vehicles(uuid, decimal, decimal, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_purchase_candidate_vehicles(uuid, decimal, decimal, varchar) TO authenticated;

CREATE OR REPLACE FUNCTION city_purchase_candidates(p_city_id uuid, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL, p_urgency varchar DEFAULT NULL) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'vehicle_id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type,
    'source', c.source, 'reference_destination', c.reference_destination, 'distance_km', c.distance_km,
    'trust_score', c.trust_score, 'trust_tier', c.trust_tier
  ) ORDER BY c.trust_score DESC, c.distance_km NULLS LAST, c.source, v.owner_name), '[]'::jsonb)
  FROM city_purchase_candidate_vehicles(p_city_id, p_pickup_lat, p_pickup_lng, p_urgency) c JOIN vehicles v ON v.id = c.vehicle_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION city_purchase_candidates(uuid, decimal, decimal, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_purchase_candidates(uuid, decimal, decimal, varchar) TO authenticated;

-- create_city_purchase_request gains p_urgency (trailing, defaulted) —
-- same overload-duplication risk, drop the prior 8-arg signature first.
DROP FUNCTION IF EXISTS create_city_purchase_request(uuid, text, text, text, decimal, decimal, decimal, uuid);

CREATE OR REPLACE FUNCTION create_city_purchase_request(
  p_city_id uuid, p_item text, p_item_attachment_path text DEFAULT NULL,
  p_pickup_label text DEFAULT NULL, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL,
  p_goods_budget_pkr decimal DEFAULT 0, p_target_vehicle_id uuid DEFAULT NULL, p_urgency varchar DEFAULT 'standard'
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id(); v_request_id uuid; v_count int;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_item IS NULL OR trim(p_item) = '' THEN RAISE EXCEPTION 'Describe what you need first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cities WHERE id = p_city_id AND is_active) THEN RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001'; END IF;
  IF p_goods_budget_pkr IS NULL OR p_goods_budget_pkr < 0 THEN RAISE EXCEPTION 'Enter a valid amount, or 0 if unsure.' USING ERRCODE = 'P0001'; END IF;
  IF p_urgency NOT IN ('standard', '1hr', '2hr', 'urgent') THEN RAISE EXCEPTION 'Invalid urgency.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO city_purchase_requests (initiator_portal_user_id, city_id, item, item_attachment_path, pickup_label, pickup_lat, pickup_lng, goods_budget_pkr, status, urgency)
  VALUES (v_portal_user_id, p_city_id, trim(p_item), NULLIF(p_item_attachment_path, ''), NULLIF(p_pickup_label, ''), p_pickup_lat, p_pickup_lng, p_goods_budget_pkr, 'ringing', p_urgency)
  RETURNING id INTO v_request_id;

  IF p_target_vehicle_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_target_vehicle_id AND is_active AND is_online AND vehicle_delivery_eligible(id)) THEN
      RAISE EXCEPTION 'That vehicle is not available right now.' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination)
    SELECT v_request_id, c.vehicle_id, c.source, c.reference_destination
    FROM city_purchase_candidate_vehicles(p_city_id, p_pickup_lat, p_pickup_lng, p_urgency) c WHERE c.vehicle_id = p_target_vehicle_id;
    IF NOT FOUND THEN
      INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination) VALUES (v_request_id, p_target_vehicle_id, 'direct', NULL);
    END IF;
  ELSE
    INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination)
    SELECT v_request_id, c.vehicle_id, c.source, c.reference_destination FROM city_purchase_candidate_vehicles(p_city_id, p_pickup_lat, p_pickup_lng, p_urgency) c;
  END IF;

  SELECT count(*) INTO v_count FROM city_purchase_invitations WHERE request_id = v_request_id;
  IF v_count = 0 THEN
    UPDATE city_purchase_requests SET status = 'no_answer' WHERE id = v_request_id;
  ELSE
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT v.portal_user_id, 'city_purchase_invited', 'City purchase request', p_item, '/portal/marketplace/city-purchase/' || v_request_id
    FROM city_purchase_invitations i JOIN vehicles v ON v.id = i.vehicle_id WHERE i.request_id = v_request_id AND v.portal_user_id IS NOT NULL;
  END IF;

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_city_purchase_request(uuid, text, text, text, decimal, decimal, decimal, uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_city_purchase_request(uuid, text, text, text, decimal, decimal, decimal, uuid, varchar) TO authenticated;

-- accept_city_purchase_request: same signature (no new params needed —
-- tier-exclusivity and detour-fuel are both derived, not driver-typed).
-- Defense-in-depth tier check (candidate matching already keeps a
-- committed driver from being invited cross-tier, but a direct invite
-- or a stale invitation could still reach here), plus the detour-fuel
-- line item added into total_fare_pkr.
CREATE OR REPLACE FUNCTION accept_city_purchase_request(p_request_id uuid, p_vehicle_id uuid, p_addon_fee_pkr decimal) RETURNS jsonb AS $$
DECLARE
  v vehicles%ROWTYPE; r city_purchase_requests%ROWTYPE; ci cities%ROWTYPE;
  v_addon_min decimal; v_addon_max decimal; v_leg_fare decimal; v_distance_fare decimal;
  v_committed_tier varchar; v_detour_free_km decimal; v_detour_fuel decimal := 0;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND OR v.portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF v.per_km_pkr IS NULL THEN
    RAISE EXCEPTION 'Your per-km rate has not been set yet — ask the committee to set it before accepting jobs.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(value::decimal, 100) INTO v_addon_min FROM site_settings WHERE key = 'city_purchase_addon_min_pkr';
  SELECT COALESCE(value::decimal, 1000) INTO v_addon_max FROM site_settings WHERE key = 'city_purchase_addon_max_pkr';
  IF p_addon_fee_pkr IS NULL OR p_addon_fee_pkr < v_addon_min OR p_addon_fee_pkr > v_addon_max THEN
    RAISE EXCEPTION 'Your service fee must be between % and %.', v_addon_min, v_addon_max USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO r FROM city_purchase_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  IF r.status <> 'ringing' THEN RAISE EXCEPTION 'This request is no longer open.' USING ERRCODE = 'P0001'; END IF;

  v_committed_tier := vehicle_committed_urgency_tier(p_vehicle_id);
  IF v_committed_tier IS NOT NULL AND v_committed_tier <> r.urgency THEN
    RAISE EXCEPTION 'You are committed to % deliveries right now — finish those before accepting a different urgency tier.', v_committed_tier USING ERRCODE = 'P0001';
  END IF;

  UPDATE city_purchase_invitations SET status = 'accepted', responded_at = now()
    WHERE request_id = p_request_id AND vehicle_id = p_vehicle_id AND status = 'ringing';
  IF NOT FOUND THEN RAISE EXCEPTION 'You were not invited to this request, or someone else already accepted it.' USING ERRCODE = 'P0001'; END IF;

  -- First accept wins — every other still-ringing invitation closes out.
  UPDATE city_purchase_invitations SET status = 'expired', responded_at = now()
    WHERE request_id = p_request_id AND vehicle_id <> p_vehicle_id AND status = 'ringing';

  SELECT * INTO ci FROM cities WHERE id = r.city_id;
  v_leg_fare := round_to_10(ci.distance_km * v.per_km_pkr);
  v_distance_fare := v_leg_fare * 2;

  IF r.pickup_lat IS NOT NULL AND r.pickup_lng IS NOT NULL AND ci.lat IS NOT NULL AND ci.lng IS NOT NULL THEN
    SELECT COALESCE(value::decimal, 2) INTO v_detour_free_km FROM site_settings WHERE key = 'city_purchase_detour_free_km';
    v_detour_fuel := round_to_10(GREATEST(0, haversine_km(r.pickup_lat, r.pickup_lng, ci.lat, ci.lng) - v_detour_free_km) * v.per_km_pkr);
  END IF;

  UPDATE city_purchase_requests SET
    status = 'priced', accepted_vehicle_id = p_vehicle_id,
    distance_fare_pkr = v_distance_fare, addon_fee_pkr = p_addon_fee_pkr, detour_fuel_pkr = v_detour_fuel,
    total_fare_pkr = v_distance_fare + p_addon_fee_pkr + v_detour_fuel
  WHERE id = p_request_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (r.initiator_portal_user_id, 'city_purchase_accepted', 'City purchase accepted', v.owner_name || ' — Rs ' || (v_distance_fare + p_addon_fee_pkr + v_detour_fuel)::text, '/portal/marketplace/city-purchase/' || p_request_id);

  RETURN city_purchase_request_detail(p_request_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- city_purchase_request_detail: surface urgency + detour_fuel_pkr.
CREATE OR REPLACE FUNCTION city_purchase_request_detail(p_request_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'request', jsonb_build_object(
      'id', r.id, 'item', r.item, 'has_item_attachment', (r.item_attachment_path IS NOT NULL), 'pickup_label', r.pickup_label,
      'pickup_lat', r.pickup_lat, 'pickup_lng', r.pickup_lng, 'goods_budget_pkr', r.goods_budget_pkr, 'status', r.status,
      'urgency', r.urgency,
      'distance_fare_pkr', r.distance_fare_pkr, 'addon_fee_pkr', r.addon_fee_pkr, 'detour_fuel_pkr', r.detour_fuel_pkr, 'total_fare_pkr', r.total_fare_pkr,
      'actual_goods_cost_pkr', r.actual_goods_cost_pkr, 'has_bill_attachment', (r.bill_attachment_path IS NOT NULL),
      'city_name', ci.name, 'city_name_ur', ci.name_ur, 'city_km', ci.distance_km,
      'accepted_vehicle_id', av.id, 'accepted_owner_name', av.owner_name, 'accepted_owner_mobile', av.owner_mobile, 'accepted_vehicle_type', av.vehicle_type,
      'initiator_portal_user_id', r.initiator_portal_user_id,
      'created_at', r.created_at
    ),
    'invitations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'vehicle_id', v.id, 'owner_name', v.owner_name, 'source', i.source, 'reference_destination', i.reference_destination,
        'status', i.status, 'invited_at', i.invited_at, 'responded_at', i.responded_at
      ) ORDER BY i.invited_at)
      FROM city_purchase_invitations i JOIN vehicles v ON v.id = i.vehicle_id WHERE i.request_id = r.id
    ), '[]'::jsonb)
  )
  FROM city_purchase_requests r
  JOIN cities ci ON ci.id = r.city_id
  LEFT JOIN vehicles av ON av.id = r.accepted_vehicle_id
  WHERE r.id = p_request_id AND is_party_to_city_purchase(r.id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- my_city_purchase_requests / my_city_purchase_invitations: surface
-- urgency so the rider's own list and the driver's incoming-invitation
-- list both show it.
CREATE OR REPLACE FUNCTION my_city_purchase_requests() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'item', r.item, 'status', r.status, 'urgency', r.urgency, 'total_fare_pkr', r.total_fare_pkr, 'created_at', r.created_at,
    'city_name', ci.name, 'city_name_ur', ci.name_ur,
    'as_role', CASE WHEN r.initiator_portal_user_id = current_portal_user_id() THEN 'user' ELSE 'driver' END
  ) ORDER BY r.created_at DESC), '[]'::jsonb)
  FROM city_purchase_requests r JOIN cities ci ON ci.id = r.city_id
  WHERE r.initiator_portal_user_id = current_portal_user_id()
     OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = r.accepted_vehicle_id AND v.portal_user_id = current_portal_user_id());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION my_city_purchase_invitations(p_vehicle_id uuid) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'request_id', r.id, 'item', r.item, 'goods_budget_pkr', r.goods_budget_pkr, 'pickup_label', r.pickup_label, 'urgency', r.urgency,
    'source', i.source, 'reference_destination', i.reference_destination, 'city_name', ci.name, 'city_name_ur', ci.name_ur, 'invited_at', i.invited_at
  ) ORDER BY i.invited_at), '[]'::jsonb)
  FROM city_purchase_invitations i
  JOIN city_purchase_requests r ON r.id = i.request_id
  JOIN cities ci ON ci.id = r.city_id
  WHERE i.vehicle_id = p_vehicle_id AND i.status = 'ringing' AND r.status = 'ringing'
    AND EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
