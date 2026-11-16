-- Migration 890: HOTFIX — 888's set_fleet_staff_driver_details only
-- COALESCEd medical_report_url/photo_url, but overwrote license_number/
-- license_expiry/cnic_number/date_of_birth/blood_group unconditionally.
-- Caught while wiring the frontend: a photo-only upload call (passing
-- just p_photo_url, leaving the other params at their default NULL)
-- would have silently wiped out a driver's already-saved licence/CNIC/
-- DOB/blood group. Never shipped to the frontend with this bug live —
-- caught in review before any real call could hit it.

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
    license_number = COALESCE(p_license_number, license_number), license_expiry = COALESCE(p_license_expiry, license_expiry),
    cnic_number = COALESCE(p_cnic_number, cnic_number), date_of_birth = COALESCE(p_date_of_birth, date_of_birth),
    blood_group = COALESCE(p_blood_group, blood_group),
    medical_report_url = COALESCE(p_medical_report_url, medical_report_url),
    photo_url = COALESCE(p_photo_url, photo_url)
  WHERE id = p_fleet_staff_id;
  PERFORM log_fleet_action(v_fleet_id, 'staff_driver_details_set', jsonb_build_object('fleet_staff_id', p_fleet_staff_id));
END;
$$;

-- my_fleet_drivers also needs mobile: set_route_co_driver (879) takes a
-- mobile number, not a portal_user_id, and the frontend has no other
-- way to resolve one from the dropdown selection without it.
CREATE OR REPLACE FUNCTION my_fleet_drivers(p_fleet_id uuid)
RETURNS TABLE(id uuid, portal_user_id uuid, full_name varchar, mobile varchar, license_number varchar, license_expiry date, routes_assigned_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT fs.id, fs.portal_user_id, pu.full_name, pu.mobile, fs.license_number, fs.license_expiry,
    (SELECT COUNT(*) FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id WHERE v.fleet_id = p_fleet_id AND vr.co_driver_portal_user_id = fs.portal_user_id)
  FROM fleet_staff fs JOIN portal_users pu ON pu.id = fs.portal_user_id
  WHERE fs.fleet_id = p_fleet_id AND fs.role = 'driver'
    AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND (f.owning_portal_user_id = current_portal_user_id() OR EXISTS (SELECT 1 FROM fleet_staff fs2 WHERE fs2.fleet_id = p_fleet_id AND fs2.portal_user_id = current_portal_user_id())))
  ORDER BY pu.full_name;
$$;
