-- Migration 146: Proposer-submitted representative photo for a project
-- proposal — separate from before_image_url/after_image_url (migration
-- 001/staff-set construction-progress documentation, a different concept).
-- Lets the public project cards and the per-project OG share image
-- (opengraph-image.tsx) show a real photo instead of the generated
-- illustration/branded card once a proposer has one.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS proposal_image_url text;
