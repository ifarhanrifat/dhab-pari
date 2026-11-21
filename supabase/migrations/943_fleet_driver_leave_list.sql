-- Migration 943: small follow-up to 942 — the admin Job Calendar page
-- needs a flat "who's on leave when" list (so a driver's leave shows up
-- even on a day their vehicle has no scheduled route at all), separate
-- from fleet_route_roster's per-route conflict flag.
CREATE OR REPLACE FUNCTION fleet_driver_leave_list(p_fleet_id uuid, p_date_from date, p_date_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'fleet_staff_id', fs.id, 'driver_name', pu.full_name, 'leave_date', dl.leave_date, 'reason', dl.reason
    ) ORDER BY dl.leave_date, pu.full_name)
    FROM driver_leave dl
    JOIN fleet_staff fs ON fs.id = dl.fleet_staff_id
    JOIN portal_users pu ON pu.id = fs.portal_user_id
    WHERE fs.fleet_id = p_fleet_id AND dl.leave_date BETWEEN p_date_from AND p_date_to
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION fleet_driver_leave_list(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_driver_leave_list(uuid, date, date) TO authenticated;
