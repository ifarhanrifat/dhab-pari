-- 2026-11-20: real conflict caught before shipping — fleet_staff.
-- counter_id is also the terminal-WRITE-scoping key (is_my_counter_or_
-- admin, 924/926): a staff member with counter_id SET is restricted to
-- operating only that one terminal's stop desk (board/no-show/alight/
-- close-stop), while counter_id NULL means unrestricted. Attendance
-- check-in (929) used that same column as "the driver's home base" —
-- so assigning a driver a home terminal for attendance would have
-- silently locked them out of closing/boarding any OTHER stop along
-- their own route, a real regression of existing driver behavior.
-- These are two different concepts (the blueprint itself keeps them
-- separate: "primary/assigned terminal in HR" vs. terminal-desk
-- scoping) — given a dedicated column instead of overloading counter_id.
ALTER TABLE fleet_staff ADD COLUMN IF NOT EXISTS home_terminal_id uuid REFERENCES fleet_counters(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION set_staff_home_terminal(p_fleet_id uuid, p_portal_user_id uuid, p_home_terminal_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id AND owning_portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_home_terminal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_counters WHERE id = p_home_terminal_id AND fleet_id = p_fleet_id) THEN
    RAISE EXCEPTION 'That terminal is not part of this fleet.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE fleet_staff SET home_terminal_id = p_home_terminal_id WHERE fleet_id = p_fleet_id AND portal_user_id = p_portal_user_id;
END;
$$;
REVOKE ALL ON FUNCTION set_staff_home_terminal(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_staff_home_terminal(uuid, uuid, uuid) TO authenticated;

-- my_fleet_staff (911) — true-replace, adds home_terminal_id/city so the
-- Staff page can show + edit it next to the existing counter_id picker.
CREATE OR REPLACE FUNCTION my_fleet_staff(p_fleet_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', fs.id, 'portal_user_id', fs.portal_user_id, 'full_name', pu.full_name, 'added_at', fs.added_at,
    'counter_id', fs.counter_id, 'counter_city', c.city, 'counter_name', c.name,
    'home_terminal_id', fs.home_terminal_id, 'home_terminal_city', ht.city, 'home_terminal_name', ht.name,
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
    'license_number', fs.license_number, 'license_expiry', fs.license_expiry, 'cnic_number', fs.cnic_number,
    'date_of_birth', fs.date_of_birth, 'blood_group', fs.blood_group, 'medical_report_url', fs.medical_report_url, 'photo_url', fs.photo_url
  ) ORDER BY fs.added_at), '[]'::jsonb)
  FROM fleet_staff fs JOIN portal_users pu ON pu.id = fs.portal_user_id
  LEFT JOIN fleet_counters c ON c.id = fs.counter_id
  LEFT JOIN fleet_counters ht ON ht.id = fs.home_terminal_id
  WHERE fs.fleet_id = p_fleet_id AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id());
$$;
REVOKE ALL ON FUNCTION my_fleet_staff(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_fleet_staff(uuid) TO authenticated;

-- driver_check_in / my_driver_attendance_status — true-replace (same
-- signatures), now keyed on home_terminal_id, never counter_id.
CREATE OR REPLACE FUNCTION driver_check_in(p_lat numeric, p_lng numeric) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fs fleet_staff%ROWTYPE; v_counter fleet_counters%ROWTYPE; v_distance_km numeric; v_radius_km numeric; v_id uuid;
BEGIN
  IF p_lat IS NULL OR p_lng IS NULL THEN RAISE EXCEPTION 'Location is required to check in.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_fs FROM fleet_staff WHERE portal_user_id = current_portal_user_id() AND home_terminal_id IS NOT NULL LIMIT 1;
  IF v_fs.id IS NULL THEN
    RAISE EXCEPTION 'You have no assigned terminal yet — ask your fleet owner to assign one.' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM driver_attendance_log WHERE fleet_staff_id = v_fs.id AND check_out_at IS NULL) THEN
    RAISE EXCEPTION 'You are already checked in — check out first.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_counter FROM fleet_counters WHERE id = v_fs.home_terminal_id;
  IF v_counter.lat IS NULL OR v_counter.lng IS NULL THEN
    RAISE EXCEPTION 'Your terminal has no stored location yet — ask your fleet owner to set it.' USING ERRCODE = 'P0001';
  END IF;

  v_distance_km := haversine_km(p_lat, p_lng, v_counter.lat, v_counter.lng);
  v_radius_km := COALESCE((SELECT value::numeric FROM site_settings WHERE key = 'driver_checkin_radius_km' LIMIT 1), 0.5);

  IF v_distance_km > v_radius_km THEN
    RAISE EXCEPTION 'You are % km from % — move within % km to check in.', round(v_distance_km, 2), v_counter.city, round(v_radius_km, 1) USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO driver_attendance_log (fleet_staff_id, counter_id, check_in_lat, check_in_lng, distance_km_at_checkin)
  VALUES (v_fs.id, v_counter.id, p_lat, p_lng, v_distance_km)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'counter_city', v_counter.city, 'counter_name', v_counter.name, 'distance_km', v_distance_km);
END;
$$;
REVOKE ALL ON FUNCTION driver_check_in(numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION driver_check_in(numeric, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION my_driver_attendance_status(p_fleet_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fs fleet_staff%ROWTYPE; v_open driver_attendance_log%ROWTYPE; v_counter fleet_counters%ROWTYPE;
BEGIN
  SELECT * INTO v_fs FROM fleet_staff WHERE fleet_id = p_fleet_id AND portal_user_id = current_portal_user_id();
  IF v_fs.id IS NULL THEN RAISE EXCEPTION 'You do not work at this fleet.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_open FROM driver_attendance_log WHERE fleet_staff_id = v_fs.id AND check_out_at IS NULL ORDER BY check_in_at DESC LIMIT 1;
  IF v_fs.home_terminal_id IS NOT NULL THEN SELECT * INTO v_counter FROM fleet_counters WHERE id = v_fs.home_terminal_id; END IF;

  RETURN jsonb_build_object(
    'has_terminal', v_fs.home_terminal_id IS NOT NULL,
    'counter_city', v_counter.city, 'counter_name', v_counter.name,
    'checked_in', v_open.id IS NOT NULL, 'since', v_open.check_in_at
  );
END;
$$;
REVOKE ALL ON FUNCTION my_driver_attendance_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_driver_attendance_status(uuid) TO authenticated;
