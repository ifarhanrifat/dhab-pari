-- Migration 137: Project proposals + voting. Reuses the EXISTING
-- projects.status='upcoming' state rather than a parallel table — the
-- public /projects page already had a whole "Upcoming / Voting" card
-- treatment with a vote count and target (previously hardcoded fake data:
-- "142 Votes", "Requires 250 to initiate fund") that was clearly designed
-- for exactly this. A proposal IS a projects row; once approved, staff just
-- flips status to 'ongoing' via the existing admin Projects edit form —
-- no separate "launch" mechanism needed.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS proposed_by_portal_user_id uuid REFERENCES portal_users(id),
  ADD COLUMN IF NOT EXISTS vote_target int,
  ADD COLUMN IF NOT EXISTS minimum_monthly_commitment_pkr decimal;

CREATE TABLE IF NOT EXISTS project_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE (project_id, portal_user_id)
);

ALTER TABLE project_votes ENABLE ROW LEVEL SECURITY;
-- Votes are deliberately public — "anyone can view who voted" (with the
-- voter's own portal profile, not sensitive) is an explicit requirement.
CREATE POLICY "project_votes_read" ON project_votes FOR SELECT USING (true);
CREATE POLICY "project_votes_insert_own" ON project_votes FOR INSERT TO authenticated
  WITH CHECK (portal_user_id = current_portal_user_id());
CREATE POLICY "project_votes_delete_own" ON project_votes FOR DELETE TO authenticated
  USING (portal_user_id = current_portal_user_id());

-- Portal users can propose a project (status must start 'upcoming' — cannot
-- self-launch), additive alongside the existing staff-only projects_write.
CREATE POLICY "projects_portal_propose" ON projects FOR INSERT TO authenticated
  WITH CHECK (proposed_by_portal_user_id = current_portal_user_id() AND status = 'upcoming');

-- Agenda import hook, mirroring source_suggestion_id (migration 108) exactly
-- — same manual, persisted, staff-triggered "+ Add" pattern, just for
-- vote-threshold-reached proposals instead of website suggestions.
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS source_project_id uuid REFERENCES projects(id) ON DELETE SET NULL;

-- Public voter list — project_votes_read is public, but portal_users itself
-- is staff/self-only (migration 121), so a raw client-side join would show
-- nothing to an anonymous visitor. Exposes username (the intentional public
-- identity, never a phone number) + avatar only.
CREATE VIEW project_votes_public AS
SELECT v.id, v.project_id, v.created_at, p.username, p.avatar_url
FROM project_votes v JOIN portal_users p ON p.id = v.portal_user_id;

GRANT SELECT ON project_votes_public TO anon, authenticated;
