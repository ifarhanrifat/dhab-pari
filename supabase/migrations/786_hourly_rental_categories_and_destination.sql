-- Migration 786: real ask, 2026-11-03 — "when i chose this [hourly
-- rental] feature its showing the list of all vehicles separately and
-- not in the category shape... this will also have the same
-- categories but it will add buses, costers, hiace, meaning all adda
-- vehicle type will be existing in this categories from where user
-- can pickup the model wise vehicle." Also: "check the request
-- procedure... where he wants to go, how many hours... so our system
-- will make him choose the request comfortable way" and "please setup
-- the fare of all categories according to Pakistani market like base
-- fare, waiting, per km fare etc."
--
-- Real finding: Car Rental (653/714) already HAS exactly this category
-- mechanism — CategoryVehiclePicker + vehicles.rental_tier (small_ac/
-- small_non_ac/big_ac/big_non_ac/suv/luxury) — but Hourly never got
-- it at all (plain flat vehicles.map()), and rental_tier's own 6
-- values never included a van/Hiace/Coaster/Bus class. One shared fix:
-- extend rental_tier (the vehicle's general "hire size class", used by
-- both hourly and point-to-point rental) with the 4 missing classes,
-- and give Hourly the exact same CategoryVehiclePicker treatment
-- rental already has — not a second, parallel category system.
--
-- Fare numbers: direct research (inDrive/Bykea/Careem Pakistan) found
-- NO publicly documented PKR rate card for either hourly packages or
-- outstation pricing from any of the three — inDrive is pure
-- negotiation, Bykea/Careem publish nothing. The one well-documented
-- real mechanism found (Uber Intercity, same product family, South
-- Asia) confirms two things this app's existing design already gets
-- right: outstation is priced as a higher per-km rate, not a literal
-- distance double (rental_bookings' 1.5x one-way / 2x return split,
-- 653, is directionally the same idea); and an hourly package's
-- included-km is a continuously-running TOTAL-TRIP odometer for the
-- whole hired window — covering any return/backtrack driving, not
-- just a one-way destination — which is exactly how hourly_bookings'
-- live-GPS billing (475) already works. Nothing to fix in the billing
-- mechanism itself; the real gaps were the missing category grouping
-- and the fact that no app (including this one, until now) discloses
-- the two-way nature to the rider up front.
--
-- Numbers below are explicit STARTING references, not claimed market
-- data (none exists publicly) — anchored proportionally off the one
-- real committee-approved rate this app already has (vehicle_categories
-- 'car' = Rs12/km, 2% commission, 707) and the ~10km/hour included
-- baseline the research did confirm as real industry practice (Uber/
-- Ola Rentals package shapes). Committee-editable via the existing
-- admin vehicle-rates screen, same as every other category rate in
-- this app.

ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_rental_tier_check;
ALTER TABLE vehicles ADD CONSTRAINT vehicles_rental_tier_check
  CHECK (rental_tier IN ('small_ac', 'small_non_ac', 'big_ac', 'big_non_ac', 'suv', 'luxury', 'van', 'hiace', 'coaster', 'bus'));

