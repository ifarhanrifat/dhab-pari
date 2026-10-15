-- Migration 654: wedding fleet-by-vehicle-type, ported from the design
-- file's own sheetWedding/priceWedding — the rider asks for N vehicles
-- of each TYPE (sedan/bolan/hiace) and any willing driver of that type
-- can claim an open slot, rather than hand-picking specific vehicles
-- up front. Confirmed structurally different from our existing shadi
-- booking flow (which only ever lets the rider pick specific vehicles,
-- each individually invited).
--
-- This is added ADDITIVELY, not as a replacement: a real, live wedding
-- booking (event_date 2026-10-15, today) already has 3 real vehicles
-- sitting in 'requested' status on the existing hand-pick flow when
-- this migration is written — breaking or migrating that flow away
-- is not an option. Both flows now coexist: the rider chooses "pick
-- specific vehicles" (unchanged, same RPCs) or "request by type" (new).
-- A vehicle can opt into both at once (its own per-vehicle rate for
-- hand-pick invitations it receives, plus a fleet class for open slots
-- it can browse and claim itself).
--
-- Pricing for the TYPE flow is necessarily class-level, not per-vehicle
-- — a slot has to carry one price before any specific vehicle claims
-- it. Base + per-extra-km rates are the design's own TARIFF.wedding
-- numbers verbatim (sedan 5500 base/30 per extra km, bolan 4200/35,
-- hiace 9000/50, 40km free on every class), given directly as a
-- starting point for the committee to edit, not invented here.

CREATE TABLE IF NOT EXISTS shadi_vehicle_classes (
  class_key varchar PRIMARY KEY,
  name_en varchar NOT NULL,
  name_ur varchar NOT NULL,
  full_day_rate_pkr decimal NOT NULL CHECK (full_day_rate_pkr >= 0),
  free_km decimal NOT NULL DEFAULT 40 CHECK (free_km >= 0),
  per_extra_km_pkr decimal NOT NULL DEFAULT 0 CHECK (per_extra_km_pkr >= 0),
  is_active boolean NOT NULL DEFAULT true,
  display_order int NOT NULL DEFAULT 0
);
ALTER TABLE shadi_vehicle_classes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shadi_vehicle_classes_read" ON shadi_vehicle_classes FOR SELECT USING (true);
CREATE POLICY "shadi_vehicle_classes_write" ON shadi_vehicle_classes FOR ALL TO authenticated
  USING (COALESCE(current_admin_permission('manage_parties'), false)) WITH CHECK (COALESCE(current_admin_permission('manage_parties'), false));

INSERT INTO shadi_vehicle_classes (class_key, name_en, name_ur, full_day_rate_pkr, free_km, per_extra_km_pkr, display_order) VALUES
  ('sedan', 'Decorated car', 'سجی ہوئی کار', 5500, 40, 30, 1),
  ('bolan', 'Bolan van', 'بولان وین', 4200, 40, 35, 2),
  ('hiace', 'Hiace van', 'ہائی ایس وین', 9000, 40, 50, 3)
ON CONFLICT DO NOTHING;

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS shadi_vehicle_class varchar REFERENCES shadi_vehicle_classes(class_key);

-- Widen shadi_vehicle_requests to allow an "open" (unclaimed) slot:
-- vehicle_id becomes nullable, a class_key is added (only meaningful
-- on a fleet-flow row), and 'open' joins the status machine. None of
-- this touches any existing row — every row created so far already has
-- a real vehicle_id and a status other than 'open'.
ALTER TABLE shadi_vehicle_requests ALTER COLUMN vehicle_id DROP NOT NULL;
ALTER TABLE shadi_vehicle_requests ADD COLUMN IF NOT EXISTS class_key varchar REFERENCES shadi_vehicle_classes(class_key);
ALTER TABLE shadi_vehicle_requests DROP CONSTRAINT IF EXISTS shadi_vehicle_requests_status_check;
ALTER TABLE shadi_vehicle_requests ADD CONSTRAINT shadi_vehicle_requests_status_check
  CHECK (status IN ('open', 'requested', 'accepted', 'declined', 'cancelled', 'withdrawn'));

