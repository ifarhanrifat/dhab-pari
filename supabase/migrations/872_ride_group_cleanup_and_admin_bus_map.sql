-- Migration 872: two real bugs confirmed live/by direct audit.
--
-- 1. end_route_run never touched route_participants at all — a rider
--    stayed in a route's live "ride group" (map/chat visibility)
--    forever after their own trip actually completed, across every
--    future trip on that route, until they manually tapped "leave
--    group". Fixed at the one real completion signal that exists:
--    the same bookings this function just marked dropped_off_at.
--
-- 2. admin_fleet_locations (486, the data behind the admin dashboard's
--    only live map) only ever unioned vehicle_trip_offers and
--    hourly_bookings positions — it never read route_live_locations at
--    all, so a bus running a daily route never appeared on the admin
--    map regardless of how live its GPS was. Added as a third source,
--    scoped to the vehicle's own driver (not every rider who might
--    also be sharing location on that route).

CREATE OR REPLACE FUNCTION end_route_run(p_route_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route vehicle_routes%ROWTYPE; v_direction varchar; v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_dropped_off_riders uuid[];
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only end your own route''s run.' USING ERRCODE = 'P0001'; END IF;
  UPDATE route_runs SET ended_at = now() WHERE route_id = p_route_id AND ended_at IS NULL
    RETURNING direction INTO v_direction;

  IF v_direction IS NULL THEN RETURN; END IF;

  WITH dropped AS (
    UPDATE ride_bookings SET dropped_off_at = now()
    WHERE route_id = p_route_id AND travel_date = v_today AND boarded_at IS NOT NULL AND dropped_off_at IS NULL
    RETURNING portal_user_id
  )
  SELECT array_agg(portal_user_id) INTO v_dropped_off_riders FROM dropped;

  -- 872: this trip is over for exactly these riders — leave the ride
  -- group (they rejoin automatically the next time a new booking of
  -- theirs on this route gets accepted, same ON CONFLICT upsert every
  -- join site already uses).
  IF v_dropped_off_riders IS NOT NULL THEN
    UPDATE route_participants SET is_active = false, sharing_location = false
    WHERE route_id = p_route_id AND portal_user_id = ANY(v_dropped_off_riders);
  END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT rp.portal_user_id, 'route_run_ended',
    CASE WHEN v_direction = 'return' THEN 'Back at ' || v_route.origin ELSE 'Trip finished' END,
    CASE WHEN v_direction = 'return'
      THEN 'The return trip from ' || v_route.destination || ' has finished.'
      ELSE v_route.origin || ' → ' || v_route.destination || ' has finished for today.' END,
    '/portal/marketplace/route/' || p_route_id
  FROM route_participants rp WHERE rp.route_id = p_route_id AND rp.is_active = true;
END;
$$;

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

    UNION ALL

    SELECT jsonb_build_object(
      'source', 'route', 'ref_id', vr.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile,
      'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
      'context', vr.origin || ' → ' || vr.destination, 'lat', rl.lat, 'lng', rl.lng, 'updated_at', rl.updated_at
    ) AS row
    FROM route_live_locations rl
    JOIN vehicle_routes vr ON vr.id = rl.route_id
    JOIN vehicles v ON v.id = vr.vehicle_id AND v.portal_user_id = rl.portal_user_id
    WHERE rl.updated_at > now() - interval '5 minutes'
  ) rows;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
