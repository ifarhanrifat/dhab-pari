-- Migration 106: Plumber charge, digging charge, and security deposit on a
-- new connection request should default to a fixed committee-set rate rather
-- than starting blank at 0 each time — but the accountant creating/editing a
-- specific request can still raise it for an unusual job. Mirrors the
-- existing defaulter_restore_fee pattern (migration 076) exactly: a plain
-- site_settings row, edited in Settings, read as a default by the form.
-- Seeded at 0 deliberately — real committee-set amounts are entered via
-- Settings, not guessed here.
INSERT INTO site_settings (key, value, description) VALUES
  ('connection_plumber_charge', '0', 'Default plumber charge on a new connection request — the accountant can still raise it per job'),
  ('connection_digging_charge', '0', 'Default digging charge on a new connection request — the accountant can still raise it per job'),
  ('connection_security_deposit', '0', 'Default security deposit on a new connection request — the accountant can still raise it per job')
ON CONFLICT (key) DO NOTHING;
