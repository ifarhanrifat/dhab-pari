-- Migration 886: route amenities — the non-monetary half of the
-- "promotional entitlements" item (free meal/WiFi/AC/etc shown to a
-- rider deciding between buses), same descriptive-tag shape as
-- service_class (883). Deliberately NOT discount/coupon logic: that
-- half stays out — it's the one piece the SAFAR reference dashboard
-- itself never specified past "Draft," and real discount math belongs
-- nowhere near fare_per_seat_pkr after the regression already hit
-- once this session from touching shared pricing code.

ALTER TABLE vehicle_routes ADD COLUMN IF NOT EXISTS amenities varchar[] NOT NULL DEFAULT '{}'
  CHECK (amenities <@ ARRAY['ac', 'wifi', 'meal', 'charging', 'tv', 'toilet', 'water']::varchar[]);

CREATE OR REPLACE FUNCTION set_route_amenities(p_route_id uuid, p_amenities varchar[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (COALESCE(p_amenities, '{}') <@ ARRAY['ac', 'wifi', 'meal', 'charging', 'tv', 'toilet', 'water']::varchar[]) THEN
    RAISE EXCEPTION 'Unknown amenity.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE vehicle_routes SET amenities = COALESCE(p_amenities, '{}') WHERE id = p_route_id;
END;
$$;
