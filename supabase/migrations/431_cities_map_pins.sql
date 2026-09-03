-- Migration 431: lat/lng per city, purely for the Travel hub map display —
-- not used in any fare calculation (that stays tier-based, see 430's own
-- comment on why a live-GPS/routing engine was deliberately rejected).
-- Chakwal is seeded from the real, already committee-set Chakwal Adda pin
-- (addas, migration 409) rather than a second guess at the same place.
-- The other four are well-known public city-center coordinates (not
-- village-specific, not requiring committee sign-off the way an adda's
-- own exact pin does) — approximate is fine here since a map pin only
-- needs to be in roughly the right place, never turn-by-turn accurate.
ALTER TABLE cities ADD COLUMN IF NOT EXISTS lat decimal;
ALTER TABLE cities ADD COLUMN IF NOT EXISTS lng decimal;

UPDATE cities SET lat = a.lat, lng = a.lng
FROM addas a WHERE a.id = '00000000-0000-0000-0000-00000000ad02' AND cities.name = 'Chakwal' AND cities.lat IS NULL;

UPDATE cities SET lat = 33.3667, lng = 73.2333 WHERE name = 'Mandra' AND lat IS NULL;
UPDATE cities SET lat = 32.9256, lng = 72.4181 WHERE name = 'Talagang' AND lat IS NULL;
UPDATE cities SET lat = 33.5651, lng = 73.0169 WHERE name = 'Rawalpindi' AND lat IS NULL;
UPDATE cities SET lat = 33.6844, lng = 73.0479 WHERE name = 'Islamabad' AND lat IS NULL;
