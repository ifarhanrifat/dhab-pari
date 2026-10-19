-- Migration 707: "create a full modern vehical add for new
-- registeration system and make the all catagories rate and
-- commission card separatly so when we select the cataogry of car
-- supposly then the rate card fare card etc will filled automatically."
--
-- Real gap: zero shared vehicle-category taxonomy exists anywhere in
-- this app today (confirmed by direct exploration) — equipment uses its
-- own booleans, "pro service" uses a coarse passenger/loading
-- service_classes.category, trip bookings key commission off free-text
-- vehicle_type via vehicle_type_commission_rates, and four other flows
-- each have their own separate, non-overlapping mechanism. This table
-- becomes the one real category system: a rate card (base fare, per-km)
-- and a commission card (intercity/out-of-city %, mirroring
-- vehicle_type_commission_rates' own existing two-classification shape
-- so trip-booking commission loses no fidelity when it's rewired onto
-- this in migration 709) per category, driver-picked at registration.
--
-- Seeded with the design source's own categories (.design_ref/app_source.jsx:
-- 🚗 car, 🛵 bike, 🚐 van, 🚚 loader, 🚜 tractor, 🏗️ machinery) plus
-- rickshaw (🛺) — a real vehicle type this app's own registration
-- placeholder already names ("e.g. HIACE, Rickshaw, Car") even though
-- the design mockup itself never drew a distinct rickshaw glyph.
-- Commission defaults are NOT invented: 'car' inherits the real,
-- already-committee-set 2%/2% override currently sitting in
-- vehicle_type_commission_rates for "Cars" (so no live vehicle's
-- commission silently changes when 709 rewires trip-booking commission
-- onto this table); every other category inherits today's real flat
-- site_settings defaults (10% intercity / 15% out-of-city / 10% equipment)
-- so nothing changes for an existing booking until the committee
-- deliberately differentiates a category via the new admin screen.

CREATE TABLE IF NOT EXISTS vehicle_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT COALESCE(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) REFERENCES tenants(id),
  key varchar NOT NULL,
  name varchar NOT NULL,
  name_ur varchar,
  emoji varchar NOT NULL,
  base_fare_pkr decimal NOT NULL DEFAULT 0 CHECK (base_fare_pkr >= 0),
  per_km_pkr decimal NOT NULL DEFAULT 0 CHECK (per_km_pkr >= 0),
  intercity_commission_pct decimal NOT NULL DEFAULT 10 CHECK (intercity_commission_pct >= 0),
  out_of_city_commission_pct decimal NOT NULL DEFAULT 15 CHECK (out_of_city_commission_pct >= 0),
  is_active boolean NOT NULL DEFAULT true,
  display_order int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  UNIQUE (tenant_id, key)
);
ALTER TABLE vehicle_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vehicle_categories_read" ON vehicle_categories FOR SELECT TO authenticated, anon USING (tenant_id = COALESCE(request_tenant_id(), my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid));
CREATE POLICY "vehicle_categories_admin_write" ON vehicle_categories FOR ALL TO authenticated
  USING (tenant_id = my_tenant_id() AND current_admin_permission('manage_parties')) WITH CHECK (tenant_id = my_tenant_id() AND current_admin_permission('manage_parties'));

INSERT INTO vehicle_categories (tenant_id, key, name, name_ur, emoji, base_fare_pkr, per_km_pkr, intercity_commission_pct, out_of_city_commission_pct, display_order)
SELECT t.id, c.key, c.name, c.name_ur, c.emoji, c.base_fare_pkr, c.per_km_pkr, c.intercity_pct, c.out_of_city_pct, c.display_order
FROM tenants t
CROSS JOIN (VALUES
  ('car', 'Car', 'کار', '🚗', 0, 12, 2, 2, 1),
  ('bike', 'Motorbike', 'موٹر بائیک', '🛵', 0, 8, 10, 15, 2),
  ('rickshaw', 'Rickshaw', 'رکشا', '🛺', 0, 9, 10, 15, 3),
  ('van', 'Van', 'وین', '🚐', 50, 15, 10, 15, 4),
  ('loader', 'Loader', 'لوڈر', '🚚', 100, 20, 10, 15, 5),
  ('tractor', 'Tractor', 'ٹریکٹر', '🚜', 0, 0, 10, 15, 6),
  ('machinery', 'Heavy Machinery', 'بھاری مشینری', '🏗️', 0, 0, 10, 15, 7)
) AS c(key, name, name_ur, emoji, base_fare_pkr, per_km_pkr, intercity_pct, out_of_city_pct, display_order)
ON CONFLICT (tenant_id, key) DO NOTHING;

-- vehicles.category_id — the new authoritative category. vehicle_type
-- (free text) stays untouched for every existing reader; new
-- registrations auto-set it from the category's own name (see 708's
-- frontend wiring note / submit_vehicle_registration below).
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES vehicle_categories(id);
ALTER TABLE vehicle_registration_requests ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES vehicle_categories(id);

