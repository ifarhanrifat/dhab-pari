-- Records that this account's email was actually verified at signup
-- (mandatory now, see migration 516) — lets the profile page and any
-- future support flow tell a verified email apart from the historical
-- portal_users rows created before this requirement existed.
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
