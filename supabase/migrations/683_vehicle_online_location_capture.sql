-- Migration 683: real fix for "why is there a manual 'where are you
-- now' button instead of the system just knowing" -- going online now
-- captures one GPS fix automatically (not continuous tracking, that
-- stays reserved for the existing per-trip live-share feature). Also
-- fixes a real, separately-confirmed problem: fleet/distance logic
-- elsewhere in the app falls back to the village's own fixed center
-- point for any vehicle with no location on file -- an online-but-idle
-- driver was invisible to that math and to the admin fleet map, which
-- only ever showed vehicles actively live-sharing a posted trip or
-- mid hourly-booking, never just "online and available."

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS current_lat decimal;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS current_lng decimal;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS current_location_updated_at timestamptz;

-- Reproduced from its real, current body, with two new optional
-- params -- going online with a GPS fix stores it; going offline (or
-- going online without one, e.g. permission denied) leaves whatever
-- location is already on file untouched rather than clearing it, so a
-- last-known position still beats the old village-center fallback.
CREATE OR REPLACE FUNCTION public.set_vehicle_online_status(
  p_vehicle_id uuid, p_is_online boolean,
  p_lat decimal DEFAULT NULL, p_lng decimal DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND OR v.portal_user_id IS DISTINCT FROM current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF p_lat IS NOT NULL AND p_lng IS NOT NULL THEN
    UPDATE vehicles SET is_online = p_is_online, current_lat = p_lat, current_lng = p_lng, current_location_updated_at = now()
     WHERE id = p_vehicle_id;
  ELSE
    UPDATE vehicles SET is_online = p_is_online WHERE id = p_vehicle_id;
  END IF;
END;
$function$;

-- Reproduced from its real, current body, with one new UNION ALL arm
-- for a plain online-and-idle vehicle (not already covered by live
-- trip-sharing or an in-progress hourly booking -- NOT EXISTS guards
-- against showing the same vehicle twice under two sources at once).
-- A stale fix (driver's been online 20+ minutes without moving/
-- re-triggering) is still shown -- unlike the two live-tracking
-- sources, there's no continuous ping to judge staleness against, so
-- this is explicitly a "last known, not guaranteed current" pin,
-- distinguished by its own source label.
CREATE OR REPLACE FUNCTION public.admin_fleet_locations()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(row), '[]'::jsonb) FROM (
    SELECT jsonb_build_object(
      'source', 'trip', 'ref_id', o.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile,
      'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
      'context', o.origin || ' → ' || o.destination, 'lat', l.lat, 'lng', l.lng, 'updated_at', l.updated_at
    ) AS row
    FROM vehicle_trip_offers o
    JOIN vehicles v ON v.id = o.vehicle_id
    JOIN vehicle_trip_offer_locations l ON l.trip_offer_id = o.id
    WHERE o.tenant_id = my_tenant_id() AND o.share_live_location AND l.updated_at > now() - interval '5 minutes'

    UNION ALL

    SELECT jsonb_build_object(
      'source', 'hourly', 'ref_id', b.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile,
      'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
      'context', b.pickup_address, 'lat', latest.lat, 'lng', latest.lng, 'updated_at', latest.recorded_at
    ) AS row
    FROM hourly_bookings b
    JOIN vehicles v ON v.id = b.vehicle_id
    JOIN LATERAL (
      SELECT lat, lng, recorded_at FROM hourly_booking_locations hl
      WHERE hl.booking_id = b.id ORDER BY hl.recorded_at DESC LIMIT 1
    ) latest ON true
    WHERE b.tenant_id = my_tenant_id() AND b.status = 'in_progress' AND latest.recorded_at > now() - interval '5 minutes'

    UNION ALL

    SELECT jsonb_build_object(
      'source', 'online', 'ref_id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile,
      'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
      'context', 'Online, available', 'lat', v.current_lat, 'lng', v.current_lng, 'updated_at', v.current_location_updated_at
    ) AS row
    FROM vehicles v
    WHERE v.tenant_id = my_tenant_id() AND v.is_online AND v.current_lat IS NOT NULL AND v.current_lng IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM vehicle_trip_offers o2
        WHERE o2.vehicle_id = v.id AND o2.share_live_location
          AND EXISTS (SELECT 1 FROM vehicle_trip_offer_locations l2 WHERE l2.trip_offer_id = o2.id AND l2.updated_at > now() - interval '5 minutes')
      )
      AND NOT EXISTS (
        SELECT 1 FROM hourly_bookings b2
        WHERE b2.vehicle_id = v.id AND b2.status = 'in_progress'
          AND EXISTS (SELECT 1 FROM hourly_booking_locations hl2 WHERE hl2.booking_id = b2.id AND hl2.recorded_at > now() - interval '5 minutes')
      )
  ) rows;
$function$;
