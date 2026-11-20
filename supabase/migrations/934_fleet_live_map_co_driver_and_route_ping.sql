-- 2026-11-20: real gap found while answering "where does admin see the
-- driver's live location" — fleet_vehicle_locations (854)'s "route"
-- source only ever matched a ping recorded under the vehicle's own
-- portal_user_id (the primary driver). A co-driver who's actually
-- driving (via the 879 shuffle mechanism) pings under their own
-- portal_user_id and would never show up on the fleet owner's Live
-- Fleet Map at all. True-replace, widened to match either driver.
CREATE OR REPLACE FUNCTION fleet_vehicle_locations(p_fleet_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(row), '[]'::jsonb) INTO v_result FROM (
    SELECT jsonb_build_object(
      'source', 'trip', 'ref_id', o.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
      'context', o.origin || ' → ' || o.destination, 'lat', l.lat, 'lng', l.lng, 'updated_at', l.updated_at
    ) AS row
    FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id JOIN vehicle_trip_offer_locations l ON l.trip_offer_id = o.id
    WHERE v.fleet_id = p_fleet_id AND o.share_live_location AND l.updated_at > now() - interval '5 minutes'

    UNION ALL

    SELECT jsonb_build_object(
      'source', 'hourly', 'ref_id', b.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
      'context', b.pickup_address, 'lat', latest.lat, 'lng', latest.lng, 'updated_at', latest.recorded_at
    ) AS row
    FROM hourly_bookings b JOIN vehicles v ON v.id = b.vehicle_id
    JOIN LATERAL (SELECT lat, lng, recorded_at FROM hourly_booking_locations hl WHERE hl.booking_id = b.id ORDER BY hl.recorded_at DESC LIMIT 1) latest ON true
    WHERE v.fleet_id = p_fleet_id AND b.status = 'in_progress' AND latest.recorded_at > now() - interval '5 minutes'

    UNION ALL

    SELECT jsonb_build_object(
      'source', 'route', 'ref_id', vr.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
      'context', vr.origin || ' → ' || vr.destination, 'lat', rl.lat, 'lng', rl.lng, 'updated_at', rl.updated_at
    ) AS row
    FROM route_runs run JOIN vehicle_routes vr ON vr.id = run.route_id JOIN vehicles v ON v.id = vr.vehicle_id
    JOIN route_live_locations rl ON rl.route_id = vr.id AND rl.portal_user_id IN (v.portal_user_id, vr.co_driver_portal_user_id)
    WHERE v.fleet_id = p_fleet_id AND run.ended_at IS NULL AND rl.updated_at > now() - interval '5 minutes'
  ) rows;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION fleet_vehicle_locations(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_vehicle_locations(uuid) TO authenticated;
