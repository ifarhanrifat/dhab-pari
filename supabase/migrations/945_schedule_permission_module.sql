-- Migration 945: real gap found live while reviewing a route's "Edit"
-- button with the user — update_vehicle_route_schedule/close_vehicle_
-- route/reopen_vehicle_route all gate on can_administer_vehicle, which
-- is "anyone who isn't specifically a driver": a basic terminal/
-- booking-counter staff member, an accountant, or any other non-driver
-- role can unilaterally change a route's departure time, which days it
-- runs, or close/relaunch it entirely — a dispatch-level decision that
-- affects every other terminal and every booking already made, not
-- something a ticket counter should be able to do on its own.
--
-- Deliberately NOT applied to set_route_day_delay (900) — that one's
-- own migration comment already reasons through this exact question
-- and lands the other way on purpose ("a booking officer fielding a
-- phone call from a stuck driver needs to be able to set this too"),
-- a real, considered decision this migration leaves untouched.
--
-- Reuses the existing role-permission matrix (885/926) rather than
-- inventing a new mechanism — same WIDEN semantics as staff_payroll/
-- cash (no row = owner-only; the owner explicitly grants a role access
-- if they want one), not the accountant-lockdown's NARROW semantics
-- (which only ever blocks one specific role). Solo owner-operator
-- vehicles (fleet_id IS NULL) are completely unaffected — same
-- precedent as can_administer_vehicle itself.

ALTER TABLE fleet_role_permissions DROP CONSTRAINT IF EXISTS fleet_role_permissions_module_check;
ALTER TABLE fleet_role_permissions ADD CONSTRAINT fleet_role_permissions_module_check
  CHECK (module IN ('staff_payroll', 'cash', 'bookings', 'schedule'));

-- set_fleet_role_permission (885/926) — true-replace, only the module
-- allow-list widened.
CREATE OR REPLACE FUNCTION set_fleet_role_permission(p_fleet_id uuid, p_role varchar, p_module varchar, p_can_edit boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id AND owning_portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_role NOT IN ('staff', 'booking_officer', 'terminal_manager', 'accountant', 'other') THEN RAISE EXCEPTION 'Unknown role.' USING ERRCODE = 'P0001'; END IF;
  IF p_module NOT IN ('staff_payroll', 'cash', 'bookings', 'schedule') THEN RAISE EXCEPTION 'Unknown module.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO fleet_role_permissions (fleet_id, role, module, can_edit, granted_by_portal_user_id)
  VALUES (p_fleet_id, p_role, p_module, p_can_edit, v_portal_user_id)
  ON CONFLICT (fleet_id, role, module) DO UPDATE SET can_edit = EXCLUDED.can_edit, granted_at = now(), granted_by_portal_user_id = EXCLUDED.granted_by_portal_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION fleet_role_permissions_matrix(p_fleet_id uuid) RETURNS TABLE(role varchar, module varchar, can_edit boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.role, m.module, COALESCE(p.can_edit, false)
  FROM (VALUES ('staff'), ('booking_officer'), ('terminal_manager'), ('accountant'), ('other')) AS r(role)
  CROSS JOIN (VALUES ('staff_payroll'), ('cash'), ('bookings'), ('schedule')) AS m(module)
  LEFT JOIN fleet_role_permissions p ON p.fleet_id = p_fleet_id AND p.role = r.role AND p.module = m.module
  WHERE EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id());
$$;

-- The WIDEN-style guard itself: blocked only for a non-owner fleet_staff
-- member on a FLEET vehicle whose role hasn't been explicitly granted
-- 'schedule'. A driver is already rejected upstream by can_administer_
-- vehicle before this ever runs; a solo owner-operator (fleet_id NULL)
-- never matches the first EXISTS, so this can never block one.
CREATE OR REPLACE FUNCTION fleet_staff_schedule_blocked(p_vehicle_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM vehicles v JOIN fleet_staff fs ON fs.fleet_id = v.fleet_id
    WHERE v.id = p_vehicle_id AND v.fleet_id IS NOT NULL AND fs.portal_user_id = current_portal_user_id()
  )
  AND NOT EXISTS (
    SELECT 1 FROM vehicles v JOIN fleets f ON f.id = v.fleet_id
    WHERE v.id = p_vehicle_id AND f.owning_portal_user_id = current_portal_user_id()
  )
  AND NOT fleet_staff_role_has_permission(
    (SELECT fleet_id FROM vehicles WHERE id = p_vehicle_id),
    (SELECT fs.role FROM vehicles v JOIN fleet_staff fs ON fs.fleet_id = v.fleet_id WHERE v.id = p_vehicle_id AND fs.portal_user_id = current_portal_user_id()),
    'schedule'
  );
$$;
REVOKE ALL ON FUNCTION fleet_staff_schedule_blocked(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_staff_schedule_blocked(uuid) TO authenticated;

-- update_vehicle_route_schedule (893) — true-replace, current body
-- copied verbatim, one new check added right after the existing gate.
CREATE OR REPLACE FUNCTION update_vehicle_route_schedule(
  p_route_id uuid, p_departure_time time, p_days_of_week int[], p_return_departure_time time DEFAULT NULL,
  p_is_two_way boolean DEFAULT NULL, p_return_wait_minutes int DEFAULT NULL, p_return_days_of_week int[] DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vehicle_routes vr WHERE vr.id = p_route_id AND can_administer_vehicle(vr.vehicle_id)) THEN
    RAISE EXCEPTION 'You can only edit your own route.' USING ERRCODE = 'P0001';
  END IF;
  IF fleet_staff_schedule_blocked((SELECT vehicle_id FROM vehicle_routes WHERE id = p_route_id)) THEN
    RAISE EXCEPTION 'Only the fleet owner can edit the schedule, unless your role has been granted schedule access.' USING ERRCODE = 'P0001';
  END IF;
  IF p_days_of_week IS NULL OR array_length(p_days_of_week, 1) IS NULL THEN RAISE EXCEPTION 'Pick at least one day.' USING ERRCODE = 'P0001'; END IF;
  IF p_return_days_of_week IS NOT NULL AND array_length(p_return_days_of_week, 1) IS NULL THEN
    RAISE EXCEPTION 'Pick at least one return day, or leave it blank to match the outbound days.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicle_routes SET departure_time = p_departure_time, days_of_week = p_days_of_week, return_departure_time = p_return_departure_time,
    is_two_way = COALESCE(p_is_two_way, is_two_way), return_wait_minutes = CASE WHEN p_is_two_way IS NOT NULL THEN p_return_wait_minutes ELSE return_wait_minutes END,
    return_days_of_week = p_return_days_of_week
  WHERE id = p_route_id;
END;
$$;

-- close_vehicle_route (895) — true-replace, current body copied
-- verbatim, one new check added.
CREATE OR REPLACE FUNCTION public.close_vehicle_route(p_route_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r vehicle_routes%ROWTYPE; v vehicles%ROWTYPE;
  v_portal_user_id uuid := current_portal_user_id();
  b RECORD;
  v_cancelled_count int := 0;
BEGIN
  SELECT * INTO r FROM vehicle_routes WHERE id = p_route_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = r.vehicle_id;

  IF NOT (can_administer_vehicle(r.vehicle_id) OR COALESCE(current_admin_permission('post_transactions'), false)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF fleet_staff_schedule_blocked(r.vehicle_id) THEN
    RAISE EXCEPTION 'Only the fleet owner can close this route, unless your role has been granted schedule access.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicle_routes SET is_active = false WHERE id = p_route_id;

  FOR b IN
    SELECT id FROM ride_bookings
    WHERE route_id = p_route_id AND status IN ('announced', 'confirmed') AND travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
  LOOP
    PERFORM cancel_ride_booking(b.id, COALESCE(trim(p_reason), 'Route closed by driver'));
    v_cancelled_count := v_cancelled_count + 1;
  END LOOP;

  UPDATE commercial_ilans SET status = 'rejected', rejection_reason = 'Route was closed by the driver before review.', reviewed_at = now()
    WHERE vehicle_route_id = p_route_id AND status = 'pending_approval';

  UPDATE commercial_ilans SET is_paused = true, ends_at = now()
    WHERE vehicle_route_id = p_route_id AND status = 'approved' AND (ends_at IS NULL OR ends_at > now());

  RETURN jsonb_build_object('route_id', p_route_id, 'bookings_cancelled', v_cancelled_count);
END;
$function$;

-- reopen_vehicle_route (867) — true-replace. Gate upgraded from
-- can_manage_vehicle (which still includes drivers) to can_administer_
-- vehicle, consistent with its own sibling close_vehicle_route/
-- update_vehicle_route_schedule, plus the same new check.
CREATE OR REPLACE FUNCTION reopen_vehicle_route(p_route_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO r FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_administer_vehicle(r.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF fleet_staff_schedule_blocked(r.vehicle_id) THEN
    RAISE EXCEPTION 'Only the fleet owner can relaunch this route, unless your role has been granted schedule access.' USING ERRCODE = 'P0001';
  END IF;
  IF r.is_active THEN RAISE EXCEPTION 'This route is already active.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM vehicle_routes WHERE vehicle_id = r.vehicle_id AND is_active = true) THEN
    RAISE EXCEPTION 'This vehicle already has an active route — close it before relaunching another.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE vehicle_routes SET is_active = true WHERE id = p_route_id;
END;
$$;
