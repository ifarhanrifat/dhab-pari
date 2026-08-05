-- Migration 107: Task Todo — Meetings & Agenda.
--
-- The Water & Welfare Committee (12 members) meets roughly every 10 days.
-- Points get allocated to members with deadlines and today there is no
-- follow-up — anything skipped is forgotten. This adds meetings + discrete
-- agenda items (tasks and suggestions), multi-member allocation, a fixed
-- standing proxy for the 7-8 members who don't use smartphones (falling back
-- to whoever is running the meeting), and carry-forward of unresolved tasks
-- into the next meeting.
--
-- Reuses the existing public `committee_members` table (001_schema.sql)
-- rather than a parallel roster — same 12 people, just extended with the
-- login-linkage a public bio table never needed. Photo→Urdu-text extraction
-- is deliberately out of scope here (no AI/LLM key configured anywhere in
-- this codebase) — agenda points are typed/edited directly; a photo can still
-- be attached as a reference image via the existing public `attachments`
-- bucket (053_attachments.sql).

ALTER TABLE committee_members ADD COLUMN IF NOT EXISTS admin_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL;
ALTER TABLE committee_members ADD COLUMN IF NOT EXISTS proxy_admin_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL;
ALTER TABLE committee_members ADD COLUMN IF NOT EXISTS uses_smartphone boolean NOT NULL DEFAULT true;

-- 1. Meetings — the one with the latest meeting_date is implicitly "current";
-- older ones are just history, so no status column is needed.
CREATE TABLE IF NOT EXISTS agenda_meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_date date NOT NULL,
  title varchar,
  run_by_admin_user_id uuid NOT NULL REFERENCES admin_users(id),
  agenda_photo_urls text[],
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);

-- 2. Agenda items — one row per discrete point, whether a task or a
-- suggestion. carried_from_item_id/carry_count trace the carry-forward chain
-- back to the original item so a repeatedly-skipped task is easy to spot.
CREATE TABLE IF NOT EXISTS agenda_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES agenda_meetings(id) ON DELETE CASCADE,
  kind varchar NOT NULL CHECK (kind IN ('task', 'suggestion')) DEFAULT 'task',
  text_ur text NOT NULL,
  display_order int NOT NULL DEFAULT 0,
  due_date date,
  status varchar NOT NULL CHECK (status IN ('pending', 'in_progress', 'done')) DEFAULT 'pending',
  done_at timestamptz,
  done_by_admin_user_id uuid REFERENCES admin_users(id),
  raised_by_committee_member_id uuid REFERENCES committee_members(id),
  carried_from_item_id uuid REFERENCES agenda_items(id) ON DELETE SET NULL,
  carry_count int NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agenda_items_meeting_idx ON agenda_items(meeting_id);

-- 3. Multi-assignee junction — a task can go to more than one committee
-- member at once. Allocation works in terms of committee members (how the
-- user actually thinks about it — "give this to the IT Professional"), not
-- raw admin_user ids; resolve_agenda_assignee() below maps that to an actual
-- login when a reminder needs sending or a completion needs recording.
CREATE TABLE IF NOT EXISTS agenda_item_assignees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agenda_item_id uuid NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  committee_member_id uuid NOT NULL REFERENCES committee_members(id),
  UNIQUE (agenda_item_id, committee_member_id)
);

ALTER TABLE agenda_meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agenda_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE agenda_item_assignees ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agenda_meetings_read" ON agenda_meetings FOR SELECT TO authenticated USING (true);
CREATE POLICY "agenda_meetings_write" ON agenda_meetings FOR ALL TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin'))
  WITH CHECK (current_admin_role() IN ('super_admin', 'admin'));

CREATE POLICY "agenda_items_read" ON agenda_items FOR SELECT TO authenticated USING (true);
-- Insert/general edits (text, due date, notes) are an admin action. Status
-- transitions to 'done' do NOT go through this policy at all — they only
-- happen via mark_agenda_item_done() below, which is the real enforcement
-- point for "assignee OR their proxy OR any admin."
CREATE POLICY "agenda_items_write" ON agenda_items FOR ALL TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin'))
  WITH CHECK (current_admin_role() IN ('super_admin', 'admin'));

