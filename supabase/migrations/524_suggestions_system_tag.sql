-- Migration 524: which committee system a portal suggestion is about.
--
-- Real ask, 2026-09-29: a suggestion landed on staff's desk with no way to
-- tell whether it was about the water supply or the donors/projects side
-- -- both run under one committee, but different staff often handle each.
-- Nullable: existing rows, and other suggestion types that aren't tied to
-- either system (role_request, a general remark), have nothing to backfill
-- this from and aren't required to carry one going forward either.
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS system varchar
  CHECK (system IN ('water_supply', 'donors_projects'));
