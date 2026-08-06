-- Migration 124: Blood donor registry (Part E). Not scoped to water_supply
-- or donors_projects — a committee-wide function, so staff access is gated
-- on "any active admin_users row" rather than can_access_system(). Per
-- explicit direction: no public directory, no cross-donor visibility —
-- contact info is staff-search-only, relayed by a staff member in an
-- emergency, matching this app's existing privacy stance (no phone numbers
-- shown publicly anywhere).

CREATE TABLE IF NOT EXISTS blood_donors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id uuid UNIQUE NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  blood_group varchar NOT NULL CHECK (blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  is_available boolean NOT NULL DEFAULT true,
  sector varchar,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE blood_donors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "blood_donors_self_all" ON blood_donors FOR ALL TO authenticated
  USING (portal_user_id = current_portal_user_id()) WITH CHECK (portal_user_id = current_portal_user_id());
CREATE POLICY "blood_donors_staff_read" ON blood_donors FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));
