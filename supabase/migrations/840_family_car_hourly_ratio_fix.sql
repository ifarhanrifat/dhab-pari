-- Migration 840: real ask, 2026-11-11 — "make family car fare equal
-- (same ratio) with other categories".
--
-- Measured every tier's real step ratio from the tier below it
-- (Economy→Family, Family→SUV) across all 7 rate fields. Every field
-- steps up ~1.2x-1.4x except Family Car's two hourly fields, which sit
-- at exactly 1.20x while this same category's own rental/outstation
-- fields already sit at 1.25x-1.40x. Bringing just those two fields up
-- to the ~1.25x ratio this category's own per_km field already uses —
-- not a new invented number, the same ratio already present everywhere
-- else in this ladder:
--   hourly_rate_pkr:         600 * 1.25 = 750  (was 720, i.e. 1.20x)
--   hourly_overage_per_km_pkr: 15 * 1.25 = 18.75 → 19 (was 18, i.e. 1.20x)
-- Applies to both big_car_ac and big_car_non_ac — this pair's hourly
-- fields have always been AC-independent (600/600, 720/720 today),
-- matching every other tier's pattern. The vehicle_categories_sync_
-- rental_tier trigger (837) carries this straight into
-- rental_tier_fare_guides for tier_key = big_ac / big_non_ac.
UPDATE vehicle_categories
SET hourly_rate_pkr = 750,
    hourly_overage_per_km_pkr = 19
WHERE key IN ('big_car_ac', 'big_car_non_ac') AND is_active;
