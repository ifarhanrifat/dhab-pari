-- 2026-11-20: the real driver-app rebuild (SAFAR_Driver_Trip_Operations.html
-- blueprint). Confirmed by direct audit: the trip-ops RPCs (close_route_
-- stop_challan, board_manual_ticket, mark_manual_ticket_no_show/alighted,
-- route_departure_chalan, route_master_trip_challan, all 924/926/927/928)
-- already gate on can_manage_vehicle, which a driver already passes —
-- those need zero changes, only a new frontend screen (drive/page.tsx).
-- What's genuinely missing, added here:
--   1. A real GPS-geofenced driver attendance system (none existed —
--      driver_duty_shifts, 912, is explicitly admin-recorded only).
--   2. A driver's own payroll self-view (salary/commission/overtime data
--      already exists; only fleet_staff_overtime_entries' SELECT policy
--      was missing the self-read branch salaries/commissions already have).
--   3. A real submit/confirm cash-handover flow — record_route_driver_
--      handover (924) is owner-only, one-step "already received"; the
--      blueprint is explicit that a driver's submission alone must not
--      settle the cash.

-- ═════════════════════════════════════════════════════════════════════
-- 1. Driver attendance — geofenced self check-in/out. Reuses haversine_km
-- (475, already proven for geofencing by check_catch_feasibility, 859)
-- against the driver's own assigned terminal (fleet_staff.counter_id →
-- fleet_counters.lat/lng, 883). A driver with no counter_id assigned
-- gets a clear rejection, not a silent pass — unlike is_my_counter_or_
-- admin's "no counter = open" rule, which exists for a different reason
-- (scoping an action to *someone's* terminal, not proving physical
-- presence at a specific point).
-- ═════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS driver_attendance_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_staff_id uuid NOT NULL REFERENCES fleet_staff(id) ON DELETE CASCADE,
  counter_id uuid NOT NULL REFERENCES fleet_counters(id),
  check_in_at timestamptz NOT NULL DEFAULT now(),
  check_in_lat numeric, check_in_lng numeric, distance_km_at_checkin numeric,
  check_out_at timestamptz
);
CREATE INDEX IF NOT EXISTS driver_attendance_log_staff_idx ON driver_attendance_log(fleet_staff_id, check_in_at DESC);
ALTER TABLE driver_attendance_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "driver_attendance_log_read" ON driver_attendance_log FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.id = fleet_staff_id AND fs.portal_user_id = current_portal_user_id())
    OR EXISTS (SELECT 1 FROM fleet_staff fs JOIN fleets f ON f.id = fs.fleet_id WHERE fs.id = fleet_staff_id AND f.owning_portal_user_id = current_portal_user_id())
  );
-- No INSERT/UPDATE/DELETE policy — SECURITY DEFINER RPC only.

CREATE OR REPLACE FUNCTION driver_check_in(p_lat numeric, p_lng numeric) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fs fleet_staff%ROWTYPE; v_counter fleet_counters%ROWTYPE; v_distance_km numeric; v_radius_km numeric; v_id uuid;
BEGIN
  IF p_lat IS NULL OR p_lng IS NULL THEN RAISE EXCEPTION 'Location is required to check in.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_fs FROM fleet_staff WHERE portal_user_id = current_portal_user_id() AND counter_id IS NOT NULL LIMIT 1;
  IF v_fs.id IS NULL THEN
    RAISE EXCEPTION 'You have no assigned terminal yet — ask your fleet owner to assign one.' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM driver_attendance_log WHERE fleet_staff_id = v_fs.id AND check_out_at IS NULL) THEN
    RAISE EXCEPTION 'You are already checked in — check out first.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_counter FROM fleet_counters WHERE id = v_fs.counter_id;
  IF v_counter.lat IS NULL OR v_counter.lng IS NULL THEN
    RAISE EXCEPTION 'Your terminal has no stored location yet — ask your fleet owner to set it.' USING ERRCODE = 'P0001';
  END IF;

  v_distance_km := haversine_km(p_lat, p_lng, v_counter.lat, v_counter.lng);
  SELECT COALESCE(value::numeric, 0.5) INTO v_radius_km FROM site_settings WHERE key = 'driver_checkin_radius_km' LIMIT 1;

  IF v_distance_km > v_radius_km THEN
    RAISE EXCEPTION 'You are %.2f km from % — move within %.1f km to check in.', v_distance_km, v_counter.city, v_radius_km USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO driver_attendance_log (fleet_staff_id, counter_id, check_in_lat, check_in_lng, distance_km_at_checkin)
  VALUES (v_fs.id, v_counter.id, p_lat, p_lng, v_distance_km)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'counter_city', v_counter.city, 'counter_name', v_counter.name, 'distance_km', v_distance_km);
