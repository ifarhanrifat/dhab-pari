-- Migration 324: Phase D — mentor↔student chat. Design constraints, locked
-- in before writing a line of this:
--
--   1. NOT actually private. Every thread and message is readable by
--      admin/super_admin, forever — this is a mentorship program between
--      adults and school-age students, not a consumer chat product. The
--      client shows a pinned Urdu notice saying exactly that at the top of
--      every conversation (frontend concern, not this migration's job).
--   2. No phone numbers, WhatsApp links, or emails ever leave this table.
--      Enforced here, at the database, not just in the UI — a contact-info
--      pattern in the message body raises an exception and nothing is
--      written. Client-side pre-checks the same pattern too, purely so the
--      sender gets an instant inline error instead of a round trip.
--   3. No per-conversation accept step. A student starting a chat with an
--      approved, available mentor opens it immediately — the one approval
--      gate that exists is upstream, at mentor vetting (migration 323).
--   4. A mentor can block one specific student from chatting with them —
--      scoped to that pair, never a platform-wide ban.

CREATE TABLE IF NOT EXISTS mentor_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  mentor_portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  status varchar NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_portal_user_id, mentor_portal_user_id)
);

CREATE TABLE IF NOT EXISTS mentor_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES mentor_conversations(id) ON DELETE CASCADE,
  sender_portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mentor_messages_conversation_idx ON mentor_messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS mentor_chat_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  blocked_portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (blocker_portal_user_id, blocked_portal_user_id)
);

-- ── Contact-info guard ──────────────────────────────────────────────────
-- Deliberately broad rather than a single tight regex: catches Pakistani
-- mobile numbers in any common spacing/format, a bare 10-11 digit run, an
-- email address, and wa.me/WhatsApp links. False positives (a student
-- typing a long unrelated number) are an acceptable cost here — "err
-- toward blocking" is the correct default for this specific guard.
CREATE OR REPLACE FUNCTION contains_contact_info(p_text text) RETURNS boolean AS $$
BEGIN
  RETURN
    p_text ~ '(\+?92|0)[\s-]?3\d{2}[\s-]?\d{7}'          -- PK mobile, any spacing
    OR p_text ~ '\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d' -- any 10+ digit run, loosely spaced
    OR p_text ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'  -- email
    OR p_text ~* 'wa\.me/|whatsapp\.com';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION trg_mentor_message_guard() RETURNS trigger AS $$
BEGIN
  IF contains_contact_info(NEW.content) THEN
    RAISE EXCEPTION 'Message not sent — sharing phone numbers, WhatsApp links, or email addresses in chat isn''t allowed. Everything you need this chat for happens right here.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mentor_message_guard_trigger ON mentor_messages;
CREATE TRIGGER mentor_message_guard_trigger BEFORE INSERT ON mentor_messages
  FOR EACH ROW EXECUTE FUNCTION trg_mentor_message_guard();

-- Bump last_message_at so a conversation list can sort by recency without a
-- correlated subquery over messages every render.
CREATE OR REPLACE FUNCTION trg_mentor_conversation_bump() RETURNS trigger AS $$
BEGIN
  UPDATE mentor_conversations SET last_message_at = NEW.created_at WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS mentor_conversation_bump_trigger ON mentor_messages;
CREATE TRIGGER mentor_conversation_bump_trigger AFTER INSERT ON mentor_messages
  FOR EACH ROW EXECUTE FUNCTION trg_mentor_conversation_bump();

-- Opens (or returns) a thread with an approved, available mentor who hasn't
-- blocked the caller. All the gating logic lives here rather than in RLS's
-- WITH CHECK, so the error the student sees is an actual sentence, not a
-- generic "row violates policy".
CREATE OR REPLACE FUNCTION start_mentor_conversation(p_mentor_portal_user_id uuid) RETURNS uuid AS $$
DECLARE
  v_student_id uuid;
  v_conversation_id uuid;
  v_mentor_status varchar;
  v_mentor_available boolean;
