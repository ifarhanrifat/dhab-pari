-- Migration 761: real ask, 2026-10-28 — "we need to have travel,
-- loading and machinery separately... will not have machinery on it
-- when we are calling a loading vehicle." category_group (756) was
-- only a 2-way split (passenger/equipment), so the ride_dispatch_
-- category_options fallback for a loading rickshaw offered heavy
-- machinery as an alternative — a completely different kind of job.
-- Splitting 'equipment' into 'loading' (small point-to-point goods
-- vehicles: loader, loading rickshaw, Ravi Dala) and 'machinery'
-- (tractor, heavy machinery) fixes the fallback-list scoping for free
-- — ride_dispatch_category_options already does an exact
-- category_group match, no logic change needed there, just a more
-- correct taxonomy.
ALTER TABLE vehicle_categories DROP CONSTRAINT IF EXISTS vehicle_categories_category_group_check;
UPDATE vehicle_categories SET category_group = 'loading' WHERE key IN ('loader', 'rickshaw_loading', 'suzuki_ravi_dala');
UPDATE vehicle_categories SET category_group = 'machinery' WHERE key IN ('tractor', 'machinery');
ALTER TABLE vehicle_categories ADD CONSTRAINT vehicle_categories_category_group_check CHECK (category_group IN ('passenger', 'loading', 'machinery'));
