-- Real ask, 2026-10-26: "check the existing screen its ugly and using
-- two maps inside it which is absolutely garbage and wrong, implement
-- these screens instead. completely copy the design." The reference
-- design's own city-purchase ("Purchase for Me") screen asks for a real
-- pickup (shop) AND a real delivery (home) location with one shared map
-- between them, a date/time, a city/out-of-city area toggle, a bike/car
-- ride-type toggle (bike disabled for out-of-city per direct
-- instruction), an upfront tip, and a formulaic fee (area base fee +
-- per-km fuel) shown before sending — none of which city_purchase_
-- requests had a column for. The existing candidate-discovery/trust-
-- score/urgency-tier system (495/701/705/710) is untouched — it's
-- genuinely more capable than the reference's own demo and the driver
-- side already depends on it; this only adds the rider-facing fields
-- the create screen needs and an upfront fee *estimate* so the rider
-- sees a real number before sending, same as the reference does.
ALTER TABLE city_purchase_requests ADD COLUMN IF NOT EXISTS delivery_label text;
ALTER TABLE city_purchase_requests ADD COLUMN IF NOT EXISTS delivery_lat decimal;
ALTER TABLE city_purchase_requests ADD COLUMN IF NOT EXISTS delivery_lng decimal;
ALTER TABLE city_purchase_requests ADD COLUMN IF NOT EXISTS area varchar NOT NULL DEFAULT 'city' CHECK (area IN ('city', 'out_of_city'));
ALTER TABLE city_purchase_requests ADD COLUMN IF NOT EXISTS ride_type varchar NOT NULL DEFAULT 'bike' CHECK (ride_type IN ('bike', 'car'));
ALTER TABLE city_purchase_requests ADD COLUMN IF NOT EXISTS scheduled_date date;
ALTER TABLE city_purchase_requests ADD COLUMN IF NOT EXISTS scheduled_time time;
ALTER TABLE city_purchase_requests ADD COLUMN IF NOT EXISTS tip_pkr decimal NOT NULL DEFAULT 0 CHECK (tip_pkr >= 0);
ALTER TABLE city_purchase_requests ADD COLUMN IF NOT EXISTS payment_method varchar DEFAULT 'cash' CHECK (payment_method IN ('cash', 'jazzcash', 'easypaisa'));
ALTER TABLE city_purchase_requests ADD COLUMN IF NOT EXISTS estimated_fee_pkr decimal;

-- Same honesty convention as migration 420's own comment (these are the
-- reference design's own placeholder numbers where it showed one —
-- Rs 300 city base fee, Rs 8/km fuel — and an invented-but-labeled
-- placeholder for out-of-city, which the reference screens never
-- actually showed a number for): not claimed real committee-approved
-- rates, admin-editable via site_settings like every other fare knob.
INSERT INTO site_settings (key, value, description) VALUES
  ('city_purchase_base_fee_city', '300', 'City Purchase: fixed service fee for an in-city (home city) delivery'),
  ('city_purchase_base_fee_outstation', '600', 'City Purchase: fixed service fee for an out-of-city delivery'),
  ('city_purchase_fuel_per_km_pkr', '8', 'City Purchase: fuel surcharge per km between pickup and delivery points')
ON CONFLICT (tenant_id, key) DO NOTHING;

CREATE OR REPLACE FUNCTION city_purchase_fee_estimate(p_distance_km decimal, p_area varchar, p_tip_pkr decimal DEFAULT 0) RETURNS jsonb AS $$
DECLARE
  v_base decimal; v_per_km decimal; v_fuel decimal; v_base_key varchar;
