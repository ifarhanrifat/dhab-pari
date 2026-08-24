-- Migration 325: let approved mentors (freelancer or professional, migration
-- 323) submit blog posts through the same pipeline donors already use
-- (migration 312), without needing the Darya donation-tier badge — a
-- volunteering doctor or engineer has nothing to do with donation history.
-- The two eligibility paths OR together; everything else about the flow
-- (pending moderation, staff Approve/Reject, no self-publish) is unchanged.
--
-- Also: when a mentor-or-donor-submitted post is actually published, notify
-- every portal user who ticked "I'd like career/freelancing guidance" —
-- this is the concrete feature the registration note (migration 322)
-- promised ("we'll reach out as each part becomes available").

CREATE OR REPLACE FUNCTION trg_donor_blog_submission_defaults() RETURNS trigger AS $$
DECLARE
  v_tier varchar;
  v_mentor_status varchar;
  v_name varchar;
BEGIN
  IF NEW.submitted_by_portal_user_id IS NULL THEN RETURN NEW; END IF;

  v_tier := donor_badge_tier(NEW.submitted_by_portal_user_id);
  SELECT mentor_status INTO v_mentor_status FROM portal_users WHERE id = NEW.submitted_by_portal_user_id;

  IF v_tier NOT IN ('river', 'ocean', 'wellspring') AND v_mentor_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'Submitting a blog post is open to donors who have reached at least the Darya (River) badge, or approved mentors.';
  END IF;
  IF NEW.category <> 'blog' THEN
    RAISE EXCEPTION 'Donor/mentor submissions may only be blog posts.';
  END IF;

  SELECT full_name INTO v_name FROM portal_users WHERE id = NEW.submitted_by_portal_user_id;
  NEW.author := v_name;
  NEW.is_published := false;
  NEW.moderation_status := 'pending';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Fires only on the actual publish transition (false/NULL -> true) of a
-- donor/mentor-submitted post — staff-authored posts have
-- submitted_by_portal_user_id NULL and never hit this at all.
CREATE OR REPLACE FUNCTION trg_notify_mentorship_students_on_publish() RETURNS trigger AS $$
DECLARE
  v_author varchar;
BEGIN
  IF NEW.submitted_by_portal_user_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.is_published IS DISTINCT FROM true THEN RETURN NEW; END IF;
  IF OLD.is_published IS TRUE THEN RETURN NEW; END IF;

  v_author := NEW.author;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT id, 'mentor_blog_published', 'New post: ' || NEW.title,
    COALESCE(v_author, 'A mentor') || ' just published a new post you might find useful.',
    '/news/' || NEW.id
  FROM portal_users WHERE seeking_mentorship = true AND is_active = true;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS notify_mentorship_students_on_publish_trigger ON news_posts;
CREATE TRIGGER notify_mentorship_students_on_publish_trigger AFTER UPDATE ON news_posts
  FOR EACH ROW EXECUTE FUNCTION trg_notify_mentorship_students_on_publish();
