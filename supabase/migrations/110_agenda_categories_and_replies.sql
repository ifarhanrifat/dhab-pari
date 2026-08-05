-- Migration 110: issue categories for printed/sorted task grouping, and a
-- proper reply mechanism for suggestions (currently a committee-member-raised
-- suggestion has no reply path at all, and a website-raised one only had a
-- broken one — /admin/suggestions' "Send Reply" just logs to
-- notifications_log, a placeholder table nothing ever sends from). Replies
-- here use the same wa.me-deep-link convention as every other "automatic"
-- notification in this app.

ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS category varchar
  CHECK (category IN ('miscellaneous', 'donation_projects', 'medical', 'tree_plantation', 'water_supply'))
  DEFAULT 'miscellaneous';
-- Task-only in practice (ignored for kind='suggestion' rows); the column
-- default backfills every existing row to Miscellaneous automatically.

ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS reply_text text;
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS replied_at timestamptz;
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS replied_by_admin_user_id uuid REFERENCES admin_users(id);
-- Captured at import time from suggestions.mobile so replying to a
-- website-origin suggestion never needs a live join back to that table —
-- robust even if the original suggestions row is later edited or deleted.
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS raised_by_mobile varchar;

-- carry_forward_meeting (107) — same as before, plus copying category so a
-- carried task keeps its original topic instead of resetting to Miscellaneous.
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
