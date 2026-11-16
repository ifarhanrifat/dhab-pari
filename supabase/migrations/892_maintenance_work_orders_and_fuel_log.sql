-- Migration 892: Maintenance work orders + fuel log — confirmed via
-- direct grep that neither exists anywhere in dhab-pari today. The
-- generic vehicle_expenses log (854) already has 'fuel'/'maintenance'
-- categories, but only as a one-time amount+note — it has no odometer/
-- litres/rate breakdown for fuel, and no trackable work-order lifecycle
-- (workshop, estimate, due date, status) for maintenance the way
-- SAFAR's reference dashboard shows. This is additive: the expense log
-- keeps working exactly as before for P&L purposes; these are new,
-- separate operational records, same can_manage_vehicle() gate pattern
-- every other vehicle-scoped table in this app already uses (854/860/881).

CREATE TABLE IF NOT EXISTS vehicle_maintenance_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  issue text NOT NULL,
  workshop varchar,
  estimate_pkr decimal CHECK (estimate_pkr IS NULL OR estimate_pkr >= 0),
  due_date date,
  status varchar NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'hold', 'completed')),
  created_by_portal_user_id uuid REFERENCES portal_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS vehicle_maintenance_orders_vehicle_id_idx ON vehicle_maintenance_orders(vehicle_id);
ALTER TABLE vehicle_maintenance_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vehicle_maintenance_orders_manager_read" ON vehicle_maintenance_orders FOR SELECT TO authenticated
  USING (can_manage_vehicle(vehicle_id) OR current_admin_permission('manage_parties'));
-- No INSERT/UPDATE/DELETE policy — SECURITY DEFINER RPC only.

CREATE TABLE IF NOT EXISTS vehicle_fuel_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  odometer_km int CHECK (odometer_km IS NULL OR odometer_km >= 0),
  litres decimal NOT NULL CHECK (litres > 0),
  rate_pkr decimal NOT NULL CHECK (rate_pkr > 0),
  total_pkr decimal GENERATED ALWAYS AS (litres * rate_pkr) STORED,
  issued_by_portal_user_id uuid REFERENCES portal_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicle_fuel_log_vehicle_id_idx ON vehicle_fuel_log(vehicle_id);
ALTER TABLE vehicle_fuel_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vehicle_fuel_log_manager_read" ON vehicle_fuel_log FOR SELECT TO authenticated
  USING (can_manage_vehicle(vehicle_id) OR current_admin_permission('manage_parties'));
-- No INSERT/UPDATE/DELETE policy — SECURITY DEFINER RPC only.

CREATE OR REPLACE FUNCTION create_maintenance_order(p_vehicle_id uuid, p_issue text, p_workshop varchar DEFAULT NULL, p_estimate_pkr decimal DEFAULT NULL, p_due_date date DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(p_vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF p_issue IS NULL OR trim(p_issue) = '' THEN RAISE EXCEPTION 'Describe the issue.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicle_maintenance_orders (vehicle_id, issue, workshop, estimate_pkr, due_date, created_by_portal_user_id)
  VALUES (p_vehicle_id, trim(p_issue), nullif(trim(coalesce(p_workshop, '')), ''), p_estimate_pkr, p_due_date, v_portal_user_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION set_maintenance_order_status(p_id uuid, p_status varchar) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_vehicle_id uuid;
BEGIN
  SELECT vehicle_id INTO v_vehicle_id FROM vehicle_maintenance_orders WHERE id = p_id;
  IF v_vehicle_id IS NULL THEN RAISE EXCEPTION 'Work order not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF p_status NOT IN ('scheduled', 'in_progress', 'hold', 'completed') THEN RAISE EXCEPTION 'Unknown status.' USING ERRCODE = 'P0001'; END IF;
  UPDATE vehicle_maintenance_orders SET status = p_status, completed_at = CASE WHEN p_status = 'completed' THEN now() ELSE NULL END WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION record_fuel_entry(p_vehicle_id uuid, p_litres decimal, p_rate_pkr decimal, p_odometer_km int DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(p_vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF p_litres IS NULL OR p_litres <= 0 THEN RAISE EXCEPTION 'Enter real litres.' USING ERRCODE = 'P0001'; END IF;
  IF p_rate_pkr IS NULL OR p_rate_pkr <= 0 THEN RAISE EXCEPTION 'Enter a real rate.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicle_fuel_log (vehicle_id, odometer_km, litres, rate_pkr, issued_by_portal_user_id)
  VALUES (p_vehicle_id, p_odometer_km, p_litres, p_rate_pkr, v_portal_user_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Fleet-wide listings, joined with the vehicle's registration number
-- (same rule just fixed across the rest of the fleet section).
CREATE OR REPLACE FUNCTION fleet_maintenance_orders(p_fleet_id uuid)
RETURNS TABLE(id uuid, vehicle_id uuid, vehicle_number varchar, vehicle_type varchar, issue text, workshop varchar, estimate_pkr decimal, due_date date, status varchar, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.id, m.vehicle_id, v.vehicle_number, v.vehicle_type, m.issue, m.workshop, m.estimate_pkr, m.due_date, m.status, m.created_at
  FROM vehicle_maintenance_orders m JOIN vehicles v ON v.id = m.vehicle_id
  WHERE v.fleet_id = p_fleet_id
    AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND (f.owning_portal_user_id = current_portal_user_id() OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())))
  ORDER BY (m.status = 'completed'), m.due_date NULLS LAST, m.created_at DESC;
$$;

CREATE OR REPLACE FUNCTION fleet_fuel_log(p_fleet_id uuid)
RETURNS TABLE(id uuid, vehicle_id uuid, vehicle_number varchar, vehicle_type varchar, odometer_km int, litres decimal, rate_pkr decimal, total_pkr decimal, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT fl.id, fl.vehicle_id, v.vehicle_number, v.vehicle_type, fl.odometer_km, fl.litres, fl.rate_pkr, fl.total_pkr, fl.created_at
  FROM vehicle_fuel_log fl JOIN vehicles v ON v.id = fl.vehicle_id
  WHERE v.fleet_id = p_fleet_id
    AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND (f.owning_portal_user_id = current_portal_user_id() OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())))
  ORDER BY fl.created_at DESC
  LIMIT 100;
$$;

REVOKE ALL ON FUNCTION create_maintenance_order(uuid, text, varchar, decimal, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_maintenance_order(uuid, text, varchar, decimal, date) TO authenticated;
REVOKE ALL ON FUNCTION set_maintenance_order_status(uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_maintenance_order_status(uuid, varchar) TO authenticated;
REVOKE ALL ON FUNCTION record_fuel_entry(uuid, decimal, decimal, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_fuel_entry(uuid, decimal, decimal, int) TO authenticated;
REVOKE ALL ON FUNCTION fleet_maintenance_orders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_maintenance_orders(uuid) TO authenticated;
REVOKE ALL ON FUNCTION fleet_fuel_log(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_fuel_log(uuid) TO authenticated;
