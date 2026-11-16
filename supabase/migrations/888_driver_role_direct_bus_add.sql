-- Migration 888: driver becomes a real fleet_staff role (not a disconnected
-- invite-only flow), and a fleet owner can add a bus directly without
-- going through "invite a driver, they self-register." Confirmed live
-- on device: "Add a bus" actually linked to the driver-invite page, and
-- there was no dropdown-based driver assignment anywhere — co_driver was
-- a free-text mobile number. vehicles.model_year already exists (checked
-- live), so "registration year" only needed exposing in forms, not a
-- new column.

-- 1. Widen fleet_staff: role + driver-specific fields (nullable, only
-- shown in the UI when role = 'driver'). True replace of 885's exact
-- live bodies, widening the role list to add 'driver'.
DO $$
DECLARE v_conname text;
BEGIN
  SELECT con.conname INTO v_conname FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attname = 'role'
  WHERE rel.relname = 'fleet_staff' AND con.contype = 'c' AND att.attnum = ANY(con.conkey) AND array_length(con.conkey, 1) = 1;
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE fleet_staff DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;
ALTER TABLE fleet_staff ADD CONSTRAINT fleet_staff_role_check
  CHECK (role IN ('staff', 'booking_officer', 'terminal_manager', 'accountant', 'other', 'driver'));

ALTER TABLE fleet_staff ADD COLUMN IF NOT EXISTS license_number varchar;
ALTER TABLE fleet_staff ADD COLUMN IF NOT EXISTS license_expiry date;
ALTER TABLE fleet_staff ADD COLUMN IF NOT EXISTS cnic_number varchar;
ALTER TABLE fleet_staff ADD COLUMN IF NOT EXISTS date_of_birth date;
ALTER TABLE fleet_staff ADD COLUMN IF NOT EXISTS blood_group varchar CHECK (blood_group IS NULL OR blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'));
ALTER TABLE fleet_staff ADD COLUMN IF NOT EXISTS medical_report_url text;
ALTER TABLE fleet_staff ADD COLUMN IF NOT EXISTS photo_url text;

CREATE OR REPLACE FUNCTION set_fleet_staff_role(p_fleet_staff_id uuid, p_role varchar) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fleet_id uuid;
BEGIN
  SELECT fs.fleet_id INTO v_fleet_id FROM fleet_staff fs JOIN fleets f ON f.id = fs.fleet_id WHERE fs.id = p_fleet_staff_id AND f.owning_portal_user_id = current_portal_user_id();
  IF v_fleet_id IS NULL THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_role NOT IN ('staff', 'booking_officer', 'terminal_manager', 'accountant', 'other', 'driver') THEN
    RAISE EXCEPTION 'Unknown role.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE fleet_staff SET role = p_role WHERE id = p_fleet_staff_id;
  PERFORM log_fleet_action(v_fleet_id, 'staff_role_set', jsonb_build_object('fleet_staff_id', p_fleet_staff_id, 'role', p_role));
END;
$$;

CREATE OR REPLACE FUNCTION set_fleet_staff_driver_details(
  p_fleet_staff_id uuid, p_license_number varchar DEFAULT NULL, p_license_expiry date DEFAULT NULL,
  p_cnic_number varchar DEFAULT NULL, p_date_of_birth date DEFAULT NULL, p_blood_group varchar DEFAULT NULL,
  p_medical_report_url text DEFAULT NULL, p_photo_url text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fleet_id uuid;
BEGIN
  SELECT fs.fleet_id INTO v_fleet_id FROM fleet_staff fs JOIN fleets f ON f.id = fs.fleet_id WHERE fs.id = p_fleet_staff_id AND f.owning_portal_user_id = current_portal_user_id();
  IF v_fleet_id IS NULL THEN RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001'; END IF;
  IF p_blood_group IS NOT NULL AND p_blood_group NOT IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-') THEN
    RAISE EXCEPTION 'Unknown blood group.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE fleet_staff SET
    license_number = p_license_number, license_expiry = p_license_expiry, cnic_number = p_cnic_number,
    date_of_birth = p_date_of_birth, blood_group = p_blood_group,
    medical_report_url = COALESCE(p_medical_report_url, medical_report_url),
    photo_url = COALESCE(p_photo_url, photo_url)
  WHERE id = p_fleet_staff_id;
  PERFORM log_fleet_action(v_fleet_id, 'staff_driver_details_set', jsonb_build_object('fleet_staff_id', p_fleet_staff_id));
END;
$$;

-- 2. Widen my_fleet_staff to carry the driver fields too (true replace
-- of 883's exact live body, same structure, fields added).
CREATE OR REPLACE FUNCTION my_fleet_staff(p_fleet_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', fs.id, 'portal_user_id', fs.portal_user_id, 'full_name', pu.full_name, 'added_at', fs.added_at,
    'counter_id', fs.counter_id, 'counter_city', c.city, 'counter_name', c.name,
    'role', fs.role, 'commission_amount_pkr', fs.commission_amount_pkr,
    'commission_this_month_pkr', (
      SELECT COALESCE(SUM(fc.amount_pkr), 0) FROM fleet_staff_commissions fc
      WHERE fc.fleet_staff_id = fs.id AND fc.status = 'earned'
        AND date_trunc('month', fc.created_at AT TIME ZONE 'Asia/Karachi') = date_trunc('month', now() AT TIME ZONE 'Asia/Karachi')
    ),
    'license_number', fs.license_number, 'license_expiry', fs.license_expiry, 'cnic_number', fs.cnic_number,
    'date_of_birth', fs.date_of_birth, 'blood_group', fs.blood_group, 'medical_report_url', fs.medical_report_url, 'photo_url', fs.photo_url
  ) ORDER BY fs.added_at), '[]'::jsonb)
  FROM fleet_staff fs JOIN portal_users pu ON pu.id = fs.portal_user_id
  LEFT JOIN fleet_counters c ON c.id = fs.counter_id
  WHERE fs.fleet_id = p_fleet_id AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id());
