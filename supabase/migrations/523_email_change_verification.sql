-- Migration 523: changing the portal email itself now requires a code too,
-- same shape as the WhatsApp number change (521).
--
-- Real ask, 2026-09-29: email just became compulsory (522) and is the
-- account's trusted identity anchor (where the WhatsApp-change code
-- itself gets sent, among other things) -- it was still a plain free-text
-- field saved with the rest of the profile form, no confirmation at all.
-- Unlike the WhatsApp flow (code sent to the already-trusted current
-- email, to prove the account owner requested the change), changing the
-- anchor itself has to prove control of the NEW address instead -- so the
-- code goes to pending_email, not the current one. The live email column
-- is never touched until that code is confirmed.
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS email_change_code varchar;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS email_change_code_expires_at timestamptz;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS email_change_requested_at timestamptz;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS pending_email varchar;
