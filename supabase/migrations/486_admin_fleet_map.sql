-- Fleet-wide live map for the admin overview, per the v2 design handoff
-- (§2.5 item 3): "You had per-vehicle GPS but no committee view of it."
--
-- Deliberately its own admin-only function rather than reusing
-- nearby_open_trips() (415) as-is: that one is scoped for rider
-- discovery (destination filter, radius, and it deliberately hides a
-- vehicle still sitting at the adda it checked in at — noise for a
-- rider, but exactly the kind of thing a committee might want to see).
-- The admin view is unfiltered: every vehicle currently pinging on
-- either a live one-off trip or an in-progress hourly job.
CREATE OR REPLACE FUNCTION admin_fleet_locations() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(row), '[]'::jsonb) FROM (
    SELECT jsonb_build_object(
      'source', 'trip', 'ref_id', o.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile,
      'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
      'context', o.origin || ' → ' || o.destination, 'lat', l.lat, 'lng', l.lng, 'updated_at', l.updated_at
    ) AS row
    FROM vehicle_trip_offers o
    JOIN vehicles v ON v.id = o.vehicle_id
    JOIN vehicle_trip_offer_locations l ON l.trip_offer_id = o.id
    WHERE o.share_live_location AND l.updated_at > now() - interval '5 minutes'

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
    WHERE b.status = 'in_progress' AND latest.recorded_at > now() - interval '5 minutes'
  ) rows;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Wrapped by the admin permission check itself rather than left as a
-- bare STABLE SQL function grantable to authenticated — unlike
-- portal_user_trust (483), this returns exact live coordinates, mobile
-- numbers and pickup addresses, which is real information to keep
-- admin-only.
CREATE OR REPLACE FUNCTION admin_fleet_locations_guarded() RETURNS jsonb AS $$
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  RETURN admin_fleet_locations();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE;
GRANT EXECUTE ON FUNCTION admin_fleet_locations_guarded() TO authenticated;
REVOKE EXECUTE ON FUNCTION admin_fleet_locations() FROM PUBLIC, authenticated, anon;
