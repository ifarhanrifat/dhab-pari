-- Migration 542: a wedding is one card with multiple functions, not one
-- card per function -- real correction, 2026-09-30: "if there is marriage
-- of 1 family then its 3 events mehndi, barat and waleema so there should
-- be a way to add all these three events in single card for shadi".
--
-- 539 put wedding_function/venue_men/venue_women as flat, single-value
-- columns on village_events, meaning Mehndi/Baraat/Valima each needed
-- their own separate event row. Replacing that with a child table: one
-- village_events row is "the wedding" (title, groom/bride names, the
-- Salami accounts from 540 hang off this one id), and each function gets
-- its own row here with its own date/time and venue.
CREATE TABLE wedding_functions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES village_events(id) ON DELETE CASCADE,
  function_type varchar NOT NULL CHECK (function_type IN ('mehndi', 'nikkah', 'baraat', 'valima', 'other')),
  function_datetime timestamptz NOT NULL,
  venue_men varchar,
  venue_women varchar,
  display_order int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX wedding_functions_event_idx ON wedding_functions(event_id);

ALTER TABLE wedding_functions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wedding_functions_public_read" ON wedding_functions FOR SELECT
  USING (EXISTS (SELECT 1 FROM village_events WHERE id = event_id AND is_active = true));
CREATE POLICY "wedding_functions_staff_all" ON wedding_functions FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));

-- Carry the one real wedding row already entered under the old shape
-- forward instead of losing it.
INSERT INTO wedding_functions (event_id, function_type, function_datetime, venue_men, venue_women)
SELECT id, wedding_function, start_datetime, venue_men, venue_women
FROM village_events WHERE category = 'wedding' AND wedding_function IS NOT NULL;

-- village_events.start_datetime/end_datetime are now derived from the
-- functions list (min/max), so the flat single-function column goes --
-- venue_men/venue_women stay on village_events for condolence, which is
-- still a single gathering with one venue.
ALTER TABLE village_events DROP COLUMN wedding_function;

-- Real ask, 2026-09-30: "create two muntazims for both family... so that
-- groom and bride can be contacted with these specific muntazim of
-- shadi" -- a dedicated point-of-contact per side, distinct from the
-- generic organizer_name/organizer_contact every other category uses.
ALTER TABLE village_events
  ADD COLUMN groom_muntazim_name varchar,
  ADD COLUMN groom_muntazim_contact varchar,
  ADD COLUMN bride_muntazim_name varchar,
  ADD COLUMN bride_muntazim_contact varchar;
