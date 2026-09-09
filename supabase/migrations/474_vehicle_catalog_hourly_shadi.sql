-- Foundation for hourly rental + shadi (wedding) vehicle booking, both
-- confirmed directly: neither can work without vehicles actually
-- carrying a colour, a model, and the rates that make them bookable —
-- none of which exist on `vehicles` today.
--
-- vehicle_media (vehicle photos) turned out to ALREADY exist (388) —
-- missed on first read of this migration, caught when this file's own
-- first push attempt failed trying to re-create it. Reused as-is; its
-- own write policies are widened below (owner self-service, not just
-- admin) to match the confirmed decision that photos are the owner's
-- own to manage, unlike the rate fields.
--
-- Split ownership, confirmed directly and deliberately DIFFERENT from
-- per_km_pkr's own precedent (that one is owner self-service —
-- set_vehicle_delivery_prefs, 428):
--   - hourly_rate_pkr / hourly_included_km / hourly_overage_per_km_pkr —
--     committee/admin-set only, same as every other vehicles column the
--     admin panel already edits directly (vehicles_update's own RLS is
--     already admin-only — no new policy needed for these).
--   - color / model / has_ac / offers_hourly / offers_shadi — vehicle
--     owner's own self-service, same shape as set_vehicle_delivery_prefs.
--   - photos (vehicle_media) — the owner's own too, widened below.

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS color varchar;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS model varchar;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS has_ac boolean NOT NULL DEFAULT false;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS offers_hourly boolean NOT NULL DEFAULT false;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS offers_shadi boolean NOT NULL DEFAULT false;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS hourly_rate_pkr decimal CHECK (hourly_rate_pkr IS NULL OR hourly_rate_pkr >= 0);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS hourly_included_km decimal CHECK (hourly_included_km IS NULL OR hourly_included_km >= 0);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS hourly_overage_per_km_pkr decimal CHECK (hourly_overage_per_km_pkr IS NULL OR hourly_overage_per_km_pkr >= 0);

DROP POLICY IF EXISTS "vehicle_media_write" ON vehicle_media;
CREATE POLICY "vehicle_media_write" ON vehicle_media FOR INSERT TO authenticated
  WITH CHECK (current_admin_permission('manage_parties') OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id()));
DROP POLICY IF EXISTS "vehicle_media_update" ON vehicle_media;
CREATE POLICY "vehicle_media_update" ON vehicle_media FOR UPDATE TO authenticated
  USING (true) WITH CHECK (current_admin_permission('manage_parties') OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id()));
DROP POLICY IF EXISTS "vehicle_media_delete" ON vehicle_media;
CREATE POLICY "vehicle_media_delete" ON vehicle_media FOR DELETE TO authenticated
  USING (current_admin_permission('manage_parties') OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id()));

-- Owner self-service for everything EXCEPT the rate fields — vehicles'
-- own row RLS is admin-write-only (388), same reason
-- set_vehicle_delivery_prefs exists at all. Refuses to switch on
-- offers_hourly/offers_shadi until the committee has actually set a
-- rate — otherwise a vehicle could list itself as bookable at a null/
-- zero price.
CREATE OR REPLACE FUNCTION set_vehicle_catalog_prefs(
  p_vehicle_id uuid, p_color text, p_model text, p_has_ac boolean, p_offers_hourly boolean, p_offers_shadi boolean
) RETURNS void AS $$
DECLARE v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF (p_offers_hourly OR p_offers_shadi) AND v.hourly_rate_pkr IS NULL THEN
    RAISE EXCEPTION 'Ask the committee to set your rate before turning this on.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicles SET
    color = NULLIF(trim(p_color), ''), model = NULLIF(trim(p_model), ''),
    has_ac = p_has_ac, offers_hourly = p_offers_hourly, offers_shadi = p_offers_shadi
  WHERE id = p_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION set_vehicle_catalog_prefs(uuid, text, text, boolean, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_vehicle_catalog_prefs(uuid, text, text, boolean, boolean, boolean) TO authenticated;
