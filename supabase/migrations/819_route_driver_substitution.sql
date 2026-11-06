-- Migration 819: real ask, 2026-11-06 (phase 5 of the agreed order) —
-- "if the driver is ill or has not started his ride for 10 minutes...
-- the new driver will see all the groups... the driver also can
-- transfer his whole group to a driver who he knew." Path B from the
-- earlier analysis: the committee never holds rider money for routes
-- today (confirmed this session — riders pay drivers directly, the
-- ledger only tracks a commission debt), so real escrow-backed
-- automatic settlement has no foundation to build on here the way it
-- does for shadi bookings. This builds the logistics half for real —
-- a substitute driver gets full owner-equivalent access to the route
-- for the day — and keeps money manual, settled between drivers
-- directly, exactly as flagged in the plan. No automatic timer-based
-- reassignment anywhere — always triggered by a rider, the driver, or
-- an admin.

CREATE TABLE route_run_substitutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES vehicle_routes(id) ON DELETE CASCADE,
  run_date date NOT NULL,
  original_vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  substitute_vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  reason varchar NOT NULL CHECK (reason IN ('driver_requested', 'admin_assigned')),
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  status varchar NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  UNIQUE (route_id, run_date)
);
ALTER TABLE route_run_substitutions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "route_run_substitutions_read" ON route_run_substitutions FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM vehicles v WHERE v.id IN (original_vehicle_id, substitute_vehicle_id) AND v.portal_user_id = current_portal_user_id())
    OR is_route_member(route_id)
    OR COALESCE(current_admin_permission('manage_parties'), false)
  );

-- The key unlock — every other Routes RPC already gates through this
-- one function, so a substitute transparently gets full owner-
-- equivalent access everywhere, for today only, from this one change.
CREATE OR REPLACE FUNCTION is_route_owner(p_route_id uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id
    WHERE vr.id = p_route_id AND v.portal_user_id = current_portal_user_id()
  ) OR EXISTS (
    SELECT 1 FROM route_run_substitutions s JOIN vehicles v ON v.id = s.substitute_vehicle_id
    WHERE s.route_id = p_route_id AND s.run_date = (now() AT TIME ZONE 'Asia/Karachi')::date
      AND s.status = 'active' AND v.portal_user_id = current_portal_user_id()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- board_ride_bookings (817) inlined its own route-ownership check
-- instead of calling is_route_owner -- switch it to the shared
-- function so it picks up the substitute case for free too.
CREATE OR REPLACE FUNCTION board_ride_bookings(p_booking_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; b ride_bookings%ROWTYPE; v_owner_ok boolean;
BEGIN
  FOREACH v_id IN ARRAY p_booking_ids LOOP
    SELECT * INTO b FROM ride_bookings WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF b.status NOT IN ('announced', 'confirmed') OR b.boarded_at IS NOT NULL THEN CONTINUE; END IF;

    IF b.route_id IS NOT NULL THEN
      v_owner_ok := is_route_owner(b.route_id);
    ELSE
      SELECT EXISTS (SELECT 1 FROM adda_queue_entries e JOIN vehicles v ON v.id = e.vehicle_id WHERE e.id = b.adda_queue_entry_id AND v.portal_user_id = current_portal_user_id()) INTO v_owner_ok;
    END IF;
    IF NOT v_owner_ok THEN RAISE EXCEPTION 'You do not manage this booking''s vehicle.' USING ERRCODE = 'P0001'; END IF;

    UPDATE ride_bookings SET boarded_at = now() WHERE id = v_id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (b.portal_user_id, 'rider_boarded', 'You''re on board', 'The driver has marked you as boarded.',
      CASE WHEN b.route_id IS NOT NULL THEN '/portal/marketplace/route/' || b.route_id ELSE '/portal/marketplace/buses' END);
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION board_ride_bookings(uuid[]) TO authenticated;

-- Rider-triggered reminder — a nudge, not a formal report. Simple
-- spam guard so one impatient rider can't flood the driver.
CREATE OR REPLACE FUNCTION nudge_route_driver(p_route_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route vehicle_routes%ROWTYPE; v_owner_portal_user_id uuid;
BEGIN
  IF NOT is_route_member(p_route_id) THEN RAISE EXCEPTION 'You are not part of this route.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (
    SELECT 1 FROM portal_notifications
    WHERE link = '/portal/marketplace/route/' || p_route_id AND event_type = 'route_driver_nudged' AND created_at > now() - interval '30 minutes'
  ) THEN RETURN; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  SELECT v.portal_user_id INTO v_owner_portal_user_id FROM vehicles v WHERE v.id = v_route.vehicle_id;
  IF v_owner_portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_owner_portal_user_id, 'route_driver_nudged', 'A rider is waiting',
      v_route.origin || ' → ' || v_route.destination || ' — a rider says the van hasn''t started yet.',
      '/portal/marketplace/route/' || p_route_id);
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION nudge_route_driver(uuid) TO authenticated;

-- Shared insert+notify logic for both the driver hand-off and the
-- admin-assigned path, kept as one function so the two RPCs below
-- can't drift from each other.
CREATE OR REPLACE FUNCTION assign_route_substitute(p_route_id uuid, p_substitute_vehicle_id uuid, p_reason varchar) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route vehicle_routes%ROWTYPE; v_original_owner_name varchar; v_substitute_portal_user_id uuid; v_original_portal_user_id uuid; v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_substitute_vehicle_id AND is_active) THEN
    RAISE EXCEPTION 'Pick an active vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF p_substitute_vehicle_id = v_route.vehicle_id THEN RAISE EXCEPTION 'That is already this route''s own vehicle.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO route_run_substitutions (route_id, run_date, original_vehicle_id, substitute_vehicle_id, reason, created_by)
  VALUES (p_route_id, v_today, v_route.vehicle_id, p_substitute_vehicle_id, p_reason, current_portal_user_id())
  ON CONFLICT (route_id, run_date) DO UPDATE SET substitute_vehicle_id = excluded.substitute_vehicle_id, reason = excluded.reason, status = 'active', created_by = excluded.created_by, created_at = now();

  SELECT owner_name, portal_user_id INTO v_original_owner_name, v_original_portal_user_id FROM vehicles WHERE id = v_route.vehicle_id;
  SELECT portal_user_id INTO v_substitute_portal_user_id FROM vehicles WHERE id = p_substitute_vehicle_id;

  IF v_substitute_portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_substitute_portal_user_id, 'route_substitute_assigned', 'You''re covering a route today',
      v_route.origin || ' → ' || v_route.destination || ' for today — settle today''s fare with ' || COALESCE(v_original_owner_name, 'the regular driver') || ' directly, the app does not move this money.',
      '/portal/my-vehicle/routes');
  END IF;
  IF v_original_portal_user_id IS NOT NULL AND v_original_portal_user_id IS DISTINCT FROM v_substitute_portal_user_id THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_original_portal_user_id, 'route_substitute_assigned', 'A substitute is covering your route today',
      v_route.origin || ' → ' || v_route.destination || ' is being covered today.', '/portal/my-vehicle/routes');
  END IF;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT rp.portal_user_id, 'route_substitute_assigned', 'A substitute driver is covering today',
    v_route.origin || ' → ' || v_route.destination || ' will be run by a substitute vehicle today.', '/portal/marketplace/route/' || p_route_id
  FROM route_participants rp WHERE rp.route_id = p_route_id AND rp.is_active = true;