BEGIN
  v_student_id := current_portal_user_id();
  IF v_student_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF v_student_id = p_mentor_portal_user_id THEN
    RAISE EXCEPTION 'You cannot start a conversation with yourself';
  END IF;

  SELECT mentor_status, mentor_available INTO v_mentor_status, v_mentor_available
  FROM portal_users WHERE id = p_mentor_portal_user_id;
  IF v_mentor_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'This mentor is not available for chat';
  END IF;
  IF NOT COALESCE(v_mentor_available, false) THEN
    RAISE EXCEPTION 'This mentor is currently not accepting new conversations';
  END IF;
  IF EXISTS (SELECT 1 FROM mentor_chat_blocks WHERE blocker_portal_user_id = p_mentor_portal_user_id AND blocked_portal_user_id = v_student_id) THEN
    RAISE EXCEPTION 'This mentor is not available to chat with you';
  END IF;

  INSERT INTO mentor_conversations (student_portal_user_id, mentor_portal_user_id)
  VALUES (v_student_id, p_mentor_portal_user_id)
  ON CONFLICT (student_portal_user_id, mentor_portal_user_id) DO UPDATE SET status = 'open'
  RETURNING id INTO v_conversation_id;

  RETURN v_conversation_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION start_mentor_conversation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_mentor_conversation(uuid) TO authenticated;

-- Scoped block — this pair only. Either side may block; a mentor blocking a
-- student is the documented use (professional blocks a problem chatter),
-- but nothing stops a student blocking a mentor either, symmetric on
-- purpose.
CREATE OR REPLACE FUNCTION block_mentor_chat_partner(p_other_portal_user_id uuid) RETURNS void AS $$
DECLARE
  v_self_id uuid;
BEGIN
  v_self_id := current_portal_user_id();
  IF v_self_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  INSERT INTO mentor_chat_blocks (blocker_portal_user_id, blocked_portal_user_id)
  VALUES (v_self_id, p_other_portal_user_id)
  ON CONFLICT DO NOTHING;
  UPDATE mentor_conversations SET status = 'closed'
  WHERE (student_portal_user_id = v_self_id AND mentor_portal_user_id = p_other_portal_user_id)
     OR (mentor_portal_user_id = v_self_id AND student_portal_user_id = p_other_portal_user_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION block_mentor_chat_partner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION block_mentor_chat_partner(uuid) TO authenticated;

-- ── RLS ───────────────────────────────────────────────────────────────
ALTER TABLE mentor_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mentor_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE mentor_chat_blocks ENABLE ROW LEVEL SECURITY;

-- No client INSERT policy on mentor_conversations — start_mentor_conversation()
-- (SECURITY DEFINER) is the only way one is ever created, so every gating
-- rule above is enforced exactly once, not duplicated into a WITH CHECK.
CREATE POLICY "mentor_conversations_participant_read" ON mentor_conversations FOR SELECT TO authenticated
  USING (student_portal_user_id = current_portal_user_id() OR mentor_portal_user_id = current_portal_user_id()
         OR current_admin_role() IN ('super_admin', 'admin'));

CREATE POLICY "mentor_messages_participant_read" ON mentor_messages FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM mentor_conversations c WHERE c.id = conversation_id
            AND (c.student_portal_user_id = current_portal_user_id() OR c.mentor_portal_user_id = current_portal_user_id()))
    OR current_admin_role() IN ('super_admin', 'admin')
  );
CREATE POLICY "mentor_messages_participant_insert" ON mentor_messages FOR INSERT TO authenticated
  WITH CHECK (
    sender_portal_user_id = current_portal_user_id()
    AND EXISTS (
      SELECT 1 FROM mentor_conversations c WHERE c.id = conversation_id AND c.status = 'open'
      AND (c.student_portal_user_id = current_portal_user_id() OR c.mentor_portal_user_id = current_portal_user_id())
    )
  );

CREATE POLICY "mentor_chat_blocks_own_read" ON mentor_chat_blocks FOR SELECT TO authenticated
  USING (blocker_portal_user_id = current_portal_user_id() OR current_admin_role() IN ('super_admin', 'admin'));
