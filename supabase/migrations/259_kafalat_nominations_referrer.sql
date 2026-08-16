-- Migration 259: the Nominations tab has always known who referred a
-- child (nominated_by_portal_user_id, nominator_phone captured at
-- submission) but never shown it — every card just said "here's a child",
-- with no way to tell a walk-in committee referral from a donor who used
-- the portal's Nominate button. A direct client join to portal_users would
-- come back empty for most staff roles anyway (its own RLS only allows
-- super_admin/admin, migration 121) — this resolves the name server-side,
-- the same pattern as admin_search_portal_users().
CREATE OR REPLACE FUNCTION kafalat_nominations_with_referrer() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', n.id, 'child_name', n.child_name, 'guardian_name', n.guardian_name,
    'approximate_age', n.approximate_age, 'gender', n.gender, 'address_hint', n.address_hint,
    'reason', n.reason, 'status', n.status, 'created_at', n.created_at,
    'referrer_name', COALESCE((SELECT full_name FROM portal_users WHERE id = n.nominated_by_portal_user_id), NULL),
    'referrer_phone', COALESCE(n.nominator_phone, (SELECT mobile FROM portal_users WHERE id = n.nominated_by_portal_user_id))
  ) ORDER BY n.created_at DESC), '[]'::jsonb)
  FROM kafalat_nominations n;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION kafalat_nominations_with_referrer() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kafalat_nominations_with_referrer() TO authenticated;
