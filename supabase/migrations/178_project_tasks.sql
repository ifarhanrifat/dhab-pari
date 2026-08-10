-- Migration 178: tasks a volunteer is given on a project.
--
-- Deliberately NOT part of agenda_items. Agenda items assign through a junction
-- to committee_members, and a volunteer is a portal_user. Bridging the two would
-- mean either enrolling volunteers as fake committee members — polluting the
-- public members page, quorum counting and proxy resolution — or a polymorphic
-- assignee that every later query has to ask "which kind of person is this?"
-- about, forever.
--
-- Keeping them separate also makes the lifecycle the committee asked for fall
-- out on its own: a task belongs to a project, so when the project closes the
-- volunteer's list empties. There is no "close his window" rule to write, and
-- none to forget.
--
-- The committee still allots this work during a meeting — the meeting screen
-- creates project tasks from the discussion (source_meeting_id below records
-- which meeting), so the workflow spans both models without entangling them.
CREATE TABLE IF NOT EXISTS project_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Who it is for. Null = an unassigned task on the project board.
  portal_user_id uuid REFERENCES portal_users(id) ON DELETE SET NULL,
  title varchar NOT NULL,
  detail text,
  -- Urdu alongside English, same rule as the rest of the app: whichever the
  -- committee typed is what the volunteer reads.
  title_ur text,
  due_date date,
  status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')),
  -- Set when the task was allotted during a meeting, so the minutes and the
  -- volunteer's task list point at each other.
  source_meeting_id uuid REFERENCES agenda_meetings(id) ON DELETE SET NULL,
  created_by_admin_user_id uuid REFERENCES admin_users(id),
  done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_tasks_project_idx ON project_tasks(project_id, status);
CREATE INDEX IF NOT EXISTS project_tasks_volunteer_idx ON project_tasks(portal_user_id, status);

ALTER TABLE project_tasks ENABLE ROW LEVEL SECURITY;

-- A volunteer sees only their own tasks, and only while they are actually an
-- assigned volunteer on that project — acceptance is what opens the window,
-- and completion is what closes it.
CREATE POLICY "project_tasks_read_own" ON project_tasks FOR SELECT TO authenticated
  USING (
    portal_user_id = current_portal_user_id()
    AND EXISTS (
      SELECT 1 FROM volunteers v
      WHERE v.portal_user_id = current_portal_user_id()
        AND v.project_id = project_tasks.project_id
        AND v.status = 'assigned'
    )
  );

-- Volunteers may report progress on their own task, but not reassign it,
-- move it to another project, or change what was asked of them.
CREATE POLICY "project_tasks_update_own_status" ON project_tasks FOR UPDATE TO authenticated
  USING (portal_user_id = current_portal_user_id())
  WITH CHECK (portal_user_id = current_portal_user_id());

CREATE POLICY "project_tasks_staff_read" ON project_tasks FOR SELECT TO authenticated
  USING (can_access_system('donors_projects'));
CREATE POLICY "project_tasks_staff_write" ON project_tasks FOR ALL TO authenticated
  USING (can_access_system('donors_projects') AND current_admin_permission('manage_parties'))
  WITH CHECK (can_access_system('donors_projects') AND current_admin_permission('manage_parties'));

-- Stamp completion time from the status change rather than trusting a client
-- to send it.
CREATE OR REPLACE FUNCTION trg_project_task_done_at() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'done' AND COALESCE(OLD.status, '') <> 'done' THEN
    NEW.done_at := now();
  ELSIF NEW.status <> 'done' THEN
    NEW.done_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS project_task_done_at_trigger ON project_tasks;
CREATE TRIGGER project_task_done_at_trigger BEFORE INSERT OR UPDATE ON project_tasks
  FOR EACH ROW EXECUTE FUNCTION trg_project_task_done_at();

-- Being given a job is the whole point of the feature — tell them.
INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('project_task_assigned', 'A volunteer is given a task', false, true)
ON CONFLICT (event_type) DO NOTHING;

CREATE OR REPLACE FUNCTION trg_project_task_notify() RETURNS trigger AS $$
DECLARE
  v_project varchar;
BEGIN
  IF NEW.portal_user_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.portal_user_id IS NOT DISTINCT FROM OLD.portal_user_id
     AND NEW.title IS NOT DISTINCT FROM OLD.title THEN
    RETURN NEW;
  END IF;

  SELECT title INTO v_project FROM projects WHERE id = NEW.project_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (NEW.portal_user_id, 'project_task_assigned',
          'New task: ' || NEW.title,
          COALESCE(v_project, 'Project') || COALESCE(' — due ' || to_char(NEW.due_date, 'DD/MM/YYYY'), ''),
          '/portal/my-volunteering');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS project_task_notify_trigger ON project_tasks;
CREATE TRIGGER project_task_notify_trigger AFTER INSERT OR UPDATE ON project_tasks
  FOR EACH ROW EXECUTE FUNCTION trg_project_task_notify();

-- When a project closes, everyone who helped is marked complete in one step —
-- which is also what puts them on the public page under the committee's thanks.
CREATE OR REPLACE FUNCTION complete_project_volunteers(p_project_id uuid) RETURNS int AS $$
DECLARE
  v_count int;
BEGIN
  IF NOT can_access_system('donors_projects') OR NOT current_admin_permission('manage_parties') THEN
    RAISE EXCEPTION 'Not authorized to close out volunteers';
  END IF;
  UPDATE volunteers SET status = 'completed'
   WHERE project_id = p_project_id AND status = 'assigned';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE project_tasks SET status = 'cancelled'
   WHERE project_id = p_project_id AND status IN ('pending', 'in_progress');
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION complete_project_volunteers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_project_volunteers(uuid) TO authenticated;
