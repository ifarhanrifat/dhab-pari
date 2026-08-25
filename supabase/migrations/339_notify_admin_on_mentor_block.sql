-- Migration 339: closes a gap flagged in the mentorship-loop review — a
-- block silently ended a conversation with nothing telling admin it
-- happened. Since a block is exactly the signal something may have gone
-- wrong between a mentor and a student, every active super_admin/admin
-- now gets a notification the moment one occurs, same pattern as
-- trg_complaint_after_insert_notify (migration 063) — they don't have to
-- happen to notice a closed conversation while browsing Mentor Chats.
CREATE OR REPLACE FUNCTION block_mentor_chat_partner(p_other_portal_user_id uuid) RETURNS void AS $$
DECLARE
  v_self_id uuid;
  v_self_name varchar;
  v_other_name varchar;
  r record;
BEGIN
  v_self_id := current_portal_user_id();
  IF v_self_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  INSERT INTO mentor_chat_blocks (blocker_portal_user_id, blocked_portal_user_id)
  VALUES (v_self_id, p_other_portal_user_id)
  ON CONFLICT DO NOTHING;
  UPDATE mentor_conversations SET status = 'closed'
  WHERE (student_portal_user_id = v_self_id AND mentor_portal_user_id = p_other_portal_user_id)
     OR (mentor_portal_user_id = v_self_id AND student_portal_user_id = p_other_portal_user_id);

  SELECT portal_public_name(v_self_id) INTO v_self_name;
  SELECT portal_public_name(p_other_portal_user_id) INTO v_other_name;

  FOR r IN SELECT id FROM admin_users WHERE role IN ('super_admin', 'admin') AND is_active = true LOOP
    INSERT INTO notifications (recipient_id, event_type, title, body, link)
    VALUES (r.id, 'mentor_chat_blocked', 'A mentor chat was blocked',
      COALESCE(v_self_name, 'Someone') || ' blocked ' || COALESCE(v_other_name, 'someone') || ' — worth a look.',
      '/admin/mentor-chats');
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