CREATE OR REPLACE FUNCTION vehicle_category_commission_pct(p_category_id uuid, p_classification varchar) RETURNS decimal AS $$
  SELECT CASE WHEN p_classification = 'out_of_city' THEN out_of_city_commission_pct ELSE intercity_commission_pct END
  FROM vehicle_categories WHERE id = p_category_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_category_commission_pct(uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_category_commission_pct(uuid, varchar) TO authenticated;

-- submit_vehicle_registration gains a trailing p_category_id — adding a
-- trailing param creates a new overload rather than replacing in place
-- (same class of bug fixed several times already this session), so the
-- prior 19-arg signature is dropped first.
DROP FUNCTION IF EXISTS submit_vehicle_registration(varchar, varchar, varchar, text, varchar, varchar, varchar, varchar, int, text, text, text, text, boolean, boolean, boolean, boolean, boolean, uuid[]);

CREATE OR REPLACE FUNCTION submit_vehicle_registration(
  p_owner_name varchar, p_cnic_number varchar, p_father_husband_name varchar, p_address text,
  p_vehicle_type varchar, p_vehicle_number varchar, p_model varchar, p_color varchar, p_total_seats int,
  p_owner_id_card_url text, p_license_url text, p_vehicle_doc_url text, p_driver_photo_url text,
  p_wants_delivers boolean, p_wants_hourly boolean, p_wants_shadi boolean, p_wants_out_of_city boolean, p_wants_night_booking boolean,
  p_wants_service_class_ids uuid[] DEFAULT '{}', p_category_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_request_id uuid;
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

  INSERT INTO vehicle_registration_requests (
    portal_user_id, owner_name, cnic_number, father_husband_name, address,
    vehicle_type, vehicle_number, model, color, total_seats,
    owner_id_card_url, license_url, vehicle_doc_url, driver_photo_url,
    wants_delivers, wants_hourly, wants_shadi, wants_out_of_city, wants_night_booking, wants_service_class_ids, category_id
  ) VALUES (
    v_portal_user_id, trim(p_owner_name), trim(p_cnic_number), nullif(trim(p_father_husband_name), ''), trim(p_address),
    trim(p_vehicle_type), nullif(trim(p_vehicle_number), ''), nullif(trim(p_model), ''), nullif(trim(p_color), ''), p_total_seats,
    p_owner_id_card_url, p_license_url, p_vehicle_doc_url, p_driver_photo_url,
    p_wants_delivers, p_wants_hourly, p_wants_shadi, p_wants_out_of_city, p_wants_night_booking, coalesce(p_wants_service_class_ids, '{}'), p_category_id
  ) RETURNING id INTO v_request_id;

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION submit_vehicle_registration(varchar, varchar, varchar, text, varchar, varchar, varchar, varchar, int, text, text, text, text, boolean, boolean, boolean, boolean, boolean, uuid[], uuid) TO authenticated;

-- admin_approve_vehicle_registration: a pre-existing, independent bug
-- found while touching this — a stale 7-arg overload (missing
-- p_service_class_ids) was left live alongside the real 8-arg one from
-- a prior migration that added a trailing param without dropping the
-- old signature (the exact same class of bug already fixed elsewhere
-- this session). Dropped here while adding category_id for real.
DROP FUNCTION IF EXISTS admin_approve_vehicle_registration(uuid, boolean, numeric, numeric, numeric, numeric, numeric);
DROP FUNCTION IF EXISTS admin_approve_vehicle_registration(uuid, boolean, numeric, numeric, numeric, numeric, numeric, uuid[]);

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
    owner_name, vehicle_type, vehicle_number, model, color, total_seats, portal_user_id, is_active,
    delivers, per_km_pkr, offers_hourly, hourly_rate_pkr, hourly_included_km, hourly_overage_per_km_pkr,
    offers_shadi, shadi_full_day_rate_pkr, allows_out_of_city, night_booking_enabled, category_id
  ) VALUES (
    r.owner_name, r.vehicle_type, r.vehicle_number, r.model, r.color, r.total_seats, r.portal_user_id, true,
    r.wants_delivers, p_per_km_pkr, r.wants_hourly, p_hourly_rate_pkr, p_hourly_included_km, p_hourly_overage_per_km_pkr,
    r.wants_shadi, p_shadi_full_day_rate_pkr, r.wants_out_of_city, r.wants_night_booking, COALESCE(p_category_id, r.category_id)
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

-- admin_list_vehicle_registrations: surface category_id + the category's
-- own rate card so the approval screen can auto-fill p_per_km_pkr.
CREATE OR REPLACE FUNCTION admin_list_vehicle_registrations(p_status varchar DEFAULT 'pending') RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'owner_name', r.owner_name, 'cnic_number', r.cnic_number, 'father_husband_name', r.father_husband_name, 'address', r.address,
    'vehicle_type', r.vehicle_type, 'vehicle_number', r.vehicle_number, 'model', r.model, 'color', r.color, 'total_seats', r.total_seats,
    'owner_id_card_url', r.owner_id_card_url, 'license_url', r.license_url, 'vehicle_doc_url', r.vehicle_doc_url, 'driver_photo_url', r.driver_photo_url,
    'wants_delivers', r.wants_delivers, 'wants_hourly', r.wants_hourly, 'wants_shadi', r.wants_shadi,
    'wants_out_of_city', r.wants_out_of_city, 'wants_night_booking', r.wants_night_booking, 'wants_service_class_ids', r.wants_service_class_ids,
    'status', r.status, 'is_village_resident', r.is_village_resident, 'rejection_reason', r.rejection_reason,
    'created_at', r.created_at, 'reviewed_at', r.reviewed_at,
    'submitter_name', pu.full_name, 'submitter_mobile', pu.mobile,
    'category_id', r.category_id, 'category_name', vc.name, 'category_name_ur', vc.name_ur, 'category_emoji', vc.emoji,
    'category_per_km_pkr', vc.per_km_pkr
  ) ORDER BY r.created_at DESC), '[]'::jsonb)
  FROM vehicle_registration_requests r JOIN portal_users pu ON pu.id = r.portal_user_id
  LEFT JOIN vehicle_categories vc ON vc.id = r.category_id
  WHERE current_admin_permission('manage_parties') AND (p_status IS NULL OR r.status = p_status)
  LIMIT 200;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