CREATE OR REPLACE FUNCTION create_shadi_fleet_event(
  p_event_date date, p_venue_address text, p_distance_km decimal, p_notes text, p_fleet jsonb,
  p_venue_lat decimal DEFAULT NULL, p_venue_lng decimal DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_event_id uuid;
  v_item jsonb;
  v_class shadi_vehicle_classes%ROWTYPE;
  v_qty int;
  v_price decimal;
  v_i int;
  v_total_qty int := 0;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_event_date IS NULL OR p_event_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN
    RAISE EXCEPTION 'Pick a wedding date that has not already passed.' USING ERRCODE = 'P0001';
  END IF;
  IF p_venue_address IS NULL OR trim(p_venue_address) = '' THEN RAISE EXCEPTION 'Enter the venue address.' USING ERRCODE = 'P0001'; END IF;
  IF p_distance_km IS NULL OR p_distance_km < 0 THEN RAISE EXCEPTION 'Enter the approximate distance.' USING ERRCODE = 'P0001'; END IF;
  IF p_fleet IS NULL OR jsonb_array_length(p_fleet) = 0 THEN RAISE EXCEPTION 'Choose at least one vehicle.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO shadi_events (portal_user_id, event_date, venue_address, venue_lat, venue_lng, distance_km, notes)
  VALUES (v_portal_user_id, p_event_date, trim(p_venue_address), p_venue_lat, p_venue_lng, p_distance_km, NULLIF(trim(p_notes), ''))
  RETURNING id INTO v_event_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_fleet) LOOP
    SELECT * INTO v_class FROM shadi_vehicle_classes WHERE class_key = (v_item->>'class_key') AND is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown vehicle type.' USING ERRCODE = 'P0001'; END IF;
    v_qty := COALESCE((v_item->>'qty')::int, 0);
    IF v_qty <= 0 THEN CONTINUE; END IF;
    v_total_qty := v_total_qty + v_qty;
    v_price := v_class.full_day_rate_pkr + round(greatest(0, p_distance_km - v_class.free_km) * v_class.per_extra_km_pkr, 2);
    FOR v_i IN 1..v_qty LOOP
      INSERT INTO shadi_vehicle_requests (event_id, class_key, full_day_rate_pkr, status) VALUES (v_event_id, v_class.class_key, v_price, 'open');
    END LOOP;
  END LOOP;

  IF v_total_qty = 0 THEN RAISE EXCEPTION 'Choose at least one vehicle.' USING ERRCODE = 'P0001'; END IF;

  RETURN v_event_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_shadi_fleet_event(date, text, decimal, text, jsonb, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_shadi_fleet_event(date, text, decimal, text, jsonb, decimal, decimal) TO authenticated;

-- Browse open slots matching this vehicle's own fleet class — the
-- driver-side equivalent of hourly_bookable_vehicles, but keyed off
-- an existing event rather than a vehicle list.
CREATE OR REPLACE FUNCTION shadi_open_slots_for_vehicle(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_class varchar; v_result jsonb;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT shadi_vehicle_class INTO v_class FROM vehicles WHERE id = p_vehicle_id;
  IF v_class IS NULL THEN RETURN '[]'::jsonb; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'class_key', r.class_key, 'full_day_rate_pkr', r.full_day_rate_pkr,
    'event_id', e.id, 'event_date', e.event_date, 'venue_address', e.venue_address,
    'venue_lat', e.venue_lat, 'venue_lng', e.venue_lng, 'distance_km', e.distance_km, 'notes', e.notes,
    'customer_name', pu.full_name, 'customer_mobile', pu.mobile, 'customer_trust', portal_user_trust(pu.id)
  ) ORDER BY e.event_date), '[]'::jsonb) INTO v_result
  FROM shadi_vehicle_requests r
  JOIN shadi_events e ON e.id = r.event_id
  JOIN portal_users pu ON pu.id = e.portal_user_id
  WHERE r.status = 'open' AND r.class_key = v_class AND e.status = 'collecting' AND e.event_date >= (now() AT TIME ZONE 'Asia/Karachi')::date;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION shadi_open_slots_for_vehicle(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION shadi_open_slots_for_vehicle(uuid) TO authenticated;

-- Claim an open slot — the fleet-flow equivalent of respond_shadi_request's
-- accept path (no decline: an unclaimed slot carries no obligation, so
-- there's nothing to decline, only other slots to leave unclaimed).
CREATE OR REPLACE FUNCTION claim_shadi_slot(p_request_id uuid, p_vehicle_id uuid) RETURNS void AS $$
DECLARE r shadi_vehicle_requests%ROWTYPE; e shadi_events%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles vv WHERE vv.id = p_vehicle_id AND vv.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO r FROM shadi_vehicle_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'open' THEN RAISE EXCEPTION 'This slot is no longer available.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active AND offers_shadi;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available for wedding booking.' USING ERRCODE = 'P0001'; END IF;
  IF v.shadi_vehicle_class IS NULL OR v.shadi_vehicle_class <> r.class_key THEN
    RAISE EXCEPTION 'This vehicle is not the right type for this slot.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO e FROM shadi_events WHERE id = r.event_id;
  IF v.portal_user_id = e.portal_user_id THEN RAISE EXCEPTION 'You cannot book your own vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF e.status <> 'collecting' THEN RAISE EXCEPTION 'This booking is no longer accepting vehicles.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM shadi_vehicle_requests WHERE event_id = r.event_id AND vehicle_id = p_vehicle_id AND status NOT IN ('declined', 'withdrawn', 'cancelled')) THEN
    RAISE EXCEPTION 'This vehicle already has a live request for this event.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM shadi_vehicle_requests r2 JOIN shadi_events e2 ON e2.id = r2.event_id
    WHERE r2.vehicle_id = p_vehicle_id AND r2.status = 'accepted' AND e2.event_date = e.event_date AND e2.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'This vehicle is already booked for another wedding on that date.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE shadi_vehicle_requests SET vehicle_id = p_vehicle_id, status = 'accepted', responded_at = now() WHERE id = p_request_id;

  IF e.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (e.portal_user_id, 'shadi_request_accepted', 'A driver claimed a vehicle slot',
      v.owner_name || ' will be available on ' || to_char(e.event_date, 'DD Mon YYYY') || '.', '/portal/marketplace/shadi/' || e.id);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION claim_shadi_slot(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION claim_shadi_slot(uuid, uuid) TO authenticated;

-- A rider should still see their own open (unclaimed) slots in "mine" —
-- both read RPCs just add class_key to the existing requests payload;
-- owner_name/owner_mobile/vehicle_type/model/color naturally come back
-- NULL for a still-open slot via the same LEFT JOIN.
CREATE OR REPLACE FUNCTION my_shadi_events() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', e.id, 'event_date', e.event_date, 'venue_address', e.venue_address, 'venue_lat', e.venue_lat, 'venue_lng', e.venue_lng, 'distance_km', e.distance_km, 'notes', e.notes,
    'status', e.status, 'advance_pct', e.advance_pct, 'advance_amount_pkr', e.advance_amount_pkr, 'advance_rejected_reason', e.advance_rejected_reason,
    'created_at', e.created_at,
    'requests', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', r.id, 'vehicle_id', r.vehicle_id, 'class_key', r.class_key, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile,
        'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color,
        'full_day_rate_pkr', r.full_day_rate_pkr, 'status', r.status, 'decline_reason', r.decline_reason, 'advance_share_pkr', r.advance_share_pkr,
        'paid_out_at', r.paid_out_at, 'withdrawn_at', r.withdrawn_at, 'replaces_request_id', r.replaces_request_id
      ) ORDER BY r.created_at), '[]'::jsonb)
      FROM shadi_vehicle_requests r LEFT JOIN vehicles v ON v.id = r.vehicle_id WHERE r.event_id = e.id
    )
  ) ORDER BY e.event_date DESC), '[]'::jsonb)
  FROM shadi_events e WHERE e.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION vehicle_shadi_requests(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'class_key', r.class_key, 'status', r.status, 'decline_reason', r.decline_reason, 'full_day_rate_pkr', r.full_day_rate_pkr, 'advance_share_pkr', r.advance_share_pkr,
    'paid_out_at', r.paid_out_at, 'withdrawn_at', r.withdrawn_at, 'replaces_request_id', r.replaces_request_id,
    'event_id', e.id, 'event_date', e.event_date, 'venue_address', e.venue_address, 'venue_lat', e.venue_lat, 'venue_lng', e.venue_lng, 'distance_km', e.distance_km, 'notes', e.notes, 'event_status', e.status,
    'customer_portal_user_id', pu.id, 'customer_name', pu.full_name, 'customer_mobile', pu.mobile, 'customer_trust', portal_user_trust(pu.id)
  ) ORDER BY e.event_date), '[]'::jsonb) INTO v_result
  FROM shadi_vehicle_requests r JOIN shadi_events e ON e.id = r.event_id JOIN portal_users pu ON pu.id = e.portal_user_id
  WHERE r.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- A driver picks their own fleet class the same self-service way they
