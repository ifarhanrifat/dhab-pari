-- Migration 148: Volunteer signups. Same public-directory shape as
-- job_listings (migration 145) — "a man joins as volunteer for the
-- mentioned project" is explicitly meant to be visible, not private. A
-- signup for a specific project sets project_id; a general "assign me to
-- whatever the committee needs" signup leaves it null.

CREATE TABLE IF NOT EXISTS volunteers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  message text,
  status varchar NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'assigned', 'completed')),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS volunteers_created_idx ON volunteers(created_at);

ALTER TABLE volunteers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "volunteers_public_read" ON volunteers FOR SELECT
  USING (true);

CREATE POLICY "volunteers_self_all" ON volunteers FOR ALL TO authenticated
  USING (portal_user_id = current_portal_user_id())
  WITH CHECK (portal_user_id = current_portal_user_id());

-- Staff-wide status management (offered -> assigned -> completed), same
-- committee-wide gate as job_listings/blood_donors — not system-scoped.
CREATE POLICY "volunteers_staff_moderate" ON volunteers FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));