END;
$$;

CREATE OR REPLACE FUNCTION driver_request_substitute(p_route_id uuid, p_substitute_vehicle_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only hand off your own route.' USING ERRCODE = 'P0001'; END IF;
  PERFORM assign_route_substitute(p_route_id, p_substitute_vehicle_id, 'driver_requested');
END;
$$;
GRANT EXECUTE ON FUNCTION driver_request_substitute(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION admin_assign_route_substitute(p_route_id uuid, p_substitute_vehicle_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  PERFORM assign_route_substitute(p_route_id, p_substitute_vehicle_id, 'admin_assigned');
END;
$$;
GRANT EXECUTE ON FUNCTION admin_assign_route_substitute(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION admin_routes_not_started_today() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date; v_now time := (now() AT TIME ZONE 'Asia/Karachi')::time; v_todow int := extract(dow FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RETURN '[]'::jsonb; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'route_id', r.id, 'origin', r.origin, 'destination', r.destination, 'departure_time', r.departure_time,
      'is_monthly_fixed', r.is_monthly_fixed, 'owner_name', v.owner_name,
      'rider_count', (
        (SELECT count(*) FROM ride_bookings rb WHERE rb.route_id = r.id AND rb.travel_date = v_today AND rb.status IN ('announced', 'confirmed'))
        + (SELECT count(*) FROM route_subscriptions rs WHERE rs.route_id = r.id AND rs.status IN ('active', 'pending_cancellation'))
      )
    ) ORDER BY r.departure_time), '[]'::jsonb)
    FROM vehicle_routes r JOIN vehicles v ON v.id = r.vehicle_id
    WHERE r.tenant_id = my_tenant_id() AND r.is_active AND v_todow = ANY(r.days_of_week)
      AND r.departure_time IS NOT NULL AND r.departure_time < v_now
      AND NOT EXISTS (SELECT 1 FROM route_runs run WHERE run.route_id = r.id AND run.started_at::date = v_today)
  );
END;
$$;
GRANT EXECUTE ON FUNCTION admin_routes_not_started_today() TO authenticated;

CREATE OR REPLACE FUNCTION my_substitute_assignments_today() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'route_id', r.id, 'origin', r.origin, 'destination', r.destination, 'departure_time', r.departure_time, 'reason', s.reason
  )), '[]'::jsonb)
  FROM route_run_substitutions s
  JOIN vehicle_routes r ON r.id = s.route_id
  JOIN vehicles v ON v.id = s.substitute_vehicle_id
  WHERE v.portal_user_id = current_portal_user_id() AND s.run_date = (now() AT TIME ZONE 'Asia/Karachi')::date AND s.status = 'active';
