-- Migration 838: follow-through on 833-837, 2026-11-10 — "make
-- registration and fare cards professional-grade". Everything here was
-- verified against the live database (read-only) before being written:
-- 3 tenants × 30 category rows, 29 vehicles (all on one tenant), 1
-- pending registration, 30 rental_tier_fare_guides rows, 3 shadi
-- classes. Nothing in this file touches create_hourly_booking,
-- create_rental_booking, the broadcast/accept/decline matching, or the
-- adda queue — they keep reading rental_tier / rental_tier_fare_guides
-- byte-for-byte as before.
--
-- Five things, each independently small:
--
--  1. submit_vehicle_registration — closes the last client-trust gap
--     833 left open. 833 derives the category server-side for
--     car/rickshaw/bike, but for every other kind it still inserted
--     whatever category_id the client sent, unvalidated: a tampered
--     client could send p_vehicle_kind = NULL with the 'luxury' (or any
--     car band's) id and skip the CC resolver entirely. Now a client-
--     sent category must be an active row in the caller's own tenant
--     whose vehicle_kind is NOT one of the resolver-owned kinds; cars
--     must declare a CC; an unknown kind string is rejected.
--
--  2. suzuki_carry_dabba + suzuki_ravi retired into 'van'. Confirmed
--     live: all three rows are identical in every rate/commission/
--     ride_group/hint field on every tenant (835 already gave them one
--     shared hint: "Van, Suzuki Carry Dabba, Suzuki Ravi"), zero
--     vehicles, zero registration requests and zero vehicle_models
--     reference either of the two — every one of the 12 van models
--     already sits on 'van'. (One already-cancelled ride_dispatch_
--     request points at one of them: history, FK stays valid, left
--     alone exactly as 833/836 did.) Three equal-weight registration tiles for one rate card is
--     exactly the "ad-hoc rows" problem 833 set out to fix. Retired
--     with is_active = false, never deleted; the admin "Show
--     deactivated categories → Activate" toggle reverses it in one tap.
--     Side effect worth naming: since 'van' already carries the
--     committee's van hourly/rental tier (837), this closes two of the
--     four "no rental/hourly rate" gaps without inventing a number.
--
--  3. vehicles.rental_tier backfilled from the category's own
--     rental_tier_key where it was NULL. 837 only set the tier for
--     approvals from that point on; 9 live vehicles sitting on a
--     unified category (small_car_ac/non_ac, van) still had no tier, so
--     their drivers could never opt into Hourly/Rental without an admin
--     hand-picking "choti gari ac" on /admin/vehicles — the exact manual
--     step 837 was written to remove. Data-only; matching is untouched.
--     Only fills NULLs, never overrides a committee-set tier.
--
--  4. Shadi day-rate carried onto the two categories that map 1:1 onto
--     an existing, committee-set shadi_vehicle_classes row (654):
--     suzuki_bolan ← 'bolan', hiace ← 'hiace'. Straight copy, never
--     invented, same discipline 837 used for the rental grid. The
--     'sedan' class is deliberately NOT copied — it spans every car band
--     (Economy through Luxury) at one price, which is a committee call,
--     not a mapping. Every other category's shadi rate stays NULL (=
--     "not offered until the committee sets it", 834's own rule).
--
--  5. hourly_tier_options / rental_tier_options now also return the
--     linked category's fare_spread_pct + example_models_hint(_ur) +
--     name so the rider-facing Hourly and Rental tiles can show the same
--     "Rs 1,200–1,600 · Mehran, Alto" range+hint the point-to-point
--     tiles already show (833), instead of one flat number. Purely
--     additive JSON keys; the booking sheet still quotes the exact
--     committee figure.
--
--  6. set_vehicle_catalog_prefs — two real bugs. (a) 742 locked
--     rental_tier to admin-only ("never driver-editable"); 787's rewrite
--     dropped the v_is_admin guard from both the validation and the
--     UPDATE, so a driver has been able to set their own tier (e.g.
--     'luxury', 'bus') and be matched into those jobs ever since. The
--     lock is restored. (b) The "can I turn Hourly/Rental on" gates
--     checked the per-vehicle rental_base_pkr / hourly_rate_pkr columns,
--     which NOTHING live prices from any more (create_rental_booking and
--     create_hourly_booking price from rental_tier_fare_guides by
--     rental_tier since 787) — so a driver was blocked for lacking a
--     number nobody uses, while 3 live vehicles carry per-vehicle rental
--     numbers (800+25/km, 500+35/km, 1000+60/km) that differ from what
--     riders are actually charged (250+16, 350+18). The gate is now
--     "this vehicle has a rental_tier with a fare guide in this tenant",
--     which is the real precondition for being matched at all.
--
--  7. vehicles.rental_base_pkr / rental_per_km_pkr / rental_wait_hour_pkr
--     are documented as deprecated (COMMENT ON COLUMN), not dropped:
--     zero live readers after this migration (the last one was the gate
--     in 6b; the only remaining references are the dead
--     rental_bookable_vehicles / hourly_bookable_vehicles listers from
--     714/786 that no screen calls). Kept for history; the admin and
--     driver screens stop showing/editing them in the same commit.

-- ═════════════════════════════════════════════════════════════════════
-- 1. submit_vehicle_registration — validate the client-sent category.
--    Same signature as 833 (CREATE OR REPLACE, no drop needed).
-- ═════════════════════════════════════════════════════════════════════
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
  v_tenant_id uuid := COALESCE(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
  v_kind varchar := NULLIF(trim(coalesce(p_vehicle_kind, '')), '');
  v_request_id uuid;
  v_category_id uuid;
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

  -- Declared-kind path: the category is always derived here, never
  -- taken from the client (833). Tightened: an unknown kind string is
  -- rejected instead of silently falling through to the client-trust
  -- path, and a car must declare its CC (the band is meaningless
  -- without it — luxury included, the CC is still a fact on record).
  IF v_kind IS NOT NULL AND v_kind NOT IN ('car', 'rickshaw', 'bike') THEN
    RAISE EXCEPTION 'Unknown vehicle kind.' USING ERRCODE = 'P0001';
  END IF;
  IF v_kind = 'car' AND p_engine_cc IS NULL THEN
    RAISE EXCEPTION 'Engine CC is required for a car.' USING ERRCODE = 'P0001';
  END IF;
  IF p_engine_cc IS NOT NULL AND (p_engine_cc < 50 OR p_engine_cc > 10000) THEN
    RAISE EXCEPTION 'Engine CC looks wrong — enter the real engine size in CC.' USING ERRCODE = 'P0001';
  END IF;

  IF v_kind IS NOT NULL THEN
    v_category_id := resolve_vehicle_category(v_kind, p_engine_cc, p_has_ac, p_is_electric, p_is_loader, p_is_luxury_declared);
    IF v_category_id IS NULL THEN
      RAISE EXCEPTION 'Could not match your vehicle to a category from the details entered — double check the CC and try again.' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    -- Simple-pick path (van/suv/bus/loader/tractor/machinery/...): the
    -- client-sent id must be a real, active category in the caller's
    -- own tenant, and must NOT be a kind the resolver owns — otherwise
    -- a tampered client could hand-pick 'luxury' and skip the CC band.
    IF p_category_id IS NULL THEN
      RAISE EXCEPTION 'Pick your vehicle type.' USING ERRCODE = 'P0001';
    END IF;
    SELECT id INTO v_category_id FROM vehicle_categories
    WHERE id = p_category_id AND tenant_id = v_tenant_id AND is_active
      AND COALESCE(vehicle_kind, '') NOT IN ('car', 'rickshaw', 'bike');
    IF v_category_id IS NULL THEN
      RAISE EXCEPTION 'That vehicle type must be registered by its kind and engine CC — pick Car, Rickshaw or Bike and enter the details.' USING ERRCODE = 'P0001';
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

-- ═════════════════════════════════════════════════════════════════════
-- 2. Retire suzuki_carry_dabba + suzuki_ravi into 'van'. Remap every FK
--    first (all no-ops today — confirmed zero rows — same discipline as
--    833/836), then deactivate. Never deleted.
-- ═════════════════════════════════════════════════════════════════════
UPDATE vehicles v SET category_id = dest.id
FROM vehicle_categories src, vehicle_categories dest
WHERE v.category_id = src.id AND src.key IN ('suzuki_carry_dabba', 'suzuki_ravi')
  AND dest.tenant_id = src.tenant_id AND dest.key = 'van';

UPDATE vehicle_registration_requests r SET category_id = dest.id
FROM vehicle_categories src, vehicle_categories dest
WHERE r.category_id = src.id AND src.key IN ('suzuki_carry_dabba', 'suzuki_ravi')
  AND dest.tenant_id = src.tenant_id AND dest.key = 'van';

UPDATE vehicle_models m SET category_id = dest.id
FROM vehicle_categories src, vehicle_categories dest
WHERE m.category_id = src.id AND src.key IN ('suzuki_carry_dabba', 'suzuki_ravi')
  AND dest.tenant_id = src.tenant_id AND dest.key = 'van';

UPDATE vehicle_categories SET is_active = false
WHERE key IN ('suzuki_carry_dabba', 'suzuki_ravi');

-- ═════════════════════════════════════════════════════════════════════
-- 2b. User's explicit choice (over building 2 brand-new tiers from
--     invented numbers): Compact Car shares the Economy/small_car
--     tier's rate; Suzuki Bolan shares the Van tier's rate. Straight
--     copy of that tier's existing committee numbers onto the category
--     — same "never invent, only carry forward" discipline as 837 and
--     step 4 below. A later admin edit to either category re-prices the
--     one shared tier for every category/vehicle on it, which is the
--     correct behaviour for "sharing a tier" rather than independent
--     numbers that happen to start out equal.
-- ═════════════════════════════════════════════════════════════════════
UPDATE vehicle_categories
SET rental_tier_key = CASE key
  WHEN 'compact_car_ac' THEN 'small_ac'
  WHEN 'compact_car_non_ac' THEN 'small_non_ac'
  WHEN 'suzuki_bolan' THEN 'van'
END
WHERE key IN ('compact_car_ac', 'compact_car_non_ac', 'suzuki_bolan') AND is_active AND rental_tier_key IS NULL;

UPDATE vehicle_categories vc SET
  hourly_rate_pkr = g.hourly_rate_pkr, hourly_included_km = g.hourly_included_km_per_hour, hourly_overage_per_km_pkr = g.hourly_overage_per_km_pkr,
  rental_base_pkr = g.rental_base_pkr, rental_per_km_pkr = g.rental_per_km_pkr, rental_wait_hour_pkr = g.rental_wait_hour_pkr,
  hourly_out_of_city_base_pkr = g.out_of_city_base_pkr, hourly_out_of_city_per_km_pkr = g.out_of_city_per_km_pkr
FROM rental_tier_fare_guides g
WHERE vc.key IN ('compact_car_ac', 'compact_car_non_ac', 'suzuki_bolan') AND vc.tenant_id = g.tenant_id
  AND vc.rental_tier_key = g.tier_key AND vc.hourly_rate_pkr IS NULL;

-- ═════════════════════════════════════════════════════════════════════
-- 3. Backfill vehicles.rental_tier from the category (NULLs only).
--    Runs after 2b so compact_car / suzuki_bolan vehicles are included.
-- ═════════════════════════════════════════════════════════════════════
UPDATE vehicles v SET rental_tier = vc.rental_tier_key
FROM vehicle_categories vc
WHERE v.category_id = vc.id AND v.rental_tier IS NULL AND vc.rental_tier_key IS NOT NULL
  AND EXISTS (SELECT 1 FROM rental_tier_fare_guides g WHERE g.tenant_id = v.tenant_id AND g.tier_key = vc.rental_tier_key);

-- ═════════════════════════════════════════════════════════════════════
-- 4. Shadi day-rate: 1:1 carry from shadi_vehicle_classes (NULLs only).
-- ═════════════════════════════════════════════════════════════════════
UPDATE vehicle_categories vc SET shadi_full_day_rate_pkr = sc.full_day_rate_pkr
FROM shadi_vehicle_classes sc
WHERE vc.is_active AND vc.shadi_full_day_rate_pkr IS NULL AND sc.is_active
  AND ((vc.key = 'suzuki_bolan' AND sc.class_key = 'bolan') OR (vc.key = 'hiace' AND sc.class_key = 'hiace'));

-- ═════════════════════════════════════════════════════════════════════
-- 4b. User's explicit choice: the committee's 'sedan' Shadi day-rate
--     (5,500) applies to every active car-kind category for now, never
--     overriding a value already set. Van/Coaster/Bus/Bike/Rickshaw are
--     deliberately left unset — user's explicit choice to keep Shadi to
--     cars + Hiace/Bolan only; still "not offered" per 834's own rule.
-- ═════════════════════════════════════════════════════════════════════
UPDATE vehicle_categories vc SET shadi_full_day_rate_pkr = sc.full_day_rate_pkr
FROM shadi_vehicle_classes sc
WHERE vc.is_active AND vc.vehicle_kind = 'car' AND vc.shadi_full_day_rate_pkr IS NULL
  AND sc.is_active AND sc.class_key = 'sedan';

-- ═════════════════════════════════════════════════════════════════════
-- 5. hourly_tier_options / rental_tier_options — additive keys for the
--    rider tiles: category_name(_ur), fare_spread_pct,
--    example_models_hint(_ur). Bodies otherwise identical to 807 / 797.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION hourly_tier_options() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'tier_key', g.tier_key, 'vehicle_count', cnt.n,
    'hourly_rate_pkr', g.hourly_rate_pkr, 'hourly_included_km_per_hour', g.hourly_included_km_per_hour, 'hourly_overage_per_km_pkr', g.hourly_overage_per_km_pkr,
    'out_of_city_per_km_pkr', g.out_of_city_per_km_pkr,
    'out_of_city_hourly_rate_pkr', round(g.hourly_rate_pkr * (g.out_of_city_base_pkr / NULLIF(g.rental_base_pkr, 0))),
    'category_name', c.name, 'category_name_ur', c.name_ur, 'fare_spread_pct', c.fare_spread_pct,
    'example_models_hint', c.example_models_hint, 'example_models_hint_ur', c.example_models_hint_ur
  ) ORDER BY g.display_order), '[]'::jsonb)
  FROM rental_tier_fare_guides g
  JOIN LATERAL (SELECT count(*) AS n FROM vehicles v WHERE v.rental_tier = g.tier_key AND v.is_active AND v.offers_hourly AND v.tenant_id = my_tenant_id()) cnt ON cnt.n > 0
  LEFT JOIN LATERAL (
    SELECT c.name, c.name_ur, c.fare_spread_pct, c.example_models_hint, c.example_models_hint_ur
    FROM vehicle_categories c WHERE c.tenant_id = g.tenant_id AND c.rental_tier_key = g.tier_key AND c.is_active
    ORDER BY c.display_order LIMIT 1
  ) c ON true
  WHERE g.tenant_id = my_tenant_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION rental_tier_options() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'tier_key', g.tier_key, 'vehicle_count', cnt.n,
    'rental_base_pkr', g.rental_base_pkr, 'rental_per_km_pkr', g.rental_per_km_pkr, 'rental_wait_hour_pkr', g.rental_wait_hour_pkr,
    'out_of_city_base_pkr', g.out_of_city_base_pkr, 'out_of_city_per_km_pkr', g.out_of_city_per_km_pkr,
    'category_name', c.name, 'category_name_ur', c.name_ur, 'fare_spread_pct', c.fare_spread_pct,
    'example_models_hint', c.example_models_hint, 'example_models_hint_ur', c.example_models_hint_ur
  ) ORDER BY g.display_order), '[]'::jsonb)
  FROM rental_tier_fare_guides g
  JOIN LATERAL (SELECT count(*) AS n FROM vehicles v WHERE v.rental_tier = g.tier_key AND v.is_active AND v.offers_rental AND v.tenant_id = my_tenant_id()) cnt ON cnt.n > 0
  LEFT JOIN LATERAL (
    SELECT c.name, c.name_ur, c.fare_spread_pct, c.example_models_hint, c.example_models_hint_ur
    FROM vehicle_categories c WHERE c.tenant_id = g.tenant_id AND c.rental_tier_key = g.tier_key AND c.is_active
    ORDER BY c.display_order LIMIT 1
  ) c ON true
  WHERE g.tenant_id = my_tenant_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════
