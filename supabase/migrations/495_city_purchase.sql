-- Migration 495: City Purchase — a new feature, deliberately separate
-- from the existing City Fetch (negotiation_threads kind='fetch').
--
-- Design conversation with the user settled on: City Fetch stays exactly
-- as it is today (a quick chat + agreed fee for "carry this thing back
-- for me" — no purchase happening, nothing to reconcile). This is for
-- the heavier, genuinely different job: "buy this specific thing for me
-- from a specific place" — a real purchase-on-behalf task with a photo/
-- prescription attachment, a candidate list of vehicles already in or
-- heading to that city (so the villager can see WHERE each one is
-- actually going and either message one directly or ask everyone at
-- once), a fare split into an objective distance-based component and a
-- capped driver add-on fee, and a real purchase → bill → deliver →
-- confirm pipeline (not just a price agreement with nothing after it).
--
-- Reuses two things that already exist rather than inventing a third
-- broadcast/status system from scratch:
--   - The dispatch_calls (423/430) ring→price→approve→complete shape —
--     this table/RPC set mirrors it closely, with two real additions:
--     a driver-settable add-on fee (dispatch's fare is pure formula,
--     no driver input) and a genuine two-sided close (dispatch lets the
--     driver alone mark "completed"; here the driver marks delivered
--     and the villager separately confirms received).
--   - migration 494's vehicle_delivery_eligible/is_online gates — a
--     vehicle only shows up as a candidate, and only stays invited, if
--     it's actually allowed to do delivery work and is currently
--     accepting new jobs.
--
-- Distance/fare model: this deliberately does NOT try to compute a real
-- driver-to-pickup-spot road distance — neither vehicle_trip_offers,
-- vehicle_routes, nor vehicle_city_presence carry real coordinates for
-- "where in the city is this vehicle headed," and this codebase has a
-- consistent habit of not faking precision it doesn't have (cities.
-- distance_km is itself an admin-corrected estimate, not GPS-measured).
-- So the fare is computed exactly like dispatch already does — the
-- vehicle's own per_km_pkr against the known village↔city distance,
-- round trip — plus a driver-set add-on fee capped by two new
-- site_settings. The candidate list's destination text (from a trip
-- offer or scheduled route) is shown for the villager's own judgment of
-- "is this one going near where I need," not fed into the price.

-- ── Storage: item photo/prescription + purchase bill photo ─────────────
INSERT INTO storage.buckets (id, name, public) VALUES ('city_purchase_attachments', 'city_purchase_attachments', false)
ON CONFLICT (id) DO NOTHING;
CREATE POLICY "Portal users can upload their own city purchase attachments" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'city_purchase_attachments' AND auth.role() = 'authenticated');
CREATE POLICY "Authenticated can read city purchase attachments" ON storage.objects FOR SELECT
  USING (bucket_id = 'city_purchase_attachments' AND auth.role() = 'authenticated');
CREATE POLICY "Admin can delete city purchase attachments" ON storage.objects FOR DELETE
  USING (bucket_id = 'city_purchase_attachments' AND current_admin_permission('manage_parties'));

-- ── The two admin-set add-on caps the user asked for ("100 to 1000") ──
INSERT INTO site_settings (key, value, description) VALUES
  ('city_purchase_addon_min_pkr', '100', 'Minimum service fee a driver can add on top of the computed distance fare for a City Purchase job'),
  ('city_purchase_addon_max_pkr', '1000', 'Maximum service fee a driver can add on top of the computed distance fare for a City Purchase job')
ON CONFLICT (key) DO NOTHING;

-- ── Tables ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS city_purchase_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  initiator_portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  city_id uuid NOT NULL REFERENCES cities(id),
  item text NOT NULL,
  item_attachment_path text,
  pickup_label text,
  pickup_lat decimal, pickup_lng decimal,
  goods_budget_pkr decimal NOT NULL DEFAULT 0 CHECK (goods_budget_pkr >= 0),
  status varchar NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing', 'no_answer', 'priced', 'approved', 'purchased', 'delivered', 'completed', 'cancelled')),
  accepted_vehicle_id uuid REFERENCES vehicles(id),
  distance_fare_pkr decimal,
  addon_fee_pkr decimal,
  total_fare_pkr decimal,
  actual_goods_cost_pkr decimal,
  bill_attachment_path text,
  approved_at timestamptz, purchased_at timestamptz, delivered_at timestamptz, completed_at timestamptz, cancelled_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS city_purchase_requests_initiator_idx ON city_purchase_requests(initiator_portal_user_id);

