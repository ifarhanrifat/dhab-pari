-- Migration 365: is_private (359) does full lockdown — card gone, donations/
-- expenses/comments all hidden, only counted in one anonymous aggregate.
-- کمیٹی اکاؤنٹ (Main) isn't a privacy case at all — it's the committee's own
-- general account, awkwardly represented as a "project" row so it can be a
-- donation target. It doesn't need its donations hidden, just needs to stop
-- cluttering the public projects listing as if it were a real project card
-- — while staying selectable in the donate-project pickers exactly as
-- before, since donors still need to be able to give to it directly.
--
-- unlisted is a plain, non-RLS-gated column: the row stays exactly as
-- publicly readable as any other project (nothing sensitive is being
-- protected here), the listing page just filters it out of its own query.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS unlisted boolean NOT NULL DEFAULT false;
