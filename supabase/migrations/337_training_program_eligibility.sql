-- Migration 337: a training program needs to say who it's for and what to
-- bring — "students who've finished matric" vs "anyone", "bring your own
-- laptop" vs "we provide one". Previously only title/description existed,
-- so this was either crammed into the description or left unsaid until
-- someone showed up unprepared.
ALTER TABLE training_programs
  ADD COLUMN IF NOT EXISTS eligibility text,
  ADD COLUMN IF NOT EXISTS requirements text;