$$;
GRANT EXECUTE ON FUNCTION my_substitute_assignments_today() TO authenticated;

-- vehicle_route_adda_live_status (817): a substitute's vehicle should
-- drive the floating button exactly like an owned route.
CREATE OR REPLACE FUNCTION vehicle_route_adda_live_status(p_vehicle_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date; v_todow int := extract(dow FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = current_portal_user_id()) THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(merged.row), '[]'::jsonb) FROM (
      SELECT jsonb_build_object('kind', 'route_ongoing', 'route_id', r.id, 'origin', r.origin, 'destination', r.destination, 'started_at', run.started_at) AS row
      FROM vehicle_routes r JOIN route_runs run ON run.route_id = r.id AND run.ended_at IS NULL
      WHERE r.vehicle_id = p_vehicle_id
        OR EXISTS (SELECT 1 FROM route_run_substitutions s WHERE s.route_id = r.id AND s.substitute_vehicle_id = p_vehicle_id AND s.run_date = v_today AND s.status = 'active')

      UNION ALL

      SELECT jsonb_build_object('kind', 'route_action', 'route_id', r.id, 'origin', r.origin, 'destination', r.destination,
        'pending_count', (
          (SELECT count(*) FROM ride_bookings rb WHERE rb.route_id = r.id AND rb.travel_date = v_today AND rb.status IN ('announced', 'confirmed') AND rb.boarded_at IS NULL)
          + (SELECT count(*) FROM route_subscriptions rs WHERE rs.route_id = r.id AND rs.status IN ('active', 'pending_cancellation'))
        )) AS row
      FROM vehicle_routes r
      WHERE (
          r.vehicle_id = p_vehicle_id
          OR EXISTS (SELECT 1 FROM route_run_substitutions s WHERE s.route_id = r.id AND s.substitute_vehicle_id = p_vehicle_id AND s.run_date = v_today AND s.status = 'active')
        )
        AND r.is_active AND v_todow = ANY(r.days_of_week)
        AND NOT EXISTS (SELECT 1 FROM route_runs run WHERE run.route_id = r.id AND run.ended_at IS NULL)
        AND (
          EXISTS (SELECT 1 FROM ride_bookings rb WHERE rb.route_id = r.id AND rb.travel_date = v_today AND rb.status IN ('announced', 'confirmed') AND rb.boarded_at IS NULL)
          OR EXISTS (SELECT 1 FROM route_subscriptions rs WHERE rs.route_id = r.id AND rs.status IN ('active', 'pending_cancellation'))
        )

      UNION ALL

      SELECT jsonb_build_object('kind', 'adda_ongoing', 'entry_id', e.id, 'adda_name', a.name, 'adda_name_ur', a.name_ur) AS row
      FROM adda_queue_entries e JOIN addas a ON a.id = e.adda_id
      WHERE e.vehicle_id = p_vehicle_id AND e.queue_date = v_today AND e.status = 'departed'
        AND EXISTS (SELECT 1 FROM ride_bookings rb WHERE rb.adda_queue_entry_id = e.id AND rb.boarded_at IS NOT NULL AND rb.dropped_off_at IS NULL)

      UNION ALL

      SELECT jsonb_build_object('kind', 'adda_action', 'entry_id', e.id, 'adda_name', a.name, 'adda_name_ur', a.name_ur,
        'pending_count', (SELECT count(*) FROM ride_bookings rb WHERE rb.adda_queue_entry_id = e.id AND rb.status IN ('announced', 'confirmed') AND rb.boarded_at IS NULL)) AS row
      FROM adda_queue_entries e JOIN addas a ON a.id = e.adda_id
      WHERE e.vehicle_id = p_vehicle_id AND e.queue_date = v_today AND e.status IN ('waiting', 'current')
        AND EXISTS (SELECT 1 FROM ride_bookings rb WHERE rb.adda_queue_entry_id = e.id AND rb.status IN ('announced', 'confirmed') AND rb.boarded_at IS NULL)
    ) merged
  );
END;
$$;
GRANT EXECUTE ON FUNCTION vehicle_route_adda_live_status(uuid) TO authenticated;
