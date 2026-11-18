-- Migration 919: Terminal Schedule — a dedicated screen, distinct from
-- the existing Terminals directory (fleet/counters, which registers a
-- terminal's own location/manager/cash office). This one answers a
-- different real question: "what comes through my terminal, and when"
-- — the mockup's own "Today's departures" column, done for real this
-- time, grouped by the fleet's actual terminals (918's route_stops.
-- counter_id link) instead of a static number.
CREATE OR REPLACE FUNCTION fleet_terminal_schedule(p_fleet_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'stop_id', rs.id, 'counter_id', rs.counter_id, 'terminal_city', fc.city, 'terminal_name', fc.name,
      'arrival_time', rs.arrival_time, 'departure_time', rs.departure_time, 'stop_order', rs.stop_order,
      'route_id', vr.id, 'origin', vr.origin, 'destination', vr.destination, 'is_two_way', vr.is_two_way,
      'days_of_week', vr.days_of_week, 'vehicle_number', v.vehicle_number, 'vehicle_type', v.vehicle_type
    ) ORDER BY fc.city, fc.name, rs.arrival_time NULLS LAST)
    FROM route_stops rs
    JOIN fleet_counters fc ON fc.id = rs.counter_id
    JOIN vehicle_routes vr ON vr.id = rs.route_id
    JOIN vehicles v ON v.id = vr.vehicle_id
    WHERE v.fleet_id = p_fleet_id AND vr.is_active
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION fleet_terminal_schedule(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_terminal_schedule(uuid) TO authenticated;
