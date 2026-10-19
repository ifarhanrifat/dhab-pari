-- Migration 700: Phase 2 of the vehicle-marketplace rebuild, machinery
-- piece — "the driver will set there discount on the fixed rates from
-- there apps and rider can negociate with the drivers and they can set
-- a price after nagociations... but not bellow the belt." Machinery
-- already has a driver-vs-committee band (machinery_hourly_rate_min_pkr/
-- max_pkr + set_own_machinery_rate(), migration 666) but zero
-- rider-facing negotiation — today a rider can only accept the driver's
-- self-set rate as-is. This adds that missing rider<->driver layer,
-- modeled 1:1 on the proven vehicle_trip_fare_offers shape (migration
-- 400/484): propose/respond(accept|reject|counter)/accept-counter, with
-- the vehicle's own committee-set min as the floor and its own
-- currently-listed rate as the ceiling — a rider can only ever
-- negotiate DOWN, never above the sticker price, never below the belt.

CREATE TABLE IF NOT EXISTS machinery_rate_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  proposed_rate_pkr decimal NOT NULL CHECK (proposed_rate_pkr >= 0),
  counter_rate_pkr decimal CHECK (counter_rate_pkr IS NULL OR counter_rate_pkr >= 0),
  status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'countered', 'accepted', 'rejected', 'withdrawn')),
  equipment_booking_id uuid REFERENCES equipment_bookings(id),
  created_at timestamptz DEFAULT now(),
  responded_at timestamptz
);
CREATE INDEX IF NOT EXISTS machinery_rate_offers_vehicle_id_idx ON machinery_rate_offers(vehicle_id);

ALTER TABLE machinery_rate_offers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "machinery_rate_offers_rider_read" ON machinery_rate_offers FOR SELECT TO authenticated
  USING (portal_user_id = current_portal_user_id());
CREATE POLICY "machinery_rate_offers_driver_read" ON machinery_rate_offers FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id()));

CREATE OR REPLACE FUNCTION propose_machinery_rate(p_vehicle_id uuid, p_proposed_rate_pkr decimal)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v vehicles%ROWTYPE;
  v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF v.portal_user_id = v_portal_user_id THEN RAISE EXCEPTION 'You cannot negotiate your own vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF NOT v.offers_machinery OR v.machinery_hourly_rate_pkr IS NULL THEN
    RAISE EXCEPTION 'This vehicle is not available for machinery booking.' USING ERRCODE = 'P0001';
  END IF;
  IF v.machinery_hourly_rate_min_pkr IS NULL THEN
    RAISE EXCEPTION 'This owner has not set a negotiable range — book at the listed rate.' USING ERRCODE = 'P0001';
  END IF;
  IF p_proposed_rate_pkr < v.machinery_hourly_rate_min_pkr OR p_proposed_rate_pkr > v.machinery_hourly_rate_pkr THEN
    RAISE EXCEPTION 'Offer between % and % per hour.', v.machinery_hourly_rate_min_pkr, v.machinery_hourly_rate_pkr USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM machinery_rate_offers WHERE vehicle_id = p_vehicle_id AND portal_user_id = v_portal_user_id AND status IN ('pending', 'countered')) THEN
    RAISE EXCEPTION 'You already have an offer pending on this vehicle.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO machinery_rate_offers (vehicle_id, portal_user_id, proposed_rate_pkr)
  VALUES (p_vehicle_id, v_portal_user_id, p_proposed_rate_pkr)
  RETURNING id INTO v_id;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'machinery_rate_offer_proposed', 'New rate offer',
      'A rider offered ₨' || p_proposed_rate_pkr || '/hour for your machine.', '/portal/my-vehicle/equipment');
  END IF;

  RETURN v_id;
