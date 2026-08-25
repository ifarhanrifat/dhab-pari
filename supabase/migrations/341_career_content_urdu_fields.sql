-- Migration 341: institutes and training_programs got title_ur/name_ur but
-- not the rest — every other admin-curated bilingual content type in this
-- app (news_posts, videos, projects...) pairs every real text field with
-- its _ur twin, and these two were left half-done. Talent Showcase and a
-- mentor's own bio/expertise stay single-field on purpose — that's
-- person-typed free text (same as a complaint or a suggestion), not
-- staff-curated copy, so there's nothing to translate on their behalf.
ALTER TABLE institutes
  ADD COLUMN IF NOT EXISTS description_ur text,
  ADD COLUMN IF NOT EXISTS subjects_ur text;

ALTER TABLE training_programs
  ADD COLUMN IF NOT EXISTS description_ur text,
  ADD COLUMN IF NOT EXISTS eligibility_ur text,
  ADD COLUMN IF NOT EXISTS requirements_ur text;
