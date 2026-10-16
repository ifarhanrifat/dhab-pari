-- Migration 695: the real, complete root cause of "videos sometimes
-- don't show" -- confirmed on a real connected device via Chrome
-- remote debugging (adb + CDP), replaying the actual JWT the device
-- held, with RLS genuinely enforced (SET ROLE authenticated, not just
-- request.jwt.claims -- that alone runs as a role that bypasses RLS
-- entirely and silently returns every row regardless of policy,
-- which is why earlier checks this session looked fine).
--
-- public_read_published_videos was scoped to the `anon` role ONLY.
-- video_content's other policy (video_content_publish) is scoped to
-- `authenticated` but requires admin publish permission. Net effect:
-- a logged-out visitor could always see published videos; literally
-- any logged-in user at all -- any portal user, any admin without
-- video-publish rights -- has never been able to see a single one,
-- the whole time this policy has existed. Not intermittent, not
-- device-specific: logged out shows them, logged in hides them,
-- deterministically, every time. Adding `authenticated` to this
-- policy's roles is the actual fix -- a published video should be
-- public regardless of whether the viewer happens to be signed in.

DROP POLICY IF EXISTS public_read_published_videos ON video_content;
CREATE POLICY public_read_published_videos ON video_content
  FOR SELECT
  TO anon, authenticated
  USING (
    tenant_id = COALESCE(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
    AND is_published = true
  );
