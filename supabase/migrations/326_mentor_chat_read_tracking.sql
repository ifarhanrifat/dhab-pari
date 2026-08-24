-- Migration 326: per-participant read tracking for mentor chat, so the
-- portal sidebar can show an unread badge the same way every other tab
-- does (portal_sidebar_badges, migration 191) — a conversation has two
-- different people with two different "have I seen this" states, so this
-- can't just be a notifications-table entry like everything else that
-- function already handles generically.

ALTER TABLE mentor_conversations
  ADD COLUMN IF NOT EXISTS student_last_read_at timestamptz NOT NULL DEFAULT '-infinity',
  ADD COLUMN IF NOT EXISTS mentor_last_read_at timestamptz NOT NULL DEFAULT '-infinity';

CREATE OR REPLACE FUNCTION mark_mentor_conversation_read(p_conversation_id uuid) RETURNS void AS $$
DECLARE
  v_self_id uuid;
BEGIN
  v_self_id := current_portal_user_id();
  IF v_self_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  UPDATE mentor_conversations SET
    student_last_read_at = CASE WHEN student_portal_user_id = v_self_id THEN now() ELSE student_last_read_at END,
    mentor_last_read_at = CASE WHEN mentor_portal_user_id = v_self_id THEN now() ELSE mentor_last_read_at END
  WHERE id = p_conversation_id AND (student_portal_user_id = v_self_id OR mentor_portal_user_id = v_self_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION mark_mentor_conversation_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_mentor_conversation_read(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION portal_sidebar_badges() RETURNS jsonb AS $$
DECLARE
  v_user uuid;
  v_out jsonb;
  v_unread_chats int;
BEGIN
  v_user := current_portal_user_id();
  IF v_user IS NULL THEN RETURN '{}'::jsonb; END IF;

  SELECT coalesce(jsonb_object_agg(page, n), '{}'::jsonb) INTO v_out
    FROM (
      SELECT split_part(ltrim(link, '/'), '/', 2) AS page, count(*) AS n
        FROM portal_notifications
       WHERE portal_user_id = v_user AND is_read = false AND link LIKE '/portal/%'
       GROUP BY 1
    ) s;

  SELECT count(*) INTO v_unread_chats
    FROM mentor_messages m
    JOIN mentor_conversations c ON c.id = m.conversation_id
   WHERE m.sender_portal_user_id <> v_user
     AND (
       (c.student_portal_user_id = v_user AND m.created_at > c.student_last_read_at)
       OR (c.mentor_portal_user_id = v_user AND m.created_at > c.mentor_last_read_at)
     );

  RETURN v_out || jsonb_build_object(
    'blood-donor', (
      SELECT count(*)
        FROM blood_request_contacts c
        JOIN blood_requests r ON r.id = c.request_id
        JOIN blood_donors d ON d.id = c.blood_donor_id
       WHERE d.portal_user_id = v_user
         AND c.response = 'pending'
         AND c.stood_down_at IS NULL
         AND r.status = 'open'
    ),
    'mentors', v_unread_chats
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
