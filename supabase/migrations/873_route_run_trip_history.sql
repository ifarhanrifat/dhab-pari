-- Migration 873: admin trip-history — real spec given live: click a
-- bus's travel route and see the full map of where it actually went,
-- fuel cost and where it was bought, who's driving and how many times
-- they shuffled (driver-shuffle system itself left exactly as it is,
-- per direct instruction — this only surfaces the EXISTING route_run_
-- substitutions data, no new shuffle mechanics), how many passengers
-- and how much luggage boarded along the way, and earnings vs cost for
-- that specific run.
--
-- Two real gaps closed to make this possible at all:
-- 1. The system only ever stored a vehicle's SINGLE latest GPS point
--    (route_live_locations, overwritten every ping) — there was no
--    trail to show a route actually taken. New route_run_path_points
--    table, appended to by the existing ping_route_location RPC
--    (driver-only, not every rider who might also share location).
-- 2. vehicle_expenses had no location and no link to a specific trip —
--    cost could only ever be attributed to a vehicle+date, never one
--    run. Both added as optional fields; nothing before this ever set
--    them, so every historical expense just shows as unattributed.

-- ═════════════════════════════════════════════════════════════════════
-- 1. GPS trail
-- ═════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS route_run_path_points (
  id bigserial PRIMARY KEY,
  route_run_id uuid NOT NULL REFERENCES route_runs(id) ON DELETE CASCADE,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS route_run_path_points_run_idx ON route_run_path_points(route_run_id, recorded_at);
ALTER TABLE route_run_path_points ENABLE ROW LEVEL SECURITY;
CREATE POLICY "route_run_path_points_manager_read" ON route_run_path_points FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM route_runs rr JOIN vehicle_routes vr ON vr.id = rr.route_id WHERE rr.id = route_run_id AND can_manage_vehicle(vr.vehicle_id))
    OR current_admin_permission('manage_parties'));
-- No INSERT/UPDATE/DELETE policy — SECURITY DEFINER RPC only (ping_route_location below).

CREATE OR REPLACE FUNCTION ping_route_location(p_route_id uuid, p_lat numeric, p_lng numeric) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_sharing boolean; v_vehicle_id uuid; v_is_driver boolean; v_run_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT sharing_location INTO v_sharing FROM route_participants WHERE route_id = p_route_id AND portal_user_id = v_portal_user_id;
  IF v_sharing IS NOT TRUE THEN RETURN; END IF;

  INSERT INTO route_live_locations (route_id, portal_user_id, lat, lng, updated_at)
  VALUES (p_route_id, v_portal_user_id, p_lat, p_lng, now())
  ON CONFLICT (route_id, portal_user_id) DO UPDATE SET lat = p_lat, lng = p_lng, updated_at = now();

  SELECT vr.vehicle_id INTO v_vehicle_id FROM vehicle_routes vr WHERE vr.id = p_route_id;
  SELECT EXISTS (SELECT 1 FROM vehicles v WHERE v.id = v_vehicle_id AND v.portal_user_id = v_portal_user_id) INTO v_is_driver;
  IF v_is_driver THEN
    SELECT id INTO v_run_id FROM route_runs WHERE route_id = p_route_id AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1;
    IF v_run_id IS NOT NULL THEN
      INSERT INTO route_run_path_points (route_run_id, lat, lng) VALUES (v_run_id, p_lat, p_lng);
    END IF;
  END IF;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 2. Fuel cost per trip — optional station/location + trip link.
-- ═════════════════════════════════════════════════════════════════════
ALTER TABLE vehicle_expenses ADD COLUMN IF NOT EXISTS route_run_id uuid REFERENCES route_runs(id) ON DELETE SET NULL;
ALTER TABLE vehicle_expenses ADD COLUMN IF NOT EXISTS station_name varchar;
ALTER TABLE vehicle_expenses ADD COLUMN IF NOT EXISTS lat double precision;
ALTER TABLE vehicle_expenses ADD COLUMN IF NOT EXISTS lng double precision;

CREATE OR REPLACE FUNCTION record_vehicle_expense(
  p_vehicle_id uuid, p_category varchar, p_amount_pkr decimal, p_note text DEFAULT NULL, p_expense_date date DEFAULT NULL,
  p_route_run_id uuid DEFAULT NULL, p_station_name varchar DEFAULT NULL, p_lat double precision DEFAULT NULL, p_lng double precision DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(p_vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF p_category NOT IN ('fuel', 'maintenance', 'toll', 'other') THEN RAISE EXCEPTION 'Invalid expense category.' USING ERRCODE = 'P0001'; END IF;
  IF p_amount_pkr IS NULL OR p_amount_pkr <= 0 THEN RAISE EXCEPTION 'Enter a real amount.' USING ERRCODE = 'P0001'; END IF;
  IF p_route_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM route_runs rr JOIN vehicle_routes vr ON vr.id = rr.route_id WHERE rr.id = p_route_run_id AND vr.vehicle_id = p_vehicle_id
  ) THEN
    RAISE EXCEPTION 'That trip does not belong to this vehicle.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO vehicle_expenses (vehicle_id, category, amount_pkr, note, expense_date, recorded_by_portal_user_id, route_run_id, station_name, lat, lng)
  VALUES (p_vehicle_id, p_category, p_amount_pkr, nullif(trim(coalesce(p_note, '')), ''), coalesce(p_expense_date, (now() AT TIME ZONE 'Asia/Karachi')::date), v_portal_user_id,
    p_route_run_id, nullif(trim(coalesce(p_station_name, '')), ''), p_lat, p_lng)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 3. admin_recent_route_runs — the picker list. Platform-wide (admin
--    only); a fleet owner already has fleet_vehicle_schedule for "what's
--    running today" and can reach the same detail via route_run_detail.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION admin_recent_route_runs(p_from date DEFAULT NULL, p_to date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_from date := COALESCE(p_from, (now() AT TIME ZONE 'Asia/Karachi')::date - 13);
  v_to date := COALESCE(p_to, (now() AT TIME ZONE 'Asia/Karachi')::date);
  v_result jsonb;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', rr.id, 'route_id', rr.route_id, 'direction', rr.direction, 'started_at', rr.started_at, 'ended_at', rr.ended_at,
    'origin', vr.origin, 'destination', vr.destination, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type
  ) ORDER BY rr.started_at DESC), '[]'::jsonb) INTO v_result
  FROM route_runs rr JOIN vehicle_routes vr ON vr.id = rr.route_id JOIN vehicles v ON v.id = vr.vehicle_id
  WHERE (rr.started_at AT TIME ZONE 'Asia/Karachi')::date BETWEEN v_from AND v_to
  LIMIT 200;

  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION admin_recent_route_runs(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_recent_route_runs(date, date) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 4. route_run_detail — the whole trip-history screen in one call.
--    Reachable by the fleet owner/staff too (can_manage_vehicle), not
--    just admin — same RPC, same reasoning as every other report this
--    session.
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
    -- manual_ride_bookings has no boarded_at/dropped_off_at at all — a
    -- counter sale is always picked up in person at the station, no
    -- separate onboard-confirmation step the way an app booking has.
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
    'actual_path', (SELECT COALESCE(jsonb_agg(jsonb_build_object('lat', lat, 'lng', lng, 'recorded_at', recorded_at) ORDER BY recorded_at), '[]'::jsonb) FROM route_run_path_points WHERE route_run_id = p_route_run_id),
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
REVOKE ALL ON FUNCTION route_run_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION route_run_detail(uuid) TO authenticated;
