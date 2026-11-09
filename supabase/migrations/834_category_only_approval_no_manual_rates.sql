-- Migration 834: real ask, 2026-11-10 — "there should be absolutely no
-- manual input for the admin or staff end like manually entering the
-- fares, kms, rent hour rate etc instead admin or staff after
-- confirmation just attach it to a category and that's it... what is
-- for intercity, and what is for outstation — this will also be fixed
-- in those category fare cards." Machinery/tractor/loader are
-- explicitly deferred to a future fleet-owner-negotiated system per
-- the user — untouched here.
--
-- Today admin_approve_vehicle_registration makes the committee hand-
-- type per_km_pkr/hourly_rate_pkr/hourly_included_km/
-- hourly_overage_per_km_pkr/shadi_full_day_rate_pkr for every single
-- approval. vehicle_categories (707+) already carries the intercity
-- rate (base_fare_pkr/per_km_pkr) and the outstation rate
-- (out_of_city_base_fare_pkr/out_of_city_per_km_pkr, 788/791) — it was
-- just never extended to also carry the hourly/shadi rate card, so
-- those two kept needing a human to type a number every time. Adding
-- them here closes that, and the approval RPC now reads every rate off
-- the resolved category instead of taking any of them as input.
--
-- Also fixes two concrete bugs found while stress-testing the CC bands
-- last pass: (1) no car band existed above 1800cc unless the driver
-- declared luxury, so a real, honestly-declared 2800cc non-luxury car
-- hit a hard "no category" dead end; (2) the BETWEEN comparison used
-- for CC matching never matches when max_cc is NULL (an "open-ended"
-- band), which would have silently broken the fix in (1) if written
-- the obvious way.

-- ═════════════════════════════════════════════════════════════════════
-- The category's fare card now also carries hourly + shadi rates, same
-- discipline as every other rate field here: nullable, so an unset
-- category simply can't be approved into those services yet (checked
-- below) rather than silently defaulting to some invented number.
-- ═════════════════════════════════════════════════════════════════════
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS hourly_rate_pkr decimal CHECK (hourly_rate_pkr IS NULL OR hourly_rate_pkr >= 0);
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS hourly_included_km decimal CHECK (hourly_included_km IS NULL OR hourly_included_km >= 0);
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS hourly_overage_per_km_pkr decimal CHECK (hourly_overage_per_km_pkr IS NULL OR hourly_overage_per_km_pkr >= 0);
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS shadi_full_day_rate_pkr decimal CHECK (shadi_full_day_rate_pkr IS NULL OR shadi_full_day_rate_pkr >= 0);

-- ═════════════════════════════════════════════════════════════════════
-- CC gap fix: a 4th car band, open-ended at the top, so any honestly-
-- declared CC resolves to something — luxury stays a separate self-
-- declared override on top of this, not the only way past 1800cc.
-- Cloned from the nearest real rate card (big_car_ac), never invented.
-- ═════════════════════════════════════════════════════════════════════
INSERT INTO vehicle_categories (
  tenant_id, key, name, name_ur, emoji, base_fare_pkr, per_km_pkr, intercity_commission_pct, out_of_city_commission_pct,
  category_group, out_of_city_eligible, out_of_city_base_fare_pkr, out_of_city_per_km_pkr, route_stake_pkr,
  vehicle_kind, min_cc, max_cc, fare_spread_pct, example_models_hint, example_models_hint_ur,
  ride_group, display_order
)
SELECT src.tenant_id, 'large_car', 'Large Car', 'بڑی کار', '🚘',
  src.base_fare_pkr, src.per_km_pkr, src.intercity_commission_pct, src.out_of_city_commission_pct,
  src.category_group, src.out_of_city_eligible, src.out_of_city_base_fare_pkr, src.out_of_city_per_km_pkr, src.route_stake_pkr,
  'car', 1801, NULL, 0.25, 'Land Cruiser, Fortuner, big sedans above 1800cc', 'لینڈ کروزر، فارچیونر، 1800 سی سی سے بڑی سیڈان',
  'car', 12
FROM vehicle_categories src WHERE src.key = 'big_car_ac' AND src.is_active
ON CONFLICT (tenant_id, key) DO NOTHING;

