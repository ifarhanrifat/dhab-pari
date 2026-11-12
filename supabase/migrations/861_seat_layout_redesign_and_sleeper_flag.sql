-- Migration 861: real bus seat-layout redesign (real ask: "study the
-- bus seating system of Daewoo and Faisal Movers then sleeper buses and
-- fix the seating layout accordingly"). The seat grid itself is pure
-- frontend math (seatGrid.ts/SeatPicker.tsx) and needs no schema change
-- — van-kind vehicles already had everything required (total_seats,
-- route_seat_status for taken seats). The one genuinely new piece is a
-- sleeper flag: a coach's seat layout can't be inferred from total_
-- seats alone (a 30-seat bus could be ordinary 2+1 business class OR a
-- 30-berth sleeper), so an owner needs a real way to declare it.
--
-- Mirrors has_ac/offers_hourly's own precedent on vehicles — a plain
-- boolean column, settable through the existing set_vehicle_catalog_
-- prefs() RPC (474/838) rather than a new one, same owner-only gate
-- that RPC already enforces.

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS is_sleeper boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION set_vehicle_catalog_prefs(
  p_vehicle_id uuid, p_color text, p_model text, p_has_ac boolean, p_offers_hourly boolean, p_offers_shadi boolean,
  p_offers_rental boolean DEFAULT NULL::boolean, p_shadi_vehicle_class character varying DEFAULT NULL::character varying,
  p_rental_tier character varying DEFAULT NULL::character varying, p_model_year int DEFAULT NULL,
  p_is_sleeper boolean DEFAULT NULL
) RETURNS void AS $$
DECLARE v vehicles%ROWTYPE; v_is_admin boolean; v_tier varchar;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  v_is_admin := COALESCE(current_admin_permission('manage_parties'), false);
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;

  v_tier := v.rental_tier;
  IF v_is_admin AND p_rental_tier IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM rental_tier_fare_guides g WHERE g.tenant_id = v.tenant_id AND g.tier_key = p_rental_tier) THEN
      RAISE EXCEPTION 'Unknown rental category.' USING ERRCODE = 'P0001';
    END IF;
    v_tier := p_rental_tier;
  END IF;

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
    model_year = COALESCE(p_model_year, model_year),
    is_sleeper = COALESCE(p_is_sleeper, is_sleeper)
  WHERE id = p_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
