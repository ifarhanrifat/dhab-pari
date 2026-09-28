-- Real ask, 2026-09-28: portal signup collected an email (already
-- required) but never verified it -- make verification mandatory before
-- an account is created at all. Deliberately does NOT persist the
-- signup form (name/password/etc.) server-side while waiting on the
-- code — only the email + code + expiry. The browser holds the rest of
-- the form in memory across the two-step wizard and resends it with the
-- code on confirm; this table only ever proves "this email received and
-- typed back this code", it's never a place a raw password could leak
-- from even briefly.
CREATE TABLE IF NOT EXISTS portal_signup_verifications (
  email varchar PRIMARY KEY,
  code varchar NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