CREATE OR REPLACE FUNCTION set_vehicle_catalog_prefs(
  p_vehicle_id uuid, p_color text, p_model text, p_has_ac boolean, p_offers_hourly boolean, p_offers_shadi boolean,
  p_offers_rental boolean DEFAULT NULL::boolean, p_shadi_vehicle_class character varying DEFAULT NULL::character varying,
  p_rental_tier character varying DEFAULT NULL::character varying
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
  IF p_shadi_vehicle_class IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM shadi_vehicle_classes WHERE class_key = p_shadi_vehicle_class AND is_active) THEN
      RAISE EXCEPTION 'Unknown vehicle type.' USING ERRCODE = 'P0001';
    END IF;
    IF (p_shadi_vehicle_class = 'hiace' AND v.vehicle_type NOT ILIKE '%hiace%')
      OR (p_shadi_vehicle_class = 'bolan' AND v.vehicle_type NOT ILIKE '%bolan%')
      OR (p_shadi_vehicle_class = 'sedan' AND (v.vehicle_type ILIKE '%hiace%' OR v.vehicle_type ILIKE '%bolan%'))
    THEN
      RAISE EXCEPTION 'This wedding-vehicle category doesn''t match your registered vehicle (%). Ask the committee if you think this is wrong.', v.vehicle_type USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF p_rental_tier IS NOT NULL AND p_rental_tier NOT IN ('small_ac', 'small_non_ac', 'big_ac', 'big_non_ac', 'suv', 'luxury', 'van', 'hiace', 'coaster', 'bus') THEN
    RAISE EXCEPTION 'Unknown rental category.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicles SET
    color = NULLIF(trim(p_color), ''), model = NULLIF(trim(p_model), ''),
    has_ac = p_has_ac, offers_hourly = p_offers_hourly, offers_shadi = p_offers_shadi,
    offers_rental = COALESCE(p_offers_rental, offers_rental),
    shadi_vehicle_class = CASE WHEN p_shadi_vehicle_class IS NOT NULL THEN p_shadi_vehicle_class ELSE shadi_vehicle_class END,
    rental_tier = CASE WHEN p_rental_tier IS NOT NULL THEN p_rental_tier ELSE rental_tier END
  WHERE id = p_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- The real, visible, committee-editable rate guide the ask was for —
-- one row per hire-size class, covering every fare dimension both
-- verticals charge (hourly: rate/included-km-per-hour/overage; point-
-- to-point rental: base/per-km/wait-hour). Read-only reference for now
-- (surfaced on the driver catalog page and the admin rate-entry form
-- below) — an admin still types the vehicle's own live rate, same
-- committee-differentiates-per-vehicle pattern this app uses
-- everywhere else; this is the number they're starting from instead of
-- a blank box.
CREATE TABLE IF NOT EXISTS rental_tier_fare_guides (
  tier_key varchar PRIMARY KEY CHECK (tier_key IN ('small_ac', 'small_non_ac', 'big_ac', 'big_non_ac', 'suv', 'luxury', 'van', 'hiace', 'coaster', 'bus')),
  display_order int NOT NULL,
  hourly_rate_pkr decimal NOT NULL,
  hourly_included_km_per_hour decimal NOT NULL,
  hourly_overage_per_km_pkr decimal NOT NULL,
  rental_base_pkr decimal NOT NULL,
  rental_per_km_pkr decimal NOT NULL,
  rental_wait_hour_pkr decimal NOT NULL
);
ALTER TABLE rental_tier_fare_guides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rental_tier_fare_guides_read" ON rental_tier_fare_guides FOR SELECT TO authenticated USING (true);

INSERT INTO rental_tier_fare_guides (tier_key, display_order, hourly_rate_pkr, hourly_included_km_per_hour, hourly_overage_per_km_pkr, rental_base_pkr, rental_per_km_pkr, rental_wait_hour_pkr) VALUES
  ('small_non_ac', 1, 250, 10, 15, 200, 14, 120),
  ('small_ac',     2, 300, 10, 15, 250, 16, 140),
  ('big_non_ac',   3, 350, 10, 18, 300, 18, 160),
  ('big_ac',       4, 400, 10, 18, 350, 20, 180),
  ('suv',          5, 500, 10, 20, 400, 24, 220),
  ('van',          6, 450, 10, 18, 350, 18, 180),
  ('hiace',        7, 700, 10, 25, 500, 26, 280),
  ('luxury',       8, 700, 10, 25, 600, 30, 300),
  ('coaster',      9, 1200, 10, 35, 1000, 40, 500),
  ('bus',          10, 2000, 10, 45, 1800, 55, 800)
ON CONFLICT (tier_key) DO NOTHING;

CREATE OR REPLACE FUNCTION rental_tier_fare_guides_list() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'tier_key', tier_key, 'hourly_rate_pkr', hourly_rate_pkr, 'hourly_included_km_per_hour', hourly_included_km_per_hour,
    'hourly_overage_per_km_pkr', hourly_overage_per_km_pkr, 'rental_base_pkr', rental_base_pkr, 'rental_per_km_pkr', rental_per_km_pkr,
    'rental_wait_hour_pkr', rental_wait_hour_pkr
  ) ORDER BY display_order), '[]'::jsonb)
  FROM rental_tier_fare_guides;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION rental_tier_fare_guides_list() TO authenticated;

