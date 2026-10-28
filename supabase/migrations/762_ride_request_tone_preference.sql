-- Migration 762: real ask, 2026-10-28 — "add the special tones for
-- the drivers which receive the call request for a ride which it can
-- set through the setting." Android channel sound can only ever be
-- set once at creation (the OS protects it from being silently
-- changed later), so "choosing a tone" means choosing WHICH of three
-- pre-created channels a driver's pushes get routed to, not changing
-- one channel's sound live. This column is that choice.
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS ride_request_tone varchar NOT NULL DEFAULT 'announce'
  CHECK (ride_request_tone IN ('announce', 'interface', 'wave'));
