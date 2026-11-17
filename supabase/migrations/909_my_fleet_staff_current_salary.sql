-- Migration 909: Staff screen rebuild (design-first plan, screen 5)
-- from safar_admin_dashboard-1.html's "Staff, drivers & payroll" view
-- — a kpi-row (active employees/drivers/monthly fixed payroll/
-- commission payable) and a "Pay plan" column per employee. Real gap
-- confirmed by reading the code: set_fleet_staff_salary (860) writes
-- a new row into fleet_staff_salaries every time, but my_fleet_staff
-- never read it back — a fleet owner could SET a salary but never SEE
-- what's currently set for anyone, on this page or anywhere else.
-- True-replace, one new field: the latest salary row per staff member
-- by effective_from.
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
    'current_monthly_salary_pkr', (
      SELECT fss.monthly_salary_pkr FROM fleet_staff_salaries fss
      WHERE fss.fleet_staff_id = fs.id ORDER BY fss.effective_from DESC, fss.created_at DESC LIMIT 1
    ),
    'license_number', fs.license_number, 'license_expiry', fs.license_expiry, 'cnic_number', fs.cnic_number,
    'date_of_birth', fs.date_of_birth, 'blood_group', fs.blood_group, 'medical_report_url', fs.medical_report_url, 'photo_url', fs.photo_url
  ) ORDER BY fs.added_at), '[]'::jsonb)
  FROM fleet_staff fs JOIN portal_users pu ON pu.id = fs.portal_user_id
  LEFT JOIN fleet_counters c ON c.id = fs.counter_id
  WHERE fs.fleet_id = p_fleet_id AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id());
$$;
