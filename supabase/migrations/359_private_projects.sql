-- Migration 359: the "make sensitive medical accounts private" decision
-- from the very start of this import work, finally built. A private
-- project is fully invisible to the public — not listed, not reachable by
-- direct link, its donor names and amounts never shown — while staff still
-- see and manage it exactly like any other project, and its money still
-- counts in one honest public aggregate ("Total spent on private/medical
-- support") that names no one and no specific case.
--
-- Deliberately its own column, not a reuse of admin_hidden (migration 311)
-- — that flag means "still a draft/rejected proposal," a different concept
-- from "this is a real, live, funded project that must never be
-- individually identifiable in public." Conflating the two would risk an
-- unrelated future change to draft-hiding logic silently affecting donor
-- privacy, or vice versa.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;

-- Same RLS choke point every public page's project query already goes
-- through (migration 311) — extending it here means every current and
-- future public surface (listing, detail page, OG image, the donate
-- page's donor-history project-name lookup) is blocked at the one place,
-- not patched page by page where a forgotten filter would leak a name.
DROP POLICY IF EXISTS "public_read_projects" ON projects;
CREATE POLICY "public_read_projects" ON projects FOR SELECT
  USING (
    (admin_hidden = false AND is_private = false)
    OR proposed_by_portal_user_id = current_portal_user_id()
    OR current_admin_role() IS NOT NULL
  );

-- The one thing the public IS told: how much, in total, without naming
-- anyone or anything specific. A project account is debited on every
-- expense against it and credited on every donation received — the
-- gross debit side is total money SPENT, which is the figure "total spent
-- on medical purposes" actually means (the net balance would mix in
-- unspent donations still sitting there, understating real spend on an
-- active case). SECURITY DEFINER so it can read across every private
-- project's account regardless of the RLS above — a public aggregate,
-- deliberately bypassing project-level privacy for the sum only, never
-- for any row.
CREATE OR REPLACE FUNCTION public_private_projects_total() RETURNS decimal AS $$
  SELECT COALESCE(SUM(b.total_debit), 0)
  FROM projects p
  JOIN accounts a ON a.project_id = p.id
  JOIN ledger_account_balances b ON b.account_id = a.id
  WHERE p.is_private = true;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public_private_projects_total() TO anon, authenticated;
