-- Migration 879: real spec given live, for long routes with two
-- drivers: "both drivers will now a floating button on there apps,
-- after 8 hours if the driver want to shuffle they can shuffle and
-- this will aslo create a full ride history for the admin end."
--
-- Explicitly reverses a standing instruction from earlier this session
-- ("keep the driver shuffle same as existing, don't update this") —
-- confirmed directly with the user via a clarifying question before
-- building, since this is exactly the boundary that instruction drew.
--
-- Deliberately a NEW, separate mechanism from route_run_substitutions
-- (819) — that one swaps the entire VEHICLE for a whole day, decided
-- before a run starts. This one keeps the same vehicle and the same
-- run; it only changes which of the two assigned drivers is currently
-- the one actually driving, mid-route, with each interval logged.

-- ═════════════════════════════════════════════════════════════════════
-- 1. A route can name a second driver for long trips, and how many
--    hours a driver must be on duty before they can hand off.
-- ═════════════════════════════════════════════════════════════════════
ALTER TABLE vehicle_routes ADD COLUMN IF NOT EXISTS co_driver_portal_user_id uuid REFERENCES portal_users(id);
ALTER TABLE vehicle_routes ADD COLUMN IF NOT EXISTS min_shift_hours int NOT NULL DEFAULT 8;

-- ═════════════════════════════════════════════════════════════════════
-- 2. Each continuous interval one driver actually held the wheel
--    during one run — the "full ride history for the admin end".
-- ═════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS route_run_driver_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_run_id uuid NOT NULL REFERENCES route_runs(id) ON DELETE CASCADE,
  driver_portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS route_run_driver_shifts_run_idx ON route_run_driver_shifts(route_run_id);
-- At most one open (still-driving) shift per run at any time.
CREATE UNIQUE INDEX IF NOT EXISTS route_run_driver_shifts_one_open_per_run ON route_run_driver_shifts(route_run_id) WHERE ended_at IS NULL;

ALTER TABLE route_run_driver_shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "route_run_driver_shifts_read" ON route_run_driver_shifts FOR SELECT TO authenticated
  USING (
    driver_portal_user_id = current_portal_user_id()
    OR EXISTS (SELECT 1 FROM route_runs rr JOIN vehicle_routes vr ON vr.id = rr.route_id WHERE rr.id = route_run_id AND can_manage_vehicle(vr.vehicle_id))
    OR current_admin_permission('manage_parties')
  );
-- No INSERT/UPDATE/DELETE policy — SECURITY DEFINER RPC only.

