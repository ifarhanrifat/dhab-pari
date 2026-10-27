-- Real bug found live, 2026-10-28: investigating "why aren't there
-- more car categories (luxury, AC/non-AC, small/big)" surfaced a much
-- bigger problem underneath it — EVERY vehicle in the live system has
-- category_id = NULL, including real, already-approved ones, not just
-- test data. category_id (707) only ever gets set through the
-- registration flow's own category picker; every vehicle approved
-- before that existed (which is all of them) never got one. This
-- silently breaks the brand-new category-wise ride dispatch (746-748)
-- for every single real vehicle — it was never going to show a single
-- online driver for any category, for anyone, until this is fixed.
--
-- Two things, together:
-- 1. Real car tiers (small/big × AC/non-AC, SUV, Luxury) — splitting
--    the one generic "Car" row the same category-rate-card way 707
--    already works, not a parallel system. Seeded from the existing
--    'car' row's own already-committee-set rate/commission per tenant
--    (707's own comment: that 2%/2% was a real inherited rate, not
--    invented) so no live vehicle's commission silently changes —
--    committee can differentiate them further via the existing
--    admin vehicle-categories screen (marketplace-reference) exactly
--    like every other category.
-- 2. Backfilling every existing vehicle's category_id from its own
--    free-text vehicle_type (same keyword-matching approach
--    shadiClassMatchesVehicleType already established on the frontend)
--    — cars get split by their own already-locked has_ac (740) into
--    the new small-car-AC/non-AC tiers (a reasonable default; "small"
--    since there's no reliable existing size signal — committee can
--    reclassify specific ones to SUV/Luxury/Big Car by hand).

INSERT INTO vehicle_categories (tenant_id, key, name, name_ur, emoji, base_fare_pkr, per_km_pkr, intercity_commission_pct, out_of_city_commission_pct, display_order)
SELECT car.tenant_id, tier.key, tier.name, tier.name_ur, tier.emoji, car.base_fare_pkr, car.per_km_pkr, car.intercity_commission_pct, car.out_of_city_commission_pct, tier.display_order
FROM vehicle_categories car
CROSS JOIN (VALUES
  ('small_car_ac', 'Small Car — AC', 'چھوٹی گاڑی — اے سی', '🚗', 11),
  ('small_car_non_ac', 'Small Car — Non-AC', 'چھوٹی گاڑی — بغیر اے سی', '🚙', 12),
  ('big_car_ac', 'Big Car — AC', 'بڑی گاڑی — اے سی', '🚘', 13),
  ('big_car_non_ac', 'Big Car — Non-AC', 'بڑی گاڑی — بغیر اے سی', '🚖', 14),
  ('suv', 'SUV', 'ایس یو وی', '🚙', 15),
  ('luxury', 'Luxury', 'لگژری', '🏎️', 16)
) AS tier(key, name, name_ur, emoji, display_order)
WHERE car.key = 'car'
ON CONFLICT (tenant_id, key) DO NOTHING;

-- Backfill: match free-text vehicle_type to the right category key,
-- same keyword precedence the frontend's own shadi-class matcher uses
-- (specific vehicle names before generic fallbacks).
UPDATE vehicles v SET category_id = (
  SELECT c.id FROM vehicle_categories c
  WHERE c.tenant_id = COALESCE((SELECT tenant_id FROM portal_users WHERE id = v.portal_user_id), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
    AND c.key = (
      CASE
        WHEN v.vehicle_type ILIKE '%bulldozer%' OR v.vehicle_type ILIKE '%excavator%' OR v.vehicle_type ILIKE '%crane%'
          OR v.vehicle_type ILIKE '%forklift%' OR v.vehicle_type ILIKE '%concrete mixer%' OR v.vehicle_type ILIKE '%boring rig%' THEN 'machinery'
        WHEN v.vehicle_type ILIKE '%tractor%' THEN 'tractor'
        WHEN v.vehicle_type ILIKE '%loader%' OR v.vehicle_type ILIKE '%pickup%' OR v.vehicle_type ILIKE '%truck%' THEN 'loader'
        WHEN v.vehicle_type ILIKE '%rickshaw%' THEN 'rickshaw'
        WHEN v.vehicle_type ILIKE '%hiace%' OR v.vehicle_type ILIKE '%bolan%' OR v.vehicle_type ILIKE '%van%' THEN 'van'
        WHEN v.vehicle_type ILIKE '%bike%' OR v.vehicle_type ILIKE '%motorcycle%' OR v.vehicle_type ILIKE '%موٹر بائیک%' THEN 'bike'
        ELSE CASE WHEN v.has_ac THEN 'small_car_ac' ELSE 'small_car_non_ac' END
      END
    )
  LIMIT 1
)
WHERE v.category_id IS NULL;
