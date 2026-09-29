-- Migration 522: email is now compulsory for every real portal account.
--
-- Real ask, 2026-09-29: admin_users.email was already NOT NULL since the
-- very first schema (006) -- staff log in with it directly, there was
-- never a gap there. portal_users.email stayed nullable, and while signup
-- has required + verified it since migration 516, an account created
-- before that (or the profile page, which showed it as "Email (optional)"
-- and let it be cleared) could still end up with none.
--
-- Not a plain NOT NULL: admin_create_donor_account() (migration 239)
-- deliberately creates a placeholder portal_users row for a walk-in donor
-- who hasn't signed up yet -- auth_user_id IS NULL, no email, nothing to
-- verify it against, and it isn't a real login until/unless that person
-- later signs up and claims it (portalSignup.ts's own claiming path,
-- which already sets and validates email at that moment). A blanket NOT
-- NULL would break that real, actively-used feature outright. The
-- constraint instead only requires an email once a row is an actual,
-- logged-in account -- exactly the population "portal users" means here.
ALTER TABLE portal_users ADD CONSTRAINT portal_users_email_required_when_active
  CHECK (auth_user_id IS NULL OR (email IS NOT NULL AND btrim(email) <> ''));
