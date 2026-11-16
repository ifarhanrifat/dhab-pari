-- Migration 885: granular RBAC delegation + a real fleet audit log.
--
-- Deliberately scoped to be additive-only, confirmed safe by first
-- checking each candidate function's CURRENT gate directly from its
-- live migration file: set_fleet_staff_salary, record_staff_salary_
-- payment, and record_counter_remittance are ALL hard owner-only
-- today (fleet staff get a flat rejection, no exceptions). So the
-- permission matrix below can only ever WIDEN access for a role the
-- owner explicitly opts in — it can never take away something staff
-- already rely on. Route/document edits stay owner-only this round;
-- delegating those is a bigger operational risk, left for later.
--
-- The audit log is a brand-new fleet-scoped table, not a retrofit of
-- the existing `audit_log` (021) — that table is hard-CHECK-scoped to
-- bills/payments/donors/vouchers, FKs to admin_users (not
-- portal_users), and is shaped for delete/restore tracking, not a
-- general action log. Wrong bounded context to reuse.

-- 1. The permission matrix itself.
CREATE TABLE IF NOT EXISTS fleet_role_permissions (
  fleet_id uuid NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,
  role varchar NOT NULL CHECK (role IN ('staff', 'booking_officer', 'terminal_manager', 'accountant', 'other')),
  module varchar NOT NULL CHECK (module IN ('staff_payroll', 'cash')),
  can_edit boolean NOT NULL DEFAULT false,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by_portal_user_id uuid REFERENCES portal_users(id),
  PRIMARY KEY (fleet_id, role, module)
);
ALTER TABLE fleet_role_permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_rw_fleet_role_permissions" ON fleet_role_permissions;
CREATE POLICY "owner_rw_fleet_role_permissions" ON fleet_role_permissions FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM fleets f WHERE f.id = fleet_id AND f.owning_portal_user_id = current_portal_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM fleets f WHERE f.id = fleet_id AND f.owning_portal_user_id = current_portal_user_id()));

CREATE OR REPLACE FUNCTION fleet_staff_role_has_permission(p_fleet_id uuid, p_role varchar, p_module varchar) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT can_edit FROM fleet_role_permissions WHERE fleet_id = p_fleet_id AND role = p_role AND module = p_module), false);
$$;

CREATE OR REPLACE FUNCTION set_fleet_role_permission(p_fleet_id uuid, p_role varchar, p_module varchar, p_can_edit boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id AND owning_portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_role NOT IN ('staff', 'booking_officer', 'terminal_manager', 'accountant', 'other') THEN RAISE EXCEPTION 'Unknown role.' USING ERRCODE = 'P0001'; END IF;
  IF p_module NOT IN ('staff_payroll', 'cash') THEN RAISE EXCEPTION 'Unknown module.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO fleet_role_permissions (fleet_id, role, module, can_edit, granted_by_portal_user_id)
  VALUES (p_fleet_id, p_role, p_module, p_can_edit, v_portal_user_id)
  ON CONFLICT (fleet_id, role, module) DO UPDATE SET can_edit = EXCLUDED.can_edit, granted_at = now(), granted_by_portal_user_id = EXCLUDED.granted_by_portal_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION fleet_role_permissions_matrix(p_fleet_id uuid) RETURNS TABLE(role varchar, module varchar, can_edit boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.role, m.module, COALESCE(p.can_edit, false)
  FROM (VALUES ('staff'), ('booking_officer'), ('terminal_manager'), ('accountant'), ('other')) AS r(role)
  CROSS JOIN (VALUES ('staff_payroll'), ('cash')) AS m(module)
  LEFT JOIN fleet_role_permissions p ON p.fleet_id = p_fleet_id AND p.role = r.role AND p.module = m.module
  WHERE EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id());
$$;

-- 2. The audit log.
CREATE TABLE IF NOT EXISTS fleet_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id uuid NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,
  actor_portal_user_id uuid REFERENCES portal_users(id),
  action varchar NOT NULL,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fleet_audit_log_fleet_idx ON fleet_audit_log(fleet_id, created_at DESC);
ALTER TABLE fleet_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_read_fleet_audit_log" ON fleet_audit_log;
CREATE POLICY "owner_read_fleet_audit_log" ON fleet_audit_log FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM fleets f WHERE f.id = fleet_id AND f.owning_portal_user_id = current_portal_user_id()));
-- No INSERT/UPDATE/DELETE policy for authenticated at all — writes only
-- happen through log_fleet_action, SECURITY DEFINER, never directly.

