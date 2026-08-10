-- Migration 179: ask a volunteer *how* they can help, not just that they want to.
--
-- "I want to help" is not something the committee can act on. Before anyone can
-- be given a job they need to know whether this person can lift a pipe, wire a
-- switch, keep accounts, drive to Chakwal for fittings, or only wants to lend
-- their name and advice — and whether they are free on a weekday morning or
-- only in an emergency. Without that, every assignment starts with a phone call
-- to ask.
--
-- Stored as an array rather than one choice because people are genuinely more
-- than one of these: a mason with a motorbike who is also happy to do the
-- market run.
ALTER TABLE volunteers
  ADD COLUMN IF NOT EXISTS help_types text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS availability varchar,
  ADD COLUMN IF NOT EXISTS can_travel boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS skills text;

-- Deliberately not a CHECK constraint: the committee will want to add a
-- category eventually (tent/marquee setup, night watch, whatever the next
-- project needs), and a constraint would make that a migration instead of a
-- code change. The form offers a fixed list; the column stays permissive.
COMMENT ON COLUMN volunteers.help_types IS
  'Any of: physical, skilled, professional, transport, purchasing, financial, moral';
COMMENT ON COLUMN volunteers.availability IS
  'One of: anytime, weekdays, weekends, evenings, emergency_only';
COMMENT ON COLUMN volunteers.can_travel IS
  'Willing to travel outside the village for purchasing/errands';
