-- Migration 842: two real asks, 2026-11-11.
--
-- 1. "Why do Economy and Compact Car charge the same fare despite
--    different CC bands — raise Compact's fare, same ratio as other
--    categories." Compact (801-1000cc) was sharing Economy's exact
--    tier (838, user's own earlier choice to avoid inventing numbers).
--    Now raising it means it can no longer share tier_key = small_ac/
--    small_non_ac with Economy — a shared tier is ONE row, so editing
--    it would silently drag Economy's price along too. Compact needs
--    its own tier. Every field computed as the geometric half-step
--    between Economy and Family (both real, committee-set numbers) —
--    Compact sits exactly in the middle of that CC ladder (801-1000cc,
--    between Economy's 660-800 and Family's 1001+), so the fair value
--    is the midpoint ratio, not a new invented number:
--      hourly_rate_pkr:            600 -> 670  (Family = 750, step ~1.118x)
--      hourly_overage_per_km_pkr:   15 -> 17   (Family = 19)
--      rental_base_pkr (AC):       250 -> 300  (Family = 350)
--      rental_base_pkr (Non-AC):   200 -> 245  (Family = 300)
--      rental_per_km_pkr (AC):      16 -> 18   (Family = 20)
--      rental_per_km_pkr (Non-AC):  14 -> 16   (Family = 18)
--      rental_wait_hour_pkr (AC):  140 -> 160  (Family = 180)
--      rental_wait_hour_pkr (Non-AC): 120 -> 140 (Family = 160)
--      hourly_out_of_city_base_pkr: 550 -> 620 (Family = 700)
--      hourly_out_of_city_per_km_pkr: 48 -> 53 (Family = 58)
--      base_fare_pkr (P2P in-city):  60 -> 70  (Family = 80)
--      per_km_pkr (P2P in-city):     14 -> 15  (Family = 16)
--      out_of_city_base_fare_pkr (P2P): 500 -> 600 (Family = 700)
--      out_of_city_per_km_pkr (P2P):     45 -> 50  (Family = 58)
--    Shadi stays 5,500 — already the user's explicit "flat across all
--    car bands" choice (838), unaffected by this.
--
-- 2. "The 5,580-9,310 range is confusing, only one number is ever
--    charged." Removed the pre-match range from every rider-facing
--    tile (results/hourly/rental/loading); each tile now shows the
--    exact same single number the booking sheet already shows. The
--    fare_spread_pct column and fareRange() helper are left in place
--    (harmless, unused) rather than ripped out — reversible with no
--    schema risk if a future ask wants a narrower range back.
-- ═════════════════════════════════════════════════════════════════════

-- New tier key everywhere rental_tier is validated. vehicles table:
-- exact constraint name confirmed live from 786's own explicit DDL.
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_rental_tier_check;
ALTER TABLE vehicles ADD CONSTRAINT vehicles_rental_tier_check
  CHECK (rental_tier IN ('small_ac', 'small_non_ac', 'big_ac', 'big_non_ac', 'suv', 'luxury', 'van', 'hiace', 'coaster', 'bus', 'compact_ac', 'compact_non_ac'));

-- rental_tier_fare_guides.tier_key's CHECK was created inline in 786
-- (CREATE TABLE ... tier_key varchar PRIMARY KEY CHECK (...)) so its
-- real name was never asserted anywhere since — found dynamically
-- rather than guessed, to avoid silently leaving the old, narrower
-- check still active under a different name.
DO $$
DECLARE v_conname text;
BEGIN
  SELECT conname INTO v_conname FROM pg_constraint
  WHERE conrelid = 'rental_tier_fare_guides'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%tier_key%';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE rental_tier_fare_guides DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;
ALTER TABLE rental_tier_fare_guides ADD CONSTRAINT rental_tier_fare_guides_tier_key_check
  CHECK (tier_key IN ('small_ac', 'small_non_ac', 'big_ac', 'big_non_ac', 'suv', 'luxury', 'van', 'hiace', 'coaster', 'bus', 'compact_ac', 'compact_non_ac'));

-- Fare-guide rows must exist BEFORE the category update below fires
-- the vehicle_categories_sync_rental_tier trigger (837) — that trigger
-- only UPDATEs an existing row (never INSERTs), so creating the rows
-- first is required, not optional, or the sync would silently no-op.
INSERT INTO rental_tier_fare_guides (
  tenant_id, tier_key, display_order, hourly_rate_pkr, hourly_included_km_per_hour, hourly_overage_per_km_pkr,
  rental_base_pkr, rental_per_km_pkr, rental_wait_hour_pkr, out_of_city_base_pkr, out_of_city_per_km_pkr
)
SELECT DISTINCT tenant_id, 'compact_ac', 11, 670, 10, 17, 300, 18, 160, 620, 53 FROM rental_tier_fare_guides
UNION ALL
SELECT DISTINCT tenant_id, 'compact_non_ac', 12, 670, 10, 17, 245, 16, 140, 620, 53 FROM rental_tier_fare_guides
ON CONFLICT (tenant_id, tier_key) DO NOTHING;

-- Point the two Compact categories at their own tier and give them
-- their real numbers (both the rental/hourly fields the sync trigger
-- mirrors, and the separate P2P in-city + P2P outstation fields that
-- trigger doesn't touch).
UPDATE vehicle_categories
SET rental_tier_key = CASE key WHEN 'compact_car_ac' THEN 'compact_ac' WHEN 'compact_car_non_ac' THEN 'compact_non_ac' END,
    hourly_rate_pkr = 670, hourly_overage_per_km_pkr = 17,
    hourly_out_of_city_base_pkr = 620, hourly_out_of_city_per_km_pkr = 53,
    rental_base_pkr = CASE key WHEN 'compact_car_ac' THEN 300 WHEN 'compact_car_non_ac' THEN 245 END,
    rental_per_km_pkr = CASE key WHEN 'compact_car_ac' THEN 18 WHEN 'compact_car_non_ac' THEN 16 END,
    rental_wait_hour_pkr = CASE key WHEN 'compact_car_ac' THEN 160 WHEN 'compact_car_non_ac' THEN 140 END,
    base_fare_pkr = 70, per_km_pkr = 15,
    out_of_city_base_fare_pkr = 600, out_of_city_per_km_pkr = 50
WHERE key IN ('compact_car_ac', 'compact_car_non_ac') AND is_active;