END;
$function$;
REVOKE ALL ON FUNCTION propose_machinery_rate(uuid, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION propose_machinery_rate(uuid, decimal) TO authenticated;

CREATE OR REPLACE FUNCTION respond_machinery_rate_offer(p_offer_id uuid, p_action varchar, p_counter_rate_pkr decimal DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  o machinery_rate_offers%ROWTYPE;
  v vehicles%ROWTYPE;
BEGIN
  IF p_action NOT IN ('accept', 'reject', 'counter') THEN RAISE EXCEPTION 'Invalid action.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO o FROM machinery_rate_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Offer not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = o.vehicle_id AND portal_user_id = current_portal_user_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;

  IF p_action = 'reject' THEN
    IF o.status NOT IN ('pending', 'countered') THEN RAISE EXCEPTION 'This offer is no longer open.' USING ERRCODE = 'P0001'; END IF;
    UPDATE machinery_rate_offers SET status = 'rejected', responded_at = now() WHERE id = p_offer_id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (o.portal_user_id, 'machinery_rate_offer_rejected', 'Rate offer declined', v.owner_name || ' declined your offer.', '/portal/marketplace/machinery');
    RETURN;
  END IF;

  IF o.status <> 'pending' THEN RAISE EXCEPTION 'This offer has already been responded to.' USING ERRCODE = 'P0001'; END IF;

  IF p_action = 'accept' THEN
    UPDATE machinery_rate_offers SET status = 'accepted', responded_at = now() WHERE id = p_offer_id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (o.portal_user_id, 'machinery_rate_offer_accepted', 'Rate offer accepted', v.owner_name || ' accepted your offer of ₨' || o.proposed_rate_pkr || '/hour — book now.', '/portal/marketplace/machinery');
  ELSE
    IF p_counter_rate_pkr IS NULL THEN RAISE EXCEPTION 'Enter a counter rate.' USING ERRCODE = 'P0001'; END IF;
    IF p_counter_rate_pkr < COALESCE(v.machinery_hourly_rate_min_pkr, 0) OR p_counter_rate_pkr > v.machinery_hourly_rate_pkr THEN
      RAISE EXCEPTION 'Counter between % and % per hour.', COALESCE(v.machinery_hourly_rate_min_pkr, 0), v.machinery_hourly_rate_pkr USING ERRCODE = 'P0001';
    END IF;
    UPDATE machinery_rate_offers SET status = 'countered', counter_rate_pkr = p_counter_rate_pkr, responded_at = now() WHERE id = p_offer_id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (o.portal_user_id, 'machinery_rate_offer_countered', 'Counter-offer', v.owner_name || ' countered at ₨' || p_counter_rate_pkr || '/hour.', '/portal/marketplace/machinery');
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION respond_machinery_rate_offer(uuid, varchar, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION respond_machinery_rate_offer(uuid, varchar, decimal) TO authenticated;

CREATE OR REPLACE FUNCTION accept_machinery_rate_counter(p_offer_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE o machinery_rate_offers%ROWTYPE;
BEGIN
  SELECT * INTO o FROM machinery_rate_offers WHERE id = p_offer_id AND portal_user_id = current_portal_user_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Offer not found.' USING ERRCODE = 'P0001'; END IF;
  IF o.status <> 'countered' THEN RAISE EXCEPTION 'There is no counter-offer to accept.' USING ERRCODE = 'P0001'; END IF;
  UPDATE machinery_rate_offers SET status = 'accepted', responded_at = now() WHERE id = p_offer_id;
END;
$function$;
REVOKE ALL ON FUNCTION accept_machinery_rate_counter(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_machinery_rate_counter(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION my_machinery_rate_offers(p_vehicle_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', o.id, 'proposed_rate_pkr', o.proposed_rate_pkr, 'counter_rate_pkr', o.counter_rate_pkr, 'status', o.status, 'created_at', o.created_at,
    'rider_full_name', p.full_name, 'rider_mobile', p.mobile
  ) ORDER BY o.created_at DESC), '[]'::jsonb)
  FROM machinery_rate_offers o
  JOIN vehicles v ON v.id = o.vehicle_id
  JOIN portal_users p ON p.id = o.portal_user_id
  WHERE o.vehicle_id = p_vehicle_id AND v.portal_user_id = current_portal_user_id() AND o.status IN ('pending', 'countered');
$function$;
REVOKE ALL ON FUNCTION my_machinery_rate_offers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_machinery_rate_offers(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION my_proposed_machinery_rate(p_vehicle_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $function$
  SELECT jsonb_build_object('id', o.id, 'proposed_rate_pkr', o.proposed_rate_pkr, 'counter_rate_pkr', o.counter_rate_pkr, 'status', o.status)
  FROM machinery_rate_offers o
  WHERE o.vehicle_id = p_vehicle_id AND o.portal_user_id = current_portal_user_id() AND o.status IN ('pending', 'countered', 'accepted')
  ORDER BY o.created_at DESC LIMIT 1;
$function$;
REVOKE ALL ON FUNCTION my_proposed_machinery_rate(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_proposed_machinery_rate(uuid) TO authenticated;

-- equipment_bookable_vehicles (668): add the negotiable floor so the
-- rider UI knows whether this vehicle has a band at all.
CREATE OR REPLACE FUNCTION equipment_bookable_vehicles(p_kind varchar) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'color', v.color, 'model', v.model,
    'machinery_hourly_rate_pkr', v.machinery_hourly_rate_pkr, 'machinery_hourly_rate_min_pkr', v.machinery_hourly_rate_min_pkr,
    'machinery_min_hours', v.machinery_min_hours, 'machinery_mobilization_fee_pkr', v.machinery_mobilization_fee_pkr,
    'loader_trip_rate_pkr', v.loader_trip_rate_pkr,
    'cover_url', (SELECT m.url FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.is_cover LIMIT 1),
    'avg_rating', (SELECT round(avg(r.stars)::numeric, 1) FROM ratings r WHERE r.target_party_type = 'vehicle' AND r.target_party_id = v.id),
    'shared_from_other_village', v.tenant_id <> my_tenant_id(),
    'owner_village_name', CASE WHEN v.tenant_id <> my_tenant_id() THEN (SELECT t.name FROM tenants t WHERE t.id = v.tenant_id) ELSE NULL END,
    'tractor_services', CASE WHEN p_kind = 'tractor' THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('service_key', ts.service_key, 'name_en', ts.name_en, 'name_ur', ts.name_ur, 'rate_pkr', ts.rate_pkr, 'unit', ts.unit) ORDER BY ts.name_en), '[]'::jsonb)
      FROM tractor_services ts WHERE ts.vehicle_id = v.id
    ) ELSE NULL END
  ) ORDER BY v.owner_name), '[]'::jsonb)
  FROM vehicles v
  WHERE v.is_active AND (
    (p_kind = 'machinery' AND v.offers_machinery AND v.machinery_hourly_rate_pkr IS NOT NULL)
    OR (p_kind = 'tractor' AND v.offers_tractor AND EXISTS (SELECT 1 FROM tractor_services ts WHERE ts.vehicle_id = v.id))
    OR (p_kind = 'loader' AND v.offers_loader AND v.loader_trip_rate_pkr IS NOT NULL)
  )
  AND (v.tenant_id = my_tenant_id() OR EXISTS (
    SELECT 1 FROM marketplace_share_agreements sa
    WHERE sa.owner_tenant_id = v.tenant_id AND sa.target_tenant_id = my_tenant_id() AND sa.category = p_kind AND sa.is_active
  ));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- create_equipment_booking: a stale 8-arg overload (from 652) was left
-- behind alongside the 10-arg one (659) when that migration added
-- trailing params without dropping the old signature — same class of
-- bug just fixed on create_vehicle_route_self. Drop both stale
-- overloads here while adding the 11th param for real, so only the
-- current signature survives.
DROP FUNCTION IF EXISTS create_equipment_booking(uuid, varchar, varchar, int, text, varchar, decimal, decimal);
DROP FUNCTION IF EXISTS create_equipment_booking(uuid, varchar, varchar, int, text, varchar, decimal, decimal, text, varchar);

CREATE OR REPLACE FUNCTION create_equipment_booking(
  p_vehicle_id uuid, p_kind varchar, p_service_key varchar, p_hours int, p_site_address text, p_material varchar,
  p_site_lat decimal DEFAULT NULL, p_site_lng decimal DEFAULT NULL, p_notes text DEFAULT NULL, p_payment_method varchar DEFAULT 'cash',
  p_accepted_offer_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v vehicles%ROWTYPE;
  v_rate decimal;
  v_mobilization decimal := 0;
  v_booking_id uuid;
  v_offer machinery_rate_offers%ROWTYPE;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_kind NOT IN ('machinery', 'tractor', 'loader') THEN RAISE EXCEPTION 'Unknown booking kind.' USING ERRCODE = 'P0001'; END IF;
  IF p_site_address IS NULL OR trim(p_site_address) = '' THEN RAISE EXCEPTION 'Enter the site address.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF v.portal_user_id = v_portal_user_id THEN RAISE EXCEPTION 'You cannot book your own vehicle.' USING ERRCODE = 'P0001'; END IF;

  IF p_kind = 'machinery' THEN
    IF NOT v.offers_machinery OR v.machinery_hourly_rate_pkr IS NULL THEN
      RAISE EXCEPTION 'This vehicle is not available for machinery booking.' USING ERRCODE = 'P0001';
    END IF;
    IF p_hours IS NULL OR p_hours <= 0 THEN RAISE EXCEPTION 'Enter how many hours you need.' USING ERRCODE = 'P0001'; END IF;
    IF v.machinery_min_hours IS NOT NULL AND p_hours < v.machinery_min_hours THEN
      RAISE EXCEPTION 'This machine has a minimum of % hours.', v.machinery_min_hours USING ERRCODE = 'P0001';
    END IF;
    v_rate := v.machinery_hourly_rate_pkr;
    v_mobilization := COALESCE(v.machinery_mobilization_fee_pkr, 0);

    IF p_accepted_offer_id IS NOT NULL THEN
      SELECT * INTO v_offer FROM machinery_rate_offers
        WHERE id = p_accepted_offer_id AND vehicle_id = p_vehicle_id AND portal_user_id = v_portal_user_id AND status = 'accepted' AND equipment_booking_id IS NULL
        FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'This negotiated rate is no longer available.' USING ERRCODE = 'P0001'; END IF;
      v_rate := COALESCE(v_offer.counter_rate_pkr, v_offer.proposed_rate_pkr);
    END IF;
  ELSIF p_kind = 'tractor' THEN
    IF NOT v.offers_tractor THEN RAISE EXCEPTION 'This vehicle is not available for tractor booking.' USING ERRCODE = 'P0001'; END IF;
    IF p_hours IS NULL OR p_hours <= 0 THEN RAISE EXCEPTION 'Enter how many hours you need.' USING ERRCODE = 'P0001'; END IF;
    SELECT rate_pkr INTO v_rate FROM tractor_services WHERE vehicle_id = p_vehicle_id AND service_key = p_service_key;
    IF v_rate IS NULL THEN RAISE EXCEPTION 'Choose a valid service for this tractor.' USING ERRCODE = 'P0001'; END IF;
  ELSE
    IF NOT v.offers_loader OR v.loader_trip_rate_pkr IS NULL THEN
      RAISE EXCEPTION 'This vehicle is not available for loader booking.' USING ERRCODE = 'P0001';
    END IF;
    v_rate := v.loader_trip_rate_pkr;
  END IF;

  INSERT INTO equipment_bookings (portal_user_id, vehicle_id, kind, service_key, site_address, site_lat, site_lng, material, requested_hours, rate_pkr, mobilization_fee_pkr, pin, notes, payment_method)
  VALUES (v_portal_user_id, p_vehicle_id, p_kind, p_service_key, trim(p_site_address), p_site_lat, p_site_lng, p_material, p_hours, v_rate, v_mobilization, lpad(floor(random() * 10000)::text, 4, '0'), NULLIF(trim(p_notes), ''), COALESCE(p_payment_method, 'cash'))
  RETURNING id INTO v_booking_id;

  IF p_accepted_offer_id IS NOT NULL THEN
    UPDATE machinery_rate_offers SET equipment_booking_id = v_booking_id WHERE id = p_accepted_offer_id;
  END IF;

  PERFORM ensure_booking_thread('equipment_booking', v_booking_id, p_vehicle_id, v_portal_user_id, trim(coalesce(v.model, v.vehicle_type)) || ' — ' || p_kind);

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'equipment_booking_requested', 'New ' || p_kind || ' request', trim(p_site_address), '/portal/my-vehicle/equipment');
  END IF;

  RETURN v_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_equipment_booking(uuid, varchar, varchar, int, text, varchar, decimal, decimal, text, varchar, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_equipment_booking(uuid, varchar, varchar, int, text, varchar, decimal, decimal, text, varchar, uuid) TO authenticated;