-- Real ask: "check the request procedure of the driver... where he
-- wants to go, how many hours he wants to book... make him choose the
-- request a comfortable way." Hourly never asked a rider where they
-- actually intend to go at all — only a pickup point + a bare hour
-- count, leaving the driver to accept blind. Purely informational
-- (billing stays exactly as it was — live GPS for the whole hired
-- window, 475/786's own header comment) but now the driver's request
-- card can show the rider's real plan before they decide.
ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS destination_address text;
ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS destination_lat decimal;
ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS destination_lng decimal;
ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS is_outstation boolean NOT NULL DEFAULT false;

DROP FUNCTION IF EXISTS create_hourly_booking(uuid, int, text, decimal, decimal, text, varchar);
CREATE OR REPLACE FUNCTION create_hourly_booking(
  p_vehicle_id uuid, p_hours int, p_pickup_address text, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL,
  p_notes text DEFAULT NULL, p_payment_method varchar DEFAULT 'cash',
  p_destination_address text DEFAULT NULL, p_destination_lat decimal DEFAULT NULL, p_destination_lng decimal DEFAULT NULL, p_is_outstation boolean DEFAULT false
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v vehicles%ROWTYPE;
  v_booking_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_hours IS NULL OR p_hours <= 0 THEN RAISE EXCEPTION 'Enter how many hours you need.' USING ERRCODE = 'P0001'; END IF;
  IF p_pickup_address IS NULL OR trim(p_pickup_address) = '' THEN RAISE EXCEPTION 'Enter a pickup address.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active AND offers_hourly FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available for hourly booking.' USING ERRCODE = 'P0001'; END IF;
  IF v.hourly_rate_pkr IS NULL THEN RAISE EXCEPTION 'This vehicle has no rate set yet.' USING ERRCODE = 'P0001'; END IF;
  IF v.portal_user_id = v_portal_user_id THEN RAISE EXCEPTION 'You cannot book your own vehicle.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO hourly_bookings (
    portal_user_id, vehicle_id, hours, pickup_address, pickup_lat, pickup_lng, hourly_rate_pkr, included_km, overage_per_km_pkr, base_amount_pkr, pin, notes, payment_method,
    destination_address, destination_lat, destination_lng, is_outstation
  )
  VALUES (
    v_portal_user_id, p_vehicle_id, p_hours, trim(p_pickup_address), p_pickup_lat, p_pickup_lng, v.hourly_rate_pkr, COALESCE(v.hourly_included_km, 0) * p_hours, COALESCE(v.hourly_overage_per_km_pkr, 0), v.hourly_rate_pkr * p_hours, lpad(floor(random() * 10000)::text, 4, '0'), NULLIF(trim(p_notes), ''), COALESCE(p_payment_method, 'cash'),
    NULLIF(trim(p_destination_address), ''), p_destination_lat, p_destination_lng, COALESCE(p_is_outstation, false)
  )
  RETURNING id INTO v_booking_id;

  PERFORM ensure_booking_thread('hourly_booking', v_booking_id, p_vehicle_id, v_portal_user_id, trim(coalesce(v.model, v.vehicle_type)) || ' — ' || p_hours || 'h');

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'hourly_booking_requested', 'Hourly rental request',
      p_hours || ' hour(s) — Rs ' || round(v.hourly_rate_pkr * p_hours), '/portal/my-vehicle/hourly');
  END IF;

  RETURN v_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_hourly_booking(uuid, int, text, decimal, decimal, text, varchar, text, decimal, decimal, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_hourly_booking(uuid, int, text, decimal, decimal, text, varchar, text, decimal, decimal, boolean) TO authenticated;

-- hourly_bookable_vehicles: same category_name/rental_tier/avg_rating/
-- cross-tenant-share shape rental_bookable_vehicles (714) already
-- returns, so Hourly's browse tab can use the exact same
-- CategoryVehiclePicker grouping, not a second bespoke shape.
CREATE OR REPLACE FUNCTION hourly_bookable_vehicles() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'color', v.color, 'model', v.model,
    'has_ac', v.has_ac, 'hourly_rate_pkr', v.hourly_rate_pkr, 'hourly_included_km', v.hourly_included_km,
    'hourly_overage_per_km_pkr', v.hourly_overage_per_km_pkr,
    'category_name', vc.name, 'category_name_ur', vc.name_ur, 'rental_tier', v.rental_tier,
    'avg_rating', (SELECT round(avg(r.stars)::numeric, 1) FROM ratings r WHERE r.target_party_type = 'vehicle' AND r.target_party_id = v.id),
    'cover_url', (SELECT m.url FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.is_cover LIMIT 1),
    'shared_from_other_village', v.tenant_id <> my_tenant_id(),
    'owner_village_name', CASE WHEN v.tenant_id <> my_tenant_id() THEN (SELECT t.name FROM tenants t WHERE t.id = v.tenant_id) ELSE NULL END
  ) ORDER BY v.owner_name), '[]'::jsonb)
  FROM vehicles v LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
  WHERE v.is_active AND v.offers_hourly AND v.hourly_rate_pkr IS NOT NULL
    AND (v.tenant_id = my_tenant_id() OR EXISTS (
      SELECT 1 FROM marketplace_share_agreements sa
      WHERE sa.owner_tenant_id = v.tenant_id AND sa.target_tenant_id = my_tenant_id() AND sa.category = 'hourly' AND sa.is_active
    ));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION hourly_bookable_vehicles() TO authenticated, anon;

