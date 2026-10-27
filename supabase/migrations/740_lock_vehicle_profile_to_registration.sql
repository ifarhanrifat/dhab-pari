-- Real asks, 2026-10-27:
-- 1) "in the my vehical page user can update and select the catagory
--    of its cars like small car, big car etc? it should be bound to
--    the backend not front end, and this will be implemented while
--    registering that vehical, also color and model cant be changed
--    by the driver itself, image should be matching with the driver
--    car"
-- 2) "now when a driver which having no ac at all cant be marked the
--    checked box with ac on its catalog" — a driver with no AC
--    shouldn't be able to just tick "has AC" on themselves.
--
-- Traced the real gap: category_id is already registration-time +
-- admin-approved-only (707) — that part was already correct. But
-- color, model AND has_ac are a different story: my-vehicle/catalog's
-- set_vehicle_catalog_prefs() (474, still true through 714) lets the
-- *driver themselves* silently rewrite all three, any time, with zero
-- verification — exactly the "driver ticks AC on a car with no AC" and
-- "driver swaps their registered model/colour" bugs reported. These
-- three are real-world-verifiable facts about the physical vehicle
-- (same class as category), so they move to the same place category
-- already lives: driver-declared once at registration, locked after
-- admin approval, editable only by the committee (admin's own vehicles
-- screen already does a direct `vehicles` table update — no change
-- needed there).
--
-- has_ac never existed on vehicle_registration_requests at all (only
-- on the live vehicles row, defaulting to false on every single past
-- approval) — added here so a driver can declare it up front, same as
-- color/model.

ALTER TABLE vehicle_registration_requests ADD COLUMN IF NOT EXISTS has_ac boolean NOT NULL DEFAULT false;

-- submit_vehicle_registration gains a trailing p_has_ac — new overload
-- rule applies again (same class of bug fixed repeatedly this
-- session), so the prior 20-arg signature is dropped first.
DROP FUNCTION IF EXISTS submit_vehicle_registration(varchar, varchar, varchar, text, varchar, varchar, varchar, varchar, int, text, text, text, text, boolean, boolean, boolean, boolean, boolean, uuid[], uuid);

CREATE OR REPLACE FUNCTION submit_vehicle_registration(
  p_owner_name varchar, p_cnic_number varchar, p_father_husband_name varchar, p_address text,
  p_vehicle_type varchar, p_vehicle_number varchar, p_model varchar, p_color varchar, p_total_seats int,
  p_owner_id_card_url text, p_license_url text, p_vehicle_doc_url text, p_driver_photo_url text,
  p_wants_delivers boolean, p_wants_hourly boolean, p_wants_shadi boolean, p_wants_out_of_city boolean, p_wants_night_booking boolean,
  p_wants_service_class_ids uuid[] DEFAULT '{}', p_category_id uuid DEFAULT NULL, p_has_ac boolean DEFAULT false
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
    wants_delivers, wants_hourly, wants_shadi, wants_out_of_city, wants_night_booking, wants_service_class_ids, category_id, has_ac
  ) VALUES (
    v_portal_user_id, trim(p_owner_name), trim(p_cnic_number), nullif(trim(p_father_husband_name), ''), trim(p_address),
    trim(p_vehicle_type), nullif(trim(p_vehicle_number), ''), nullif(trim(p_model), ''), nullif(trim(p_color), ''), p_total_seats,
    p_owner_id_card_url, p_license_url, p_vehicle_doc_url, p_driver_photo_url,
    p_wants_delivers, p_wants_hourly, p_wants_shadi, p_wants_out_of_city, p_wants_night_booking, coalesce(p_wants_service_class_ids, '{}'), p_category_id, p_has_ac
  ) RETURNING id INTO v_request_id;

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION submit_vehicle_registration(varchar, varchar, varchar, text, varchar, varchar, varchar, varchar, int, text, text, text, text, boolean, boolean, boolean, boolean, boolean, uuid[], uuid, boolean) TO authenticated;

-- admin_approve_vehicle_registration: same signature, now also carries
-- the declared has_ac onto the real vehicle row instead of silently
-- defaulting to false on every approval.
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
    offers_shadi, shadi_full_day_rate_pkr, allows_out_of_city, night_booking_enabled, category_id
  ) VALUES (
    r.owner_name, r.vehicle_type, r.vehicle_number, r.model, r.color, r.has_ac, r.total_seats, r.portal_user_id, true,
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

-- admin_list_vehicle_registrations: surface has_ac so the review
-- screen can show what was declared (same signature, no DROP needed).
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
    'category_per_km_pkr', vc.per_km_pkr
  ) ORDER BY r.created_at DESC), '[]'::jsonb)
  FROM vehicle_registration_requests r JOIN portal_users pu ON pu.id = r.portal_user_id
  LEFT JOIN vehicle_categories vc ON vc.id = r.category_id
  WHERE current_admin_permission('manage_parties') AND (p_status IS NULL OR r.status = p_status)
  LIMIT 200;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- set_vehicle_catalog_prefs: color/model/has_ac are now a committee-
-- verified, registration-time fact (same class as category_id, which
-- was already locked this way) — a driver calling this RPC can still
-- toggle offers_hourly/offers_shadi/offers_rental/shadi_vehicle_class/
-- rental_tier exactly as before, but their own color/model/has_ac
-- values are silently kept as-is rather than overwritten. Admin
-- (manage_parties) keeps full write access to all three, same as it
-- always has via the admin vehicles screen's own direct table update.
CREATE OR REPLACE FUNCTION set_vehicle_catalog_prefs(
  p_vehicle_id uuid, p_color text, p_model text, p_has_ac boolean, p_offers_hourly boolean, p_offers_shadi boolean,
  p_offers_rental boolean DEFAULT NULL::boolean, p_shadi_vehicle_class character varying DEFAULT NULL::character varying,
  p_rental_tier character varying DEFAULT NULL::character varying
) RETURNS void AS $$
DECLARE v vehicles%ROWTYPE; v_is_admin boolean;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  v_is_admin := COALESCE(current_admin_permission('manage_parties'), false);
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
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
  IF p_rental_tier IS NOT NULL AND p_rental_tier NOT IN ('small_ac', 'small_non_ac', 'big_ac', 'big_non_ac', 'suv', 'luxury') THEN
    RAISE EXCEPTION 'Unknown rental category.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicles SET
    color = CASE WHEN v_is_admin THEN NULLIF(trim(p_color), '') ELSE color END,
    model = CASE WHEN v_is_admin THEN NULLIF(trim(p_model), '') ELSE model END,
    has_ac = CASE WHEN v_is_admin THEN p_has_ac ELSE has_ac END,
    offers_hourly = p_offers_hourly, offers_shadi = p_offers_shadi,
    offers_rental = COALESCE(p_offers_rental, offers_rental),
    shadi_vehicle_class = CASE WHEN p_shadi_vehicle_class IS NOT NULL THEN p_shadi_vehicle_class ELSE shadi_vehicle_class END,
    rental_tier = CASE WHEN p_rental_tier IS NOT NULL THEN p_rental_tier ELSE rental_tier END
  WHERE id = p_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION set_vehicle_catalog_prefs(uuid, text, text, boolean, boolean, boolean, boolean, varchar, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_vehicle_catalog_prefs(uuid, text, text, boolean, boolean, boolean, boolean, varchar, varchar) TO authenticated;
