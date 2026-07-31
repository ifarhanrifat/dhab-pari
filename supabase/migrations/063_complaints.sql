-- Migration 063: Complaint & verification system.
--
-- Deliberately separate from `suggestions` (which already has a 'complaint'
-- type) per an earlier explicit decision — this is a structured workflow with
-- numbering, assignment, an SLA, a status timeline with photos/voice notes,
-- and a distinct higher-management verification step, not a flat inbox.
--
-- Intake: the public website form (anon insert, source='website') and manual
-- entry by water supply / donor accountants (source='manual'). Handlers are a
-- per-system roster (mirrors approval_approvers/complaint_handlers below) who
-- get popped a notification on submission; any of them can claim/be assigned
-- it. A 2-day SLA (extendable) applies; a daily cron reminds the assignee to
-- post a status update while it's open. Once the handler marks it resolved,
-- everyone with the new can_verify_complaints flag gets notified to do final
-- sign-off — verify closes it (and would notify the complainant, see below);
-- reopen sends it back to the handler with a note.
--
-- No consumer-facing notification channel exists beyond WhatsApp: this
-- codebase has no consumer/public login system at all (confirmed by research
-- before writing this) — only admin_users are ever authenticated. So "notify
-- the complainant" can only ever be a WhatsApp deep-link a staff member taps
-- to send (the same constraint already established for collectors/approvers
-- in migrations 056/060), never an in-app popup for the complainant
-- themselves.

-- 1. Complaint handler roster + verifier permission flag — exact same shape
-- as approval_approvers (migration 060) and can_collect_payments (056).
CREATE TABLE IF NOT EXISTS complaint_handlers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system varchar NOT NULL CHECK (system IN ('water_supply', 'donors_projects')),
  admin_user_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE (system, admin_user_id)
);
ALTER TABLE complaint_handlers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "complaint_handlers_read" ON complaint_handlers FOR SELECT TO authenticated
  USING (can_access_system(system));
CREATE POLICY "complaint_handlers_write" ON complaint_handlers FOR ALL TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin'))
  WITH CHECK (current_admin_role() IN ('super_admin', 'admin'));

ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_verify_complaints boolean NOT NULL DEFAULT false;

-- Extend the self-tamper guard (migration 022, last touched in 056) for the
-- new column — same reasoning as can_collect_payments: a new sensitive column
-- that isn't in this explicit list would otherwise pass through a self-update
-- unblocked. While here, also fix a real pre-existing bug in this same
-- function: `current_admin_role() != 'super_admin'` silently passes (doesn't
-- raise) when current_admin_role() returns NULL, because NULL != 'x' is NULL
-- and plpgsql treats a NULL IF-condition as false — the exact fail-open class
-- of bug caught and fixed in migration 062 for override_approve_confirmation.
-- IS DISTINCT FROM treats NULL as a real, non-equal value, so it fails closed.
CREATE OR REPLACE FUNCTION trg_admin_users_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.role = 'super_admin' AND OLD.role IS DISTINCT FROM 'super_admin' AND current_admin_role() IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'Only a super admin can grant the super_admin role.';
  END IF;

  IF NEW.auth_user_id = auth.uid() AND (
    NEW.role IS DISTINCT FROM OLD.role
    OR NEW.can_post_transactions IS DISTINCT FROM OLD.can_post_transactions
    OR NEW.can_edit_transactions IS DISTINCT FROM OLD.can_edit_transactions
    OR NEW.can_delete_transactions IS DISTINCT FROM OLD.can_delete_transactions
    OR NEW.can_view_reports IS DISTINCT FROM OLD.can_view_reports
    OR NEW.can_approve_transactions IS DISTINCT FROM OLD.can_approve_transactions
    OR NEW.can_manage_parties IS DISTINCT FROM OLD.can_manage_parties
    OR NEW.can_manage_accounts IS DISTINCT FROM OLD.can_manage_accounts
    OR NEW.can_edit_accounts IS DISTINCT FROM OLD.can_edit_accounts
    OR NEW.can_delete_accounts IS DISTINCT FROM OLD.can_delete_accounts
    OR NEW.can_restore_deleted IS DISTINCT FROM OLD.can_restore_deleted
    OR NEW.can_invite_users IS DISTINCT FROM OLD.can_invite_users
    OR NEW.access_water_supply IS DISTINCT FROM OLD.access_water_supply
    OR NEW.access_donors_projects IS DISTINCT FROM OLD.access_donors_projects
    OR NEW.can_collect_payments IS DISTINCT FROM OLD.can_collect_payments
    OR NEW.assigned_sectors IS DISTINCT FROM OLD.assigned_sectors
    OR NEW.can_verify_complaints IS DISTINCT FROM OLD.can_verify_complaints
  ) THEN
    RAISE EXCEPTION 'You cannot change your own role or permissions.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 2. Sequential per-system complaint numbering (WS-CMP-0001 / DP-CMP-0001),
