-- Migration 702: Phase 3 of the vehicle-marketplace rebuild, part 2/2 —
-- Parcel Delivery, a genuinely new flow. Real ask: "a rider can collect
-- a parcel from a villager and deliver it to a city or out of city
-- destination" — distinct from City Purchase ("buy something new and
-- bring it back", 495) and from City Fetch ("carry this thing back for
-- me", a pure negotiation-chat with no tracked lifecycle). Modeled
-- directly on City Purchase's own ringing→priced→...→completed shape
-- and candidate-matching (reused verbatim, zero new eligibility logic),
-- but with no "purchase" step at all (nothing is being bought) and no
-- addon-fee concept (nothing to tip on for carrying an existing item) —
-- just the same round-trip distance fare + detour-fuel surcharge City
-- Purchase now has (701), plus a real distance-banded commission on
-- completion, which City Purchase itself never posts but dispatch
-- (complete_dispatch_call, 665) already does — reused here verbatim.

CREATE TABLE IF NOT EXISTS parcel_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  initiator_portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  city_id uuid NOT NULL REFERENCES cities(id),
  description text NOT NULL,
  recipient_name varchar,
  recipient_mobile varchar,
  pickup_label text, pickup_lat decimal, pickup_lng decimal,
  dropoff_label text, dropoff_lat decimal, dropoff_lng decimal,
  status varchar NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing', 'no_answer', 'priced', 'approved', 'picked_up', 'delivered', 'completed', 'cancelled')),
  accepted_vehicle_id uuid REFERENCES vehicles(id),
  distance_fare_pkr decimal,
  detour_fuel_pkr decimal,
  total_fare_pkr decimal,
  commission_voucher_id uuid REFERENCES vouchers(id),
  approved_at timestamptz, picked_up_at timestamptz, delivered_at timestamptz, completed_at timestamptz, cancelled_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parcel_deliveries_initiator_idx ON parcel_deliveries(initiator_portal_user_id);

CREATE TABLE IF NOT EXISTS parcel_delivery_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES parcel_deliveries(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  source varchar NOT NULL CHECK (source IN ('presence', 'trip_offer', 'route', 'direct')),
  reference_destination text,
  status varchar NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing', 'declined', 'accepted', 'expired')),
  invited_at timestamptz DEFAULT now(), responded_at timestamptz,
  UNIQUE (delivery_id, vehicle_id)
);
CREATE INDEX IF NOT EXISTS parcel_delivery_invitations_delivery_idx ON parcel_delivery_invitations(delivery_id);
CREATE INDEX IF NOT EXISTS parcel_delivery_invitations_vehicle_idx ON parcel_delivery_invitations(vehicle_id) WHERE status = 'ringing';

