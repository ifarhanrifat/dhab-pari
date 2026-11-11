-- Migration 839: real bug caught by the user, 2026-11-11 — "why is
-- family car fare too low, these are also 800-1000cc vehicles?"
--
-- Root cause confirmed live: big_car_ac/big_car_non_ac ("Family Car",
-- min_cc=1001) listed "Cultus AGS" in example_models_hint alongside
-- Corolla/City/Civic. The Suzuki Cultus is a 1000cc car across every
-- trim (VXL/VXR/AGS — "AGS" is just the auto-gear-shift transmission
-- option, not a bigger engine), so it belongs in Compact Car
-- (801-1000cc), not Family Car (1001cc+) — it was already correctly
-- hinted there via "Cultus VXR". This was a pure labeling mistake, not
-- a functional bug: resolve_vehicle_category() buckets by the driver's
-- declared engine_cc, never by this hint text, so no vehicle was ever
-- mis-registered by it. But it explains the user's read: seeing a
-- known-cheap small car bundled into "Family Car" made that tier's
-- fare look too low for what it's supposed to represent.
UPDATE vehicle_categories
SET example_models_hint = 'Corolla, City, Civic',
    example_models_hint_ur = 'کرولا، سٹی، سوِک'
WHERE key IN ('big_car_ac', 'big_car_non_ac') AND is_active;
