-- Migration 833: real ask, 2026-11-09 — "look this is how professional
-- apps are showing categories... when user is going to register he
-- will pickup a model car or write down his car then pickup the cc and
-- when he will choose cc then his car will be automatically added into
-- category, the committee or admin will only need to verify."
--
-- Confirmed via direct audit before writing anything here:
-- vehicle_categories (707) started clean (car/bike/rickshaw/van/
-- loader/tractor/machinery) but 749/757/781/814 each bolted on more
-- rows as complaints came in, landing on 27 rows today that mix
-- specific car MODELS (suzuki_mehran_ac, suzuki_alto, toyota_corolla)
-- next to generic size tiers (small_car_ac, big_car_ac, suv, luxury)
-- and plain kinds (bike, rickshaw, van) as equal-weight siblings — the
-- flat icon grid the user screenshotted on the registration page. The
-- RIDER-facing fare-card screen (results/page.tsx, ride_group_options,
-- 781) already collapses this into 5 clean tiles and is NOT part of
-- this complaint — this migration only fixes the registration side and
-- adds a 6th tile (compact_car) to match the new middle CC band.
--
-- No CC/electric/loader field existed anywhere before this. Approved
-- plan (user confirmed all three questions): car bands 660-800 /
-- 801-1000 / 1001-1800cc; luxury is a driver self-declared checkbox
-- (admin can override), not CC-derived; rickshaw/bike stay flag-gated
-- (electric / loader toggles) with no CC input.

-- ═════════════════════════════════════════════════════════════════════
-- Schema additions — all nullable/defaulted, nothing breaks for an
-- existing reader that doesn't know about them yet.
-- ═════════════════════════════════════════════════════════════════════
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS vehicle_kind varchar;
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS min_cc int;
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS max_cc int;
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS requires_ac boolean;
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS requires_electric boolean;
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS requires_loader boolean;
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS is_luxury_tier boolean NOT NULL DEFAULT false;
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS fare_spread_pct decimal NOT NULL DEFAULT 0.25 CHECK (fare_spread_pct >= 0 AND fare_spread_pct <= 1);
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS example_models_hint varchar;
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS example_models_hint_ur varchar;

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS engine_cc int;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS is_electric boolean NOT NULL DEFAULT false;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS is_loader boolean NOT NULL DEFAULT false;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS is_luxury_declared boolean NOT NULL DEFAULT false;

ALTER TABLE vehicle_registration_requests ADD COLUMN IF NOT EXISTS engine_cc int;
ALTER TABLE vehicle_registration_requests ADD COLUMN IF NOT EXISTS is_electric boolean NOT NULL DEFAULT false;
ALTER TABLE vehicle_registration_requests ADD COLUMN IF NOT EXISTS is_loader boolean NOT NULL DEFAULT false;
ALTER TABLE vehicle_registration_requests ADD COLUMN IF NOT EXISTS is_luxury_declared boolean NOT NULL DEFAULT false;

-- ═════════════════════════════════════════════════════════════════════
-- Backfill vehicle_kind on every existing row across every tenant —
-- purely descriptive tagging, no behavior change by itself.
-- ═════════════════════════════════════════════════════════════════════
UPDATE vehicle_categories SET vehicle_kind = 'car' WHERE key IN
  ('car', 'luxury', 'small_car_ac', 'small_car_non_ac', 'big_car_ac', 'big_car_non_ac', 'suzuki_mehran_ac', 'suzuki_mehran_non_ac', 'suzuki_alto', 'toyota_corolla');
UPDATE vehicle_categories SET vehicle_kind = 'suv' WHERE key = 'suv';
UPDATE vehicle_categories SET vehicle_kind = 'bike' WHERE key IN ('bike', 'electric_bike');
UPDATE vehicle_categories SET vehicle_kind = 'rickshaw' WHERE key IN ('rickshaw', 'electric_rickshaw', 'rickshaw_loading');
UPDATE vehicle_categories SET vehicle_kind = 'van' WHERE key IN
  ('van', 'suzuki_ravi', 'suzuki_carry_dabba', 'suzuki_ravi_dala', 'bus', 'coaster', 'hiace', 'suzuki_bolan');
