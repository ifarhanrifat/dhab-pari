-- Migration 705: Phase 5 follow-up feedback, part 1/2 — "there is no
-- way to fix the delivery for intercity and out of city for a cataogry
-- of the vehicals... if we select any car or only biker can work for
-- delivery purpose inside the home city... for the outstation city if
-- we select only car[s]... then only the cars will get the delivery
-- notifications no other category will see the delivery calls."
--
-- service_classes.delivery_eligible (494) is a single flag today — no
-- distinction between a home-city job and an outstation one.
-- vehicle_delivery_eligible() grandfathers a vehicle with no assigned
-- class as eligible, else eligible if ANY assigned class has the flag.
-- Same shape, split into two columns + a classification-aware sibling
-- function, wired into the actual matching/invitation call sites —
-- cities.is_home_city (429/494) is already the real "home city vs
-- outstation" signal, no new classification concept needed.

ALTER TABLE service_classes ADD COLUMN IF NOT EXISTS home_city_delivery_eligible boolean NOT NULL DEFAULT true;
ALTER TABLE service_classes ADD COLUMN IF NOT EXISTS outstation_delivery_eligible boolean NOT NULL DEFAULT true;
UPDATE service_classes SET home_city_delivery_eligible = delivery_eligible, outstation_delivery_eligible = delivery_eligible;

