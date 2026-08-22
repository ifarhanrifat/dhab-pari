-- Migration 305: a committee note can optionally point at the project it's
-- announcing — "share this" then has something real to link to (the
-- project's own public page) instead of just the note text.
ALTER TABLE committee_notes
  ADD COLUMN IF NOT EXISTS linked_project_id uuid REFERENCES projects(id) ON DELETE SET NULL;
