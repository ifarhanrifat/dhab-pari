-- Migration 108: link agenda suggestions back to the public website's
-- suggestions inbox, and support a free-text sender name for suggestions
-- that didn't come from a committee member (a website visitor isn't one).
-- No RLS changes needed — suggestions/agenda_items are both already open to
-- any authenticated admin_user at the relevant tiers (002_rls.sql, 107).

ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS raised_by_name varchar;
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS source_suggestion_id uuid REFERENCES suggestions(id) ON DELETE SET NULL;
