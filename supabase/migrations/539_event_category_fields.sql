-- Migration 539: category-specific fields on village_events -- real ask,
-- 2026-09-30, "make the event calendar submission form according to the
-- selected category... you know the punjab culture". Same shape as the
-- classifieds category fields (534): nullable columns on the single
-- table, shown/required conditionally in the form per category rather
-- than splitting into per-category tables.
--
-- wedding_function separates the actually-distinct, separately-dated
-- functions a Punjabi wedding is made of (Mehndi/Nikkah/Baraat/Valima)
-- -- organizers post one village_events row per function rather than one
-- row trying to cover a multi-day, multi-venue event. venue_men/
-- venue_women covers the very standard separate mardana/zanana seating
-- (also reused for condolence gatherings, which have the same split).
ALTER TABLE village_events
  ADD COLUMN groom_name varchar,
  ADD COLUMN bride_name varchar,
  ADD COLUMN wedding_function varchar CHECK (wedding_function IN ('mehndi', 'nikkah', 'baraat', 'valima', 'other')),
  ADD COLUMN venue_men varchar,
  ADD COLUMN venue_women varchar,
  ADD COLUMN deceased_name varchar,
  ADD COLUMN gathering_type varchar CHECK (gathering_type IN ('soyem', 'chehlum', 'qul', 'other')),
  ADD COLUMN speaker_name varchar,
  ADD COLUMN tournament_name varchar,
  ADD COLUMN entry_fee numeric(10,2),
  ADD COLUMN registration_contact varchar,
  ADD COLUMN agenda text;
