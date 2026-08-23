-- Migration 312: Real donor-authored blog content.
--
-- A donor who has reached Darya (River) or above — the same fast-track
-- tier as skip-voting project proposals — can now submit their own blog
-- post from the portal. It lands as an ordinary news_posts row (category
-- 'blog', unpublished, moderation_status 'pending') so it goes through the
-- exact same admin Blog page and publish action staff already use for
-- everything else — no new admin content-editing UI, just a small
-- moderation queue on top of it and an Approve/Reject action.
--
-- The byline is set server-side from the submitter's own portal profile,
-- not typed by them — otherwise a donor-submitted post could credit anyone
-- it wanted regardless of who actually holds the badge next to it.

ALTER TABLE news_posts
  ADD COLUMN IF NOT EXISTS submitted_by_portal_user_id uuid REFERENCES portal_users(id),
  ADD COLUMN IF NOT EXISTS moderation_status varchar CHECK (moderation_status IN ('pending', 'approved', 'rejected'));
-- moderation_status stays NULL for every staff-authored post (the
-- overwhelming majority) — it only ever gets set on a donor submission.

CREATE OR REPLACE FUNCTION trg_donor_blog_submission_defaults() RETURNS trigger AS $$
DECLARE
  v_tier varchar;
  v_name varchar;
BEGIN
  IF NEW.submitted_by_portal_user_id IS NULL THEN RETURN NEW; END IF;

  v_tier := donor_badge_tier(NEW.submitted_by_portal_user_id);
  IF v_tier NOT IN ('river', 'ocean', 'wellspring') THEN
    RAISE EXCEPTION 'Submitting a blog post is open to donors who have reached at least the Darya (River) badge.';
  END IF;
  IF NEW.category <> 'blog' THEN
    RAISE EXCEPTION 'Donor submissions may only be blog posts.';
  END IF;

  SELECT full_name INTO v_name FROM portal_users WHERE id = NEW.submitted_by_portal_user_id;
  NEW.author := v_name;
  NEW.is_published := false;
  NEW.moderation_status := 'pending';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS donor_blog_submission_defaults_trigger ON news_posts;
CREATE TRIGGER donor_blog_submission_defaults_trigger BEFORE INSERT ON news_posts
  FOR EACH ROW EXECUTE FUNCTION trg_donor_blog_submission_defaults();

-- A donor may submit; staff (via the existing news_posts_publish policy)
-- moderate and publish exactly as they would any other blog post. This
-- policy only covers the initial INSERT — the trigger above then forces
-- the row into the correct pending/unpublished shape regardless of what
-- was sent, so there is no path to a self-published donor post.
CREATE POLICY "news_posts_donor_submit" ON news_posts FOR INSERT TO authenticated
  WITH CHECK (
    category = 'blog'
    AND submitted_by_portal_user_id = current_portal_user_id()
  );

-- Public read stays is_published = true only (migration 002) — a donor
-- needs to see their own pending/rejected submission too, which that
-- policy alone would hide from them.
CREATE POLICY "news_posts_donor_read_own" ON news_posts FOR SELECT TO authenticated
  USING (submitted_by_portal_user_id = current_portal_user_id());