CREATE OR REPLACE FUNCTION is_party_to_parcel_delivery(p_delivery_id uuid) RETURNS boolean AS $$
  SELECT COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (
    SELECT 1 FROM parcel_deliveries d WHERE d.id = p_delivery_id AND d.initiator_portal_user_id = current_portal_user_id()
  ) OR EXISTS (
    SELECT 1 FROM parcel_delivery_invitations i JOIN vehicles v ON v.id = i.vehicle_id
    WHERE i.delivery_id = p_delivery_id AND v.portal_user_id = current_portal_user_id()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

ALTER TABLE parcel_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "parcel_deliveries_parties_read" ON parcel_deliveries FOR SELECT TO authenticated USING (is_party_to_parcel_delivery(id));

ALTER TABLE parcel_delivery_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "parcel_delivery_invitations_parties_read" ON parcel_delivery_invitations FOR SELECT TO authenticated USING (is_party_to_parcel_delivery(delivery_id));
-- Writes only ever happen through the SECURITY DEFINER RPCs below —
-- same convention as city_purchase_invitations/dispatch_invitations.

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
    IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_target_vehicle_id AND is_active AND is_online AND vehicle_delivery_eligible(id)) THEN
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
REVOKE ALL ON FUNCTION create_parcel_delivery(uuid, text, text, decimal, decimal, text, decimal, decimal, varchar, varchar, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_parcel_delivery(uuid, text, text, decimal, decimal, text, decimal, decimal, varchar, varchar, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION accept_parcel_delivery(p_delivery_id uuid, p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE
  v vehicles%ROWTYPE; d parcel_deliveries%ROWTYPE; ci cities%ROWTYPE;
  v_leg_fare decimal; v_distance_fare decimal; v_detour_free_km decimal; v_detour_fuel decimal := 0;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND OR v.portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF v.per_km_pkr IS NULL THEN
    RAISE EXCEPTION 'Your per-km rate has not been set yet — ask the committee to set it before accepting jobs.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO d FROM parcel_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found.' USING ERRCODE = 'P0001'; END IF;
  IF d.status <> 'ringing' THEN RAISE EXCEPTION 'This delivery is no longer open.' USING ERRCODE = 'P0001'; END IF;

  UPDATE parcel_delivery_invitations SET status = 'accepted', responded_at = now()
    WHERE delivery_id = p_delivery_id AND vehicle_id = p_vehicle_id AND status = 'ringing';
  IF NOT FOUND THEN RAISE EXCEPTION 'You were not invited to this delivery, or someone else already accepted it.' USING ERRCODE = 'P0001'; END IF;

  -- First accept wins — every other still-ringing invitation closes out.
  UPDATE parcel_delivery_invitations SET status = 'expired', responded_at = now()
    WHERE delivery_id = p_delivery_id AND vehicle_id <> p_vehicle_id AND status = 'ringing';

  SELECT * INTO ci FROM cities WHERE id = d.city_id;
  v_leg_fare := round_to_10(ci.distance_km * v.per_km_pkr);
  v_distance_fare := v_leg_fare * 2;

  IF d.pickup_lat IS NOT NULL AND d.pickup_lng IS NOT NULL AND ci.lat IS NOT NULL AND ci.lng IS NOT NULL THEN
    SELECT COALESCE(value::decimal, 2) INTO v_detour_free_km FROM site_settings WHERE key = 'city_purchase_detour_free_km';
    v_detour_fuel := round_to_10(GREATEST(0, haversine_km(d.pickup_lat, d.pickup_lng, ci.lat, ci.lng) - v_detour_free_km) * v.per_km_pkr);
  END IF;

  UPDATE parcel_deliveries SET
    status = 'priced', accepted_vehicle_id = p_vehicle_id,
    distance_fare_pkr = v_distance_fare, detour_fuel_pkr = v_detour_fuel, total_fare_pkr = v_distance_fare + v_detour_fuel
  WHERE id = p_delivery_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (d.initiator_portal_user_id, 'parcel_delivery_accepted', 'Parcel delivery accepted', v.owner_name || ' — Rs ' || (v_distance_fare + v_detour_fuel)::text, '/portal/marketplace/parcel/' || p_delivery_id);

  RETURN parcel_delivery_detail(p_delivery_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION accept_parcel_delivery(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_parcel_delivery(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION approve_parcel_delivery_price(p_delivery_id uuid) RETURNS void AS $$
DECLARE d parcel_deliveries%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO d FROM parcel_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND OR d.initiator_portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this delivery.' USING ERRCODE = 'P0001';
  END IF;
  IF d.status <> 'priced' THEN RAISE EXCEPTION 'There is no price waiting for approval.' USING ERRCODE = 'P0001'; END IF;
  UPDATE parcel_deliveries SET status = 'approved', approved_at = now() WHERE id = p_delivery_id;
  SELECT * INTO v FROM vehicles WHERE id = d.accepted_vehicle_id;
  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'parcel_delivery_approved', 'Price approved — go ahead and collect it', d.description, '/portal/marketplace/parcel/' || p_delivery_id);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION approve_parcel_delivery_price(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION approve_parcel_delivery_price(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION mark_parcel_picked_up(p_delivery_id uuid) RETURNS void AS $$
DECLARE d parcel_deliveries%ROWTYPE;
BEGIN
  SELECT * INTO d FROM parcel_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = d.accepted_vehicle_id AND portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this job.' USING ERRCODE = 'P0001';
  END IF;
  IF d.status <> 'approved' THEN RAISE EXCEPTION 'This job is not awaiting pickup.' USING ERRCODE = 'P0001'; END IF;
  UPDATE parcel_deliveries SET status = 'picked_up', picked_up_at = now() WHERE id = p_delivery_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (d.initiator_portal_user_id, 'parcel_picked_up', 'Parcel picked up', d.description, '/portal/marketplace/parcel/' || p_delivery_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION mark_parcel_picked_up(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mark_parcel_picked_up(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION mark_parcel_delivered(p_delivery_id uuid) RETURNS void AS $$
DECLARE d parcel_deliveries%ROWTYPE;
BEGIN
  SELECT * INTO d FROM parcel_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = d.accepted_vehicle_id AND portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this job.' USING ERRCODE = 'P0001';
  END IF;
  IF d.status <> 'picked_up' THEN RAISE EXCEPTION 'This job is not awaiting delivery.' USING ERRCODE = 'P0001'; END IF;
  UPDATE parcel_deliveries SET status = 'delivered', delivered_at = now() WHERE id = p_delivery_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (d.initiator_portal_user_id, 'parcel_delivered', 'Delivered — please confirm', d.description, '/portal/marketplace/parcel/' || p_delivery_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION mark_parcel_delivered(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mark_parcel_delivered(uuid) TO authenticated;

-- Dual-confirmation close, same as City Purchase's confirm_city_purchase_received
-- — plus the real commission-voucher posting City Purchase itself never
-- had, reusing dispatch's exact distance-banded pattern (665).
CREATE OR REPLACE FUNCTION confirm_parcel_delivery_received(p_delivery_id uuid) RETURNS void AS $$
DECLARE
  d parcel_deliveries%ROWTYPE; v vehicles%ROWTYPE; ci cities%ROWTYPE;
  v_vehicle_account uuid; v_commission_account uuid; v_commission_pct decimal; v_commission_amount decimal := 0; v_commission_voucher_id uuid;
BEGIN
  SELECT * INTO d FROM parcel_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND OR d.initiator_portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this delivery.' USING ERRCODE = 'P0001';
  END IF;
  IF d.status <> 'delivered' THEN RAISE EXCEPTION 'This delivery is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  UPDATE parcel_deliveries SET status = 'completed', completed_at = now() WHERE id = p_delivery_id;

  SELECT * INTO v FROM vehicles WHERE id = d.accepted_vehicle_id;
  IF v.commission_mode = 'per_order' AND COALESCE(d.total_fare_pkr, 0) > 0 THEN
    v_vehicle_account := ensure_vehicle_account(v.id);
    SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050' AND tenant_id = v.tenant_id;
    SELECT * INTO ci FROM cities WHERE id = d.city_id;
    v_commission_pct := dispatch_commission_pct(v.tenant_id, COALESCE(ci.distance_km, 0));
    v_commission_amount := round(d.total_fare_pkr * v_commission_pct / 100, 2);
    IF v_commission_amount > 0 AND v_commission_account IS NOT NULL THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — parcel delivery: ' || d.description || ' (paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
      RETURNING id INTO v_commission_voucher_id;
      UPDATE parcel_deliveries SET commission_voucher_id = v_commission_voucher_id WHERE id = p_delivery_id;
    END IF;
    PERFORM check_seller_balance_notify('vehicle', v.id);
  END IF;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'parcel_delivery_completed', 'Confirmed delivered', d.description, '/portal/marketplace/parcel/' || p_delivery_id);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION confirm_parcel_delivery_received(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION confirm_parcel_delivery_received(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION cancel_parcel_delivery(p_delivery_id uuid) RETURNS void AS $$
DECLARE d parcel_deliveries%ROWTYPE;
BEGIN
  SELECT * INTO d FROM parcel_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND OR d.initiator_portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this delivery.' USING ERRCODE = 'P0001';
  END IF;
  IF d.status IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'This delivery is already closed.' USING ERRCODE = 'P0001'; END IF;
  UPDATE parcel_deliveries SET status = 'cancelled', cancelled_at = now() WHERE id = p_delivery_id;
  UPDATE parcel_delivery_invitations SET status = 'expired', responded_at = now() WHERE delivery_id = p_delivery_id AND status = 'ringing';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION cancel_parcel_delivery(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancel_parcel_delivery(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION parcel_delivery_detail(p_delivery_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'delivery', jsonb_build_object(
      'id', d.id, 'description', d.description, 'recipient_name', d.recipient_name, 'recipient_mobile', d.recipient_mobile,
      'pickup_label', d.pickup_label, 'pickup_lat', d.pickup_lat, 'pickup_lng', d.pickup_lng,
      'dropoff_label', d.dropoff_label, 'dropoff_lat', d.dropoff_lat, 'dropoff_lng', d.dropoff_lng,
      'status', d.status,
      'distance_fare_pkr', d.distance_fare_pkr, 'detour_fuel_pkr', d.detour_fuel_pkr, 'total_fare_pkr', d.total_fare_pkr,
      'city_name', ci.name, 'city_name_ur', ci.name_ur, 'city_km', ci.distance_km,
      'accepted_vehicle_id', av.id, 'accepted_owner_name', av.owner_name, 'accepted_owner_mobile', av.owner_mobile, 'accepted_vehicle_type', av.vehicle_type,
      'initiator_portal_user_id', d.initiator_portal_user_id,
      'created_at', d.created_at
    ),
    'invitations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'vehicle_id', v.id, 'owner_name', v.owner_name, 'source', i.source, 'reference_destination', i.reference_destination,
        'status', i.status, 'invited_at', i.invited_at, 'responded_at', i.responded_at
      ) ORDER BY i.invited_at)
      FROM parcel_delivery_invitations i JOIN vehicles v ON v.id = i.vehicle_id WHERE i.delivery_id = d.id
    ), '[]'::jsonb)
  )
  FROM parcel_deliveries d
  JOIN cities ci ON ci.id = d.city_id
  LEFT JOIN vehicles av ON av.id = d.accepted_vehicle_id
  WHERE d.id = p_delivery_id AND is_party_to_parcel_delivery(d.id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION parcel_delivery_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION parcel_delivery_detail(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION my_parcel_deliveries() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', d.id, 'description', d.description, 'status', d.status, 'total_fare_pkr', d.total_fare_pkr, 'created_at', d.created_at,
    'city_name', ci.name, 'city_name_ur', ci.name_ur,
    'as_role', CASE WHEN d.initiator_portal_user_id = current_portal_user_id() THEN 'user' ELSE 'driver' END
  ) ORDER BY d.created_at DESC), '[]'::jsonb)
  FROM parcel_deliveries d JOIN cities ci ON ci.id = d.city_id
  WHERE d.initiator_portal_user_id = current_portal_user_id()
     OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = d.accepted_vehicle_id AND v.portal_user_id = current_portal_user_id());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_parcel_deliveries() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_parcel_deliveries() TO authenticated;

CREATE OR REPLACE FUNCTION my_parcel_delivery_invitations(p_vehicle_id uuid) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'delivery_id', d.id, 'description', d.description, 'pickup_label', d.pickup_label, 'dropoff_label', d.dropoff_label,
    'source', i.source, 'reference_destination', i.reference_destination, 'city_name', ci.name, 'city_name_ur', ci.name_ur, 'invited_at', i.invited_at
  ) ORDER BY i.invited_at), '[]'::jsonb)
  FROM parcel_delivery_invitations i
  JOIN parcel_deliveries d ON d.id = i.delivery_id
  JOIN cities ci ON ci.id = d.city_id
  WHERE i.vehicle_id = p_vehicle_id AND i.status = 'ringing' AND d.status = 'ringing'
    AND EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_parcel_delivery_invitations(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_parcel_delivery_invitations(uuid) TO authenticated;
