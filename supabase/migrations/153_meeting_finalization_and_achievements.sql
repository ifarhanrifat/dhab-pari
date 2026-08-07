-- Migration 153: Meeting finalization (a meeting becomes read-only once
-- the committee is done with it — no more edits, view-only from then on),
-- a private/public flag on completed tasks (for the new public
-- Achievements page), and an RPC that turns a handwritten meeting-table
-- reply into a real reply on the actual project comment thread.

-- 1. Finalization.
ALTER TABLE agenda_meetings
  ADD COLUMN IF NOT EXISTS status varchar NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'finalized')),
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS finalized_by uuid REFERENCES admin_users(id);

CREATE OR REPLACE FUNCTION finalize_meeting(p_meeting_id uuid) RETURNS void AS $$
BEGIN
  IF COALESCE(current_admin_role(), '') NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Only an admin can finalize a meeting.';
  END IF;
  UPDATE agenda_meetings SET status = 'finalized', finalized_at = now(), finalized_by = current_admin_user_id()
  WHERE id = p_meeting_id AND status = 'open';
  IF NOT FOUND THEN RAISE EXCEPTION 'Meeting not found or already finalized.'; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION finalize_meeting(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finalize_meeting(uuid) TO authenticated;

-- Lock out further agenda_items writes once the parent meeting is
-- finalized — enforced here (server-side), not just hidden client-side.
DROP POLICY IF EXISTS "agenda_items_write" ON agenda_items;
CREATE POLICY "agenda_items_write" ON agenda_items FOR ALL TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin')
    AND EXISTS (SELECT 1 FROM agenda_meetings m WHERE m.id = agenda_items.meeting_id AND m.status = 'open'))
  WITH CHECK (current_admin_role() IN ('super_admin', 'admin')
    AND EXISTS (SELECT 1 FROM agenda_meetings m WHERE m.id = agenda_items.meeting_id AND m.status = 'open'));

-- Widening the signature (new p_is_private param) would otherwise leave the
-- old 1-arg version in place too, as an ambiguous overload — drop it first.
DROP FUNCTION IF EXISTS mark_agenda_item_done(uuid);
CREATE OR REPLACE FUNCTION mark_agenda_item_done(p_item_id uuid, p_is_private boolean DEFAULT false) RETURNS void AS $$
DECLARE
  v_item agenda_items%ROWTYPE;
  v_caller uuid := current_admin_user_id();
  v_is_admin boolean := COALESCE(current_admin_role(), '') IN ('super_admin', 'admin');
  v_allowed boolean := false;
  v_meeting_status varchar;
BEGIN
  SELECT * INTO v_item FROM agenda_items WHERE id = p_item_id;
  IF v_item.id IS NULL THEN
    RAISE EXCEPTION 'Agenda item not found.';
  END IF;

  SELECT status INTO v_meeting_status FROM agenda_meetings WHERE id = v_item.meeting_id;
  IF v_meeting_status = 'finalized' THEN
    RAISE EXCEPTION 'This meeting is finalized — it can no longer be changed.';
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
  SET status = 'done', done_at = now(), done_by_admin_user_id = v_caller, is_private = p_is_private
  WHERE id = p_item_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 2. Public/private flag on completed tasks — "Our Achievements" (public
-- page) shows the real text for public ones; private ones only confirm
-- that work happened and who did it, no detail.
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;

-- Public read of completed tasks only, and only the columns Achievements
-- actually needs — never exposes agenda content that isn't done yet.
CREATE VIEW achievements_public AS
SELECT ai.id, ai.text_ur, ai.done_at, ai.is_private,
  CASE WHEN ai.is_private THEN NULL ELSE au.full_name END AS done_by_name
FROM agenda_items ai
LEFT JOIN admin_users au ON au.id = ai.done_by_admin_user_id
WHERE ai.status = 'done'
ORDER BY ai.done_at DESC;

GRANT SELECT ON achievements_public TO anon, authenticated;

-- 3. Turn a handwritten meeting-table reply into a real reply on the
-- actual project comment thread — same shape as a normal reply insert
-- (migration 138/139), just staff-triggered from the agenda page and
-- labeled distinctly so it's clear it came from the committee, not a
-- portal user.
CREATE OR REPLACE FUNCTION post_agenda_comment_reply(p_parent_comment_id uuid, p_content text) RETURNS uuid AS $$
DECLARE
  v_project_id uuid;
  v_new_id uuid;
BEGIN
  IF NOT can_access_system('donors_projects') THEN
    RAISE EXCEPTION 'Not authorized to reply as the committee';
  END IF;
  IF p_content IS NULL OR trim(p_content) = '' THEN
    RAISE EXCEPTION 'Reply cannot be empty';
  END IF;

  SELECT project_id INTO v_project_id FROM project_comments WHERE id = p_parent_comment_id;
  IF v_project_id IS NULL THEN RAISE EXCEPTION 'Comment not found'; END IF;

  INSERT INTO project_comments (project_id, comment_type, system_label, content, parent_comment_id)
  VALUES (v_project_id, 'system', 'Committee Reply', p_content, p_parent_comment_id)
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION post_agenda_comment_reply(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION post_agenda_comment_reply(uuid, text) TO authenticated;
