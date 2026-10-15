-- Migration 664: real gap flagged live — "he can set his vehicle type to
-- car and hiace for the wedding car" — a driver's self-selected
-- shadi_vehicle_class (sedan/bolan/hiace) was never checked against
-- their own vehicle's actual vehicle_type. A Bolan owner could pick the
-- "hiace" class and collect its day-rate (9,000 vs Bolan's 4,200 — more
-- than double), with nothing stopping it. Fixed with a keyword-plausibility
-- check: the real vehicle_type strings in this committee's own data are
-- free text ("Toyota Hiace", "Suzuki Bolan (wedding van)", "Honda City",
-- "Toyota Corolla (decorated)", etc.) — not a closed enum — so this
-- checks the obvious keyword rather than requiring an exact match. A
-- driver whose own vehicle_type doesn't mention "hiace"/"bolan" can only
-- pick 'sedan', which already covers every real passenger-car entry in
-- the data today.
CREATE OR REPLACE FUNCTION set_vehicle_catalog_prefs(p_vehicle_id uuid, p_color text, p_model text, p_has_ac boolean, p_offers_hourly boolean, p_offers_shadi boolean, p_offers_rental boolean DEFAULT NULL::boolean, p_shadi_vehicle_class character varying DEFAULT NULL::character varying)
 RETURNS void AS $$
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

  UPDATE vehicles SET
    color = NULLIF(trim(p_color), ''), model = NULLIF(trim(p_model), ''),
    has_ac = p_has_ac, offers_hourly = p_offers_hourly, offers_shadi = p_offers_shadi,
    offers_rental = COALESCE(p_offers_rental, offers_rental),
    shadi_vehicle_class = CASE WHEN p_shadi_vehicle_class IS NOT NULL THEN p_shadi_vehicle_class ELSE shadi_vehicle_class END
  WHERE id = p_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