$$;

-- 3. Drivers dropdown for route crew assignment + the new direct-bus-add
-- form's primary-driver picker — a thin filter over my_fleet_staff plus
-- a route-count as a lightweight availability signal (full duty/rest
-- conflict checking belongs to the driver-app work, not this round).
CREATE OR REPLACE FUNCTION my_fleet_drivers(p_fleet_id uuid)
RETURNS TABLE(id uuid, portal_user_id uuid, full_name varchar, license_number varchar, license_expiry date, routes_assigned_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT fs.id, fs.portal_user_id, pu.full_name, fs.license_number, fs.license_expiry,
    (SELECT COUNT(*) FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id WHERE v.fleet_id = p_fleet_id AND vr.co_driver_portal_user_id = fs.portal_user_id)
  FROM fleet_staff fs JOIN portal_users pu ON pu.id = fs.portal_user_id
  WHERE fs.fleet_id = p_fleet_id AND fs.role = 'driver'
    AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND (f.owning_portal_user_id = current_portal_user_id() OR EXISTS (SELECT 1 FROM fleet_staff fs2 WHERE fs2.fleet_id = p_fleet_id AND fs2.portal_user_id = current_portal_user_id())))
  ORDER BY pu.full_name;
$$;

-- 4. Direct bus-add: the fleet owner registers a vehicle themselves,
-- right now, with no committee approval (they ARE the approving
-- authority for their own fleet) — unlike the public solo-driver
-- registration flow (submit_vehicle_registration) this does not create
-- a pending registration row, it creates the vehicle directly.
CREATE OR REPLACE FUNCTION create_fleet_vehicle_direct(
  p_fleet_id uuid, p_category_id uuid, p_model varchar DEFAULT NULL, p_color varchar DEFAULT NULL,
  p_vehicle_number varchar DEFAULT NULL, p_total_seats int DEFAULT 0, p_has_ac boolean DEFAULT false,
  p_model_year int DEFAULT NULL, p_primary_driver_fleet_staff_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_driver_portal_user_id uuid; v_owner_name varchar; v_vehicle_type varchar; v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id AND owning_portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_total_seats IS NULL OR p_total_seats <= 0 THEN RAISE EXCEPTION 'Enter a real seat count.' USING ERRCODE = 'P0001'; END IF;
  IF p_model_year IS NOT NULL AND (p_model_year < 1980 OR p_model_year > extract(year FROM now())::int + 1) THEN
    RAISE EXCEPTION 'Enter a real model year.' USING ERRCODE = 'P0001';
  END IF;

  v_driver_portal_user_id := v_portal_user_id;
  IF p_primary_driver_fleet_staff_id IS NOT NULL THEN
    SELECT fs.portal_user_id INTO v_driver_portal_user_id FROM fleet_staff fs WHERE fs.id = p_primary_driver_fleet_staff_id AND fs.fleet_id = p_fleet_id AND fs.role = 'driver';
    IF v_driver_portal_user_id IS NULL THEN RAISE EXCEPTION 'That driver is not part of this fleet.' USING ERRCODE = 'P0001'; END IF;
  END IF;

  SELECT full_name INTO v_owner_name FROM portal_users WHERE id = v_driver_portal_user_id;
  SELECT name INTO v_vehicle_type FROM vehicle_categories WHERE id = p_category_id;
  IF v_vehicle_type IS NULL THEN RAISE EXCEPTION 'Unknown vehicle category.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicles (owner_name, vehicle_type, vehicle_number, total_seats, portal_user_id, fleet_id, category_id, model, color, has_ac, model_year)
  VALUES (v_owner_name, v_vehicle_type, nullif(trim(coalesce(p_vehicle_number, '')), ''), p_total_seats, v_driver_portal_user_id, p_fleet_id, p_category_id,
    nullif(trim(coalesce(p_model, '')), ''), nullif(trim(coalesce(p_color, '')), ''), p_has_ac, p_model_year)
  RETURNING id INTO v_id;

  PERFORM log_fleet_action(p_fleet_id, 'vehicle_added', jsonb_build_object('vehicle_id', v_id, 'vehicle_number', p_vehicle_number));
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION set_fleet_staff_driver_details(uuid, varchar, date, varchar, date, varchar, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_fleet_staff_driver_details(uuid, varchar, date, varchar, date, varchar, text, text) TO authenticated;
REVOKE ALL ON FUNCTION my_fleet_drivers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_fleet_drivers(uuid) TO authenticated;
REVOKE ALL ON FUNCTION create_fleet_vehicle_direct(uuid, uuid, varchar, varchar, varchar, int, boolean, int, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_fleet_vehicle_direct(uuid, uuid, varchar, varchar, varchar, int, boolean, int, uuid) TO authenticated;
