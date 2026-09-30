-- Migration 531: "Need Help" community help network -- Phase 2 of the
-- "Village OS" feature set, 2026-09-30. Deliberately excludes a 'blood'
-- category -- that already has its own real, dedicated system
-- (blood_requests/blood_donors, migration 188) with its own donor-
-- matching flow; duplicating it here would split one need across two
-- places. The public /emergency page links to /blood directly instead.
--
-- Public read (not owner-scoped) is the point, same as civic_reports:
-- this is a community-help network where any villager might be the one
-- who can actually help, not a private support ticket.
CREATE TABLE help_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  category varchar NOT NULL CHECK (category IN
    ('medical', 'transport', 'elderly', 'missing_person', 'fire', 'accident', 'other')),
  description text NOT NULL,
  location_text varchar,
  contact_name varchar NOT NULL,
  contact_mobile varchar NOT NULL,
  status varchar NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX help_requests_status_idx ON help_requests(status);

ALTER TABLE help_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "help_requests_public_read" ON help_requests FOR SELECT
  USING (true);

CREATE POLICY "help_requests_self_insert" ON help_requests FOR INSERT TO authenticated
  WITH CHECK (portal_user_id = current_portal_user_id());
CREATE POLICY "help_requests_self_update" ON help_requests FOR UPDATE TO authenticated
  USING (portal_user_id = current_portal_user_id())
  WITH CHECK (portal_user_id = current_portal_user_id());
CREATE POLICY "help_requests_staff_all" ON help_requests FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));