-- same pattern as next_voucher_no/next_receipt_no elsewhere in this schema.
CREATE TABLE IF NOT EXISTS complaint_number_counters (
  system varchar PRIMARY KEY CHECK (system IN ('water_supply', 'donors_projects')),
  next_serial int NOT NULL DEFAULT 1
);
INSERT INTO complaint_number_counters (system) VALUES ('water_supply'), ('donors_projects')
ON CONFLICT (system) DO NOTHING;

CREATE OR REPLACE FUNCTION next_complaint_number(p_system varchar) RETURNS varchar AS $$
DECLARE
  v_serial int;
  v_prefix varchar := CASE WHEN p_system = 'water_supply' THEN 'WS-CMP' ELSE 'DP-CMP' END;
BEGIN
  UPDATE complaint_number_counters SET next_serial = next_serial + 1
  WHERE system = p_system
  RETURNING next_serial - 1 INTO v_serial;
  RETURN v_prefix || '-' || lpad(v_serial::text, 4, '0');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 3. The complaint itself.
CREATE TABLE IF NOT EXISTS complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_number varchar UNIQUE,
  system varchar NOT NULL CHECK (system IN ('water_supply', 'donors_projects')),
  complainant_name varchar,
  phone varchar,
  sector varchar,
  complaint_text text NOT NULL,
  source varchar NOT NULL DEFAULT 'manual' CHECK (source IN ('website', 'manual')),
  status varchar NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'awaiting_verification', 'verified')),
  assigned_to uuid REFERENCES admin_users(id),
  deadline_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES admin_users(id),
  verified_at timestamptz,
  verified_by uuid REFERENCES admin_users(id),
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS complaints_status_idx ON complaints(system, status);

ALTER TABLE complaints ENABLE ROW LEVEL SECURITY;
-- Public intake — mirrors suggestions' unconditional public insert (migration
-- 002) but scoped to what an anonymous submitter should actually be able to
-- set: only a fresh, unassigned, website-sourced complaint.
CREATE POLICY "complaints_public_insert" ON complaints FOR INSERT
  WITH CHECK (source = 'website' AND status = 'open' AND assigned_to IS NULL);
CREATE POLICY "complaints_staff_insert" ON complaints FOR INSERT TO authenticated
  WITH CHECK (can_access_system(system) AND source = 'manual');
CREATE POLICY "complaints_read" ON complaints FOR SELECT TO authenticated
  USING (can_access_system(system));
CREATE POLICY "complaints_update" ON complaints FOR UPDATE TO authenticated
  USING (can_access_system(system)) WITH CHECK (can_access_system(system));

-- complaint_number is always server-generated — ignore/overwrite whatever (if
-- anything) the client sent, the same way bill/voucher numbers are never
-- client-supplied. Default the SLA deadline to 2 days out if not given.
CREATE OR REPLACE FUNCTION trg_complaint_before_insert() RETURNS trigger AS $$
BEGIN
  NEW.complaint_number := next_complaint_number(NEW.system);
  IF NEW.deadline_at IS NULL THEN
    NEW.deadline_at := now() + interval '2 days';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS complaint_before_insert_trigger ON complaints;
CREATE TRIGGER complaint_before_insert_trigger BEFORE INSERT ON complaints
  FOR EACH ROW EXECUTE FUNCTION trg_complaint_before_insert();

-- Notify every active handler for this system the moment a complaint lands.
CREATE OR REPLACE FUNCTION trg_complaint_after_insert_notify() RETURNS trigger AS $$
DECLARE
  v_popup_enabled boolean;
  r record;
