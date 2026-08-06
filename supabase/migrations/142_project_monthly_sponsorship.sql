-- Migration 142: Public read of a project's total active monthly
-- sponsorship (recurring_support projects, migration 141). recurring_schedules
-- itself has no public/anon SELECT policy (donor_name/donor_phone live there
-- directly, not behind a view) — a narrow SECURITY DEFINER RPC returns just
-- the aggregate PKR total, never row-level donor data, for the public
-- project page's "Monthly Sponsorship" meter.
CREATE OR REPLACE FUNCTION project_monthly_sponsorship_pkr(p_project_id uuid) RETURNS decimal AS $$
  SELECT COALESCE(SUM(amount_pkr), 0) FROM recurring_schedules
  WHERE project_id = p_project_id AND is_active = true AND schedule_type = 'donation';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION project_monthly_sponsorship_pkr(uuid) TO anon, authenticated;
