-- Migration 155: meeting time/place (for the new printable notice), and a
-- meeting-cancellation state distinct from open/finalized — a scheduled
-- meeting that never happened shouldn't be treated as "the last real
-- meeting" by carry-forward or the activity-window anchor.

-- 1. Time & place — captured at creation, shown on the meeting-notice PNG.
ALTER TABLE agenda_meetings
  ADD COLUMN IF NOT EXISTS meeting_time time,
  ADD COLUMN IF NOT EXISTS location varchar;

-- 2. Widen status to add 'cancelled'. The column was declared with an
-- inline CHECK (no explicit constraint name), so Postgres auto-named it
-- <table>_<column>_check — drop that, then re-add with the wider list.
ALTER TABLE agenda_meetings DROP CONSTRAINT IF EXISTS agenda_meetings_status_check;
ALTER TABLE agenda_meetings ADD CONSTRAINT agenda_meetings_status_check
  CHECK (status IN ('open', 'finalized', 'cancelled'));

-- Symmetric to finalize_meeting (153): only an open (never-finalized,
-- never-already-cancelled) meeting can be cancelled, admin-only. Existing
-- agenda_items_write RLS already requires the parent meeting's status to be
-- 'open' to write, so a cancelled meeting is automatically locked the same
-- way a finalized one is — no policy change needed.
CREATE OR REPLACE FUNCTION cancel_meeting(p_meeting_id uuid) RETURNS void AS $$
BEGIN
  IF COALESCE(current_admin_role(), '') NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Only an admin can cancel a meeting.';
  END IF;
  UPDATE agenda_meetings SET status = 'cancelled' WHERE id = p_meeting_id AND status = 'open';
  IF NOT FOUND THEN RAISE EXCEPTION 'Meeting not found or no longer open.'; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION cancel_meeting(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cancel_meeting(uuid) TO authenticated;

-- 3. carry_forward_meeting (last redefined in 110) — skip cancelled
-- meetings when picking "the previous meeting" so a cancelled sitting
-- doesn't swallow whatever was still unfinished from the last real one.
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
  WHERE meeting_date < v_new_meeting.meeting_date AND id != p_new_meeting_id AND status != 'cancelled'
  ORDER BY meeting_date DESC LIMIT 1;

  IF v_prev_meeting_id IS NULL THEN
    RETURN 0;
  END IF;

  FOR r IN
    SELECT * FROM agenda_items
    WHERE meeting_id = v_prev_meeting_id AND kind = 'task' AND status != 'done'
  LOOP
    INSERT INTO agenda_items (meeting_id, kind, text_ur, display_order, due_date, category, carried_from_item_id, carry_count)
    VALUES (p_new_meeting_id, 'task', r.text_ur, r.display_order, r.due_date, r.category,
      COALESCE(r.carried_from_item_id, r.id), r.carry_count + 1)
    RETURNING id INTO v_new_item_id;

    INSERT INTO agenda_item_assignees (agenda_item_id, committee_member_id)
    SELECT v_new_item_id, committee_member_id FROM agenda_item_assignees WHERE agenda_item_id = r.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