END;
$$;
REVOKE ALL ON FUNCTION driver_check_in(numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION driver_check_in(numeric, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION driver_check_out() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fs_id uuid;
BEGIN
  SELECT id INTO v_fs_id FROM fleet_staff WHERE portal_user_id = current_portal_user_id() LIMIT 1;
  UPDATE driver_attendance_log SET check_out_at = now()
  WHERE fleet_staff_id = v_fs_id AND check_out_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'You are not currently checked in.' USING ERRCODE = 'P0001'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION driver_check_out() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION driver_check_out() TO authenticated;

CREATE OR REPLACE FUNCTION my_driver_attendance_status(p_fleet_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fs fleet_staff%ROWTYPE; v_open driver_attendance_log%ROWTYPE; v_counter fleet_counters%ROWTYPE;
BEGIN
  SELECT * INTO v_fs FROM fleet_staff WHERE fleet_id = p_fleet_id AND portal_user_id = current_portal_user_id();
  IF v_fs.id IS NULL THEN RAISE EXCEPTION 'You do not work at this fleet.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_open FROM driver_attendance_log WHERE fleet_staff_id = v_fs.id AND check_out_at IS NULL ORDER BY check_in_at DESC LIMIT 1;
  IF v_fs.counter_id IS NOT NULL THEN SELECT * INTO v_counter FROM fleet_counters WHERE id = v_fs.counter_id; END IF;

  RETURN jsonb_build_object(
    'has_terminal', v_fs.counter_id IS NOT NULL,
    'counter_city', v_counter.city, 'counter_name', v_counter.name,
    'checked_in', v_open.id IS NOT NULL, 'since', v_open.check_in_at
  );
END;
$$;
REVOKE ALL ON FUNCTION my_driver_attendance_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_driver_attendance_status(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 2. Driver payroll self-view. Salaries/commissions already let a staff
-- member read their own rows (854/883's own RLS); overtime entries
-- (911) never got that branch — true gap, fixed directly on the policy
-- (not a function, no true-replace concern).
-- ═════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "fleet_staff_overtime_manager_read" ON fleet_staff_overtime_entries;
CREATE POLICY "fleet_staff_overtime_manager_read" ON fleet_staff_overtime_entries FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM fleet_staff fs JOIN fleets f ON f.id = fs.fleet_id WHERE fs.id = fleet_staff_id AND f.owning_portal_user_id = current_portal_user_id())
    OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.id = fleet_staff_id AND fs.portal_user_id = current_portal_user_id())
  );

CREATE OR REPLACE FUNCTION my_driver_payroll(p_fleet_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fs fleet_staff%ROWTYPE; v_settings fleet_payroll_settings%ROWTYPE;
BEGIN
  SELECT * INTO v_fs FROM fleet_staff WHERE fleet_id = p_fleet_id AND portal_user_id = current_portal_user_id();
  IF v_fs.id IS NULL THEN RAISE EXCEPTION 'You do not work at this fleet.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_settings FROM fleet_payroll_settings WHERE fleet_id = p_fleet_id;

  RETURN jsonb_build_object(
    'pay_frequency', COALESCE(v_settings.pay_frequency, 'monthly'),
    'current_monthly_salary_pkr', (
      SELECT fss.monthly_salary_pkr FROM fleet_staff_salaries fss WHERE fss.fleet_staff_id = v_fs.id ORDER BY fss.effective_from DESC, fss.created_at DESC LIMIT 1
    ),
    'commission_this_month_pkr', (
      SELECT COALESCE(SUM(fc.amount_pkr), 0) FROM fleet_staff_commissions fc
      WHERE fc.fleet_staff_id = v_fs.id AND fc.status = 'earned'
        AND date_trunc('month', fc.created_at AT TIME ZONE 'Asia/Karachi') = date_trunc('month', now() AT TIME ZONE 'Asia/Karachi')
    ),
    'recent_commissions', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', fc.id, 'amount_pkr', fc.amount_pkr, 'seats', fc.seats, 'status', fc.status, 'created_at', fc.created_at) ORDER BY fc.created_at DESC), '[]'::jsonb)
      FROM (SELECT * FROM fleet_staff_commissions WHERE fleet_staff_id = v_fs.id ORDER BY created_at DESC LIMIT 10) fc
    ),
    'overtime_this_month_pkr', (
      SELECT COALESCE(SUM(oe.amount_pkr), 0) FROM fleet_staff_overtime_entries oe
      WHERE oe.fleet_staff_id = v_fs.id AND date_trunc('month', oe.work_date) = date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)
    ),
    'recent_overtime', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', oe.id, 'work_date', oe.work_date, 'hours', oe.hours, 'amount_pkr', oe.amount_pkr, 'note', oe.note) ORDER BY oe.work_date DESC), '[]'::jsonb)
      FROM (SELECT * FROM fleet_staff_overtime_entries WHERE fleet_staff_id = v_fs.id ORDER BY work_date DESC LIMIT 10) oe
    ),
    'recent_salary_payments', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', sp.id, 'amount_pkr', sp.amount_pkr, 'paid_on', sp.paid_on, 'note', sp.note) ORDER BY sp.paid_on DESC), '[]'::jsonb)
      FROM (SELECT * FROM fleet_staff_salary_payments WHERE fleet_staff_id = v_fs.id ORDER BY paid_on DESC LIMIT 10) sp
    )
  );