UPDATE vehicle_categories SET vehicle_kind = 'loader' WHERE key = 'loader';
UPDATE vehicle_categories SET vehicle_kind = 'tractor' WHERE key = 'tractor';
UPDATE vehicle_categories SET vehicle_kind = 'machinery' WHERE key = 'machinery';

-- ═════════════════════════════════════════════════════════════════════
-- Enrich the existing size-tier rows into the real canonical CC bands
-- (ride_group/variant_filter/rate card/commission untouched — only
-- name + the new banding columns change, so nothing a rider already
-- sees shifts, and no already-committee-set rate is reset).
-- ═════════════════════════════════════════════════════════════════════
UPDATE vehicle_categories SET min_cc = 660, max_cc = 800, requires_ac = true,
  name = 'Economy Car — AC', name_ur = 'اکانومی کار — اے سی',
  example_models_hint = 'Mehran, Alto, old Cultus', example_models_hint_ur = 'مہران، آلٹو، پرانا کلٹس'
  WHERE key = 'small_car_ac';
UPDATE vehicle_categories SET min_cc = 660, max_cc = 800, requires_ac = false,
  name = 'Economy Car — Non-AC', name_ur = 'اکانومی کار — بغیر اے سی',
  example_models_hint = 'Mehran, Alto, old Cultus', example_models_hint_ur = 'مہران، آلٹو، پرانا کلٹس'
  WHERE key = 'small_car_non_ac';
UPDATE vehicle_categories SET min_cc = 1001, max_cc = 1800, requires_ac = true,
  name = 'Family Car — AC', name_ur = 'فیملی کار — اے سی',
  example_models_hint = 'Corolla, City, Civic, Cultus AGS', example_models_hint_ur = 'کرولا، سٹی، سوِک، کلٹس اے جی ایس'
  WHERE key = 'big_car_ac';
UPDATE vehicle_categories SET min_cc = 1001, max_cc = 1800, requires_ac = false,
  name = 'Family Car — Non-AC', name_ur = 'فیملی کار — بغیر اے سی',
  example_models_hint = 'Corolla, City, Civic', example_models_hint_ur = 'کرولا، سٹی، سوِک'
  WHERE key = 'big_car_non_ac';
UPDATE vehicle_categories SET is_luxury_tier = true,
  example_models_hint = 'Audi, BMW, Mercedes, Land Cruiser, Prado', example_models_hint_ur = 'آڈی، بی ایم ڈبلیو، مرسڈیز، لینڈ کروزر، پراڈو'
  WHERE key = 'luxury';
UPDATE vehicle_categories SET example_models_hint = 'Hilux Vigo, Vitara, Sportage, Honda BRV/HRV', example_models_hint_ur = 'ہائی لکس وگو، وٹارا، سپورٹیج، ہونڈا بی آر وی/ایچ آر وی'
  WHERE key = 'suv';
-- requires_loader is set explicitly false on both passenger rickshaw
-- rows (not left NULL) — otherwise a loader=true query would match
-- 'rickshaw' too (NULL = "don't care"), tying against rickshaw_loading
-- with no deterministic winner.
UPDATE vehicle_categories SET requires_electric = false, requires_loader = false WHERE key = 'rickshaw';
UPDATE vehicle_categories SET requires_electric = true, requires_loader = false WHERE key = 'electric_rickshaw';
UPDATE vehicle_categories SET requires_loader = true WHERE key = 'rickshaw_loading';
UPDATE vehicle_categories SET requires_electric = false WHERE key = 'bike';
UPDATE vehicle_categories SET requires_electric = true WHERE key = 'electric_bike';

