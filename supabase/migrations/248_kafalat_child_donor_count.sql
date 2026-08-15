-- Migration 248: how many people have already joined one child's
-- sponsorship — the one number the public share card needs that isn't
-- already covered by kafalat_children_for_naming() (which rightly never
-- exposes donor identity, only totals). Count only, nothing that could be
-- traced back to who gave.
CREATE OR REPLACE FUNCTION kafalat_child_donor_count(p_child_id uuid) RETURNS int AS $$
  SELECT count(DISTINCT portal_user_id)::int FROM pool_commitments
   WHERE kafalat_child_id = p_child_id AND status IN ('active', 'lapsed');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION kafalat_child_donor_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kafalat_child_donor_count(uuid) TO anon, authenticated;
