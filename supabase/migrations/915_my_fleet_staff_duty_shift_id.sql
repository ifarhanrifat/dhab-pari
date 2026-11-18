-- Migration 915: true replace, one more field. Building the Staff
-- page's End/Handover actions found that on_duty_since (912) alone
-- isn't enough — the frontend needs the actual open shift's id to
-- call end_duty_shift/record_duty_handover, not just its start time.
-- Matching by driver name would be fragile (two staff could share a
-- name); surfacing the real id instead.
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
    'on_duty_since', (SELECT s.shift_start FROM driver_duty_shifts s WHERE s.fleet_staff_id = fs.id AND s.shift_end IS NULL LIMIT 1),
    'on_duty_shift_id', (SELECT s.id FROM driver_duty_shifts s WHERE s.fleet_staff_id = fs.id AND s.shift_end IS NULL LIMIT 1),
    'license_number', fs.license_number, 'license_expiry', fs.license_expiry, 'cnic_number', fs.cnic_number,
    'date_of_birth', fs.date_of_birth, 'blood_group', fs.blood_group, 'medical_report_url', fs.medical_report_url, 'photo_url', fs.photo_url
  ) ORDER BY fs.added_at), '[]'::jsonb)
  FROM fleet_staff fs JOIN portal_users pu ON pu.id = fs.portal_user_id
  LEFT JOIN fleet_counters c ON c.id = fs.counter_id
  WHERE fs.fleet_id = p_fleet_id AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id());
$$;
