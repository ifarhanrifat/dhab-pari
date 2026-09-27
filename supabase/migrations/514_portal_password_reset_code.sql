-- Real ask, 2026-09-27: the link-based portal password reset kept failing
-- in practice -- confirmed multiple ways: an already-verified-valid token
-- reading "expired" when the real user finally clicked it, consistent
-- with either an email security scanner pre-fetching the one-time link
-- before the human ever saw it, or the user (reasonably) opening an older
-- email out of several requests, each of which invalidates the last.
-- Replacing the clickable magic-link with a plain numeric code the user
-- types in removes both failure modes at once: nothing for a scanner to
-- silently consume, and a stale code just fails with an ordinary "wrong
-- or expired code, request a new one" instead of a confusing dead link.
-- Also fully sidesteps the redirect_to/hash-session-detection class of
-- bug chased over the last several fixes -- the whole exchange now
-- happens over a plain server API call, no Supabase magic-link machinery
-- involved at all.
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS password_reset_code varchar;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS password_reset_code_expires_at timestamptz;
