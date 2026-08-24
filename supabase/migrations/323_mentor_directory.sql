-- Migration 323: Phase C — the mentor/professional directory. A portal_user
-- (already a donor and/or student under migration 322) can additionally ask
-- to become a mentor. Admin approves each one before they're ever listed or
-- chattable — per direction, this is the one approval gate that stays
-- (the per-conversation accept step was deliberately dropped, not this one).
--
-- mentor_type distinguishes the two populations asked for: a village
-- freelancer already earning (chat only) vs a professional/doctor/engineer/
-- PhD (chat + blog-writing rights, migration 325 wires that up).

ALTER TABLE portal_users
  ADD COLUMN IF NOT EXISTS mentor_type varchar CHECK (mentor_type IN ('freelancer', 'professional')),
  ADD COLUMN IF NOT EXISTS mentor_status varchar NOT NULL DEFAULT 'none'
    CHECK (mentor_status IN ('none', 'pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS mentor_bio text,
  ADD COLUMN IF NOT EXISTS mentor_expertise varchar,
  ADD COLUMN IF NOT EXISTS mentor_available boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mentor_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS mentor_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS mentor_reviewed_by uuid REFERENCES admin_users(id);

-- Self-service request — any portal user, no prerequisite badge/tier (unlike
-- donor blog submission's Darya threshold; being a good mentor has nothing
-- to do with donation history).
CREATE OR REPLACE FUNCTION request_mentor_status(p_mentor_type varchar, p_bio text, p_expertise varchar) RETURNS void AS $$
DECLARE
  v_portal_user_id uuid;
BEGIN
  v_portal_user_id := current_portal_user_id();
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_mentor_type NOT IN ('freelancer', 'professional') THEN
    RAISE EXCEPTION 'Invalid mentor type';
  END IF;

  UPDATE portal_users SET
    mentor_type = p_mentor_type, mentor_bio = p_bio, mentor_expertise = p_expertise,
    mentor_status = 'pending', mentor_requested_at = now(),
    mentor_reviewed_at = NULL, mentor_reviewed_by = NULL
  WHERE id = v_portal_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION request_mentor_status(varchar, text, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_mentor_status(varchar, text, varchar) TO authenticated;

-- Admin review — the one approval gate that stays. Notifies the applicant
-- either way so they're not left wondering.
CREATE OR REPLACE FUNCTION review_mentor_request(p_portal_user_id uuid, p_approve boolean) RETURNS void AS $$
DECLARE
  v_admin_id uuid;
BEGIN
  v_admin_id := current_admin_user_id();
  IF current_admin_role() NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Only an Admin or Super Admin can review a mentor request';
  END IF;

  UPDATE portal_users SET
    mentor_status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
    mentor_reviewed_at = now(), mentor_reviewed_by = v_admin_id
  WHERE id = p_portal_user_id AND mentor_status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No pending mentor request for this user';
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT p_portal_user_id, 'mentor_review',
    CASE WHEN p_approve THEN 'You''re approved as a mentor!' ELSE 'Your mentor request wasn''t approved' END,
    CASE WHEN p_approve THEN 'You can now be found in the mentor directory and students can start a chat with you.'
         ELSE 'If you think this was a mistake, message us on WhatsApp.' END,
    '/portal/mentor';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION review_mentor_request(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION review_mentor_request(uuid, boolean) TO authenticated;

-- Directory view — what a student browses. Never exposes mobile/whatsapp
-- (chat is the only channel, by design) even though the underlying table
-- is already admin-only readable; this is the shape the portal actually
-- queries, so there's no raw portal_users SELECT for a student to reach for
-- in the first place.
CREATE OR REPLACE VIEW mentor_directory AS
SELECT id, full_name, avatar_url, mentor_type, mentor_bio, mentor_expertise, mentor_available
FROM portal_users
WHERE mentor_status = 'approved' AND is_active = true;

GRANT SELECT ON mentor_directory TO authenticated;
