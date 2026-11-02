-- Migration 780: a rider's own saved home location, 2026-11-02 ask —
-- "make this button to only 'ghar'... if not selected it will show
-- choose your home, and if already chosen it will display 'ghar' with
-- a small edit icon." Confirmed before writing this: no per-rider home
-- location existed anywhere — the existing "Go Home" flow only ever
-- asks which city the rider is in right now; it never remembers a
-- specific point. This is a separate, personal pin (a rider's own
-- house, not the village's shared adda), stored directly on
-- portal_users since it's simple profile data, no new table needed.
-- portal_users already has a self-service UPDATE policy (121,
-- unrestricted by column) that covers these three new columns with no
-- RLS change required.

ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS home_lat decimal;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS home_lng decimal;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS home_label varchar;
