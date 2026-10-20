-- Migration 714: Car Rental gets the same real category taxonomy as
-- Shadi (713) -- direct ask: "small cars, with ac without ac, and big
-- cars with ac without ac, then SUVs and luxury cars categories should
-- appear... right after choosing the destination and start point."
-- No such tier concept existed anywhere (confirmed: vehicle_categories
-- is a coarse vehicle-class taxonomy car/bike/van/etc, not a rental
-- size/trim tier) -- new, driver-settable via the same
-- set_vehicle_catalog_prefs() path shadi_vehicle_class already uses.
--
-- Real pre-existing bug found while touching this function: THREE
-- stale overloads of set_vehicle_catalog_prefs (6-arg from 474, 7-arg
-- from 653, 8-arg from 664) are all live simultaneously right now --
-- none of 653/664 dropped the signature they were superseding. The
-- one real caller (my-vehicle/catalog/page.tsx) happens to always pass
-- every named param, which is the only reason this hasn't silently
-- misrouted to a stale overload yet. Cleaned up here while adding a
-- 9th param, rather than stacking a 4th overload on an already-broken pile.
DROP FUNCTION IF EXISTS set_vehicle_catalog_prefs(uuid, text, text, boolean, boolean, boolean);
DROP FUNCTION IF EXISTS set_vehicle_catalog_prefs(uuid, text, text, boolean, boolean, boolean, boolean);
DROP FUNCTION IF EXISTS set_vehicle_catalog_prefs(uuid, text, text, boolean, boolean, boolean, boolean, varchar);

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS rental_tier varchar CHECK (rental_tier IN ('small_ac', 'small_non_ac', 'big_ac', 'big_non_ac', 'suv', 'luxury'));

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
  IF p_rental_tier IS NOT NULL AND p_rental_tier NOT IN ('small_ac', 'small_non_ac', 'big_ac', 'big_non_ac', 'suv', 'luxury') THEN
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
REVOKE ALL ON FUNCTION set_vehicle_catalog_prefs(uuid, text, text, boolean, boolean, boolean, boolean, varchar, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_vehicle_catalog_prefs(uuid, text, text, boolean, boolean, boolean, boolean, varchar, varchar) TO authenticated;

-- rental_bookable_vehicles / my_rental_bookings: surface rental_tier,
-- same signature, same every other field, byte-identical otherwise.
CREATE OR REPLACE FUNCTION rental_bookable_vehicles() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'color', v.color, 'model', v.model,
    'category_name', vc.name, 'category_name_ur', vc.name_ur, 'rental_tier', v.rental_tier,
    'rental_base_pkr', v.rental_base_pkr, 'rental_per_km_pkr', v.rental_per_km_pkr, 'rental_wait_hour_pkr', v.rental_wait_hour_pkr,
    'cover_url', (SELECT m.url FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.is_cover LIMIT 1),
    'avg_rating', (SELECT round(avg(r.stars)::numeric, 1) FROM ratings r WHERE r.target_party_type = 'vehicle' AND r.target_party_id = v.id),
    'shared_from_other_village', v.tenant_id <> my_tenant_id(),
    'owner_village_name', CASE WHEN v.tenant_id <> my_tenant_id() THEN (SELECT t.name FROM tenants t WHERE t.id = v.tenant_id) ELSE NULL END
  ) ORDER BY v.owner_name), '[]'::jsonb)
  FROM vehicles v LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
  WHERE v.is_active AND v.offers_rental AND v.rental_base_pkr IS NOT NULL AND v.rental_per_km_pkr IS NOT NULL
    AND (v.tenant_id = my_tenant_id() OR EXISTS (
      SELECT 1 FROM marketplace_share_agreements sa
      WHERE sa.owner_tenant_id = v.tenant_id AND sa.target_tenant_id = my_tenant_id() AND sa.category = 'rental' AND sa.is_active
    ));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION my_rental_bookings() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'from_address', b.from_address, 'from_lat', b.from_lat, 'from_lng', b.from_lng,
    'to_address', b.to_address, 'to_lat', b.to_lat, 'to_lng', b.to_lng, 'trip_type', b.trip_type, 'wait_hours', b.wait_hours,
    'km', b.km, 'status', b.status, 'decline_reason', b.decline_reason, 'pin', b.pin,
    'base_amount_pkr', b.base_amount_pkr, 'trip_amount_pkr', b.trip_amount_pkr, 'wait_amount_pkr', b.wait_amount_pkr, 'total_amount_pkr', b.total_amount_pkr,
    'notes', b.notes, 'payment_method', b.payment_method,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'vehicle_id', b.vehicle_id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color,
    'category_name', vc.name, 'category_name_ur', vc.name_ur, 'rental_tier', v.rental_tier
  ) ORDER BY b.requested_at DESC), '[]'::jsonb)
  FROM rental_bookings b JOIN vehicles v ON v.id = b.vehicle_id LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
  WHERE b.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_rental_bookings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_rental_bookings() TO authenticated;
