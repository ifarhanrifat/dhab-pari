-- Migration 534: category-specific detail fields for Buy & Sell -- real
-- report, 2026-09-30: a "کیا بیچ رہے ہیں" free-text title was fine for
-- nothing in particular, but a real cattle sale needs weight and age
-- (teeth-stage, the actual way animals are aged at a village mandi -- do
-- dandi / chaugga / chhakka / full mouth), a phone sale needs brand/model/
-- condition, a vehicle needs year/mileage, and a plot needs its size in
-- marla/kanal (the units land is actually bought and sold in here, not
-- acres). All nullable on the one table (matches this table's own
-- existing shape) -- only the fields relevant to the chosen category are
-- shown/filled in on the form, the rest stay null.
ALTER TABLE classified_listings
  ADD COLUMN animal_type varchar CHECK (animal_type IN ('cow', 'buffalo', 'goat', 'sheep', 'hen', 'other')),
  ADD COLUMN animal_age_stage varchar CHECK (animal_age_stage IN ('young', 'do_dandi', 'chaugga', 'chhakka', 'full_mouth', 'other')),
  ADD COLUMN animal_weight_kg numeric,
  ADD COLUMN brand varchar,
  ADD COLUMN model varchar,
  ADD COLUMN item_condition varchar CHECK (item_condition IN ('new', 'used')),
  ADD COLUMN specifications text,
  ADD COLUMN vehicle_year int,
  ADD COLUMN vehicle_mileage_km numeric,
  ADD COLUMN land_size numeric,
  ADD COLUMN land_size_unit varchar CHECK (land_size_unit IN ('marla', 'kanal', 'acre'));