-- ═════════════════════════════════════════════════════════════════════
-- 3. Assign (or clear) the co-driver and the hand-off threshold.
--    Resolves an existing account by mobile — no self-assign.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION set_route_co_driver(p_route_id uuid, p_co_driver_mobile varchar DEFAULT NULL, p_min_shift_hours int DEFAULT 8) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE; v_co_driver_id uuid;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  IF p_min_shift_hours IS NULL OR p_min_shift_hours < 1 THEN RAISE EXCEPTION 'Enter a real minimum shift length.' USING ERRCODE = 'P0001'; END IF;

  IF p_co_driver_mobile IS NOT NULL AND trim(p_co_driver_mobile) != '' THEN
    -- Scoped to this route's own tenant — matching mobile across every
    -- tenant would be a real cross-tenant lookup leak (the exact bug
    -- class already found and fixed once this session for RLS).
    SELECT id INTO v_co_driver_id FROM portal_users WHERE mobile = trim(p_co_driver_mobile) AND is_active AND tenant_id = v_route.tenant_id;
    IF v_co_driver_id IS NULL THEN RAISE EXCEPTION 'No account found with that mobile number in your village.' USING ERRCODE = 'P0001'; END IF;
    IF v_co_driver_id = v_vehicle.portal_user_id THEN RAISE EXCEPTION 'The co-driver must be a different account than the vehicle''s own driver.' USING ERRCODE = 'P0001'; END IF;
  ELSE
    v_co_driver_id := NULL;
  END IF;

  UPDATE vehicle_routes SET co_driver_portal_user_id = v_co_driver_id, min_shift_hours = p_min_shift_hours WHERE id = p_route_id;

  IF v_co_driver_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_co_driver_id, 'route_co_driver_assigned', 'You were added as a co-driver',
      'You can now shuffle driving duty on ' || v_route.origin || ' → ' || v_route.destination || ' once you''re on duty.', '/portal/my-vehicle/routes');
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION set_route_co_driver(uuid, varchar, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_route_co_driver(uuid, varchar, int) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 4. start_route_run — same signature as 850's live version, widened
--    to open the first duty shift for the vehicle's own driver. (The
--    caller may be a fleet owner/staff managing remotely — is_route_
--    owner already allows that — so the shift is attributed to the
--    vehicle's actual registered driver, not whoever tapped Start.)
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION start_route_run(p_route_id uuid, p_direction varchar DEFAULT 'outbound') RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE; v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only start your own route.' USING ERRCODE = 'P0001'; END IF;
  IF p_direction NOT IN ('outbound', 'return') THEN RAISE EXCEPTION 'Invalid direction.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM route_runs WHERE route_id = p_route_id AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'This route already has an active run — end it before starting another.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  PERFORM charge_vehicle_ride_stake(v_route.vehicle_id, 'Route run started (' ||
    (CASE WHEN p_direction = 'return' THEN v_route.destination || ' → ' || v_route.origin ELSE v_route.origin || ' → ' || v_route.destination END) || ')');

  INSERT INTO route_runs (route_id, direction) VALUES (p_route_id, p_direction) RETURNING id INTO v_id;

  IF v_vehicle.portal_user_id IS NOT NULL THEN
    INSERT INTO route_run_driver_shifts (route_run_id, driver_portal_user_id) VALUES (v_id, v_vehicle.portal_user_id);
  END IF;

  INSERT INTO route_participants (route_id, portal_user_id, is_active, sharing_location)
  VALUES (p_route_id, v_portal_user_id, true, true)
  ON CONFLICT (route_id, portal_user_id) DO UPDATE SET sharing_location = true, is_active = true;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT rp.portal_user_id, 'route_run_started', 'The van is on its way',
    (CASE WHEN p_direction = 'return' THEN v_route.destination || ' → ' || v_route.origin ELSE v_route.origin || ' → ' || v_route.destination END) || ' — live arrival times are now showing.',
    '/portal/marketplace/route/' || p_route_id
  FROM route_participants rp WHERE rp.route_id = p_route_id AND rp.is_active = true;

  RETURN v_id;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 5. end_route_run — same signature as 872's live version, widened to
--    close any still-open shift when the run itself ends.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION end_route_run(p_route_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route vehicle_routes%ROWTYPE; v_direction varchar; v_run_id uuid; v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_dropped_off_riders uuid[];
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only end your own route''s run.' USING ERRCODE = 'P0001'; END IF;
  UPDATE route_runs SET ended_at = now() WHERE route_id = p_route_id AND ended_at IS NULL
    RETURNING id, direction INTO v_run_id, v_direction;

  IF v_direction IS NULL THEN RETURN; END IF;

  UPDATE route_run_driver_shifts SET ended_at = now() WHERE route_run_id = v_run_id AND ended_at IS NULL;

  WITH dropped AS (
    UPDATE ride_bookings SET dropped_off_at = now()
    WHERE route_id = p_route_id AND travel_date = v_today AND boarded_at IS NOT NULL AND dropped_off_at IS NULL
    RETURNING portal_user_id
  )
  SELECT array_agg(portal_user_id) INTO v_dropped_off_riders FROM dropped;

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

-- ═════════════════════════════════════════════════════════════════════
-- 6. The floating-button status check — tells the caller's own app
--    everything it needs: is there an active run, who's driving now,
--    how long they've been on, and can THIS caller shuffle right now.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION my_duty_shift_status(p_route_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE;
  v_run route_runs%ROWTYPE; v_shift route_run_driver_shifts%ROWTYPE;
  v_other_driver_id uuid; v_other_name varchar;
  v_active_driver_name varchar;
  v_elapsed_hours numeric;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  IF v_route.co_driver_portal_user_id IS NULL THEN RETURN jsonb_build_object('has_co_driver', false); END IF;
  IF v_portal_user_id NOT IN (v_vehicle.portal_user_id, v_route.co_driver_portal_user_id) THEN
    RETURN jsonb_build_object('has_co_driver', true, 'is_assigned_driver', false);
  END IF;

  SELECT * INTO v_run FROM route_runs WHERE route_id = p_route_id AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('has_co_driver', true, 'is_assigned_driver', true, 'run_active', false);
  END IF;

  SELECT * INTO v_shift FROM route_run_driver_shifts WHERE route_run_id = v_run.id AND ended_at IS NULL LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('has_co_driver', true, 'is_assigned_driver', true, 'run_active', true, 'can_shuffle', false);
  END IF;

  v_other_driver_id := CASE WHEN v_shift.driver_portal_user_id = v_vehicle.portal_user_id THEN v_route.co_driver_portal_user_id ELSE v_vehicle.portal_user_id END;
  SELECT full_name INTO v_other_name FROM portal_users WHERE id = v_other_driver_id;
  SELECT full_name INTO v_active_driver_name FROM portal_users WHERE id = v_shift.driver_portal_user_id;
  v_elapsed_hours := EXTRACT(EPOCH FROM (now() - v_shift.started_at)) / 3600.0;

  RETURN jsonb_build_object(
    'has_co_driver', true, 'is_assigned_driver', true, 'run_active', true,
    'route_run_id', v_run.id,
    'am_i_active_driver', v_shift.driver_portal_user_id = v_portal_user_id,
    'active_driver_name', v_active_driver_name, 'other_driver_name', v_other_name,
    'shift_started_at', v_shift.started_at, 'elapsed_hours', round(v_elapsed_hours, 1), 'min_shift_hours', v_route.min_shift_hours,
    'can_shuffle', v_shift.driver_portal_user_id = v_portal_user_id AND v_elapsed_hours >= v_route.min_shift_hours
  );
END;
$$;
REVOKE ALL ON FUNCTION my_duty_shift_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_duty_shift_status(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 7. The actual hand-off. Only the driver CURRENTLY on duty can start
--    it (hands control to the other one) — the other driver can't pull
--    control away unilaterally while someone else is still driving.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION shuffle_driver(p_route_run_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_run route_runs%ROWTYPE; v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE;
  v_shift route_run_driver_shifts%ROWTYPE; v_other_driver_id uuid; v_elapsed_hours numeric;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_run FROM route_runs WHERE id = p_route_run_id FOR UPDATE;
  IF NOT FOUND OR v_run.ended_at IS NOT NULL THEN RAISE EXCEPTION 'This run is not active.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_route FROM vehicle_routes WHERE id = v_run.route_id;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  IF v_route.co_driver_portal_user_id IS NULL THEN RAISE EXCEPTION 'No co-driver assigned for this route.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_shift FROM route_run_driver_shifts WHERE route_run_id = p_route_run_id AND ended_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No active shift to hand over.' USING ERRCODE = 'P0001'; END IF;

  IF v_shift.driver_portal_user_id != v_portal_user_id THEN
    RAISE EXCEPTION 'Only the driver currently on duty can hand off.' USING ERRCODE = 'P0001';
  END IF;

  v_elapsed_hours := EXTRACT(EPOCH FROM (now() - v_shift.started_at)) / 3600.0;
  IF v_elapsed_hours < v_route.min_shift_hours THEN
    RAISE EXCEPTION 'You need to be on duty for at least % hours before shuffling — % so far.', v_route.min_shift_hours, round(v_elapsed_hours, 1) USING ERRCODE = 'P0001';
  END IF;

  v_other_driver_id := CASE WHEN v_shift.driver_portal_user_id = v_vehicle.portal_user_id THEN v_route.co_driver_portal_user_id ELSE v_vehicle.portal_user_id END;

  UPDATE route_run_driver_shifts SET ended_at = now() WHERE id = v_shift.id;
  INSERT INTO route_run_driver_shifts (route_run_id, driver_portal_user_id) VALUES (p_route_run_id, v_other_driver_id);

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_other_driver_id, 'driver_shift_handover', 'You''re now on driving duty',
    v_route.origin || ' → ' || v_route.destination || ' — the other driver just handed off to you.', '/portal/my-vehicle/routes');
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_shift.driver_portal_user_id, 'driver_shift_handover', 'Handed off duty',
    v_route.origin || ' → ' || v_route.destination || ' — you''re off duty until your next shift.', '/portal/my-vehicle/routes');
END;
$$;
REVOKE ALL ON FUNCTION shuffle_driver(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION shuffle_driver(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 8. route_run_detail (admin trip-history) — same signature as 873's
--    live version, driver_timeline widened with real shift intervals
--    alongside the existing whole-day substitute-vehicle rows.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION route_run_detail(p_route_run_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run route_runs%ROWTYPE; v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE;
  v_date date; v_result jsonb;
BEGIN
  SELECT * INTO v_run FROM route_runs WHERE id = p_route_run_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_route FROM vehicle_routes WHERE id = v_run.route_id;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;
  IF NOT (can_manage_vehicle(v_vehicle.id) OR COALESCE(current_admin_permission('manage_parties'), false)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  v_date := (v_run.started_at AT TIME ZONE 'Asia/Karachi')::date;

  WITH passengers AS (
    SELECT mb.id, 'manual'::varchar AS source, mb.passenger_name, mb.seats, mb.total_amount_pkr AS amount, NULL::timestamptz AS boarded_at, NULL::timestamptz AS dropped_off_at
    FROM manual_ride_bookings mb WHERE mb.route_id = v_run.route_id AND mb.travel_date = v_date AND mb.status = 'confirmed'
    UNION ALL
    SELECT rb.id, 'app'::varchar AS source, pu.full_name, rb.seats, rb.total_amount_pkr AS amount, rb.boarded_at, rb.dropped_off_at
    FROM ride_bookings rb JOIN portal_users pu ON pu.id = rb.portal_user_id
    WHERE rb.route_id = v_run.route_id AND rb.travel_date = v_date AND rb.status IN ('announced', 'confirmed')
  ),
  luggage AS (
    SELECT id, sender_name, receiver_name, fare_pkr, status, loaded_at, delivered_at
    FROM route_luggage_bookings WHERE route_id = v_run.route_id AND travel_date = v_date AND status != 'cancelled'
  ),
  driver_timeline AS (
    SELECT jsonb_build_object('owner_name', v_vehicle.owner_name, 'reason', 'regular', 'created_at', NULL) AS row
    UNION ALL
    SELECT jsonb_build_object('owner_name', sv.owner_name, 'reason', s.reason, 'created_at', s.created_at)
    FROM route_run_substitutions s JOIN vehicles sv ON sv.id = s.substitute_vehicle_id
    WHERE s.route_id = v_run.route_id AND s.run_date = v_date AND s.status = 'active'
    UNION ALL
    SELECT jsonb_build_object('owner_name', pu.full_name, 'reason', 'shift', 'created_at', sh.started_at, 'ended_at', sh.ended_at)
    FROM route_run_driver_shifts sh JOIN portal_users pu ON pu.id = sh.driver_portal_user_id
    WHERE sh.route_run_id = p_route_run_id
  ),
  expenses AS (
    SELECT id, category, amount_pkr, note, station_name, lat, lng, expense_date
    FROM vehicle_expenses WHERE route_run_id = p_route_run_id
  )
  SELECT jsonb_build_object(
    'route_run_id', p_route_run_id, 'route_id', v_run.route_id, 'origin', v_route.origin, 'destination', v_route.destination,
    'owner_name', v_vehicle.owner_name, 'vehicle_type', v_vehicle.vehicle_type, 'direction', v_run.direction,
    'started_at', v_run.started_at, 'ended_at', v_run.ended_at, 'travel_date', v_date,
    'planned_path', v_route.route_path,
    'actual_path', (SELECT COALESCE(jsonb_agg(jsonb_build_object('lat', lat, 'lng', lng) ORDER BY recorded_at), '[]'::jsonb) FROM route_run_path_points WHERE route_run_id = p_route_run_id),
    'passengers', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'source', source, 'passenger_name', passenger_name, 'seats', seats, 'amount', amount, 'boarded_at', boarded_at, 'dropped_off_at', dropped_off_at)), '[]'::jsonb) FROM passengers),
    'luggage', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'sender_name', sender_name, 'receiver_name', receiver_name, 'fare_pkr', fare_pkr, 'status', status, 'loaded_at', loaded_at, 'delivered_at', delivered_at)), '[]'::jsonb) FROM luggage),
    'driver_timeline', (SELECT COALESCE(jsonb_agg(row), '[]'::jsonb) FROM driver_timeline),
    'expenses', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'category', category, 'amount_pkr', amount_pkr, 'note', note, 'station_name', station_name, 'lat', lat, 'lng', lng, 'expense_date', expense_date)), '[]'::jsonb) FROM expenses),
    'total_passengers', (SELECT COALESCE(SUM(seats), 0) FROM passengers),
    'total_luggage_count', (SELECT COUNT(*) FROM luggage),
    'earnings_pkr', (SELECT COALESCE(SUM(amount), 0) FROM passengers) + (SELECT COALESCE(SUM(fare_pkr), 0) FROM luggage),
    'expenses_pkr', (SELECT COALESCE(SUM(amount_pkr), 0) FROM expenses)
  ) INTO v_result;

  RETURN v_result;
END;
$$;
