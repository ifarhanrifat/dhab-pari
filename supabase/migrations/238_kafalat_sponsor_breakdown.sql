-- Migration 238: what the admin Kafalat screen needs to stop reading
-- kafalat_shares — the per-child list of who has actually stepped up.
--
-- migration 236 moved money onto pool_commitments/pool_payments and left
-- kafalat_shares in place but unwritten. The admin child list (kf.tsx) still
-- read shares for its "70% sponsored — Donor A 40%, Donor B 30%" line, so it
-- kept showing whatever was pledged there before this session — nothing,
-- since the table has been empty and dead all along, and now it never
-- deserves it to be written to at all — while real named sponsorships
-- were invisible. This is the one piece kafalat_children_for_naming()
-- doesn't already give the admin page: names, not just a total.
CREATE OR REPLACE FUNCTION kafalat_sponsor_breakdown() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_object_agg(child_id, sponsors), '{}'::jsonb)
  FROM (
    SELECT child_id, jsonb_agg(jsonb_build_object(
             'name', CASE WHEN is_anonymous THEN NULL ELSE donor_name END,
             'is_anonymous', is_anonymous, 'recurring', is_recurring, 'total_given', total_given
           ) ORDER BY total_given DESC) AS sponsors
    FROM (
      -- One row per distinct giver per child: a recurring giver groups by
      -- their commitment, a one-time giver with no commitment groups by
      -- whoever announced it, so the same person's several months collapse
      -- into one line instead of repeating.
      SELECT pp.kafalat_child_id AS child_id,
             COALESCE(pc.is_anonymous, false) AS is_anonymous,
             pc.id IS NOT NULL AS is_recurring,
             COALESCE(pc.donor_name, pu.full_name, 'Donor') AS donor_name,
             SUM(pp.amount_pkr) AS total_given
        FROM pool_payments pp
        LEFT JOIN pool_commitments pc ON pc.id = pp.commitment_id
        LEFT JOIN portal_users pu ON pu.id = pp.announced_by_portal_user_id
       WHERE pp.kafalat_child_id IS NOT NULL AND pp.status = 'confirmed'
         AND pp.for_month >= kafalat_year_starts(kafalat_current_year())
       GROUP BY pp.kafalat_child_id, pc.id, pc.is_anonymous, pc.donor_name, pu.full_name
    ) g
    GROUP BY child_id
  ) x;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION kafalat_sponsor_breakdown() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kafalat_sponsor_breakdown() TO authenticated;
