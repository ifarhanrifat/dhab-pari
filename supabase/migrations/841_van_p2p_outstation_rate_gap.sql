-- Migration 841: real bug report, 2026-11-11 — "family van outstation
-- fare is only 1170-2956, way below economy/compact/family car/suv."
--
-- Root cause confirmed live: out_of_city_base_fare_pkr /
-- out_of_city_per_km_pkr (791, the dedicated P2P outstation rate card)
-- were only ever set for bike/rickshaw/small_car/big_car/suv — 'van'
-- didn't exist as a rider-facing point-to-point tile until 835, two
-- weeks after 791, so it never got one. ride_group_quote() (791) falls
-- back to the in-city base_fare_pkr/per_km_pkr (50/15) via COALESCE
-- when these are NULL, which is why an outstation Family Van booking
-- was silently priced like an in-city one.
--
-- Fix: carry forward van's OWN already committee-set outstation
-- number — hourly_out_of_city_base_pkr / hourly_out_of_city_per_km_pkr
-- (837, from the real rental_tier_fare_guides 'van' tier: 700 / 58) —
-- onto the P2P outstation fields too. Never invented: this is the same
-- real figure already live elsewhere for this exact category, and it
-- happens to equal Family Car's own P2P outstation rate (700/58),
-- which is a reasonable anchor since van-class vehicles are priced
-- comparably to big cars throughout this system already (837).
UPDATE vehicle_categories
SET out_of_city_base_fare_pkr = hourly_out_of_city_base_pkr,
    out_of_city_per_km_pkr = hourly_out_of_city_per_km_pkr
WHERE key = 'van' AND is_active
  AND out_of_city_base_fare_pkr IS NULL AND hourly_out_of_city_base_pkr IS NOT NULL;
