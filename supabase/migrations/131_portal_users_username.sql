-- Migration 131: username-based login. Mobile stays the underlying identity
-- key for dedup/consumer-donor matching (unchanged everywhere), but login
-- and any future public display (chat/voting/badges) should never expose a
-- phone number — a username is a safer, intentional public identity.
-- Case-insensitive uniqueness via a functional index (two usernames differing
-- only by case would otherwise both "look" unique but collide at login).
ALTER TABLE portal_users
  ADD COLUMN IF NOT EXISTS username varchar,
  ADD COLUMN IF NOT EXISTS email varchar;

-- Backfill: existing registered users (e.g. already-live donors) would be
-- locked out the moment login switches to username-only. Derive one from
-- their name, padded/truncated to the 6-char minimum and de-duplicated with
-- a numeric suffix, so nobody loses access.
DO $$
DECLARE
  r RECORD;
  v_base varchar;
  v_candidate varchar;
  v_suffix int;
BEGIN
  FOR r IN SELECT id, full_name, mobile FROM portal_users WHERE username IS NULL LOOP
    v_base := lower(regexp_replace(r.full_name, '[^a-zA-Z0-9]', '', 'g'));
    IF length(v_base) < 6 THEN
      v_base := v_base || right(regexp_replace(r.mobile, '[^0-9]', '', 'g'), 6 - length(v_base));
    END IF;
    v_base := left(v_base, 20);
    v_candidate := v_base;
    v_suffix := 1;
    WHILE EXISTS (SELECT 1 FROM portal_users WHERE lower(username) = v_candidate) LOOP
      v_suffix := v_suffix + 1;
      v_candidate := left(v_base, 17) || v_suffix::text;
    END LOOP;
    UPDATE portal_users SET username = v_candidate WHERE id = r.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS portal_users_username_lower_key ON portal_users (lower(username));
