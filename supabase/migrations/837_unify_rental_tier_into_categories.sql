-- Migration 837: real ask, 2026-11-10 — "there is still choti gari ac
-- and choti gari without ac and bari gadi ac and without ac... garbage
-- still exist" in Marketplace Reference's "Rental & Hourly" tab.
--
-- Root cause: a SEPARATE, parallel fare system (rental_tier_fare_guides
-- + vehicles.rental_tier, 714/786/787/795) powers the real Hourly and
-- Rental bookings today — completely independent of vehicle_categories,
-- with its own admin-editable rate grid (the "choti gari ac" rows) and
-- its own manual per-vehicle tier assignment. Exactly the "admin has to
-- manually configure this separately" duplication 834 was built to
-- kill, just in a corner deliberately left alone earlier this session.
--
-- The numbers already in rental_tier_fare_guides are good — clean,
-- consistent, already committee-set (unlike the noisy per-vehicle data
-- found earlier this session) — so this carries them onto the matching
-- vehicle_categories rows rather than inventing anything, then makes
-- vehicle_categories the single source of truth going forward via a
-- sync trigger, so admin only ever edits rates in ONE place.
--
-- Deliberately NOT touched (too risky to rewrite in the same pass as a
-- 19-migration-deep, continuously-live booking/dispatch subsystem):
-- create_hourly_booking, create_rental_booking, hourly_tier_options,
-- rental_tier_options, the broadcast/accept/decline matching functions,
-- my_hourly_bookings, my_rental_bookings. All of these keep reading
-- rental_tier_fare_guides and vehicles.rental_tier exactly as before —
-- only WHERE those values come from changes, not any business logic
-- that depends on them (2-hour minimum, GPS outstation detection,
-- overage scaling, idempotency dedup, model-year matching all stay
-- byte-for-byte as they are). Zero behavior change for any booking
-- through these functions.
--
-- Scope boundary: only the 10 categories that map 1:1 onto an existing
-- tier (Economy/Family Car AC+Non-AC, SUV, Luxury, Van, Hiace, Coaster,
-- Bus) get unified here. Compact Car, Suzuki Carry Dabba, Suzuki Ravi
-- and Suzuki Bolan never had an Hourly/Rental tier in the old system
-- either (the CHECK constraint never allowed one for them) — leaving
-- them unmapped is not a regression, just not yet extended; the
-- existing manual tier-pickers (/admin/vehicles, driver's own vehicle
-- catalog page) still work exactly as before for that rare case.

ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS rental_tier_key varchar;
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS rental_base_pkr decimal;
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS rental_per_km_pkr decimal;
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS rental_wait_hour_pkr decimal;
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS hourly_out_of_city_base_pkr decimal;
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS hourly_out_of_city_per_km_pkr decimal;

-- hourly_included_km (834) is redefined here, before it was ever read
-- by a real booking function, to mean "km included per hour" — matching
-- rental_tier_fare_guides.hourly_included_km_per_hour's real semantics
-- (create_hourly_booking multiplies it by the hours booked). No column
-- rename needed, just documenting the true meaning going forward.

UPDATE vehicle_categories SET rental_tier_key = CASE key
  WHEN 'small_car_ac' THEN 'small_ac' WHEN 'small_car_non_ac' THEN 'small_non_ac'
  WHEN 'big_car_ac' THEN 'big_ac' WHEN 'big_car_non_ac' THEN 'big_non_ac'
  WHEN 'suv' THEN 'suv' WHEN 'luxury' THEN 'luxury'
  WHEN 'van' THEN 'van' WHEN 'hiace' THEN 'hiace' WHEN 'coaster' THEN 'coaster' WHEN 'bus' THEN 'bus'
  ELSE NULL END
WHERE key IN ('small_car_ac', 'small_car_non_ac', 'big_car_ac', 'big_car_non_ac', 'suv', 'luxury', 'van', 'hiace', 'coaster', 'bus') AND is_active;

