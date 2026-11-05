-- Migration 809: real ask, 2026-11-05 — "these hourly rates are not
-- equivalent to what the point-to-point/travel vehicles are charging."
-- Checked the real numbers: a 10km Travel trip (small_car: base 60 +
-- 14/km) is Rs 200, so Hourly's Rs 300/hr for the same 10km (its own
-- included-km-per-hour allowance) was never literally cheaper per
-- trip. The real problem is opportunity cost: a Travel driver is free
-- to take another fare the moment they drop off; an Hourly driver is
-- locked to one customer for the whole hour whether 10 minutes or 60
-- are actually driven. Per the committee's own estimate — about 3
-- realistic short Travel fares could be chained in an hour without the
-- Hourly lock-in — the real in-city hourly rate should be roughly
-- 3x what a single matching-distance Travel trip earns, not whatever
-- the original placeholder number happened to be.
--
-- Scope: only tiers with a genuine Travel/point-to-point equivalent to
-- benchmark against (small car, big car, suv — van/hiace/coaster/bus
-- aren't offered as Travel point-to-point vehicles at all, so there's
-- no comparable number to derive a target from; left untouched rather
-- than guessed).
--
-- This only changes the IN-CITY hourly_rate_pkr. The outstation
-- scaling (807/808) reads this same column and multiplies it by
-- Rental's own base-fee ratio at booking time, so it carries forward
-- automatically — no separate outstation update needed here.

UPDATE rental_tier_fare_guides SET hourly_rate_pkr = 600 WHERE tier_key IN ('small_ac', 'small_non_ac');
UPDATE rental_tier_fare_guides SET hourly_rate_pkr = 720 WHERE tier_key IN ('big_ac', 'big_non_ac', 'luxury');
UPDATE rental_tier_fare_guides SET hourly_rate_pkr = 900 WHERE tier_key = 'suv';