-- The new middle band — no existing row to repurpose, so a genuinely
-- new category, rate card cloned from the nearest neighbour (same
-- discipline 707/757 already established: never an invented number,
-- the committee can retune via the existing admin screen).
INSERT INTO vehicle_categories (
  tenant_id, key, name, name_ur, emoji, base_fare_pkr, per_km_pkr, intercity_commission_pct, out_of_city_commission_pct,
  category_group, out_of_city_eligible, out_of_city_base_fare_pkr, out_of_city_per_km_pkr, route_stake_pkr,
  vehicle_kind, min_cc, max_cc, requires_ac, fare_spread_pct, example_models_hint, example_models_hint_ur,
  ride_group, variant_filter, display_order
)
SELECT src.tenant_id, 'compact_car_ac', 'Compact Car — AC', 'کمپیکٹ کار — اے سی', '🚗',
  src.base_fare_pkr, src.per_km_pkr, src.intercity_commission_pct, src.out_of_city_commission_pct,
  src.category_group, src.out_of_city_eligible, src.out_of_city_base_fare_pkr, src.out_of_city_per_km_pkr, src.route_stake_pkr,
  'car', 801, 1000, true, 0.25, 'Cultus VXR, Wagon R, Vitz', 'کلٹس وی ایکس آر، ویگن آر، وٹز',
  'compact_car', 'ac', 10
FROM vehicle_categories src WHERE src.key = 'small_car_ac' AND src.is_active
ON CONFLICT (tenant_id, key) DO NOTHING;

INSERT INTO vehicle_categories (
  tenant_id, key, name, name_ur, emoji, base_fare_pkr, per_km_pkr, intercity_commission_pct, out_of_city_commission_pct,
  category_group, out_of_city_eligible, out_of_city_base_fare_pkr, out_of_city_per_km_pkr, route_stake_pkr,
  vehicle_kind, min_cc, max_cc, requires_ac, fare_spread_pct, example_models_hint, example_models_hint_ur,
  ride_group, variant_filter, display_order
)
SELECT src.tenant_id, 'compact_car_non_ac', 'Compact Car — Non-AC', 'کمپیکٹ کار — بغیر اے سی', '🚙',
  src.base_fare_pkr, src.per_km_pkr, src.intercity_commission_pct, src.out_of_city_commission_pct,
  src.category_group, src.out_of_city_eligible, src.out_of_city_base_fare_pkr, src.out_of_city_per_km_pkr, src.route_stake_pkr,
  'car', 801, 1000, false, 0.25, 'Cultus VXR, Wagon R, Vitz', 'کلٹس وی ایکس آر، ویگن آر، وٹز',
  'compact_car', 'non_ac', 11