CREATE OR REPLACE FUNCTION log_fleet_action(p_fleet_id uuid, p_action varchar, p_details jsonb DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO fleet_audit_log (fleet_id, actor_portal_user_id, action, details)
  VALUES (p_fleet_id, current_portal_user_id(), p_action, p_details);
END;
$$;

CREATE OR REPLACE FUNCTION fleet_audit_log_recent(p_fleet_id uuid, p_limit int DEFAULT 100)
RETURNS TABLE(id uuid, actor_name varchar, action varchar, details jsonb, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT l.id, pu.full_name, l.action, l.details, l.created_at
  FROM fleet_audit_log l
  LEFT JOIN portal_users pu ON pu.id = l.actor_portal_user_id
  WHERE l.fleet_id = p_fleet_id AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
  ORDER BY l.created_at DESC
  LIMIT LEAST(p_limit, 500);
$$;

-- 3. Widen the 3 confirmed owner-only writes to also accept a staff
-- member whose role has been explicitly granted the matching module —
-- true replace, exact prior body plus the one condition and one log call.

CREATE OR REPLACE FUNCTION set_fleet_staff_salary(p_fleet_staff_id uuid, p_monthly_salary_pkr decimal) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_fleet_id uuid; v_portal_user_id uuid := current_portal_user_id();
BEGIN
  SELECT fs.fleet_id INTO v_fleet_id FROM fleet_staff fs WHERE fs.id = p_fleet_staff_id;
  IF v_fleet_id IS NULL THEN RAISE EXCEPTION 'Staff member not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (
    EXISTS (SELECT 1 FROM fleets f WHERE f.id = v_fleet_id AND f.owning_portal_user_id = v_portal_user_id)
    OR fleet_staff_role_has_permission(v_fleet_id, (SELECT role FROM fleet_staff WHERE portal_user_id = v_portal_user_id AND fleet_id = v_fleet_id), 'staff_payroll')
  ) THEN RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001'; END IF;
  IF p_monthly_salary_pkr IS NULL OR p_monthly_salary_pkr < 0 THEN RAISE EXCEPTION 'Enter a real salary amount.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO fleet_staff_salaries (fleet_staff_id, monthly_salary_pkr) VALUES (p_fleet_staff_id, p_monthly_salary_pkr) RETURNING id INTO v_id;
  PERFORM log_fleet_action(v_fleet_id, 'staff_salary_set', jsonb_build_object('fleet_staff_id', p_fleet_staff_id, 'monthly_salary_pkr', p_monthly_salary_pkr));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION record_staff_salary_payment(p_fleet_staff_id uuid, p_amount_pkr decimal, p_note text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid; v_fleet_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT fs.fleet_id INTO v_fleet_id FROM fleet_staff fs WHERE fs.id = p_fleet_staff_id;
  IF v_fleet_id IS NULL THEN RAISE EXCEPTION 'Staff member not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (
    EXISTS (SELECT 1 FROM fleets f WHERE f.id = v_fleet_id AND f.owning_portal_user_id = v_portal_user_id)
    OR fleet_staff_role_has_permission(v_fleet_id, (SELECT role FROM fleet_staff WHERE portal_user_id = v_portal_user_id AND fleet_id = v_fleet_id), 'staff_payroll')
  ) THEN RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001'; END IF;
  IF p_amount_pkr IS NULL OR p_amount_pkr <= 0 THEN RAISE EXCEPTION 'Enter a real amount.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO fleet_staff_salary_payments (fleet_staff_id, amount_pkr, note, recorded_by)
  VALUES (p_fleet_staff_id, p_amount_pkr, nullif(trim(coalesce(p_note, '')), ''), v_portal_user_id)
  RETURNING id INTO v_id;
  PERFORM log_fleet_action(v_fleet_id, 'staff_salary_payment_recorded', jsonb_build_object('fleet_staff_id', p_fleet_staff_id, 'amount_pkr', p_amount_pkr));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION record_counter_remittance(p_counter_id uuid, p_amount_pkr decimal, p_note text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid; v_fleet_id uuid;
BEGIN
  SELECT c.fleet_id INTO v_fleet_id FROM fleet_counters c WHERE c.id = p_counter_id;
  IF v_fleet_id IS NULL THEN RAISE EXCEPTION 'Counter not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (
    EXISTS (SELECT 1 FROM fleets f WHERE f.id = v_fleet_id AND f.owning_portal_user_id = v_portal_user_id)
    OR fleet_staff_role_has_permission(v_fleet_id, (SELECT role FROM fleet_staff WHERE portal_user_id = v_portal_user_id AND fleet_id = v_fleet_id), 'cash')
  ) THEN RAISE EXCEPTION 'You do not own this counter''s fleet.' USING ERRCODE = 'P0001'; END IF;
  IF p_amount_pkr IS NULL OR p_amount_pkr <= 0 THEN RAISE EXCEPTION 'Enter a real amount.' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO fleet_counter_remittances (counter_id, amount_pkr, note, recorded_by_portal_user_id)
  VALUES (p_counter_id, p_amount_pkr, nullif(trim(coalesce(p_note, '')), ''), v_portal_user_id)
  RETURNING id INTO v_id;
  PERFORM log_fleet_action(v_fleet_id, 'counter_remittance_recorded', jsonb_build_object('counter_id', p_counter_id, 'amount_pkr', p_amount_pkr));
  RETURN v_id;
END;
$$;

-- 4. Audit-log the sensitive owner-only writes from 883 too (no access
-- change — these stay owner-only, just now logged).

CREATE OR REPLACE FUNCTION set_fleet_staff_role(p_fleet_staff_id uuid, p_role varchar) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fleet_id uuid;
BEGIN
  SELECT fs.fleet_id INTO v_fleet_id FROM fleet_staff fs JOIN fleets f ON f.id = fs.fleet_id WHERE fs.id = p_fleet_staff_id AND f.owning_portal_user_id = current_portal_user_id();
  IF v_fleet_id IS NULL THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_role NOT IN ('staff', 'booking_officer', 'terminal_manager', 'accountant', 'other') THEN
    RAISE EXCEPTION 'Unknown role.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE fleet_staff SET role = p_role WHERE id = p_fleet_staff_id;
  PERFORM log_fleet_action(v_fleet_id, 'staff_role_set', jsonb_build_object('fleet_staff_id', p_fleet_staff_id, 'role', p_role));
END;
$$;

CREATE OR REPLACE FUNCTION set_fleet_staff_commission(p_fleet_staff_id uuid, p_commission_amount_pkr decimal) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fleet_id uuid;
BEGIN
  SELECT fs.fleet_id INTO v_fleet_id FROM fleet_staff fs JOIN fleets f ON f.id = fs.fleet_id WHERE fs.id = p_fleet_staff_id AND f.owning_portal_user_id = current_portal_user_id();
  IF v_fleet_id IS NULL THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_commission_amount_pkr IS NOT NULL AND p_commission_amount_pkr < 0 THEN RAISE EXCEPTION 'Enter a real commission amount.' USING ERRCODE = 'P0001'; END IF;
  UPDATE fleet_staff SET commission_amount_pkr = p_commission_amount_pkr WHERE id = p_fleet_staff_id;
  PERFORM log_fleet_action(v_fleet_id, 'staff_commission_set', jsonb_build_object('fleet_staff_id', p_fleet_staff_id, 'commission_amount_pkr', p_commission_amount_pkr));
END;
$$;

CREATE OR REPLACE FUNCTION cancel_manual_booking(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route_id uuid; v_fleet_id uuid;
BEGIN
  SELECT route_id INTO v_route_id FROM manual_ride_bookings WHERE id = p_id FOR UPDATE;
  IF v_route_id IS NULL THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicle_routes vr WHERE vr.id = v_route_id AND can_manage_vehicle(vr.vehicle_id)) THEN
    RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE manual_ride_bookings SET status = 'cancelled' WHERE id = p_id;
  DELETE FROM ride_booking_seat_numbers WHERE manual_ride_booking_id = p_id;
  UPDATE fleet_staff_commissions SET status = 'reversed', reversed_at = now() WHERE manual_ride_booking_id = p_id AND status = 'earned';
  SELECT v.fleet_id INTO v_fleet_id FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id WHERE vr.id = v_route_id;
  IF v_fleet_id IS NOT NULL THEN
    PERFORM log_fleet_action(v_fleet_id, 'manual_booking_cancelled', jsonb_build_object('manual_ride_booking_id', p_id));
  END IF;
END;
$$;
