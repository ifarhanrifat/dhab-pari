-- Migration 306: a committee note's "related link" stops being
-- project-only. linked_project_id (305) stays exactly as it is -- it still
-- gets its title/URL resolved from the real project record -- but a note can
-- now instead carry a plain link_url + bilingual label, covering a site
-- feature (Kafalat, Zakat, a specific child's sponsorship page, a portal
-- page) that has no dedicated table row to point a foreign key at. Adding a
-- new kind of link to offer in the admin picker is a code change to a small
-- constant list (src/lib/siteFeatureLinks.ts), never a migration -- same
-- reasoning as post_categories (migration 181): only genuinely record-backed
-- things (projects) get a real foreign key.
ALTER TABLE committee_notes
  ADD COLUMN IF NOT EXISTS link_url text,
  ADD COLUMN IF NOT EXISTS link_label_en text,
  ADD COLUMN IF NOT EXISTS link_label_ur text;