CREATE POLICY "agenda_item_assignees_read" ON agenda_item_assignees FOR SELECT TO authenticated USING (true);
CREATE POLICY "agenda_item_assignees_write" ON agenda_item_assignees FOR ALL TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin'))
  WITH CHECK (current_admin_role() IN ('super_admin', 'admin'));

-- 4. Resolve who actually acts for a given committee member on a given
-- meeting: their own login if they use one, else their fixed standing proxy,
-- else whoever is running that meeting. Single source of truth reused by both
-- the reminder sweep and the mark-done permission check.
CREATE OR REPLACE FUNCTION resolve_agenda_assignee(p_committee_member_id uuid, p_meeting_id uuid) RETURNS uuid AS $$
  SELECT COALESCE(cm.admin_user_id, cm.proxy_admin_user_id, m.run_by_admin_user_id)
  FROM committee_members cm, agenda_meetings m
  WHERE cm.id = p_committee_member_id AND m.id = p_meeting_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 5. Mark a task done. Permitted for the resolved assignee/proxy of ANY of
-- the item's assignees, or any admin-tier user as an override — no mandatory
-- second-person verification (unlike Complaints' resolve→verify step), per
-- explicit user confirmation. Uses IS DISTINCT FROM / COALESCE throughout so
-- a NULL current_admin_user_id() (not logged in as a recognized admin_user)
-- fails closed rather than silently passing.
CREATE OR REPLACE FUNCTION mark_agenda_item_done(p_item_id uuid) RETURNS void AS $$
DECLARE
  v_item agenda_items%ROWTYPE;
  v_caller uuid := current_admin_user_id();
  v_is_admin boolean := COALESCE(current_admin_role(), '') IN ('super_admin', 'admin');
  v_allowed boolean := false;
BEGIN
  SELECT * INTO v_item FROM agenda_items WHERE id = p_item_id;
  IF v_item.id IS NULL THEN
    RAISE EXCEPTION 'Agenda item not found.';
  END IF;

  IF v_is_admin THEN
    v_allowed := true;
  ELSIF v_caller IS NOT NULL THEN
    SELECT true INTO v_allowed
    FROM agenda_item_assignees aia
    WHERE aia.agenda_item_id = p_item_id
      AND resolve_agenda_assignee(aia.committee_member_id, v_item.meeting_id) IS NOT DISTINCT FROM v_caller
    LIMIT 1;
  END IF;

  IF v_allowed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Only this task''s assignee, their proxy, or an admin can mark it done.';
  END IF;

  UPDATE agenda_items
  SET status = 'done', done_at = now(), done_by_admin_user_id = v_caller
  WHERE id = p_item_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION mark_agenda_item_done(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_agenda_item_done(uuid) TO authenticated;

-- 6. Carry forward every still-open task from the previous meeting into a
-- newly-created one. Suggestions are a per-meeting log, not an open task
-- queue, so they are never carried. carried_from_item_id always points at the
-- true root of the chain (not just the immediately preceding copy) so a task
-- carried 3+ times is easy to trace and flag as stuck.
CREATE OR REPLACE FUNCTION carry_forward_meeting(p_new_meeting_id uuid) RETURNS int AS $$
DECLARE
  v_new_meeting agenda_meetings%ROWTYPE;
  v_prev_meeting_id uuid;
  v_count int := 0;
  r record;
  v_new_item_id uuid;
BEGIN
  SELECT * INTO v_new_meeting FROM agenda_meetings WHERE id = p_new_meeting_id;
  IF v_new_meeting.id IS NULL THEN
    RAISE EXCEPTION 'Meeting not found.';
  END IF;

  SELECT id INTO v_prev_meeting_id FROM agenda_meetings
  WHERE meeting_date < v_new_meeting.meeting_date AND id != p_new_meeting_id
  ORDER BY meeting_date DESC LIMIT 1;

  IF v_prev_meeting_id IS NULL THEN
    RETURN 0;
  END IF;

  FOR r IN
    SELECT * FROM agenda_items
    WHERE meeting_id = v_prev_meeting_id AND kind = 'task' AND status != 'done'
  LOOP
    INSERT INTO agenda_items (meeting_id, kind, text_ur, display_order, due_date, carried_from_item_id, carry_count)
    VALUES (p_new_meeting_id, 'task', r.text_ur, r.display_order, r.due_date,
      COALESCE(r.carried_from_item_id, r.id), r.carry_count + 1)
    RETURNING id INTO v_new_item_id;

    INSERT INTO agenda_item_assignees (agenda_item_id, committee_member_id)
    SELECT v_new_item_id, committee_member_id FROM agenda_item_assignees WHERE agenda_item_id = r.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION carry_forward_meeting(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION carry_forward_meeting(uuid) TO authenticated;

-- 7. In-app popup notifications for the software-using members/proxies —
-- immediate on assignment, plus a daily sweep for items due within 2 days or
-- already overdue. WhatsApp stays a manual wa.me tap client-side (no Business
-- API) exactly like every other reminder in this app — no queue table needed
-- for that half.
INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('agenda_task_assigned', 'A meeting task is assigned to you (or your proxy)', true, true),
  ('agenda_task_due_soon', 'Daily reminder for a meeting task due soon or overdue', true, true)
ON CONFLICT (event_type) DO NOTHING;

CREATE OR REPLACE FUNCTION notify_agenda_task_assigned() RETURNS trigger AS $$
DECLARE
  v_popup_enabled boolean;
  v_recipient uuid;
  v_item agenda_items%ROWTYPE;
BEGIN
  SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'agenda_task_assigned';
  IF v_popup_enabled IS DISTINCT FROM false THEN
    SELECT * INTO v_item FROM agenda_items WHERE id = NEW.agenda_item_id;
    v_recipient := resolve_agenda_assignee(NEW.committee_member_id, v_item.meeting_id);
    IF v_recipient IS NOT NULL THEN
      INSERT INTO notifications (recipient_id, event_type, title, body, link)
      VALUES (v_recipient, 'agenda_task_assigned', 'New meeting task assigned',
        v_item.text_ur, '/admin/tasks/meetings');
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_notify_agenda_task_assigned ON agenda_item_assignees;
CREATE TRIGGER trg_notify_agenda_task_assigned
  AFTER INSERT ON agenda_item_assignees
  FOR EACH ROW EXECUTE FUNCTION notify_agenda_task_assigned();

CREATE OR REPLACE FUNCTION run_agenda_reminder_sweep() RETURNS void AS $$
DECLARE
  v_popup_enabled boolean;
  r record;
  v_recipient uuid;
BEGIN
  SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'agenda_task_due_soon';
  IF v_popup_enabled IS DISTINCT FROM false THEN
    FOR r IN
      SELECT ai.id, ai.text_ur, ai.due_date, ai.meeting_id, aia.committee_member_id
      FROM agenda_items ai
      JOIN agenda_item_assignees aia ON aia.agenda_item_id = ai.id
      WHERE ai.kind = 'task' AND ai.status != 'done'
        AND ai.due_date IS NOT NULL AND ai.due_date <= current_date + interval '2 days'
    LOOP
      v_recipient := resolve_agenda_assignee(r.committee_member_id, r.meeting_id);
      IF v_recipient IS NOT NULL THEN
        INSERT INTO notifications (recipient_id, event_type, title, body, link)
        VALUES (v_recipient, 'agenda_task_due_soon',
          CASE WHEN r.due_date < current_date THEN 'Overdue meeting task' ELSE 'Meeting task due soon' END,
          r.text_ur, '/admin/tasks/meetings');
      END IF;
    END LOOP;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

SELECT cron.schedule('agenda-reminder-sweep', '0 8 * * *', $$SELECT run_agenda_reminder_sweep()$$);