CREATE OR REPLACE FUNCTION vehicle_delivery_eligible_for(p_vehicle_id uuid, p_is_home_city boolean) RETURNS boolean AS $$
  SELECT NOT EXISTS (SELECT 1 FROM vehicle_service_offers WHERE vehicle_id = p_vehicle_id AND is_active)
    OR EXISTS (
      SELECT 1 FROM vehicle_service_offers o JOIN service_classes sc ON sc.id = o.service_class_id
      WHERE o.vehicle_id = p_vehicle_id AND o.is_active
        AND (CASE WHEN p_is_home_city THEN sc.home_city_delivery_eligible ELSE sc.outstation_delivery_eligible END)
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_delivery_eligible_for(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_delivery_eligible_for(uuid, boolean) TO authenticated;

-- invite_dispatch_tier (579): already computes v_city_is_home, just swap the check.
create or replace function public.invite_dispatch_tier(p_call_id uuid, p_tier integer)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_city_id uuid; v_city_is_home boolean; v_count int; v_floor int;
BEGIN
  SELECT COALESCE(value::int, 15) INTO v_floor FROM site_settings WHERE key = 'vehicle_trust_floor_score' AND tenant_id = my_tenant_id();
  SELECT s.city_id, ci.is_home_city INTO v_city_id, v_city_is_home
  FROM dispatch_calls c JOIN city_shops s ON s.id = c.city_shop_id JOIN cities ci ON ci.id = s.city_id
  WHERE c.id = p_call_id AND c.tenant_id = my_tenant_id();

  INSERT INTO dispatch_invitations (call_id, vehicle_id, tier)
  SELECT p_call_id, v.id, p_tier
  FROM vehicles v
  WHERE v.tenant_id = my_tenant_id() AND v.is_active AND v.delivers AND v.is_online AND vehicle_delivery_eligible_for(v.id, v_city_is_home)
    AND vehicle_trust_score(v.id) >= COALESCE(v_floor, 15)
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
$function$;

-- city_purchase_candidate_vehicles (701): add ci.is_home_city to each
-- branch's eligibility check (ci CTE already selects the full cities row).
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
    WHERE r.is_active AND v.is_active AND v.is_online AND vehicle_delivery_eligible_for(v.id, ci.is_home_city) AND vehicle_trust_score(v.id) >= floor_score.v
      AND (r.destination ILIKE '%' || ci.name || '%' OR (ci.name_ur IS NOT NULL AND r.destination_ur ILIKE '%' || ci.name_ur || '%'))
      AND (r.days_of_week && ARRAY[extract(dow FROM today.d)::int, extract(dow FROM today.d + 1)::int])
      AND (p_urgency IS NULL OR vehicle_committed_urgency_tier(v.id) IS NULL OR vehicle_committed_urgency_tier(v.id) = p_urgency)
    UNION ALL
    SELECT v.id, 'trip_offer',
      (o.destination || CASE WHEN o.destination_ur IS NOT NULL THEN ' / ' || o.destination_ur ELSE '' END),
      CASE WHEN p_pickup_lat IS NOT NULL AND o.dest_lat IS NOT NULL THEN haversine_km(p_pickup_lat, p_pickup_lng, o.dest_lat, o.dest_lng) END,
      1
    FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id, ci, today, floor_score
    WHERE o.status = 'open' AND v.is_active AND v.is_online AND vehicle_delivery_eligible_for(v.id, ci.is_home_city) AND vehicle_trust_score(v.id) >= floor_score.v
      AND o.travel_date BETWEEN today.d AND today.d + 1
      AND (o.destination ILIKE '%' || ci.name || '%' OR (ci.name_ur IS NOT NULL AND o.destination_ur ILIKE '%' || ci.name_ur || '%'))
      AND (p_urgency IS NULL OR vehicle_committed_urgency_tier(v.id) IS NULL OR vehicle_committed_urgency_tier(v.id) = p_urgency)
    UNION ALL
    SELECT v.id, 'presence', NULL, NULL, 2
    FROM vehicle_city_presence p JOIN vehicles v ON v.id = p.vehicle_id, ci, floor_score
    WHERE p.city_id = p_city_id AND p.is_active AND v.is_active AND v.is_online AND vehicle_delivery_eligible_for(v.id, ci.is_home_city) AND vehicle_trust_score(v.id) >= floor_score.v
      AND (p_urgency IS NULL OR vehicle_committed_urgency_tier(v.id) IS NULL OR vehicle_committed_urgency_tier(v.id) = p_urgency)
  )
  SELECT DISTINCT ON (c.vehicle_id) c.vehicle_id, c.source, c.reference_destination, c.distance_km,
    vehicle_trust_score(c.vehicle_id), (vehicle_trust(c.vehicle_id)->>'tier')::varchar
  FROM candidates c
  ORDER BY c.vehicle_id, c.priority;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- create_city_purchase_request (701): target-vehicle direct-invite check
-- now also requires the right category for this city's home/outstation status.
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
    IF NOT EXISTS (
      SELECT 1 FROM vehicles v JOIN cities ci ON ci.id = p_city_id
      WHERE v.id = p_target_vehicle_id AND v.is_active AND v.is_online AND vehicle_delivery_eligible_for(v.id, ci.is_home_city)
    ) THEN
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

-- create_parcel_delivery (702): same target-vehicle fix.
CREATE OR REPLACE FUNCTION create_parcel_delivery(
  p_city_id uuid, p_description text,
  p_pickup_label text DEFAULT NULL, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL,
  p_dropoff_label text DEFAULT NULL, p_dropoff_lat decimal DEFAULT NULL, p_dropoff_lng decimal DEFAULT NULL,
  p_recipient_name varchar DEFAULT NULL, p_recipient_mobile varchar DEFAULT NULL, p_target_vehicle_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id(); v_delivery_id uuid; v_count int;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_description IS NULL OR trim(p_description) = '' THEN RAISE EXCEPTION 'Describe the parcel first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cities WHERE id = p_city_id AND is_active) THEN RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO parcel_deliveries (initiator_portal_user_id, city_id, description, recipient_name, recipient_mobile, pickup_label, pickup_lat, pickup_lng, dropoff_label, dropoff_lat, dropoff_lng, status)
  VALUES (v_portal_user_id, p_city_id, trim(p_description), NULLIF(p_recipient_name, ''), NULLIF(p_recipient_mobile, ''), NULLIF(p_pickup_label, ''), p_pickup_lat, p_pickup_lng, NULLIF(p_dropoff_label, ''), p_dropoff_lat, p_dropoff_lng, 'ringing')
  RETURNING id INTO v_delivery_id;

  IF p_target_vehicle_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM vehicles v JOIN cities ci ON ci.id = p_city_id
      WHERE v.id = p_target_vehicle_id AND v.is_active AND v.is_online AND vehicle_delivery_eligible_for(v.id, ci.is_home_city)
    ) THEN
      RAISE EXCEPTION 'That vehicle is not available right now.' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO parcel_delivery_invitations (delivery_id, vehicle_id, source, reference_destination)
    SELECT v_delivery_id, c.vehicle_id, c.source, c.reference_destination
    FROM city_purchase_candidate_vehicles(p_city_id, p_pickup_lat, p_pickup_lng) c WHERE c.vehicle_id = p_target_vehicle_id;
    IF NOT FOUND THEN
      INSERT INTO parcel_delivery_invitations (delivery_id, vehicle_id, source, reference_destination) VALUES (v_delivery_id, p_target_vehicle_id, 'direct', NULL);
    END IF;
  ELSE
    INSERT INTO parcel_delivery_invitations (delivery_id, vehicle_id, source, reference_destination)
    SELECT v_delivery_id, c.vehicle_id, c.source, c.reference_destination FROM city_purchase_candidate_vehicles(p_city_id, p_pickup_lat, p_pickup_lng) c;
  END IF;

  SELECT count(*) INTO v_count FROM parcel_delivery_invitations WHERE delivery_id = v_delivery_id;
  IF v_count = 0 THEN
    UPDATE parcel_deliveries SET status = 'no_answer' WHERE id = v_delivery_id;
  ELSE
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT v.portal_user_id, 'parcel_delivery_invited', 'Parcel delivery request', p_description, '/portal/marketplace/parcel/' || v_delivery_id
    FROM parcel_delivery_invitations i JOIN vehicles v ON v.id = i.vehicle_id WHERE i.delivery_id = v_delivery_id AND v.portal_user_id IS NOT NULL;
  END IF;

  RETURN v_delivery_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