BEGIN
  SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'complaint_submitted';
  IF v_popup_enabled IS DISTINCT FROM false THEN
    FOR r IN SELECT admin_user_id FROM complaint_handlers WHERE system = NEW.system AND is_active = true LOOP
      INSERT INTO notifications (recipient_id, event_type, title, body, link)
      VALUES (r.admin_user_id, 'complaint_submitted', 'New complaint ' || NEW.complaint_number, left(NEW.complaint_text, 140), '/admin/complaints/' || NEW.id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS complaint_after_insert_notify_trigger ON complaints;
CREATE TRIGGER complaint_after_insert_notify_trigger AFTER INSERT ON complaints
  FOR EACH ROW EXECUTE FUNCTION trg_complaint_after_insert_notify();

-- 4. The conversation/status timeline — comments, photos, voice notes, and
-- system-generated milestone entries (assigned/resolved/reopened/deadline
-- extended) all live in one ordered table so the UI renders a single thread.
CREATE TABLE IF NOT EXISTS complaint_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id uuid NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  author_id uuid REFERENCES admin_users(id),
  kind varchar NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment', 'resolved', 'reopened', 'deadline_extended', 'assigned')),
  body text,
  photo_url text,
  voice_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS complaint_updates_complaint_idx ON complaint_updates(complaint_id, created_at);

ALTER TABLE complaint_updates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "complaint_updates_read" ON complaint_updates FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM complaints c WHERE c.id = complaint_id AND can_access_system(c.system)));
-- Direct client inserts are limited to free-text/photo/voice comments — the
-- other kinds (resolved/reopened/deadline_extended/assigned) only ever come
-- from the SECURITY DEFINER functions below, so the timeline can't be forged
-- to claim a verification milestone that didn't actually happen through them.
CREATE POLICY "complaint_updates_write" ON complaint_updates FOR INSERT TO authenticated
  WITH CHECK (
    kind = 'comment'
    AND EXISTS (SELECT 1 FROM complaints c WHERE c.id = complaint_id AND can_access_system(c.system))
  );

-- Log + notify when a complaint is (re)assigned via a plain client UPDATE.
CREATE OR REPLACE FUNCTION trg_complaint_assigned_log() RETURNS trigger AS $$
DECLARE
  v_name varchar;
  v_popup_enabled boolean;
