-- Migration 329: fixes a real bug caught in live testing — both the
-- mentors hub ("My conversations") and admin's Mentor Chats page tried to
-- resolve the other participant's name with a direct client-side
-- `portal_users.select('full_name').in('id', ...)` call. portal_users has
-- been admin/super_admin-or-self-only readable since migration 121, so
-- that query silently returned zero rows for the other person — a student
-- could open the hub and see a blank name instead of their mentor's name.
--
-- Same fix shape as mentor_directory (323)/news_comments_public (328): a
-- view that pre-joins the names (bypassing RLS on portal_users for the
-- join, since the view runs as its owner), but keeps the row visibility
-- restriction in the view's own WHERE clause using the querying user's
-- real identity (current_portal_user_id()/current_admin_role() read
-- auth.uid() live, regardless of who owns the view).
CREATE OR REPLACE VIEW mentor_conversations_with_names AS
SELECT
  c.id, c.student_portal_user_id, c.mentor_portal_user_id, c.status,
  c.created_at, c.last_message_at, c.student_last_read_at, c.mentor_last_read_at,
  s.full_name AS student_name, s.avatar_url AS student_avatar_url,
  m.full_name AS mentor_name, m.avatar_url AS mentor_avatar_url
FROM mentor_conversations c
JOIN portal_users s ON s.id = c.student_portal_user_id
JOIN portal_users m ON m.id = c.mentor_portal_user_id
WHERE c.student_portal_user_id = current_portal_user_id()
   OR c.mentor_portal_user_id = current_portal_user_id()
   OR current_admin_role() IN ('super_admin', 'admin');

GRANT SELECT ON mentor_conversations_with_names TO authenticated;