FROM vehicle_categories src WHERE src.key = 'small_car_non_ac' AND src.is_active
ON CONFLICT (tenant_id, key) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════
-- Retire the specific-model rows these bands replace — remap any
-- already-registered vehicle/pending request onto the right new band
-- first (keyed off the vehicle's own already-locked has_ac so a
-- non-AC Mehran doesn't silently become an AC one), then deactivate.
-- Never deleted — FK/history safe, exactly like every other retire in
-- this codebase.
-- ═════════════════════════════════════════════════════════════════════
UPDATE vehicles v SET category_id = nc.id
  FROM vehicle_categories oc, vehicle_categories nc
  WHERE v.category_id = oc.id AND oc.key = 'suzuki_mehran_ac' AND nc.tenant_id = oc.tenant_id AND nc.key = 'small_car_ac';
UPDATE vehicles v SET category_id = nc.id
  FROM vehicle_categories oc, vehicle_categories nc
  WHERE v.category_id = oc.id AND oc.key = 'suzuki_mehran_non_ac' AND nc.tenant_id = oc.tenant_id AND nc.key = 'small_car_non_ac';
UPDATE vehicles v SET category_id = nc.id
  FROM vehicle_categories oc, vehicle_categories nc
  WHERE v.category_id = oc.id AND oc.key = 'suzuki_alto' AND nc.tenant_id = oc.tenant_id
    AND nc.key = (CASE WHEN v.has_ac THEN 'small_car_ac' ELSE 'small_car_non_ac' END);
UPDATE vehicles v SET category_id = nc.id
  FROM vehicle_categories oc, vehicle_categories nc
  WHERE v.category_id = oc.id AND oc.key = 'toyota_corolla' AND nc.tenant_id = oc.tenant_id
    AND nc.key = (CASE WHEN v.has_ac THEN 'big_car_ac' ELSE 'big_car_non_ac' END);

UPDATE vehicle_registration_requests r SET category_id = nc.id
  FROM vehicle_categories oc, vehicle_categories nc
  WHERE r.category_id = oc.id AND oc.key = 'suzuki_mehran_ac' AND nc.tenant_id = oc.tenant_id AND nc.key = 'small_car_ac';
UPDATE vehicle_registration_requests r SET category_id = nc.id
  FROM vehicle_categories oc, vehicle_categories nc
  WHERE r.category_id = oc.id AND oc.key = 'suzuki_mehran_non_ac' AND nc.tenant_id = oc.tenant_id AND nc.key = 'small_car_non_ac';
UPDATE vehicle_registration_requests r SET category_id = nc.id
  FROM vehicle_categories oc, vehicle_categories nc
  WHERE r.category_id = oc.id AND oc.key = 'suzuki_alto' AND nc.tenant_id = oc.tenant_id
    AND nc.key = (CASE WHEN r.has_ac THEN 'small_car_ac' ELSE 'small_car_non_ac' END);
UPDATE vehicle_registration_requests r SET category_id = nc.id
  FROM vehicle_categories oc, vehicle_categories nc
  WHERE r.category_id = oc.id AND oc.key = 'toyota_corolla' AND nc.tenant_id = oc.tenant_id
    AND nc.key = (CASE WHEN r.has_ac THEN 'big_car_ac' ELSE 'big_car_non_ac' END);

UPDATE vehicle_categories SET is_active = false
  WHERE key IN ('suzuki_mehran_ac', 'suzuki_mehran_non_ac', 'suzuki_alto', 'toyota_corolla');

-- ═════════════════════════════════════════════════════════════════════
-- resolve_vehicle_category — the auto-derivation itself.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION resolve_vehicle_category(
  p_kind varchar, p_cc int DEFAULT NULL, p_has_ac boolean DEFAULT NULL,
  p_is_electric boolean DEFAULT false, p_is_loader boolean DEFAULT false, p_is_luxury boolean DEFAULT false
) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM vehicle_categories
  WHERE tenant_id = COALESCE(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND is_active
    AND vehicle_kind = p_kind
    AND is_luxury_tier = (p_kind = 'car' AND coalesce(p_is_luxury, false))
    AND (min_cc IS NULL OR (p_cc IS NOT NULL AND p_cc BETWEEN min_cc AND max_cc))
    AND (requires_ac IS NULL OR (p_has_ac IS NOT NULL AND requires_ac = p_has_ac))
    AND (requires_electric IS NULL OR requires_electric = coalesce(p_is_electric, false))
    AND (requires_loader IS NULL OR requires_loader = coalesce(p_is_loader, false))
  ORDER BY min_cc NULLS LAST LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION resolve_vehicle_category(varchar, int, boolean, boolean, boolean, boolean) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- submit_vehicle_registration — category_id is now SERVER-derived for
-- car/rickshaw/bike (closes a real gap: a tampered client could send
-- any category_id before this), from the driver's own declared
-- kind/cc/ac/electric/loader/luxury. Every other kind (van/bus/loader/
-- tractor/machinery/suv) keeps trusting the client-sent p_category_id
-- exactly as before — picking the kind already fully determines the
-- one matching category, nothing to resolve.
-- ═════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS submit_vehicle_registration(varchar, varchar, varchar, text, varchar, varchar, varchar, varchar, int, text, text, text, text, boolean, boolean, boolean, boolean, boolean, uuid[], uuid, boolean);

CREATE OR REPLACE FUNCTION submit_vehicle_registration(
  p_owner_name varchar, p_cnic_number varchar, p_father_husband_name varchar, p_address text,
  p_vehicle_type varchar, p_vehicle_number varchar, p_model varchar, p_color varchar, p_total_seats int,
  p_owner_id_card_url text, p_license_url text, p_vehicle_doc_url text, p_driver_photo_url text,
  p_wants_delivers boolean, p_wants_hourly boolean, p_wants_shadi boolean, p_wants_out_of_city boolean, p_wants_night_booking boolean,
  p_wants_service_class_ids uuid[] DEFAULT '{}', p_category_id uuid DEFAULT NULL, p_has_ac boolean DEFAULT false,
  p_vehicle_kind varchar DEFAULT NULL, p_engine_cc int DEFAULT NULL,
  p_is_electric boolean DEFAULT false, p_is_loader boolean DEFAULT false, p_is_luxury_declared boolean DEFAULT false
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_request_id uuid;
  v_category_id uuid := p_category_id;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in required.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM vehicles WHERE portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'A vehicle is already linked to your account.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM vehicle_registration_requests WHERE portal_user_id = v_portal_user_id AND status = 'pending') THEN
    RAISE EXCEPTION 'You already have a registration under review.' USING ERRCODE = 'P0001';
  END IF;
  IF trim(coalesce(p_owner_name, '')) = '' OR trim(coalesce(p_cnic_number, '')) = '' OR trim(coalesce(p_address, '')) = '' OR trim(coalesce(p_vehicle_type, '')) = '' THEN
    RAISE EXCEPTION 'Owner name, CNIC, address and vehicle type are required.' USING ERRCODE = 'P0001';
  END IF;
  IF p_owner_id_card_url IS NULL OR p_license_url IS NULL OR p_vehicle_doc_url IS NULL OR p_driver_photo_url IS NULL THEN
    RAISE EXCEPTION 'All four documents are required.' USING ERRCODE = 'P0001';
  END IF;

  IF p_vehicle_kind IN ('car', 'rickshaw', 'bike') THEN
    v_category_id := resolve_vehicle_category(p_vehicle_kind, p_engine_cc, p_has_ac, p_is_electric, p_is_loader, p_is_luxury_declared);
    IF v_category_id IS NULL THEN
      RAISE EXCEPTION 'Could not match your vehicle to a category from the details entered — double check the CC and try again.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO vehicle_registration_requests (
    portal_user_id, owner_name, cnic_number, father_husband_name, address,
    vehicle_type, vehicle_number, model, color, total_seats,
    owner_id_card_url, license_url, vehicle_doc_url, driver_photo_url,
    wants_delivers, wants_hourly, wants_shadi, wants_out_of_city, wants_night_booking, wants_service_class_ids, category_id, has_ac,
    engine_cc, is_electric, is_loader, is_luxury_declared
  ) VALUES (
    v_portal_user_id, trim(p_owner_name), trim(p_cnic_number), nullif(trim(p_father_husband_name), ''), trim(p_address),
    trim(p_vehicle_type), nullif(trim(p_vehicle_number), ''), nullif(trim(p_model), ''), nullif(trim(p_color), ''), p_total_seats,
    p_owner_id_card_url, p_license_url, p_vehicle_doc_url, p_driver_photo_url,
    p_wants_delivers, p_wants_hourly, p_wants_shadi, p_wants_out_of_city, p_wants_night_booking, coalesce(p_wants_service_class_ids, '{}'), v_category_id, p_has_ac,
    p_engine_cc, coalesce(p_is_electric, false), coalesce(p_is_loader, false), coalesce(p_is_luxury_declared, false)
  ) RETURNING id INTO v_request_id;

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION submit_vehicle_registration(varchar, varchar, varchar, text, varchar, varchar, varchar, varchar, int, text, text, text, text, boolean, boolean, boolean, boolean, boolean, uuid[], uuid, boolean, varchar, int, boolean, boolean, boolean) TO authenticated;

-- admin_approve_vehicle_registration — same signature, now also copies
-- the declared engine_cc/is_electric/is_loader/is_luxury_declared onto
-- the real vehicle row (same discipline has_ac already follows, 740).
CREATE OR REPLACE FUNCTION admin_approve_vehicle_registration(
  p_request_id uuid, p_is_village_resident boolean,
  p_per_km_pkr numeric DEFAULT NULL, p_hourly_rate_pkr numeric DEFAULT NULL, p_hourly_included_km numeric DEFAULT NULL,
  p_hourly_overage_per_km_pkr numeric DEFAULT NULL, p_shadi_full_day_rate_pkr numeric DEFAULT NULL,
  p_service_class_ids uuid[] DEFAULT NULL, p_category_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE r vehicle_registration_requests%ROWTYPE; v_vehicle_id uuid; v_class_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_registration_requests WHERE id = p_request_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'This request has already been reviewed.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM vehicles WHERE portal_user_id = r.portal_user_id) THEN
    RAISE EXCEPTION 'This driver already has a linked vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF r.wants_delivers AND p_per_km_pkr IS NULL THEN RAISE EXCEPTION 'Per-km rate is required — this driver requested delivery.' USING ERRCODE = 'P0001'; END IF;
  IF r.wants_hourly AND (p_hourly_rate_pkr IS NULL OR p_hourly_included_km IS NULL OR p_hourly_overage_per_km_pkr IS NULL) THEN
    RAISE EXCEPTION 'Hourly rate, included km and overage rate are required — this driver requested hourly rental.' USING ERRCODE = 'P0001';
  END IF;
  IF r.wants_shadi AND p_shadi_full_day_rate_pkr IS NULL THEN RAISE EXCEPTION 'Shadi day-rate is required — this driver requested shadi bookings.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicles (
    owner_name, vehicle_type, vehicle_number, model, color, has_ac, total_seats, portal_user_id, is_active,
    delivers, per_km_pkr, offers_hourly, hourly_rate_pkr, hourly_included_km, hourly_overage_per_km_pkr,
    offers_shadi, shadi_full_day_rate_pkr, allows_out_of_city, night_booking_enabled, category_id,
    engine_cc, is_electric, is_loader, is_luxury_declared
  ) VALUES (
    r.owner_name, r.vehicle_type, r.vehicle_number, r.model, r.color, r.has_ac, r.total_seats, r.portal_user_id, true,
    r.wants_delivers, p_per_km_pkr, r.wants_hourly, p_hourly_rate_pkr, p_hourly_included_km, p_hourly_overage_per_km_pkr,
    r.wants_shadi, p_shadi_full_day_rate_pkr, r.wants_out_of_city, r.wants_night_booking, COALESCE(p_category_id, r.category_id),
    r.engine_cc, r.is_electric, r.is_loader, r.is_luxury_declared
  ) RETURNING id INTO v_vehicle_id;

  IF p_service_class_ids IS NOT NULL THEN
    FOREACH v_class_id IN ARRAY p_service_class_ids LOOP
      INSERT INTO vehicle_service_offers (vehicle_id, service_class_id) VALUES (v_vehicle_id, v_class_id)
      ON CONFLICT (vehicle_id, service_class_id) DO NOTHING;
    END LOOP;
  END IF;

  UPDATE vehicle_registration_requests SET
    status = 'approved', is_village_resident = p_is_village_resident, reviewed_by = current_admin_user_id(), reviewed_at = now(), vehicle_id = v_vehicle_id
  WHERE id = p_request_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
  VALUES (r.portal_user_id, 'vehicle_registration_approved', 'Vehicle approved', r.owner_name || ' — ' || r.vehicle_type, '/portal/my-vehicle', r.tenant_id);

  RETURN v_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- admin_list_vehicle_registrations — surfaces the declared cc/electric/
-- loader/luxury flags plus the already-resolved category's own
-- vehicle_kind/min_cc/max_cc, so the review screen shows "declared:
-- 800cc, AC → resolved: Economy Car (AC)" instead of a blind pick.
CREATE OR REPLACE FUNCTION admin_list_vehicle_registrations(p_status varchar DEFAULT 'pending') RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'owner_name', r.owner_name, 'cnic_number', r.cnic_number, 'father_husband_name', r.father_husband_name, 'address', r.address,
    'vehicle_type', r.vehicle_type, 'vehicle_number', r.vehicle_number, 'model', r.model, 'color', r.color, 'has_ac', r.has_ac, 'total_seats', r.total_seats,
    'owner_id_card_url', r.owner_id_card_url, 'license_url', r.license_url, 'vehicle_doc_url', r.vehicle_doc_url, 'driver_photo_url', r.driver_photo_url,
    'wants_delivers', r.wants_delivers, 'wants_hourly', r.wants_hourly, 'wants_shadi', r.wants_shadi,
    'wants_out_of_city', r.wants_out_of_city, 'wants_night_booking', r.wants_night_booking, 'wants_service_class_ids', r.wants_service_class_ids,
    'status', r.status, 'is_village_resident', r.is_village_resident, 'rejection_reason', r.rejection_reason,
    'created_at', r.created_at, 'reviewed_at', r.reviewed_at,
    'submitter_name', pu.full_name, 'submitter_mobile', pu.mobile,
    'category_id', r.category_id, 'category_name', vc.name, 'category_name_ur', vc.name_ur, 'category_emoji', vc.emoji,
    'category_per_km_pkr', vc.per_km_pkr, 'category_vehicle_kind', vc.vehicle_kind, 'category_min_cc', vc.min_cc, 'category_max_cc', vc.max_cc,
    'engine_cc', r.engine_cc, 'is_electric', r.is_electric, 'is_loader', r.is_loader, 'is_luxury_declared', r.is_luxury_declared
  ) ORDER BY r.created_at DESC), '[]'::jsonb)
  FROM vehicle_registration_requests r JOIN portal_users pu ON pu.id = r.portal_user_id
  LEFT JOIN vehicle_categories vc ON vc.id = r.category_id
  WHERE current_admin_permission('manage_parties') AND (p_status IS NULL OR r.status = p_status)
  LIMIT 200;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════
