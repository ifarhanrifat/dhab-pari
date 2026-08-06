-- Migration 122: Portal-linked recurring donations, suggestions, and
-- complaints (Part B/C of the portal). All additive — every new policy here
-- is a PERMISSIVE policy alongside the existing staff/public ones (they OR
-- together), so nothing staff-facing changes.

-- 1. Recurring donations created by a portal user, from their own panel.
-- recurring_schedules has no durable identity FK for donations today (only
-- free-text donor_name/donor_phone) — this is a real FK, set once at
-- creation, so "my recurring donations" never needs string-matching.
ALTER TABLE recurring_schedules ADD COLUMN IF NOT EXISTS created_by_portal_user_id uuid REFERENCES portal_users(id) ON DELETE CASCADE;

CREATE POLICY "recurring_schedules_portal_read" ON recurring_schedules FOR SELECT TO authenticated
  USING (created_by_portal_user_id = current_portal_user_id());
CREATE POLICY "recurring_schedules_portal_insert" ON recurring_schedules FOR INSERT TO authenticated
  WITH CHECK (created_by_portal_user_id = current_portal_user_id() AND schedule_type = 'donation' AND system = 'donors_projects');
CREATE POLICY "recurring_schedules_portal_update" ON recurring_schedules FOR UPDATE TO authenticated
  USING (created_by_portal_user_id = current_portal_user_id())
  WITH CHECK (created_by_portal_user_id = current_portal_user_id() AND schedule_type = 'donation' AND system = 'donors_projects');
CREATE POLICY "recurring_schedules_portal_delete" ON recurring_schedules FOR DELETE TO authenticated
  USING (created_by_portal_user_id = current_portal_user_id());

-- 2. Suggestions — already publicly insertable (WITH CHECK (true), migration
-- 002); just add identity so a logged-in donor can see their own history.
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS portal_user_id uuid REFERENCES portal_users(id) ON DELETE SET NULL;

CREATE POLICY "suggestions_read_own" ON suggestions FOR SELECT TO authenticated
  USING (portal_user_id = current_portal_user_id());

-- 3. Complaints — add identity + a read-own policy (today NOBODY, public or
-- portal, can re-check a complaint's status after submitting — no public
-- SELECT policy exists at all). consumer_id is locked server-side to the
-- portal user's own linked consumer (if any) via a BEFORE INSERT trigger,
-- rather than trusted from the client payload, so a portal user can never
-- attach someone else's consumer_id to their own complaint.
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS portal_user_id uuid REFERENCES portal_users(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION trg_complaint_portal_consumer_lock() RETURNS trigger AS $$
BEGIN
  IF NEW.portal_user_id IS NOT NULL THEN
    SELECT consumer_id INTO NEW.consumer_id FROM portal_users WHERE id = NEW.portal_user_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS complaint_portal_consumer_lock_trigger ON complaints;
CREATE TRIGGER complaint_portal_consumer_lock_trigger BEFORE INSERT ON complaints
  FOR EACH ROW EXECUTE FUNCTION trg_complaint_portal_consumer_lock();

CREATE POLICY "complaints_portal_insert" ON complaints FOR INSERT TO authenticated
  WITH CHECK (portal_user_id = current_portal_user_id() AND source = 'website' AND status = 'open' AND assigned_to IS NULL);
CREATE POLICY "complaints_read_own" ON complaints FOR SELECT TO authenticated
  USING (portal_user_id = current_portal_user_id());