-- my_hourly_bookings / vehicle_hourly_bookings: surface the new
-- destination fields + rental_tier, same every other field.
CREATE OR REPLACE FUNCTION my_hourly_bookings() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'hours', b.hours, 'status', b.status, 'pickup_address', b.pickup_address, 'pickup_lat', b.pickup_lat, 'pickup_lng', b.pickup_lng,
    'destination_address', b.destination_address, 'destination_lat', b.destination_lat, 'destination_lng', b.destination_lng, 'is_outstation', b.is_outstation,
    'base_amount_pkr', b.base_amount_pkr, 'total_amount_pkr', b.total_amount_pkr, 'distance_km', b.distance_km,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at, 'pin', b.pin, 'notes', b.notes, 'payment_method', b.payment_method,
    'decline_reason', b.decline_reason,
    'vehicle_id', b.vehicle_id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color,
    'category_name', vc.name, 'category_name_ur', vc.name_ur, 'rental_tier', v.rental_tier
  ) ORDER BY b.requested_at DESC), '[]'::jsonb)
  FROM hourly_bookings b JOIN vehicles v ON v.id = b.vehicle_id LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
  WHERE b.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_hourly_bookings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_hourly_bookings() TO authenticated;

CREATE OR REPLACE FUNCTION vehicle_hourly_bookings(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'hours', b.hours, 'status', b.status, 'pickup_address', b.pickup_address, 'pickup_lat', b.pickup_lat, 'pickup_lng', b.pickup_lng, 'decline_reason', b.decline_reason,
    'destination_address', b.destination_address, 'is_outstation', b.is_outstation,
    'base_amount_pkr', b.base_amount_pkr, 'total_amount_pkr', b.total_amount_pkr, 'distance_km', b.distance_km,
    'included_km', b.included_km, 'overage_km', b.overage_km, 'overage_amount_pkr', b.overage_amount_pkr,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at, 'status_confirmed', b.status_confirmed,
    'notes', b.notes, 'payment_method', b.payment_method,
    'customer_portal_user_id', pu.id, 'customer_name', pu.full_name, 'customer_mobile', pu.mobile, 'customer_trust', portal_user_trust(pu.id)
  ) ORDER BY b.requested_at DESC), '[]'::jsonb) INTO v_result
  FROM hourly_bookings b JOIN portal_users pu ON pu.id = b.portal_user_id
  WHERE b.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_hourly_bookings(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_hourly_bookings(uuid) TO authenticated;
