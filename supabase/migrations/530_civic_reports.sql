-- Migration 530: Village Problems / civic issue reporting -- Phase 1 of
-- the "Village OS" feature set, 2026-09-30. Deliberately a separate table
-- from `complaints` (063_complaints.sql), which is scoped to billing/
-- donation disputes (CHECK system IN ('water_supply','donors_projects'))
-- -- this is infrastructure (broken street light, garbage, road, etc),
-- a completely different workflow and, unlike a billing complaint,
-- public by design: the whole point is the village can see its own
-- reported problems and watch them get fixed.
CREATE TABLE civic_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  category varchar NOT NULL CHECK (category IN
    ('street_light', 'garbage', 'water', 'road', 'drainage', 'electricity', 'stray_animals', 'other')),
  title varchar NOT NULL,
  description text,
  photo_url text,
  location_text varchar,
  status varchar NOT NULL DEFAULT 'reported'
    CHECK (status IN ('reported', 'assigned', 'in_progress', 'fixed')),
  admin_notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX civic_reports_status_idx ON civic_reports(status);

ALTER TABLE civic_reports ENABLE ROW LEVEL SECURITY;

-- Public read of every report, not just the reporter's own -- this is a
-- transparency feature (matches the Development Tracker's own public
-- financial visibility), not a private support ticket.
CREATE POLICY "civic_reports_public_read" ON civic_reports FOR SELECT
  USING (true);

CREATE POLICY "civic_reports_self_insert" ON civic_reports FOR INSERT TO authenticated
  WITH CHECK (portal_user_id = current_portal_user_id());
CREATE POLICY "civic_reports_self_update" ON civic_reports FOR UPDATE TO authenticated
  USING (portal_user_id = current_portal_user_id())
  WITH CHECK (portal_user_id = current_portal_user_id());
CREATE POLICY "civic_reports_staff_all" ON civic_reports FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));