BEGIN
  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to AND NEW.assigned_to IS NOT NULL THEN
    SELECT full_name INTO v_name FROM admin_users WHERE id = NEW.assigned_to;
    INSERT INTO complaint_updates (complaint_id, author_id, kind, body)
    VALUES (NEW.id, current_admin_user_id(), 'assigned', 'Assigned to ' || COALESCE(v_name, 'Unknown'));

    SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'complaint_submitted';
    IF v_popup_enabled IS DISTINCT FROM false THEN
      INSERT INTO notifications (recipient_id, event_type, title, body, link)
      VALUES (NEW.assigned_to, 'complaint_submitted', 'Complaint assigned to you — ' || NEW.complaint_number, left(NEW.complaint_text, 140), '/admin/complaints/' || NEW.id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS complaint_assigned_log_trigger ON complaints;
CREATE TRIGGER complaint_assigned_log_trigger AFTER UPDATE OF assigned_to ON complaints
  FOR EACH ROW EXECUTE FUNCTION trg_complaint_assigned_log();

-- 5. Handler marks it resolved -> awaiting_verification, notifies verifiers.
-- admin_user_can_access_system (per-row check, migration 061) is used here
-- deliberately instead of can_access_system (which only checks the CALLER,
-- not the candidate recipients being iterated) — the same bug class fixed
-- once already this phase for get_approvers_roster.
CREATE OR REPLACE FUNCTION mark_complaint_resolved(p_complaint_id uuid, p_note text) RETURNS void AS $$
DECLARE
  v_complaint complaints%ROWTYPE;
  v_popup_enabled boolean;
  r record;
BEGIN
  SELECT * INTO v_complaint FROM complaints WHERE id = p_complaint_id;
  IF v_complaint.id IS NULL THEN RAISE EXCEPTION 'Complaint not found.'; END IF;

  UPDATE complaints SET status = 'awaiting_verification', resolved_at = now(), resolved_by = current_admin_user_id() WHERE id = p_complaint_id;
  INSERT INTO complaint_updates (complaint_id, author_id, kind, body)
  VALUES (p_complaint_id, current_admin_user_id(), 'resolved', COALESCE(NULLIF(trim(p_note), ''), 'Marked as resolved — awaiting verification.'));

  SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'complaint_ready_for_verification';
  IF v_popup_enabled IS DISTINCT FROM false THEN
    FOR r IN
      SELECT id FROM admin_users
      WHERE is_active = true AND can_verify_complaints = true AND admin_user_can_access_system(id, v_complaint.system)
    LOOP
      INSERT INTO notifications (recipient_id, event_type, title, body, link)
      VALUES (r.id, 'complaint_ready_for_verification', 'Ready for verification — ' || v_complaint.complaint_number, v_complaint.complaint_text, '/admin/complaints/' || p_complaint_id);
    END LOOP;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 6. Higher-management verification — closes the complaint for good.
CREATE OR REPLACE FUNCTION verify_complaint(p_complaint_id uuid, p_note text) RETURNS void AS $$
DECLARE v_complaint complaints%ROWTYPE;
BEGIN
  IF current_admin_role() IS DISTINCT FROM 'super_admin'
     AND COALESCE((SELECT can_verify_complaints FROM admin_users WHERE id = current_admin_user_id()), false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'You are not authorized to verify complaints.';
  END IF;
  SELECT * INTO v_complaint FROM complaints WHERE id = p_complaint_id;
  IF v_complaint.id IS NULL THEN RAISE EXCEPTION 'Complaint not found.'; END IF;
  IF v_complaint.status IS DISTINCT FROM 'awaiting_verification' THEN
    RAISE EXCEPTION 'This complaint is not awaiting verification.';
  END IF;

  UPDATE complaints SET status = 'verified', verified_at = now(), verified_by = current_admin_user_id() WHERE id = p_complaint_id;
  INSERT INTO complaint_updates (complaint_id, author_id, kind, body)
  VALUES (p_complaint_id, current_admin_user_id(), 'comment', COALESCE(NULLIF(trim(p_note), ''), 'Verified and closed.'));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Verifier isn't satisfied — sends it back to the handler with a note.
CREATE OR REPLACE FUNCTION reopen_complaint(p_complaint_id uuid, p_note text) RETURNS void AS $$
DECLARE v_complaint complaints%ROWTYPE;
BEGIN
  IF current_admin_role() IS DISTINCT FROM 'super_admin'
     AND COALESCE((SELECT can_verify_complaints FROM admin_users WHERE id = current_admin_user_id()), false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'You are not authorized to verify complaints.';
  END IF;
  SELECT * INTO v_complaint FROM complaints WHERE id = p_complaint_id;
  IF v_complaint.id IS NULL THEN RAISE EXCEPTION 'Complaint not found.'; END IF;

  UPDATE complaints SET status = 'open', resolved_at = NULL, resolved_by = NULL WHERE id = p_complaint_id;
  INSERT INTO complaint_updates (complaint_id, author_id, kind, body)
  VALUES (p_complaint_id, current_admin_user_id(), 'reopened', COALESCE(NULLIF(trim(p_note), ''), 'Sent back — not resolved.'));

  IF v_complaint.assigned_to IS NOT NULL THEN
    INSERT INTO notifications (recipient_id, event_type, title, body, link)
    VALUES (v_complaint.assigned_to, 'complaint_submitted', 'Sent back — ' || v_complaint.complaint_number, COALESCE(NULLIF(trim(p_note), ''), 'Not verified, please recheck.'), '/admin/complaints/' || p_complaint_id);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 7. "They can extend the period of time if difficult to fix in two days."
CREATE OR REPLACE FUNCTION extend_complaint_deadline(p_complaint_id uuid, p_days int, p_note text) RETURNS void AS $$
BEGIN
  IF p_days IS NULL OR p_days <= 0 THEN RAISE EXCEPTION 'Enter a positive number of days.'; END IF;
  UPDATE complaints SET deadline_at = deadline_at + (p_days || ' days')::interval WHERE id = p_complaint_id;
  INSERT INTO complaint_updates (complaint_id, author_id, kind, body)
  VALUES (p_complaint_id, current_admin_user_id(), 'deadline_extended', COALESCE(NULLIF(trim(p_note), ''), 'Deadline extended by ' || p_days || ' day(s).'));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 8. Daily nudge to whoever is currently assigned an open complaint —
-- "meanwhile those view only users can daily get the popup and they will
-- need to write down the fresh status." Runs once a day via pg_cron (same
-- extension already used for recurring schedules/auto-post, migrations
-- 055/060).
CREATE OR REPLACE FUNCTION run_complaint_daily_reminders() RETURNS void AS $$
DECLARE
  v_popup_enabled boolean;
  r record;
BEGIN
  SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'complaint_daily_reminder';
  IF v_popup_enabled IS DISTINCT FROM false THEN
    FOR r IN SELECT * FROM complaints WHERE status = 'open' AND assigned_to IS NOT NULL LOOP
      INSERT INTO notifications (recipient_id, event_type, title, body, link)
      VALUES (r.assigned_to, 'complaint_daily_reminder', 'Daily reminder — ' || r.complaint_number, 'Please post a status update for this open complaint.', '/admin/complaints/' || r.id);
    END LOOP;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

SELECT cron.schedule('complaint-daily-reminders', '0 9 * * *', $$SELECT run_complaint_daily_reminders()$$);

-- 9. Notification channel preferences for the three complaint events.
INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('complaint_submitted', 'A complaint is submitted, assigned, or sent back', true, true),
  ('complaint_daily_reminder', 'Daily reminder to update an open complaint', true, true),
  ('complaint_ready_for_verification', 'A complaint is ready for higher-management verification', true, true)
ON CONFLICT (event_type) DO NOTHING;