-- ride_group_options — adds the 6th tile (compact_car) between
-- small_car and car, matching the new middle CC band. Body otherwise
-- unchanged from 781.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION ride_group_options() RETURNS jsonb AS $$
  SELECT jsonb_agg(g.row ORDER BY g.sort) FROM (
    SELECT 1 AS sort, jsonb_build_object('ride_group', 'small_car', 'emoji', '🚗', 'filter_dimension', 'ac',
      'filter_options', jsonb_build_array(jsonb_build_object('value', 'ac', 'emoji', '❄️'), jsonb_build_object('value', 'non_ac', 'emoji', '☀️'))) AS row
    UNION ALL
    SELECT 2, jsonb_build_object('ride_group', 'compact_car', 'emoji', '🚗', 'filter_dimension', 'ac',
      'filter_options', jsonb_build_array(jsonb_build_object('value', 'ac', 'emoji', '❄️'), jsonb_build_object('value', 'non_ac', 'emoji', '☀️')))
    UNION ALL
    SELECT 3, jsonb_build_object('ride_group', 'car', 'emoji', '🚘', 'filter_dimension', null, 'filter_options', '[]'::jsonb)
    UNION ALL
    SELECT 4, jsonb_build_object('ride_group', 'suv', 'emoji', '🚙', 'filter_dimension', null, 'filter_options', '[]'::jsonb)
    UNION ALL
    SELECT 5, jsonb_build_object('ride_group', 'bike', 'emoji', '🛵', 'filter_dimension', 'electric',
      'filter_options', jsonb_build_array(jsonb_build_object('value', 'regular', 'emoji', '🛵'), jsonb_build_object('value', 'electric', 'emoji', '🔋')))
    UNION ALL
    SELECT 6, jsonb_build_object('ride_group', 'rickshaw', 'emoji', '🛺', 'filter_dimension', 'electric',
      'filter_options', jsonb_build_array(jsonb_build_object('value', 'other', 'emoji', '🛺'), jsonb_build_object('value', 'electric', 'emoji', '🔋')))
  ) g
  WHERE EXISTS (SELECT 1 FROM vehicle_categories c WHERE c.tenant_id = my_tenant_id() AND c.is_active AND c.ride_group = g.row->>'ride_group');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
