-- Follow-up to 741, same day: "i stil can select and save new catagory
-- of my own van in my vehical catagory page" — 741 only blocked a
-- *mismatched* AC pairing (e.g. "big_ac" on a non-AC vehicle); the
-- driver could still freely pick and save among the *matching* options
-- (small vs big vs SUV vs luxury), which is exactly the self-service
-- category-picking the original ask wanted bound to the backend, not
-- the driver. rental_tier moves to the same full lock as
-- color/model/has_ac (740): committee-set only, via the admin vehicles
-- screen (now has its own rental_tier picker), never driver-editable.

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
  IF v_is_admin AND p_rental_tier IS NOT NULL AND p_rental_tier NOT IN ('small_ac', 'small_non_ac', 'big_ac', 'big_non_ac', 'suv', 'luxury') THEN
    RAISE EXCEPTION 'Unknown rental category.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicles SET
    color = CASE WHEN v_is_admin THEN NULLIF(trim(p_color), '') ELSE color END,
    model = CASE WHEN v_is_admin THEN NULLIF(trim(p_model), '') ELSE model END,
    has_ac = CASE WHEN v_is_admin THEN p_has_ac ELSE has_ac END,
    offers_hourly = p_offers_hourly, offers_shadi = p_offers_shadi,
    offers_rental = COALESCE(p_offers_rental, offers_rental),
    shadi_vehicle_class = CASE WHEN p_shadi_vehicle_class IS NOT NULL THEN p_shadi_vehicle_class ELSE shadi_vehicle_class END,
    rental_tier = CASE WHEN v_is_admin AND p_rental_tier IS NOT NULL THEN p_rental_tier ELSE rental_tier END
  WHERE id = p_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION set_vehicle_catalog_prefs(uuid, text, text, boolean, boolean, boolean, boolean, varchar, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_vehicle_catalog_prefs(uuid, text, text, boolean, boolean, boolean, boolean, varchar, varchar) TO authenticated;