END;
$$;
REVOKE ALL ON FUNCTION my_driver_payroll(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_driver_payroll(uuid) TO authenticated;

-- Blueprint's explicit rule: "driver can view and dispute, but cannot
-- approve their own payroll" — a minimal query/response record, not a
-- payroll edit of any kind.
CREATE TABLE IF NOT EXISTS fleet_payroll_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_staff_id uuid NOT NULL REFERENCES fleet_staff(id) ON DELETE CASCADE,
  note text NOT NULL,
  status varchar NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS fleet_payroll_disputes_staff_idx ON fleet_payroll_disputes(fleet_staff_id, created_at DESC);
ALTER TABLE fleet_payroll_disputes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_payroll_disputes_read" ON fleet_payroll_disputes FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.id = fleet_staff_id AND fs.portal_user_id = current_portal_user_id())
    OR EXISTS (SELECT 1 FROM fleet_staff fs JOIN fleets f ON f.id = fs.fleet_id WHERE fs.id = fleet_staff_id AND f.owning_portal_user_id = current_portal_user_id())
  );
-- No INSERT/UPDATE/DELETE policy — SECURITY DEFINER RPC only.

CREATE OR REPLACE FUNCTION raise_payroll_dispute(p_fleet_id uuid, p_note text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fs_id uuid; v_id uuid; v_note text := nullif(trim(coalesce(p_note, '')), '');
BEGIN
  IF v_note IS NULL THEN RAISE EXCEPTION 'Describe your payroll query.' USING ERRCODE = 'P0001'; END IF;
  SELECT id INTO v_fs_id FROM fleet_staff WHERE fleet_id = p_fleet_id AND portal_user_id = current_portal_user_id();
  IF v_fs_id IS NULL THEN RAISE EXCEPTION 'You do not work at this fleet.' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO fleet_payroll_disputes (fleet_staff_id, note) VALUES (v_fs_id, v_note) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION raise_payroll_dispute(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION raise_payroll_dispute(uuid, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 3. Real submit/confirm cash handover. Existing column default keeps
-- record_route_driver_handover's (924) one-step owner behavior exactly
-- as it is today — only the new driver-submitted path starts 'pending'.
-- ═════════════════════════════════════════════════════════════════════
ALTER TABLE route_driver_cash_handovers ADD COLUMN IF NOT EXISTS status varchar NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed'));
ALTER TABLE route_driver_cash_handovers ADD COLUMN IF NOT EXISTS confirmed_by uuid REFERENCES portal_users(id);
ALTER TABLE route_driver_cash_handovers ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

CREATE OR REPLACE FUNCTION submit_route_driver_handover(
  p_route_id uuid, p_travel_date date, p_direction varchar, p_amount_pkr decimal,
  p_received_by_counter_id uuid DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route vehicle_routes%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF p_direction NOT IN ('outbound', 'return') THEN RAISE EXCEPTION 'Invalid direction.' USING ERRCODE = 'P0001'; END IF;
  IF p_amount_pkr IS NULL OR p_amount_pkr <= 0 THEN RAISE EXCEPTION 'Enter a real amount.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO route_driver_cash_handovers (route_id, travel_date, direction, amount_pkr, received_by_counter_id, note, recorded_by, status)
  VALUES (p_route_id, p_travel_date, p_direction, p_amount_pkr, p_received_by_counter_id, nullif(trim(coalesce(p_note, '')), ''), current_portal_user_id(), 'pending')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION submit_route_driver_handover(uuid, date, varchar, decimal, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION submit_route_driver_handover(uuid, date, varchar, decimal, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION confirm_route_driver_handover(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route_id uuid;
BEGIN
  SELECT route_id INTO v_route_id FROM route_driver_cash_handovers WHERE id = p_id AND status = 'pending' FOR UPDATE;
  IF v_route_id IS NULL THEN RAISE EXCEPTION 'Handover not found or already confirmed.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id JOIN fleets f ON f.id = v.fleet_id
    WHERE vr.id = v_route_id AND f.owning_portal_user_id = current_portal_user_id()
  ) THEN
    RAISE EXCEPTION 'You do not own this route''s fleet.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE route_driver_cash_handovers SET status = 'confirmed', confirmed_by = current_portal_user_id(), confirmed_at = now() WHERE id = p_id;
END;
$$;
REVOKE ALL ON FUNCTION confirm_route_driver_handover(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION confirm_route_driver_handover(uuid) TO authenticated;

-- route_master_trip_challan (924's body, true-replace) — driver_
-- handovers_pkr/float now count only CONFIRMED handovers (a pending
-- one isn't settled cash yet); the handovers list itself still shows
-- every row, pending included, with its real status so the UI can
-- say "awaiting confirmation" instead of hiding it.
CREATE OR REPLACE FUNCTION route_master_trip_challan(p_route_id uuid, p_travel_date date, p_direction varchar DEFAULT 'outbound') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_route vehicle_routes%ROWTYPE; v_run route_runs%ROWTYPE;
  v_revenue decimal; v_expenses decimal; v_advances decimal; v_handovers decimal;
  v_result jsonb;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_run FROM route_runs WHERE route_id = p_route_id AND direction = p_direction
    AND (started_at AT TIME ZONE 'Asia/Karachi')::date = p_travel_date ORDER BY started_at DESC LIMIT 1;

  SELECT
    COALESCE((SELECT SUM(total_amount_pkr) FROM manual_ride_bookings
      WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction AND status IN ('confirmed', 'no_show')), 0)
    + COALESCE((SELECT SUM(total_amount_pkr) FROM ride_bookings
      WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction AND status IN ('announced', 'confirmed') AND NOT is_mid_route_catch), 0)
  INTO v_revenue;

  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_expenses FROM vehicle_expenses WHERE route_run_id = v_run.id;
  SELECT COALESCE(SUM(driver_advance_pkr), 0) INTO v_advances FROM route_stop_challans WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction;
  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_handovers FROM route_driver_cash_handovers WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction AND status = 'confirmed';

  SELECT jsonb_build_object(
    'route_id', p_route_id, 'travel_date', p_travel_date, 'direction', p_direction,
    'origin', v_route.origin, 'destination', v_route.destination,
    'run_started_at', v_run.started_at, 'run_ended_at', v_run.ended_at,
    'stop_challans', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', sc.id, 'stop_id', sc.stop_id, 'stop_label', rs.label, 'terminal_city', fc.city, 'terminal_name', fc.name,
        'expected_count', sc.expected_count, 'boarded_count', sc.boarded_count, 'no_show_count', sc.no_show_count,
        'cash_collected_pkr', sc.cash_collected_pkr, 'digital_collected_pkr', sc.digital_collected_pkr,
        'driver_advance_pkr', sc.driver_advance_pkr, 'other_cash_pkr', sc.other_cash_pkr, 'note', sc.note, 'closed_at', sc.closed_at
      ) ORDER BY COALESCE(rs.stop_order, -1)), '[]'::jsonb)
      FROM route_stop_challans sc
      LEFT JOIN route_stops rs ON rs.id = sc.stop_id
      LEFT JOIN fleet_counters fc ON fc.id = rs.counter_id
      WHERE sc.route_id = p_route_id AND sc.travel_date = p_travel_date AND sc.direction = p_direction
    ),
    'total_stops', (SELECT COUNT(*) + 1 FROM route_stops WHERE route_id = p_route_id),
    'closed_stops', (SELECT COUNT(*) FROM route_stop_challans WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction),
    'revenue_pkr', v_revenue,
    'expenses_pkr', v_expenses,
    'driver_advances_pkr', v_advances,
    'driver_handovers_pkr', v_handovers,
    'driver_cash_float_pkr', v_advances - v_handovers,
    'net_result_pkr', v_revenue - v_expenses,
    'handovers', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', h.id, 'amount_pkr', h.amount_pkr, 'received_by_counter_id', h.received_by_counter_id,
        'counter_city', fc.city, 'note', h.note, 'status', h.status, 'created_at', h.created_at) ORDER BY h.created_at), '[]'::jsonb)
      FROM route_driver_cash_handovers h LEFT JOIN fleet_counters fc ON fc.id = h.received_by_counter_id
      WHERE h.route_id = p_route_id AND h.travel_date = p_travel_date AND h.direction = p_direction
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION route_master_trip_challan(uuid, date, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION route_master_trip_challan(uuid, date, varchar) TO authenticated;
