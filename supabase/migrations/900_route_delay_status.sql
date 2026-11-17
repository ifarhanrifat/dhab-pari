-- Migration 900: real gap confirmed by deep audit — there was no
-- "delayed" concept anywhere in the system, and no way for a booking
-- officer (not just the driver) to set it. Deliberately NOT attached
-- to route_runs: that row only exists AFTER the driver taps Start, so
-- it can't represent the single most common real case — a bus still
-- at the terminal, running late before it even departs. A small,
-- day-scoped table instead, so a delay can be reported and cleared at
-- any point in the day regardless of whether the run has started.
CREATE TABLE route_day_delays (
  route_id uuid NOT NULL REFERENCES vehicle_routes(id) ON DELETE CASCADE,
  travel_date date NOT NULL,
  direction varchar NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'return')),
  delay_minutes int NOT NULL CHECK (delay_minutes > 0),
  note varchar,
  marked_by uuid NOT NULL REFERENCES portal_users(id),
  marked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (route_id, travel_date, direction)
);
ALTER TABLE route_day_delays ENABLE ROW LEVEL SECURITY;
-- No policies — locked down to PUBLIC/anon/authenticated, exactly
-- like every other operational table this session; read and write
-- only through the SECURITY DEFINER RPCs below.
REVOKE ALL ON route_day_delays FROM PUBLIC, anon, authenticated;

-- Owner, staff, or the driver can report or clear a delay — unlike
-- the Group-modal's ride actions, this isn't exclusively a "physically
-- driving right now" action: a booking officer fielding a phone call
-- from a stuck driver needs to be able to set this too.
-- p_delay_minutes NULL or 0 clears it (deletes the row — no row means
-- on time, the natural default). Notifies every online-booked rider
-- for that route/date/direction on a genuine change either way.
CREATE OR REPLACE FUNCTION set_route_day_delay(
  p_route_id uuid, p_travel_date date, p_direction varchar DEFAULT 'outbound',
  p_delay_minutes int DEFAULT NULL, p_note varchar DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_vehicle_id uuid; v_route vehicle_routes%ROWTYPE; v_was_delayed boolean;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;

  v_was_delayed := EXISTS (SELECT 1 FROM route_day_delays WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction);

  IF p_delay_minutes IS NULL OR p_delay_minutes <= 0 THEN
    DELETE FROM route_day_delays WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction;
    IF v_was_delayed THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      SELECT DISTINCT rb.portal_user_id, 'route_delay_cleared', 'Back on time',
        v_route.origin || ' → ' || v_route.destination || ' is running on time again.',
        '/portal/marketplace/route/' || p_route_id
      FROM ride_bookings rb WHERE rb.route_id = p_route_id AND rb.travel_date = p_travel_date AND rb.direction = p_direction
        AND rb.status IN ('announced', 'confirmed');
    END IF;
  ELSE
    INSERT INTO route_day_delays (route_id, travel_date, direction, delay_minutes, note, marked_by)
    VALUES (p_route_id, p_travel_date, p_direction, p_delay_minutes, nullif(trim(coalesce(p_note, '')), ''), current_portal_user_id())
    ON CONFLICT (route_id, travel_date, direction) DO UPDATE SET
      delay_minutes = p_delay_minutes, note = nullif(trim(coalesce(p_note, '')), ''), marked_by = current_portal_user_id(), marked_at = now();

    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT DISTINCT rb.portal_user_id, 'route_delayed', 'Running late',
      v_route.origin || ' → ' || v_route.destination || ' is running about ' || p_delay_minutes || ' minutes late.'
        || CASE WHEN p_note IS NOT NULL AND trim(p_note) != '' THEN ' ' || p_note ELSE '' END,
      '/portal/marketplace/route/' || p_route_id
    FROM ride_bookings rb WHERE rb.route_id = p_route_id AND rb.travel_date = p_travel_date AND rb.direction = p_direction
      AND rb.status IN ('announced', 'confirmed');
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION set_route_day_delay(uuid, date, varchar, int, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_route_day_delay(uuid, date, varchar, int, varchar) TO authenticated;

-- fleet_vehicle_schedule (876) — true replace, adds delay_minutes/
-- delay_note for today's outbound leg so the booking officer's own
-- dashboard (fleet/page.tsx) shows and can clear it.
CREATE OR REPLACE FUNCTION fleet_vehicle_schedule(p_fleet_id uuid, p_date date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := COALESCE(p_date, (now() AT TIME ZONE 'Asia/Karachi')::date);
  v_dow int := extract(dow FROM v_today)::int;
  v_result jsonb;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'origin'), '[]'::jsonb) INTO v_result FROM (
    SELECT jsonb_build_object(
      'vehicle_id', v.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
      'route_id', vr.id, 'origin', vr.origin, 'destination', vr.destination, 'service_code', vr.service_code,
      'is_active', vr.is_active, 'departure_time', vr.departure_time, 'return_departure_time', vr.return_departure_time,
      'return_wait_minutes', vr.return_wait_minutes, 'is_two_way', vr.is_two_way, 'days_of_week', vr.days_of_week,
      'return_days_of_week', vr.return_days_of_week,
      'runs_today', v_dow = ANY(vr.days_of_week),
      'state', CASE
        WHEN NOT vr.is_active THEN 'closed'
        WHEN NOT (v_dow = ANY(vr.days_of_week)) THEN 'not_scheduled_today'
        WHEN last_run.id IS NULL THEN 'not_started'
        WHEN last_run.direction = 'outbound' AND last_run.ended_at IS NULL THEN 'outbound_in_progress'
        WHEN last_run.direction = 'outbound' AND last_run.ended_at IS NOT NULL THEN 'waiting_at_destination'
        WHEN last_run.direction = 'return' AND last_run.ended_at IS NULL THEN 'return_in_progress'
        ELSE 'completed_today'
      END,
      'current_driver_name', COALESCE(sub_v.owner_name, v.owner_name),
      'covered_by_substitute', sub.id IS NOT NULL,
      'last_run_started_at', last_run.started_at, 'last_run_outbound_arrived_at', last_run.outbound_arrived_at,
      'delay_minutes', delay.delay_minutes, 'delay_note', delay.note
    ) AS row
    FROM vehicles v
    JOIN LATERAL (
      SELECT * FROM vehicle_routes vr2 WHERE vr2.vehicle_id = v.id
      ORDER BY vr2.is_active DESC, vr2.created_at DESC NULLS LAST LIMIT 1
    ) vr ON true
    LEFT JOIN LATERAL (
      SELECT id, direction, started_at, ended_at, outbound_arrived_at
      FROM route_runs WHERE route_id = vr.id AND started_at::date = v_today
      ORDER BY started_at DESC LIMIT 1
    ) last_run ON true
    LEFT JOIN route_run_substitutions sub ON sub.route_id = vr.id AND sub.run_date = v_today AND sub.status = 'active'
    LEFT JOIN vehicles sub_v ON sub_v.id = sub.substitute_vehicle_id
    LEFT JOIN route_day_delays delay ON delay.route_id = vr.id AND delay.travel_date = v_today
      AND delay.direction = CASE WHEN last_run.direction = 'return' THEN 'return' ELSE 'outbound' END
    WHERE v.fleet_id = p_fleet_id AND v.is_active
  ) rows;
  RETURN v_result;
END;
$$;
