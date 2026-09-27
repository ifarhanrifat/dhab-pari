-- Real ask, 2026-09-27: username and mobile are portal_users' two identity
-- fields — mobile derives the synthetic Supabase Auth login email
-- (see /api/portal/signup's syntheticEmail()), and username is BOTH the
-- other login credential (/api/portal/login looks up by username) AND,
-- via portal_public_name() (migration 336: COALESCE(display_name,
-- username, full_name)), the name shown on every comment, mentor listing
-- and blog byline this person has ever posted unless they've set a
-- display_name override. Letting either change quietly: (a) risks
-- self-lockout the moment someone forgets they changed their own login
-- ID, and (b) for username, retroactively rewrites how they're identified
-- on everything they've already posted.
--
-- mobile was already impossible to edit through the UI (profile page
-- shows it as plain read-only text); username was still a plain editable
-- input. Removed there, and enforced here too — a UI omission alone
-- doesn't stop a direct API call from changing it, and "our system must
-- not allow this" calls for the real guarantee, not just a hidden control.
--
-- Deliberately only blocks an actual CHANGE to an already-set value, not
-- every UPDATE that merely includes the column — the account-claiming
-- path in /api/portal/signup (a walk-in donor's staff-created placeholder
-- row, auth_user_id null, username not yet set) legitimately sets
-- username for the first time when that person later signs up for real;
-- that's a NULL -> value transition, not a change to an existing one, so
-- it's untouched by this guard.
CREATE OR REPLACE FUNCTION prevent_portal_identity_change() RETURNS trigger AS $$
BEGIN
  IF OLD.username IS NOT NULL AND NEW.username IS DISTINCT FROM OLD.username THEN
    RAISE EXCEPTION 'username cannot be changed once set — it is a portal login credential and public identity.';
  END IF;
  IF OLD.mobile IS NOT NULL AND NEW.mobile IS DISTINCT FROM OLD.mobile THEN
    RAISE EXCEPTION 'mobile cannot be changed once set — it is the portal login identity.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_portal_identity_change ON portal_users;
CREATE TRIGGER trg_prevent_portal_identity_change
BEFORE UPDATE ON portal_users
FOR EACH ROW
EXECUTE FUNCTION prevent_portal_identity_change();
