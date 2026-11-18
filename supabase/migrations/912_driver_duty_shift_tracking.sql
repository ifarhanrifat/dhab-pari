-- Migration 912: Staff screen rebuild, Part B — real driver duty-
-- interval tracking (plan: proud-tickling-glacier.md). The mockup's
-- own "Open driver roster" button is just a toast; the user asked to
-- build this for real. Admin/dispatcher-recorded, not driver self-
-- service — the driver-facing app has its own separate reference and
-- stays out of scope here, per this plan's own boundary.

CREATE TABLE IF NOT EXISTS driver_duty_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_staff_id uuid NOT NULL REFERENCES fleet_staff(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  route_id uuid REFERENCES vehicle_routes(id),
  shift_start timestamptz NOT NULL,
  shift_end timestamptz,
  handover_from_shift_id uuid REFERENCES driver_duty_shifts(id),
  incident_note text,
  recorded_by uuid REFERENCES portal_users(id),
  created_at timestamptz DEFAULT now(),
  CHECK (shift_end IS NULL OR shift_end > shift_start)
);
CREATE INDEX IF NOT EXISTS driver_duty_shifts_staff_idx ON driver_duty_shifts(fleet_staff_id, shift_start DESC);
CREATE INDEX IF NOT EXISTS driver_duty_shifts_vehicle_idx ON driver_duty_shifts(vehicle_id, shift_start DESC);
ALTER TABLE driver_duty_shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "driver_duty_shifts_manager_read" ON driver_duty_shifts FOR SELECT TO authenticated
  USING (can_manage_vehicle(vehicle_id));
-- No INSERT/UPDATE/DELETE policy — SECURITY DEFINER RPC only.

CREATE TABLE IF NOT EXISTS driver_duty_rest_breaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  duty_shift_id uuid NOT NULL REFERENCES driver_duty_shifts(id) ON DELETE CASCADE,
  break_start timestamptz NOT NULL,
  break_end timestamptz,
  created_at timestamptz DEFAULT now(),
  CHECK (break_end IS NULL OR break_end > break_start)
);
CREATE INDEX IF NOT EXISTS driver_duty_rest_breaks_shift_idx ON driver_duty_rest_breaks(duty_shift_id);
ALTER TABLE driver_duty_rest_breaks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "driver_duty_rest_breaks_manager_read" ON driver_duty_rest_breaks FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM driver_duty_shifts s WHERE s.id = duty_shift_id AND can_manage_vehicle(s.vehicle_id)));

