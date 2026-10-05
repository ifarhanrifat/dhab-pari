-- Admin invite + password reset move to the same typed-in-code pattern
-- already proven on the portal side (see portal_users' equivalent columns,
-- added in migration 514) -- a clickable Supabase magic link gets silently
-- consumed by email security scanners that pre-fetch every link in a new
-- email, burning the one-time token before the real person ever clicks it.
-- A code has nothing for a scanner to consume.
--
-- invite_code/invite_code_expires_at let an admin_users row exist in a
-- genuinely pending state (auth_user_id still null -- no Supabase auth
-- user created at all until the code is verified), which is what finally
-- lets a failed/never-completed invite be cleanly re-sent instead of
-- hitting Supabase's "already registered" refusal.
alter table admin_users
  add column if not exists password_reset_code varchar(6),
  add column if not exists password_reset_code_expires_at timestamptz,
  add column if not exists password_reset_requested_at timestamptz,
  add column if not exists invite_code varchar(6),
  add column if not exists invite_code_expires_at timestamptz;
