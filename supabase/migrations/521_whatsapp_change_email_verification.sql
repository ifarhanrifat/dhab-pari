-- Migration 521: changing the portal WhatsApp number now requires an
-- email code, same shape as the password-reset code (514).
--
-- Real ask, 2026-09-29: mobile is locked (migration 515, it's the login
-- identity), but whatsapp_number -- the number donation notifications,
-- receipts and committee messages actually go to -- was a plain free-text
-- field, saved along with the rest of the profile form with no
-- confirmation at all. Anyone with a moment of access to a signed-in
-- session could silently redirect that traffic to a different number.
-- Gated the same way password reset already proved out: a 6-digit code
-- emailed to whatever address is on file, typed back before the number
-- actually changes. pending_whatsapp_number holds the requested new
-- number until the code is confirmed -- the live whatsapp_number column
-- is never touched until then.
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS whatsapp_change_code varchar;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS whatsapp_change_code_expires_at timestamptz;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS whatsapp_change_requested_at timestamptz;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS pending_whatsapp_number varchar;