-- Gated on can_administer_vehicle (28) — a dispatch/compliance
-- decision, not a driving one, same reasoning as every other admin-
-- only RPC this session (approve_manual_booking_pickup, etc). A
-- single driver can't be on two open shifts at once, regardless of
-- vehicle — mirrors the mockup's own callout almost exactly.
CREATE OR REPLACE FUNCTION record_duty_shift(p_fleet_staff_id uuid, p_vehicle_id uuid, p_route_id uuid, p_shift_start timestamptz, p_shift_end timestamptz DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fleet_staff fleet_staff%ROWTYPE; v_vehicle vehicles%ROWTYPE; v_id uuid;
BEGIN
  IF NOT can_administer_vehicle(p_vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = p_vehicle_id;
  SELECT * INTO v_fleet_staff FROM fleet_staff WHERE id = p_fleet_staff_id;
  IF NOT FOUND OR v_fleet_staff.fleet_id != v_vehicle.fleet_id THEN RAISE EXCEPTION 'That driver is not part of this vehicle''s fleet.' USING ERRCODE = 'P0001'; END IF;
  IF v_fleet_staff.role != 'driver' THEN RAISE EXCEPTION 'That staff member is not registered as a driver.' USING ERRCODE = 'P0001'; END IF;
  IF p_route_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vehicle_routes WHERE id = p_route_id AND vehicle_id = p_vehicle_id) THEN
    RAISE EXCEPTION 'That route does not belong to this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM driver_duty_shifts WHERE fleet_staff_id = p_fleet_staff_id AND shift_end IS NULL) THEN
    RAISE EXCEPTION 'This driver already has an open duty shift — end it first.' USING ERRCODE = 'P0001';
  END IF;
  IF p_shift_start IS NULL THEN RAISE EXCEPTION 'Enter the shift start time.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO driver_duty_shifts (fleet_staff_id, vehicle_id, route_id, shift_start, shift_end, recorded_by)
  VALUES (p_fleet_staff_id, p_vehicle_id, p_route_id, p_shift_start, p_shift_end, current_portal_user_id())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION record_duty_shift(uuid, uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_duty_shift(uuid, uuid, uuid, timestamptz, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION end_duty_shift(p_shift_id uuid, p_shift_end timestamptz DEFAULT now(), p_incident_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_shift driver_duty_shifts%ROWTYPE;
BEGIN
  SELECT * INTO v_shift FROM driver_duty_shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Duty shift not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_administer_vehicle(v_shift.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF v_shift.shift_end IS NOT NULL THEN RAISE EXCEPTION 'This shift has already ended.' USING ERRCODE = 'P0001'; END IF;
  IF p_shift_end <= v_shift.shift_start THEN RAISE EXCEPTION 'Shift end must be after shift start.' USING ERRCODE = 'P0001'; END IF;
  UPDATE driver_duty_shifts SET shift_end = p_shift_end, incident_note = COALESCE(nullif(trim(coalesce(p_incident_note, '')), ''), incident_note) WHERE id = p_shift_id;
END;
$$;
REVOKE ALL ON FUNCTION end_duty_shift(uuid, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION end_duty_shift(uuid, timestamptz, text) TO authenticated;

CREATE OR REPLACE FUNCTION record_duty_rest_break(p_shift_id uuid, p_break_start timestamptz, p_break_end timestamptz DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_shift driver_duty_shifts%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO v_shift FROM driver_duty_shifts WHERE id = p_shift_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Duty shift not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_administer_vehicle(v_shift.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF p_break_start IS NULL OR p_break_start < v_shift.shift_start THEN RAISE EXCEPTION 'Enter a valid rest-break start time within the shift.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO driver_duty_rest_breaks (duty_shift_id, break_start, break_end)
  VALUES (p_shift_id, p_break_start, p_break_end)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION record_duty_rest_break(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_duty_rest_break(uuid, timestamptz, timestamptz) TO authenticated;

-- Ends the handing-over driver's shift and opens a new linked shift
-- for the receiving driver on the same vehicle/route — "a return
-- schedule is a separate trip record" logic, applied to crew instead
-- of trips: two real rows, linked, not one row with two names on it.
CREATE OR REPLACE FUNCTION record_duty_handover(p_shift_id uuid, p_to_fleet_staff_id uuid, p_handover_at timestamptz DEFAULT now()) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_shift driver_duty_shifts%ROWTYPE; v_to_staff fleet_staff%ROWTYPE; v_new_id uuid;
BEGIN
  SELECT * INTO v_shift FROM driver_duty_shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Duty shift not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_administer_vehicle(v_shift.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF v_shift.shift_end IS NOT NULL THEN RAISE EXCEPTION 'This shift has already ended.' USING ERRCODE = 'P0001'; END IF;
  IF p_handover_at <= v_shift.shift_start THEN RAISE EXCEPTION 'Handover time must be after the shift started.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_to_staff FROM fleet_staff WHERE id = p_to_fleet_staff_id;
  IF NOT FOUND OR v_to_staff.fleet_id != (SELECT fleet_id FROM vehicles WHERE id = v_shift.vehicle_id) THEN
    RAISE EXCEPTION 'That driver is not part of this vehicle''s fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF v_to_staff.role != 'driver' THEN RAISE EXCEPTION 'That staff member is not registered as a driver.' USING ERRCODE = 'P0001'; END IF;
  IF v_to_staff.id = v_shift.fleet_staff_id THEN RAISE EXCEPTION 'Cannot hand a shift over to the same driver.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM driver_duty_shifts WHERE fleet_staff_id = p_to_fleet_staff_id AND shift_end IS NULL) THEN
    RAISE EXCEPTION 'The receiving driver already has an open duty shift.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE driver_duty_shifts SET shift_end = p_handover_at WHERE id = p_shift_id;
  INSERT INTO driver_duty_shifts (fleet_staff_id, vehicle_id, route_id, shift_start, handover_from_shift_id, recorded_by)
  VALUES (p_to_fleet_staff_id, v_shift.vehicle_id, v_shift.route_id, p_handover_at, p_shift_id, current_portal_user_id())
  RETURNING id INTO v_new_id;
  RETURN v_new_id;
END;
$$;
REVOKE ALL ON FUNCTION record_duty_handover(uuid, uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_duty_handover(uuid, uuid, timestamptz) TO authenticated;

-- The real roster the mockup's "Open driver roster" button never
-- actually opened — fleet-wide, one date at a time, with rest-break
-- count and handover chain so a reviewer can see a trip's full crew.
CREATE OR REPLACE FUNCTION fleet_driver_duty_roster(p_fleet_id uuid, p_date date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_date date := COALESCE(p_date, (now() AT TIME ZONE 'Asia/Karachi')::date);
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', s.id, 'driver_name', pu.full_name, 'vehicle_number', v.vehicle_number, 'vehicle_type', v.vehicle_type,
      'route_label', CASE WHEN vr.id IS NOT NULL THEN vr.origin || ' → ' || vr.destination ELSE NULL END,
      'shift_start', s.shift_start, 'shift_end', s.shift_end, 'incident_note', s.incident_note,
      'handover_from_shift_id', s.handover_from_shift_id,
      'rest_break_count', (SELECT COUNT(*) FROM driver_duty_rest_breaks b WHERE b.duty_shift_id = s.id)
    ) ORDER BY s.shift_start)
    FROM driver_duty_shifts s
    JOIN fleet_staff fs ON fs.id = s.fleet_staff_id
    JOIN portal_users pu ON pu.id = fs.portal_user_id
    JOIN vehicles v ON v.id = s.vehicle_id
    LEFT JOIN vehicle_routes vr ON vr.id = s.route_id
    WHERE v.fleet_id = p_fleet_id AND s.shift_start::date = v_date
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION fleet_driver_duty_roster(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_driver_duty_roster(uuid, date) TO authenticated;

-- my_fleet_staff (911) — true replace, adds on_duty_since so each
-- driver's card can show "On duty since HH:MM" instead of nothing.
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
    'overtime_this_month_pkr', (
      SELECT COALESCE(SUM(oe.amount_pkr), 0) FROM fleet_staff_overtime_entries oe
      WHERE oe.fleet_staff_id = fs.id
        AND date_trunc('month', oe.work_date) = date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)
    ),
    'current_monthly_salary_pkr', (
      SELECT fss.monthly_salary_pkr FROM fleet_staff_salaries fss
      WHERE fss.fleet_staff_id = fs.id ORDER BY fss.effective_from DESC, fss.created_at DESC LIMIT 1
    ),
    'on_duty_since', (
      SELECT s.shift_start FROM driver_duty_shifts s WHERE s.fleet_staff_id = fs.id AND s.shift_end IS NULL LIMIT 1
    ),
    'license_number', fs.license_number, 'license_expiry', fs.license_expiry, 'cnic_number', fs.cnic_number,
    'date_of_birth', fs.date_of_birth, 'blood_group', fs.blood_group, 'medical_report_url', fs.medical_report_url, 'photo_url', fs.photo_url
  ) ORDER BY fs.added_at), '[]'::jsonb)
  FROM fleet_staff fs JOIN portal_users pu ON pu.id = fs.portal_user_id
  LEFT JOIN fleet_counters c ON c.id = fs.counter_id
  WHERE fs.fleet_id = p_fleet_id AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id());
$$;