-- 6. set_vehicle_catalog_prefs — restore the 742 admin-only tier lock,
--    gate Hourly/Rental on the tier (what matching actually uses), stop
--    reading the deprecated per-vehicle rental_* columns. Same
--    signature as 787.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION set_vehicle_catalog_prefs(
  p_vehicle_id uuid, p_color text, p_model text, p_has_ac boolean, p_offers_hourly boolean, p_offers_shadi boolean,
  p_offers_rental boolean DEFAULT NULL::boolean, p_shadi_vehicle_class character varying DEFAULT NULL::character varying,
  p_rental_tier character varying DEFAULT NULL::character varying, p_model_year int DEFAULT NULL
) RETURNS void AS $$
DECLARE v vehicles%ROWTYPE; v_is_admin boolean; v_tier varchar;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  v_is_admin := COALESCE(current_admin_permission('manage_parties'), false);
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;

  -- rental_tier is committee-set only (742). A driver-sent value is
  -- ignored, exactly as 742 did (the driver screen shows it read-only
  -- and echoes the current value back). Validity is checked against the
  -- tenant's real fare-guide rows rather than a hardcoded list, so a
  -- tier added later by data needs no function change.
  v_tier := v.rental_tier;
  IF v_is_admin AND p_rental_tier IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM rental_tier_fare_guides g WHERE g.tenant_id = v.tenant_id AND g.tier_key = p_rental_tier) THEN
      RAISE EXCEPTION 'Unknown rental category.' USING ERRCODE = 'P0001';
    END IF;
    v_tier := p_rental_tier;
  END IF;

  -- Hourly and Rental are matched AND priced by rental_tier →
  -- rental_tier_fare_guides (787+), so that is the only real
  -- precondition for switching either on.
  IF (p_offers_hourly OR COALESCE(p_offers_rental, false))
     AND (v_tier IS NULL OR NOT EXISTS (SELECT 1 FROM rental_tier_fare_guides g WHERE g.tenant_id = v.tenant_id AND g.tier_key = v_tier)) THEN
    RAISE EXCEPTION 'Ask the committee to set your rental category before turning this on — hourly and rental bookings are matched and priced by that category.' USING ERRCODE = 'P0001';
  END IF;
  IF p_offers_shadi AND v.shadi_full_day_rate_pkr IS NULL THEN
    RAISE EXCEPTION 'Ask the committee to set your full-day wedding rate before turning this on.' USING ERRCODE = 'P0001';
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

  UPDATE vehicles SET
    color = NULLIF(trim(p_color), ''), model = NULLIF(trim(p_model), ''),
    has_ac = p_has_ac, offers_hourly = p_offers_hourly, offers_shadi = p_offers_shadi,
    offers_rental = COALESCE(p_offers_rental, offers_rental),
    shadi_vehicle_class = CASE WHEN p_shadi_vehicle_class IS NOT NULL THEN p_shadi_vehicle_class ELSE shadi_vehicle_class END,
    rental_tier = v_tier,
    model_year = COALESCE(p_model_year, model_year)
  WHERE id = p_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════
-- 7. Deprecate (not drop) the per-vehicle rental rate columns.
-- ═════════════════════════════════════════════════════════════════════
COMMENT ON COLUMN vehicles.rental_base_pkr IS 'DEPRECATED (838): rental is priced from rental_tier_fare_guides via vehicles.rental_tier since 787. No live reader. Kept for history only.';
COMMENT ON COLUMN vehicles.rental_per_km_pkr IS 'DEPRECATED (838): rental is priced from rental_tier_fare_guides via vehicles.rental_tier since 787. No live reader. Kept for history only.';
COMMENT ON COLUMN vehicles.rental_wait_hour_pkr IS 'DEPRECATED (838): rental is priced from rental_tier_fare_guides via vehicles.rental_tier since 787. No live reader. Kept for history only.';