-- Carry the real numbers forward — straight copy, never invented.
UPDATE vehicle_categories vc SET
  hourly_rate_pkr = g.hourly_rate_pkr,
  hourly_included_km = g.hourly_included_km_per_hour,
  hourly_overage_per_km_pkr = g.hourly_overage_per_km_pkr,
  rental_base_pkr = g.rental_base_pkr,
  rental_per_km_pkr = g.rental_per_km_pkr,
  rental_wait_hour_pkr = g.rental_wait_hour_pkr,
  hourly_out_of_city_base_pkr = g.out_of_city_base_pkr,
  hourly_out_of_city_per_km_pkr = g.out_of_city_per_km_pkr
FROM rental_tier_fare_guides g
WHERE vc.rental_tier_key = g.tier_key AND vc.tenant_id = g.tenant_id;

-- Going forward, admin edits only vehicle_categories (Marketplace
-- Reference's existing per-category fare card) — this trigger keeps
-- rental_tier_fare_guides in sync automatically, so create_hourly_
-- booking/create_rental_booking/hourly_tier_options/rental_tier_
-- options/broadcast dispatch need zero changes and can never silently
-- drift from the category's own rate card again.
CREATE OR REPLACE FUNCTION sync_rental_tier_fare_guide() RETURNS trigger AS $$
BEGIN
  IF NEW.rental_tier_key IS NOT NULL THEN
    UPDATE rental_tier_fare_guides SET
      hourly_rate_pkr = NEW.hourly_rate_pkr,
      hourly_included_km_per_hour = NEW.hourly_included_km,
      hourly_overage_per_km_pkr = NEW.hourly_overage_per_km_pkr,
      rental_base_pkr = NEW.rental_base_pkr,
      rental_per_km_pkr = NEW.rental_per_km_pkr,
      rental_wait_hour_pkr = NEW.rental_wait_hour_pkr,
      out_of_city_base_pkr = NEW.hourly_out_of_city_base_pkr,
      out_of_city_per_km_pkr = NEW.hourly_out_of_city_per_km_pkr
    WHERE tenant_id = NEW.tenant_id AND tier_key = NEW.rental_tier_key;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS vehicle_categories_sync_rental_tier ON vehicle_categories;
CREATE TRIGGER vehicle_categories_sync_rental_tier
  AFTER INSERT OR UPDATE OF hourly_rate_pkr, hourly_included_km, hourly_overage_per_km_pkr,
    rental_base_pkr, rental_per_km_pkr, rental_wait_hour_pkr, hourly_out_of_city_base_pkr, hourly_out_of_city_per_km_pkr
  ON vehicle_categories
  FOR EACH ROW EXECUTE FUNCTION sync_rental_tier_fare_guide();

-- admin_approve_vehicle_registration: same as 834, plus rental_tier is
-- now set automatically from the resolved category — no more manual
-- "go to /admin/vehicles and pick choti gari ac" step for the 10
-- unified categories. The manual picker still exists as a fallback for
-- the 4 categories with no rental_tier_key yet.
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
    engine_cc, is_electric, is_loader, is_luxury_declared, rental_tier
  ) VALUES (
    r.owner_name, r.vehicle_type, r.vehicle_number, r.model, r.color, r.has_ac, r.total_seats, r.portal_user_id, true,
    r.wants_delivers, CASE WHEN r.wants_delivers THEN vc.per_km_pkr ELSE NULL END,
    r.wants_hourly, CASE WHEN r.wants_hourly THEN vc.hourly_rate_pkr ELSE NULL END,
    CASE WHEN r.wants_hourly THEN vc.hourly_included_km ELSE NULL END, CASE WHEN r.wants_hourly THEN vc.hourly_overage_per_km_pkr ELSE NULL END,
    r.wants_shadi, CASE WHEN r.wants_shadi THEN vc.shadi_full_day_rate_pkr ELSE NULL END,
    r.wants_out_of_city, r.wants_night_booking, v_category_id,
    r.engine_cc, r.is_electric, r.is_loader, r.is_luxury_declared, vc.rental_tier_key
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
