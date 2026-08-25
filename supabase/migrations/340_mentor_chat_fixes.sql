-- Migration 340: three real bugs/gaps caught in live testing.
--
-- 1. mentor_conversations_with_names (329) was written before
--    portal_public_name() existed (336) and still read s.full_name/
--    m.full_name directly — a student who set a display_name still saw
--    their real name shown to the mentor in the chat header, and vice
--    versa. Also adds the mentor's own type/expertise/bio to the view so
--    the chat page can show "who is this person and what do they help
--    with" without a second query — currently a student opens a chat
--    with literally nothing about the mentor beyond their name.
--
-- 2. New messages never created an actual notification — only the
--    unread-badge count (portal_sidebar_badges, migration 326) moved.
--    Deduplicated per conversation (bump the existing unread one rather
--    than stack a new row per message) so an active back-and-forth
--    doesn't flood the bell with ten near-identical entries.
CREATE OR REPLACE VIEW mentor_conversations_with_names AS
SELECT
  c.id, c.student_portal_user_id, c.mentor_portal_user_id, c.status,
  c.created_at, c.last_message_at, c.student_last_read_at, c.mentor_last_read_at,
  portal_public_name(s.id) AS student_name, s.avatar_url AS student_avatar_url,
  portal_public_name(m.id) AS mentor_name, m.avatar_url AS mentor_avatar_url,
  m.mentor_type, m.mentor_expertise, m.mentor_bio
FROM mentor_conversations c
JOIN portal_users s ON s.id = c.student_portal_user_id
JOIN portal_users m ON m.id = c.mentor_portal_user_id
WHERE c.student_portal_user_id = current_portal_user_id()
   OR c.mentor_portal_user_id = current_portal_user_id()
   OR current_admin_role() IN ('super_admin', 'admin');

CREATE OR REPLACE FUNCTION trg_notify_mentor_message() RETURNS trigger AS $$
DECLARE
  v_recipient_id uuid;
  v_sender_name varchar;
  v_link varchar;
  v_existing_id uuid;
BEGIN
  SELECT CASE WHEN c.student_portal_user_id = NEW.sender_portal_user_id THEN c.mentor_portal_user_id ELSE c.student_portal_user_id END
  INTO v_recipient_id
  FROM mentor_conversations c WHERE c.id = NEW.conversation_id;

  v_sender_name := portal_public_name(NEW.sender_portal_user_id);
  v_link := '/portal/mentors/chat/' || NEW.conversation_id;

  SELECT id INTO v_existing_id FROM portal_notifications
    WHERE portal_user_id = v_recipient_id AND event_type = 'mentor_message' AND link = v_link AND is_read = false
    LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    UPDATE portal_notifications
      SET title = 'New message from ' || v_sender_name, body = left(NEW.content, 140), created_at = now()
      WHERE id = v_existing_id;
  ELSE
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_recipient_id, 'mentor_message', 'New message from ' || v_sender_name, left(NEW.content, 140), v_link);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS notify_mentor_message_trigger ON mentor_messages;
CREATE TRIGGER notify_mentor_message_trigger AFTER INSERT ON mentor_messages
  FOR EACH ROW EXECUTE FUNCTION trg_notify_mentor_message();