-- resolve_vehicle_category: fixed comparison (max_cc IS NULL now means
-- "no ceiling", not "never matches"), everything else unchanged.
CREATE OR REPLACE FUNCTION resolve_vehicle_category(
  p_kind varchar, p_cc int DEFAULT NULL, p_has_ac boolean DEFAULT NULL,
  p_is_electric boolean DEFAULT false, p_is_loader boolean DEFAULT false, p_is_luxury boolean DEFAULT false
) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM vehicle_categories
  WHERE tenant_id = COALESCE(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND is_active
    AND vehicle_kind = p_kind
    AND is_luxury_tier = (p_kind = 'car' AND coalesce(p_is_luxury, false))
    AND (min_cc IS NULL OR (p_cc IS NOT NULL AND p_cc >= min_cc AND (max_cc IS NULL OR p_cc <= max_cc)))
    AND (requires_ac IS NULL OR (p_has_ac IS NOT NULL AND requires_ac = p_has_ac))
    AND (requires_electric IS NULL OR requires_electric = coalesce(p_is_electric, false))
    AND (requires_loader IS NULL OR requires_loader = coalesce(p_is_loader, false))
  ORDER BY min_cc NULLS LAST LIMIT 1;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- admin_approve_vehicle_registration: every rate param dropped. The
-- only input left besides which request and village-resident status is
-- an optional category override — every actual number (delivery per-
-- km, hourly rate+included km+overage, shadi day-rate) now comes
-- straight off the resolved category's own fare card. If the driver
-- requested a service the category has no rate configured for yet,
-- approval is blocked with a clear message instead of inserting a NULL
-- rate silently — the fix there is to set the category's rate in
-- Marketplace Reference once, not to type a number per driver forever.
-- service_classes confirmation is also gone — its one real remaining
-- job (delivery eligibility) is already carried by wants_delivers +
-- the vehicle's own category, so there's nothing left for a second
-- confirmation step to add.
-- ═════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS admin_approve_vehicle_registration(uuid, boolean, numeric, numeric, numeric, numeric, numeric, uuid[], uuid);

CREATE OR REPLACE FUNCTION admin_approve_vehicle_registration(
  p_request_id uuid, p_is_village_resident boolean, p_category_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE r vehicle_registration_requests%ROWTYPE; vc vehicle_categories%ROWTYPE; v_vehicle_id uuid; v_category_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_registration_requests WHERE id = p_request_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'This request has already been reviewed.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM vehicles WHERE portal_user_id = r.portal_user_id) THEN
    RAISE EXCEPTION 'This driver already has a linked vehicle.' USING ERRCODE = 'P0001';
  END IF;

  v_category_id := COALESCE(p_category_id, r.category_id);
  IF v_category_id IS NULL THEN RAISE EXCEPTION 'This request has no category — reject it and ask the driver to resubmit.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO vc FROM vehicle_categories WHERE id = v_category_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Category not found.' USING ERRCODE = 'P0001'; END IF;

  IF r.wants_delivers AND (vc.per_km_pkr IS NULL OR vc.per_km_pkr <= 0) THEN
    RAISE EXCEPTION 'The % category has no delivery rate set yet — set it in Marketplace Reference before approving this driver for delivery.', vc.name USING ERRCODE = 'P0001';
  END IF;
  IF r.wants_hourly AND (vc.hourly_rate_pkr IS NULL OR vc.hourly_included_km IS NULL OR vc.hourly_overage_per_km_pkr IS NULL) THEN
    RAISE EXCEPTION 'The % category has no hourly rate set yet — set it in Marketplace Reference before approving this driver for hourly rental.', vc.name USING ERRCODE = 'P0001';
  END IF;
  IF r.wants_shadi AND (vc.shadi_full_day_rate_pkr IS NULL OR vc.shadi_full_day_rate_pkr <= 0) THEN
    RAISE EXCEPTION 'The % category has no shadi day-rate set yet — set it in Marketplace Reference before approving this driver for shadi bookings.', vc.name USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO vehicles (
    owner_name, vehicle_type, vehicle_number, model, color, has_ac, total_seats, portal_user_id, is_active,
    delivers, per_km_pkr, offers_hourly, hourly_rate_pkr, hourly_included_km, hourly_overage_per_km_pkr,
    offers_shadi, shadi_full_day_rate_pkr, allows_out_of_city, night_booking_enabled, category_id,
    engine_cc, is_electric, is_loader, is_luxury_declared
  ) VALUES (
    r.owner_name, r.vehicle_type, r.vehicle_number, r.model, r.color, r.has_ac, r.total_seats, r.portal_user_id, true,
    r.wants_delivers, CASE WHEN r.wants_delivers THEN vc.per_km_pkr ELSE NULL END,
    r.wants_hourly, CASE WHEN r.wants_hourly THEN vc.hourly_rate_pkr ELSE NULL END,
    CASE WHEN r.wants_hourly THEN vc.hourly_included_km ELSE NULL END, CASE WHEN r.wants_hourly THEN vc.hourly_overage_per_km_pkr ELSE NULL END,
    r.wants_shadi, CASE WHEN r.wants_shadi THEN vc.shadi_full_day_rate_pkr ELSE NULL END,
    r.wants_out_of_city, r.wants_night_booking, v_category_id,
    r.engine_cc, r.is_electric, r.is_loader, r.is_luxury_declared
  ) RETURNING id INTO v_vehicle_id;

  UPDATE vehicle_registration_requests SET
    status = 'approved', is_village_resident = p_is_village_resident, reviewed_by = current_admin_user_id(), reviewed_at = now(), vehicle_id = v_vehicle_id
  WHERE id = p_request_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
  VALUES (r.portal_user_id, 'vehicle_registration_approved', 'Vehicle approved', r.owner_name || ' — ' || r.vehicle_type, '/portal/my-vehicle', r.tenant_id);

  RETURN v_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION admin_approve_vehicle_registration(uuid, boolean, uuid) TO authenticated;

-- admin_list_vehicle_registrations: surfaces the resolved category's
-- full fare card (intercity, outstation, hourly, shadi) so the review
-- screen can show the admin exactly what approving will set, with
-- nothing left to type.
CREATE OR REPLACE FUNCTION admin_list_vehicle_registrations(p_status varchar DEFAULT 'pending') RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'owner_name', r.owner_name, 'cnic_number', r.cnic_number, 'father_husband_name', r.father_husband_name, 'address', r.address,
    'vehicle_type', r.vehicle_type, 'vehicle_number', r.vehicle_number, 'model', r.model, 'color', r.color, 'has_ac', r.has_ac, 'total_seats', r.total_seats,
    'owner_id_card_url', r.owner_id_card_url, 'license_url', r.license_url, 'vehicle_doc_url', r.vehicle_doc_url, 'driver_photo_url', r.driver_photo_url,
    'wants_delivers', r.wants_delivers, 'wants_hourly', r.wants_hourly, 'wants_shadi', r.wants_shadi,
    'wants_out_of_city', r.wants_out_of_city, 'wants_night_booking', r.wants_night_booking,
    'status', r.status, 'is_village_resident', r.is_village_resident, 'rejection_reason', r.rejection_reason,
    'created_at', r.created_at, 'reviewed_at', r.reviewed_at,
    'submitter_name', pu.full_name, 'submitter_mobile', pu.mobile,
    'category_id', r.category_id, 'category_name', vc.name, 'category_name_ur', vc.name_ur, 'category_emoji', vc.emoji,
    'category_vehicle_kind', vc.vehicle_kind, 'category_min_cc', vc.min_cc, 'category_max_cc', vc.max_cc,
    'category_per_km_pkr', vc.per_km_pkr, 'category_out_of_city_per_km_pkr', vc.out_of_city_per_km_pkr,
    'category_hourly_rate_pkr', vc.hourly_rate_pkr, 'category_hourly_included_km', vc.hourly_included_km, 'category_hourly_overage_per_km_pkr', vc.hourly_overage_per_km_pkr,
    'category_shadi_full_day_rate_pkr', vc.shadi_full_day_rate_pkr,
    'engine_cc', r.engine_cc, 'is_electric', r.is_electric, 'is_loader', r.is_loader, 'is_luxury_declared', r.is_luxury_declared
  ) ORDER BY r.created_at DESC), '[]'::jsonb)
  FROM vehicle_registration_requests r JOIN portal_users pu ON pu.id = r.portal_user_id
  LEFT JOIN vehicle_categories vc ON vc.id = r.category_id
  WHERE current_admin_permission('manage_parties') AND (p_status IS NULL OR r.status = p_status)
  LIMIT 200;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