BEGIN
  IF p_area NOT IN ('city', 'out_of_city') THEN RAISE EXCEPTION 'Invalid area.' USING ERRCODE = 'P0001'; END IF;
  v_base_key := CASE WHEN p_area = 'out_of_city' THEN 'city_purchase_base_fee_outstation' ELSE 'city_purchase_base_fee_city' END;
  SELECT COALESCE((SELECT value::decimal FROM site_settings WHERE key = v_base_key), CASE WHEN p_area = 'out_of_city' THEN 600 ELSE 300 END) INTO v_base;
  SELECT COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'city_purchase_fuel_per_km_pkr'), 8) INTO v_per_km;
  v_fuel := round(GREATEST(COALESCE(p_distance_km, 0), 0) * v_per_km);
  RETURN jsonb_build_object('base_fee_pkr', v_base, 'fuel_fee_pkr', v_fuel, 'tip_pkr', GREATEST(COALESCE(p_tip_pkr, 0), 0), 'total_fee_pkr', v_base + v_fuel + GREATEST(COALESCE(p_tip_pkr, 0), 0));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION city_purchase_fee_estimate(decimal, varchar, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_purchase_fee_estimate(decimal, varchar, decimal) TO authenticated;

DROP FUNCTION IF EXISTS create_city_purchase_request(uuid, text, text, text, decimal, decimal, decimal, uuid, varchar);

CREATE OR REPLACE FUNCTION create_city_purchase_request(
  p_city_id uuid, p_item text, p_item_attachment_path text DEFAULT NULL,
  p_pickup_label text DEFAULT NULL, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL,
  p_goods_budget_pkr decimal DEFAULT 0, p_target_vehicle_id uuid DEFAULT NULL, p_urgency varchar DEFAULT 'standard',
  p_delivery_label text DEFAULT NULL, p_delivery_lat decimal DEFAULT NULL, p_delivery_lng decimal DEFAULT NULL,
  p_area varchar DEFAULT 'city', p_ride_type varchar DEFAULT 'bike',
  p_scheduled_date date DEFAULT NULL, p_scheduled_time time DEFAULT NULL,
  p_tip_pkr decimal DEFAULT 0, p_payment_method varchar DEFAULT 'cash'
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id(); v_request_id uuid; v_count int; v_distance_km decimal; v_estimate jsonb;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_item IS NULL OR trim(p_item) = '' THEN RAISE EXCEPTION 'Describe what you need first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cities WHERE id = p_city_id AND is_active) THEN RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001'; END IF;
  IF p_goods_budget_pkr IS NULL OR p_goods_budget_pkr < 0 THEN RAISE EXCEPTION 'Enter a valid amount, or 0 if unsure.' USING ERRCODE = 'P0001'; END IF;
  IF p_urgency NOT IN ('standard', '1hr', '2hr', 'urgent') THEN RAISE EXCEPTION 'Invalid urgency.' USING ERRCODE = 'P0001'; END IF;
  IF p_area NOT IN ('city', 'out_of_city') THEN RAISE EXCEPTION 'Invalid area.' USING ERRCODE = 'P0001'; END IF;
  IF p_ride_type NOT IN ('bike', 'car') THEN RAISE EXCEPTION 'Invalid ride type.' USING ERRCODE = 'P0001'; END IF;
  -- Real ask, direct instruction: a motorbike stays disabled (not just
  -- in the UI) for an out-of-city delivery — enforced here too, not
  -- just a client-side toggle a modified request could skip.
  IF p_area = 'out_of_city' AND p_ride_type = 'bike' THEN RAISE EXCEPTION 'A motorbike is not available for an out-of-city delivery — choose a car.' USING ERRCODE = 'P0001'; END IF;
  IF p_scheduled_date IS NULL THEN RAISE EXCEPTION 'Pick a date for this job.' USING ERRCODE = 'P0001'; END IF;
  IF p_target_vehicle_id IS NOT NULL AND EXISTS (SELECT 1 FROM vehicles WHERE id = p_target_vehicle_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You cannot request your own vehicle.' USING ERRCODE = 'P0001';
  END IF;

  IF p_pickup_lat IS NOT NULL AND p_delivery_lat IS NOT NULL THEN
    v_distance_km := haversine_km(p_pickup_lat, p_pickup_lng, p_delivery_lat, p_delivery_lng);
  END IF;
  v_estimate := city_purchase_fee_estimate(v_distance_km, p_area, p_tip_pkr);

  INSERT INTO city_purchase_requests (
    initiator_portal_user_id, city_id, item, item_attachment_path, pickup_label, pickup_lat, pickup_lng, goods_budget_pkr, status, urgency,
    delivery_label, delivery_lat, delivery_lng, area, ride_type, scheduled_date, scheduled_time, tip_pkr, payment_method, estimated_fee_pkr
  )
  VALUES (
    v_portal_user_id, p_city_id, trim(p_item), NULLIF(p_item_attachment_path, ''), NULLIF(p_pickup_label, ''), p_pickup_lat, p_pickup_lng, p_goods_budget_pkr, 'ringing', p_urgency,
    NULLIF(p_delivery_label, ''), p_delivery_lat, p_delivery_lng, p_area, p_ride_type, p_scheduled_date, p_scheduled_time, GREATEST(COALESCE(p_tip_pkr, 0), 0), COALESCE(p_payment_method, 'cash'),
    (v_estimate->>'total_fee_pkr')::decimal
  )
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
    FROM city_purchase_candidate_vehicles(p_city_id, p_pickup_lat, p_pickup_lng, p_urgency, v_portal_user_id) c WHERE c.vehicle_id = p_target_vehicle_id;
    IF NOT FOUND THEN
      INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination) VALUES (v_request_id, p_target_vehicle_id, 'direct', NULL);
    END IF;
  ELSE
    INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination)
    SELECT v_request_id, c.vehicle_id, c.source, c.reference_destination FROM city_purchase_candidate_vehicles(p_city_id, p_pickup_lat, p_pickup_lng, p_urgency, v_portal_user_id) c;
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
REVOKE ALL ON FUNCTION create_city_purchase_request(uuid, text, text, text, decimal, decimal, decimal, uuid, varchar, text, decimal, decimal, varchar, varchar, date, time, decimal, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_city_purchase_request(uuid, text, text, text, decimal, decimal, decimal, uuid, varchar, text, decimal, decimal, varchar, varchar, date, time, decimal, varchar) TO authenticated;

-- my_city_purchase_requests: surface the new fields (builds its rows
-- field-by-field, so these need adding explicitly or they'd never
-- reach the rider's own list/detail view).
CREATE OR REPLACE FUNCTION my_city_purchase_requests() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'item', r.item, 'status', r.status, 'urgency', r.urgency, 'total_fare_pkr', r.total_fare_pkr, 'estimated_fee_pkr', r.estimated_fee_pkr, 'created_at', r.created_at,
    'city_name', ci.name, 'city_name_ur', ci.name_ur,
    'pickup_label', r.pickup_label, 'pickup_lat', r.pickup_lat, 'pickup_lng', r.pickup_lng,
    'delivery_label', r.delivery_label, 'delivery_lat', r.delivery_lat, 'delivery_lng', r.delivery_lng,
    'area', r.area, 'ride_type', r.ride_type, 'scheduled_date', r.scheduled_date, 'scheduled_time', r.scheduled_time,
    'tip_pkr', r.tip_pkr, 'payment_method', r.payment_method, 'goods_budget_pkr', r.goods_budget_pkr,
    'as_role', CASE WHEN r.initiator_portal_user_id = current_portal_user_id() THEN 'user' ELSE 'driver' END
  ) ORDER BY r.created_at DESC), '[]'::jsonb)
  FROM city_purchase_requests r JOIN cities ci ON ci.id = r.city_id
  WHERE r.initiator_portal_user_id = current_portal_user_id()
     OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = r.accepted_vehicle_id AND v.portal_user_id = current_portal_user_id());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_city_purchase_requests() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_city_purchase_requests() TO authenticated;
