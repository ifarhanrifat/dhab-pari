-- Migration 538: Village Events Calendar -- Phase 3 of the "Village OS"
-- feature set, 2026-09-30. Admin-curated, same trust model as
-- directory_entries (535) and committee_members -- weddings, jalsa/
-- religious gatherings, sports days, committee meetings are announced by
-- the committee, not posted by any portal user, so no approval queue.
--
-- start_datetime/end_datetime rather than a plain date -- some events
-- (a jalsa, a sports tournament) run across more than one day, and most
-- need a real start time villagers can plan around.
CREATE TABLE village_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title varchar NOT NULL,
  title_ur varchar,
  description text,
  description_ur text,
  category varchar NOT NULL DEFAULT 'other'
    CHECK (category IN ('religious', 'wedding', 'sports', 'meeting', 'education', 'condolence', 'other')),
  start_datetime timestamptz NOT NULL,
  end_datetime timestamptz,
  location_text varchar,
  organizer_name varchar,
  organizer_contact varchar,
  photo_url text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX village_events_upcoming_idx ON village_events(start_datetime) WHERE is_active = true;

ALTER TABLE village_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "village_events_public_read" ON village_events FOR SELECT
  USING (is_active = true);
CREATE POLICY "village_events_staff_all" ON village_events FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));
