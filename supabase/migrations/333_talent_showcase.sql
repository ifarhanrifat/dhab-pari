-- Migration 333: Phase B — Talent Showcase. Public cards describing a
-- talented villager, what they need, what they want to become, with
-- photos/videos. Locked-in safeguarding baseline from earlier this session
-- (admin review + guardian contact on file for minors) is enforced here,
-- not just documented: a self-submission from a portal_user flagged
-- is_minor cannot be inserted at all unless guardian_name/guardian_mobile
-- are already on that profile (migration 322) — this closes the exact gap
-- flagged after live testing, where a minor's own "I'm under 18" checkbox
-- was collected but never actually required anywhere downstream.
--
-- Staff may also create an entry directly (no portal account needed — a
-- staff member met someone and wants to feature them); guardian_consent_
-- confirmed_by_admin is the equivalent manual safeguard for that path,
-- since there's no profile to check against.
CREATE TABLE IF NOT EXISTS talent_showcases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id uuid REFERENCES portal_users(id) ON DELETE SET NULL,
  submitted_by_admin_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  display_name varchar NOT NULL,
  talent_description text NOT NULL,
  needs text,
  aspiration text,
  photo_url text,
  video_url text,
  guardian_consent_confirmed_by_admin boolean NOT NULL DEFAULT false,
  moderation_status varchar NOT NULL DEFAULT 'pending'
    CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
  is_published boolean NOT NULL DEFAULT false,
  reviewed_by uuid REFERENCES admin_users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT talent_showcases_author_check CHECK (
    (portal_user_id IS NOT NULL AND submitted_by_admin_id IS NULL)
    OR (portal_user_id IS NULL AND submitted_by_admin_id IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION trg_talent_showcase_guardian_guard() RETURNS trigger AS $$
DECLARE
  v_is_minor boolean;
  v_guardian_name varchar;
  v_guardian_mobile varchar;
BEGIN
  IF NEW.portal_user_id IS NOT NULL THEN
    SELECT is_minor, guardian_name, guardian_mobile INTO v_is_minor, v_guardian_name, v_guardian_mobile
      FROM portal_users WHERE id = NEW.portal_user_id;
    IF v_is_minor AND (v_guardian_name IS NULL OR v_guardian_mobile IS NULL) THEN
      RAISE EXCEPTION 'A parent/guardian name and mobile number must be on file before submitting a talent showcase entry for someone under 18. Add this on your profile page first.';
    END IF;
  ELSIF NEW.submitted_by_admin_id IS NOT NULL AND NOT NEW.guardian_consent_confirmed_by_admin THEN
    RAISE EXCEPTION 'Confirm guardian consent has been obtained before submitting an entry on someone else''s behalf.';
  END IF;
  -- Always lands unpublished/pending regardless of what was sent — same
  -- "the trigger, not the client, decides the row's real status" pattern
  -- as donor blog submissions (migration 312).
  NEW.is_published := false;
  NEW.moderation_status := 'pending';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS talent_showcase_guardian_guard_trigger ON talent_showcases;
CREATE TRIGGER talent_showcase_guardian_guard_trigger BEFORE INSERT ON talent_showcases
  FOR EACH ROW EXECUTE FUNCTION trg_talent_showcase_guardian_guard();

ALTER TABLE talent_showcases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "talent_showcases_public_read" ON talent_showcases FOR SELECT
  USING (is_published = true);
CREATE POLICY "talent_showcases_own_read" ON talent_showcases FOR SELECT TO authenticated
  USING (portal_user_id = current_portal_user_id());
CREATE POLICY "talent_showcases_admin_all" ON talent_showcases FOR ALL TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin'))
  WITH CHECK (current_admin_role() IN ('super_admin', 'admin'));

CREATE POLICY "talent_showcases_portal_insert" ON talent_showcases FOR INSERT TO authenticated
  WITH CHECK (portal_user_id = current_portal_user_id());
CREATE POLICY "talent_showcases_portal_delete_own" ON talent_showcases FOR DELETE TO authenticated
  USING (portal_user_id = current_portal_user_id() AND moderation_status = 'pending');
