-- Migration 250: Kafalat/Wazifa/Sadqa standing monthly shares
-- (pool_commitments) were entirely invisible on /admin/recurring — that
-- page only ever knew about recurring_schedules, the older/general
-- mechanism. A donor accountant looking at "who has a recurring donation
-- running" had no way to see a single Kafalat share, confirmed or not.
--
-- Same shape as the donor-facing my_pool_recurring_lines() (migration 244),
-- but for every donor rather than just the caller, and with the donor's
-- name/phone included the way every other admin queue on this page already
-- shows a party name — no current_admin_permission gate, matching the
-- existing convention for pool_shortfall_queue()/pool_announcement_queue()
-- (admin-page-only in practice, same as those).
CREATE OR REPLACE FUNCTION admin_pool_recurring_lines() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'pool_kind', pl.kind, 'pool', pl.name,
    'donor_name', c.donor_name, 'donor_phone', c.donor_phone,
    'monthly_amount', c.monthly_amount_pkr, 'status', c.status,
    'started_on', c.started_on, 'lapsed_at', c.lapsed_at,
    'named', COALESCE(
      (SELECT first_name FROM kafalat_children WHERE id = c.kafalat_child_id),
      (SELECT full_name FROM wazifa_students WHERE id = c.wazifa_student_id),
      (SELECT item_name FROM sadqa_objects WHERE id = c.sadqa_object_id)
    ),
    'months_given', (SELECT count(DISTINCT for_month) FROM pool_payments
                      WHERE commitment_id = c.id AND status = 'confirmed'),
    'total_given', COALESCE((SELECT SUM(amount_pkr) FROM pool_payments
                              WHERE commitment_id = c.id AND status = 'confirmed'), 0)
  ) ORDER BY c.started_on DESC), '[]'::jsonb)
  FROM pool_commitments c JOIN support_pools pl ON pl.id = c.pool_id
  WHERE c.status IN ('active', 'lapsed');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION admin_pool_recurring_lines() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_pool_recurring_lines() TO authenticated;