CREATE TABLE IF NOT EXISTS city_purchase_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES city_purchase_requests(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  -- Which of the three discovery sources suggested this vehicle (or
  -- 'direct' when the villager messaged a specific vehicle that wasn't
  -- necessarily on the discovery list at all).
  source varchar NOT NULL CHECK (source IN ('presence', 'trip_offer', 'route', 'direct')),
  reference_destination text,
  status varchar NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing', 'declined', 'accepted', 'expired')),
  invited_at timestamptz DEFAULT now(), responded_at timestamptz,
  UNIQUE (request_id, vehicle_id)
);
CREATE INDEX IF NOT EXISTS city_purchase_invitations_request_idx ON city_purchase_invitations(request_id);
CREATE INDEX IF NOT EXISTS city_purchase_invitations_vehicle_idx ON city_purchase_invitations(vehicle_id) WHERE status = 'ringing';

CREATE OR REPLACE FUNCTION is_party_to_city_purchase(p_request_id uuid) RETURNS boolean AS $$
  SELECT COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (
    SELECT 1 FROM city_purchase_requests r WHERE r.id = p_request_id AND r.initiator_portal_user_id = current_portal_user_id()
  ) OR EXISTS (
    SELECT 1 FROM city_purchase_invitations i JOIN vehicles v ON v.id = i.vehicle_id
    WHERE i.request_id = p_request_id AND v.portal_user_id = current_portal_user_id()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

ALTER TABLE city_purchase_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "city_purchase_requests_parties_read" ON city_purchase_requests FOR SELECT TO authenticated USING (is_party_to_city_purchase(id));

ALTER TABLE city_purchase_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "city_purchase_invitations_parties_read" ON city_purchase_invitations FOR SELECT TO authenticated USING (is_party_to_city_purchase(request_id));
-- Writes only ever happen through the SECURITY DEFINER RPCs below —
-- same convention as dispatch_calls/dispatch_invitations (423).

-- ── Candidate discovery (shared by the read-only browse RPC and the
-- actual invite-on-create step, so they can never drift apart) ────────
-- Text-matches a trip/route's free-text destination against the target
-- city's name — vehicle_trip_offers and vehicle_routes were never given
-- a structured city_id link (both predate the cities reference table),
-- so this is a best-effort match, not a guaranteed one; it only affects
-- which destination hint is SHOWN, every candidate still goes through
-- the same delivery-eligibility/online gate regardless of match quality.
CREATE OR REPLACE FUNCTION city_purchase_candidate_vehicles(p_city_id uuid)
RETURNS TABLE(vehicle_id uuid, source varchar, reference_destination text) AS $$
  WITH ci AS (SELECT * FROM cities WHERE id = p_city_id),
  today AS (SELECT (now() AT TIME ZONE 'Asia/Karachi')::date AS d),
  candidates AS (
    SELECT v.id AS vehicle_id, 'route'::varchar AS source,
      (r.destination || CASE WHEN r.destination_ur IS NOT NULL THEN ' / ' || r.destination_ur ELSE '' END) AS reference_destination, 1 AS priority
    FROM vehicle_routes r JOIN vehicles v ON v.id = r.vehicle_id, ci, today
    WHERE r.is_active AND v.is_active AND v.is_online AND vehicle_delivery_eligible(v.id)
      AND (r.destination ILIKE '%' || ci.name || '%' OR (ci.name_ur IS NOT NULL AND r.destination_ur ILIKE '%' || ci.name_ur || '%'))
      AND (r.days_of_week && ARRAY[extract(dow FROM today.d)::int, extract(dow FROM today.d + 1)::int])
    UNION ALL
    SELECT v.id, 'trip_offer',
      (o.destination || CASE WHEN o.destination_ur IS NOT NULL THEN ' / ' || o.destination_ur ELSE '' END), 1
    FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id, ci, today
    WHERE o.status = 'open' AND v.is_active AND v.is_online AND vehicle_delivery_eligible(v.id)
      AND o.travel_date BETWEEN today.d AND today.d + 1
      AND (o.destination ILIKE '%' || ci.name || '%' OR (ci.name_ur IS NOT NULL AND o.destination_ur ILIKE '%' || ci.name_ur || '%'))
    UNION ALL
    SELECT v.id, 'presence', NULL, 2
    FROM vehicle_city_presence p JOIN vehicles v ON v.id = p.vehicle_id
    WHERE p.city_id = p_city_id AND p.is_active AND v.is_active AND v.is_online AND vehicle_delivery_eligible(v.id)
  )
  SELECT DISTINCT ON (vehicle_id) vehicle_id, source, reference_destination
  FROM candidates
  ORDER BY vehicle_id, priority;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION city_purchase_candidate_vehicles(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_purchase_candidate_vehicles(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION city_purchase_candidates(p_city_id uuid) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'vehicle_id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type,
    'source', c.source, 'reference_destination', c.reference_destination
  ) ORDER BY c.source, v.owner_name), '[]'::jsonb)
  FROM city_purchase_candidate_vehicles(p_city_id) c JOIN vehicles v ON v.id = c.vehicle_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION city_purchase_candidates(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_purchase_candidates(uuid) TO authenticated;

-- ── Create + invite (either "ask everyone" or "message this one") ─────
CREATE OR REPLACE FUNCTION create_city_purchase_request(
  p_city_id uuid, p_item text, p_item_attachment_path text DEFAULT NULL,
  p_pickup_label text DEFAULT NULL, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL,
  p_goods_budget_pkr decimal DEFAULT 0, p_target_vehicle_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id(); v_request_id uuid; v_count int;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_item IS NULL OR trim(p_item) = '' THEN RAISE EXCEPTION 'Describe what you need first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cities WHERE id = p_city_id AND is_active) THEN RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001'; END IF;
  IF p_goods_budget_pkr IS NULL OR p_goods_budget_pkr < 0 THEN RAISE EXCEPTION 'Enter a valid amount, or 0 if unsure.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO city_purchase_requests (initiator_portal_user_id, city_id, item, item_attachment_path, pickup_label, pickup_lat, pickup_lng, goods_budget_pkr, status)
  VALUES (v_portal_user_id, p_city_id, trim(p_item), NULLIF(p_item_attachment_path, ''), NULLIF(p_pickup_label, ''), p_pickup_lat, p_pickup_lng, p_goods_budget_pkr, 'ringing')
  RETURNING id INTO v_request_id;

  IF p_target_vehicle_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_target_vehicle_id AND is_active AND is_online AND vehicle_delivery_eligible(id)) THEN
      RAISE EXCEPTION 'That vehicle is not available right now.' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination)
    SELECT v_request_id, c.vehicle_id, c.source, c.reference_destination
    FROM city_purchase_candidate_vehicles(p_city_id) c WHERE c.vehicle_id = p_target_vehicle_id;
    -- Not one of the discovery candidates (e.g. the villager already
    -- knows this driver personally) — a direct ask doesn't require
    -- having shown up on the list first.
    IF NOT FOUND THEN
      INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination) VALUES (v_request_id, p_target_vehicle_id, 'direct', NULL);
    END IF;
  ELSE
    INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination)
    SELECT v_request_id, c.vehicle_id, c.source, c.reference_destination FROM city_purchase_candidate_vehicles(p_city_id) c;
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
REVOKE ALL ON FUNCTION create_city_purchase_request(uuid, text, text, text, decimal, decimal, decimal, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_city_purchase_request(uuid, text, text, text, decimal, decimal, decimal, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION decline_city_purchase_invitation(p_request_id uuid, p_vehicle_id uuid) RETURNS void AS $$
DECLARE v_remaining int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE city_purchase_invitations SET status = 'declined', responded_at = now()
    WHERE request_id = p_request_id AND vehicle_id = p_vehicle_id AND status = 'ringing';
  IF NOT FOUND THEN RAISE EXCEPTION 'This invitation is no longer pending.' USING ERRCODE = 'P0001'; END IF;

  SELECT count(*) INTO v_remaining FROM city_purchase_invitations WHERE request_id = p_request_id AND status = 'ringing';
  IF v_remaining = 0 THEN
    UPDATE city_purchase_requests SET status = 'no_answer' WHERE id = p_request_id AND status = 'ringing';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION decline_city_purchase_invitation(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION decline_city_purchase_invitation(uuid, uuid) TO authenticated;

-- ── Accept: computes the objective distance fare automatically, driver
-- adds their own capped fee, first-to-accept wins exactly like dispatch.
CREATE OR REPLACE FUNCTION accept_city_purchase_request(p_request_id uuid, p_vehicle_id uuid, p_addon_fee_pkr decimal) RETURNS jsonb AS $$
DECLARE
  v vehicles%ROWTYPE; r city_purchase_requests%ROWTYPE; ci cities%ROWTYPE;
  v_addon_min decimal; v_addon_max decimal; v_leg_fare decimal; v_distance_fare decimal;
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

  UPDATE city_purchase_invitations SET status = 'accepted', responded_at = now()
    WHERE request_id = p_request_id AND vehicle_id = p_vehicle_id AND status = 'ringing';
  IF NOT FOUND THEN RAISE EXCEPTION 'You were not invited to this request, or someone else already accepted it.' USING ERRCODE = 'P0001'; END IF;

  -- First accept wins — every other still-ringing invitation closes out.
  UPDATE city_purchase_invitations SET status = 'expired', responded_at = now()
    WHERE request_id = p_request_id AND vehicle_id <> p_vehicle_id AND status = 'ringing';

  SELECT * INTO ci FROM cities WHERE id = r.city_id;
  v_leg_fare := round_to_10(ci.distance_km * v.per_km_pkr);
  v_distance_fare := v_leg_fare * 2;

  UPDATE city_purchase_requests SET
    status = 'priced', accepted_vehicle_id = p_vehicle_id,
    distance_fare_pkr = v_distance_fare, addon_fee_pkr = p_addon_fee_pkr, total_fare_pkr = v_distance_fare + p_addon_fee_pkr
  WHERE id = p_request_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (r.initiator_portal_user_id, 'city_purchase_accepted', 'City purchase accepted', v.owner_name || ' — Rs ' || (v_distance_fare + p_addon_fee_pkr)::text, '/portal/marketplace/city-purchase/' || p_request_id);

  RETURN city_purchase_request_detail(p_request_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION accept_city_purchase_request(uuid, uuid, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_city_purchase_request(uuid, uuid, decimal) TO authenticated;

CREATE OR REPLACE FUNCTION approve_city_purchase_price(p_request_id uuid) RETURNS void AS $$
DECLARE r city_purchase_requests%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM city_purchase_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.initiator_portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this request.' USING ERRCODE = 'P0001';
  END IF;
  IF r.status <> 'priced' THEN RAISE EXCEPTION 'There is no price waiting for approval.' USING ERRCODE = 'P0001'; END IF;
  UPDATE city_purchase_requests SET status = 'approved', approved_at = now() WHERE id = p_request_id;
  SELECT * INTO v FROM vehicles WHERE id = r.accepted_vehicle_id;
  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'city_purchase_approved', 'Price approved — go ahead and purchase', r.item, '/portal/marketplace/city-purchase/' || p_request_id);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION approve_city_purchase_price(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION approve_city_purchase_price(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION mark_city_purchase_purchased(p_request_id uuid, p_actual_goods_cost_pkr decimal, p_bill_attachment_path text DEFAULT NULL) RETURNS void AS $$
DECLARE r city_purchase_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM city_purchase_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = r.accepted_vehicle_id AND portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this job.' USING ERRCODE = 'P0001';
  END IF;
  IF r.status <> 'approved' THEN RAISE EXCEPTION 'This job is not awaiting purchase.' USING ERRCODE = 'P0001'; END IF;
  IF p_actual_goods_cost_pkr IS NULL OR p_actual_goods_cost_pkr < 0 THEN RAISE EXCEPTION 'Enter what you actually paid for the item.' USING ERRCODE = 'P0001'; END IF;

  UPDATE city_purchase_requests SET status = 'purchased', purchased_at = now(),
    actual_goods_cost_pkr = p_actual_goods_cost_pkr, bill_attachment_path = NULLIF(p_bill_attachment_path, '')
  WHERE id = p_request_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (r.initiator_portal_user_id, 'city_purchase_purchased', 'Item purchased', r.item, '/portal/marketplace/city-purchase/' || p_request_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION mark_city_purchase_purchased(uuid, decimal, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mark_city_purchase_purchased(uuid, decimal, text) TO authenticated;

CREATE OR REPLACE FUNCTION mark_city_purchase_delivered(p_request_id uuid) RETURNS void AS $$
DECLARE r city_purchase_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM city_purchase_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = r.accepted_vehicle_id AND portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this job.' USING ERRCODE = 'P0001';
  END IF;
  IF r.status <> 'purchased' THEN RAISE EXCEPTION 'This job is not awaiting delivery.' USING ERRCODE = 'P0001'; END IF;
  UPDATE city_purchase_requests SET status = 'delivered', delivered_at = now() WHERE id = p_request_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (r.initiator_portal_user_id, 'city_purchase_delivered', 'Delivered — please confirm', r.item, '/portal/marketplace/city-purchase/' || p_request_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION mark_city_purchase_delivered(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mark_city_purchase_delivered(uuid) TO authenticated;

-- The dual-confirmation close the user specifically asked for — dispatch
-- lets the driver alone mark completion; here the villager must
-- separately confirm they actually received it (and, implicitly, paid).
CREATE OR REPLACE FUNCTION confirm_city_purchase_received(p_request_id uuid) RETURNS void AS $$
DECLARE r city_purchase_requests%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM city_purchase_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.initiator_portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this request.' USING ERRCODE = 'P0001';
  END IF;
  IF r.status <> 'delivered' THEN RAISE EXCEPTION 'This request is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  UPDATE city_purchase_requests SET status = 'completed', completed_at = now() WHERE id = p_request_id;
  SELECT * INTO v FROM vehicles WHERE id = r.accepted_vehicle_id;
  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'city_purchase_completed', 'Confirmed received', r.item, '/portal/marketplace/city-purchase/' || p_request_id);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION confirm_city_purchase_received(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION confirm_city_purchase_received(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION cancel_city_purchase_request(p_request_id uuid) RETURNS void AS $$
DECLARE r city_purchase_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM city_purchase_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.initiator_portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this request.' USING ERRCODE = 'P0001';
  END IF;
  IF r.status IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'This request is already closed.' USING ERRCODE = 'P0001'; END IF;
  UPDATE city_purchase_requests SET status = 'cancelled', cancelled_at = now() WHERE id = p_request_id;
  UPDATE city_purchase_invitations SET status = 'expired', responded_at = now() WHERE request_id = p_request_id AND status = 'ringing';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION cancel_city_purchase_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancel_city_purchase_request(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION city_purchase_request_detail(p_request_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'request', jsonb_build_object(
      'id', r.id, 'item', r.item, 'has_item_attachment', (r.item_attachment_path IS NOT NULL), 'pickup_label', r.pickup_label,
      'pickup_lat', r.pickup_lat, 'pickup_lng', r.pickup_lng, 'goods_budget_pkr', r.goods_budget_pkr, 'status', r.status,
      'distance_fare_pkr', r.distance_fare_pkr, 'addon_fee_pkr', r.addon_fee_pkr, 'total_fare_pkr', r.total_fare_pkr,
      'actual_goods_cost_pkr', r.actual_goods_cost_pkr, 'has_bill_attachment', (r.bill_attachment_path IS NOT NULL),
      'city_name', ci.name, 'city_name_ur', ci.name_ur, 'city_km', ci.distance_km,
      'accepted_vehicle_id', av.id, 'accepted_owner_name', av.owner_name, 'accepted_owner_mobile', av.owner_mobile, 'accepted_vehicle_type', av.vehicle_type,
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
REVOKE ALL ON FUNCTION city_purchase_request_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_purchase_request_detail(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION city_purchase_attachment_path(p_request_id uuid, p_which varchar) RETURNS text AS $$
  SELECT CASE p_which WHEN 'item' THEN item_attachment_path WHEN 'bill' THEN bill_attachment_path ELSE NULL END
  FROM city_purchase_requests WHERE id = p_request_id AND is_party_to_city_purchase(p_request_id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION city_purchase_attachment_path(uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_purchase_attachment_path(uuid, varchar) TO authenticated;

CREATE OR REPLACE FUNCTION my_city_purchase_requests() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'item', r.item, 'status', r.status, 'total_fare_pkr', r.total_fare_pkr, 'created_at', r.created_at,
    'city_name', ci.name, 'city_name_ur', ci.name_ur,
    'as_role', CASE WHEN r.initiator_portal_user_id = current_portal_user_id() THEN 'user' ELSE 'driver' END
  ) ORDER BY r.created_at DESC), '[]'::jsonb)
  FROM city_purchase_requests r JOIN cities ci ON ci.id = r.city_id
  WHERE r.initiator_portal_user_id = current_portal_user_id()
     OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = r.accepted_vehicle_id AND v.portal_user_id = current_portal_user_id());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_city_purchase_requests() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_city_purchase_requests() TO authenticated;

CREATE OR REPLACE FUNCTION my_city_purchase_invitations(p_vehicle_id uuid) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'request_id', r.id, 'item', r.item, 'goods_budget_pkr', r.goods_budget_pkr, 'pickup_label', r.pickup_label,
    'source', i.source, 'reference_destination', i.reference_destination, 'city_name', ci.name, 'city_name_ur', ci.name_ur, 'invited_at', i.invited_at
  ) ORDER BY i.invited_at), '[]'::jsonb)
  FROM city_purchase_invitations i
  JOIN city_purchase_requests r ON r.id = i.request_id
  JOIN cities ci ON ci.id = r.city_id
  WHERE i.vehicle_id = p_vehicle_id AND i.status = 'ringing' AND r.status = 'ringing'
    AND EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_city_purchase_invitations(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_city_purchase_invitations(uuid) TO authenticated;