-- toggle offers_hourly/offers_shadi/offers_rental — an 8th parameter,
-- default NULL so the existing 7-arg frontend callers keep working
-- until updated.
CREATE OR REPLACE FUNCTION set_vehicle_catalog_prefs(
  p_vehicle_id uuid, p_color text, p_model text, p_has_ac boolean, p_offers_hourly boolean, p_offers_shadi boolean, p_offers_rental boolean DEFAULT NULL, p_shadi_vehicle_class varchar DEFAULT NULL
) RETURNS void AS $$
DECLARE v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF p_offers_hourly AND v.hourly_rate_pkr IS NULL THEN
    RAISE EXCEPTION 'Ask the committee to set your hourly rate before turning this on.' USING ERRCODE = 'P0001';
  END IF;
  IF p_offers_shadi AND v.shadi_full_day_rate_pkr IS NULL THEN
    RAISE EXCEPTION 'Ask the committee to set your full-day wedding rate before turning this on.' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(p_offers_rental, false) AND (v.rental_base_pkr IS NULL OR v.rental_per_km_pkr IS NULL) THEN
    RAISE EXCEPTION 'Ask the committee to set your rental rate before turning this on.' USING ERRCODE = 'P0001';
  END IF;
  IF p_shadi_vehicle_class IS NOT NULL AND NOT EXISTS (SELECT 1 FROM shadi_vehicle_classes WHERE class_key = p_shadi_vehicle_class AND is_active) THEN
    RAISE EXCEPTION 'Unknown vehicle type.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicles SET
    color = NULLIF(trim(p_color), ''), model = NULLIF(trim(p_model), ''),
    has_ac = p_has_ac, offers_hourly = p_offers_hourly, offers_shadi = p_offers_shadi,
    offers_rental = COALESCE(p_offers_rental, offers_rental),
    shadi_vehicle_class = CASE WHEN p_shadi_vehicle_class IS NOT NULL THEN p_shadi_vehicle_class ELSE shadi_vehicle_class END
  WHERE id = p_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION set_vehicle_catalog_prefs(uuid, text, text, boolean, boolean, boolean, boolean, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_vehicle_catalog_prefs(uuid, text, text, boolean, boolean, boolean, boolean, varchar) TO authenticated;

CREATE OR REPLACE FUNCTION shadi_vehicle_classes_list() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'class_key', c.class_key, 'name_en', c.name_en, 'name_ur', c.name_ur, 'full_day_rate_pkr', c.full_day_rate_pkr,
    'free_km', c.free_km, 'per_extra_km_pkr', c.per_extra_km_pkr
  ) ORDER BY c.display_order), '[]'::jsonb)
  FROM shadi_vehicle_classes c WHERE c.is_active;
$$ LANGUAGE sql STABLE;
GRANT EXECUTE ON FUNCTION shadi_vehicle_classes_list() TO authenticated, anon;
