-- Migration 814: real ask, 2026-11-06 — ride-sharing is the core
-- feature of the portal, but bus/Hiace/Coaster/Suzuki Bolan have no
-- first-class vehicle_categories row, so a driver registering one of
-- these today has nothing to pick and falls through to generic "Van".
--
-- Rate basis: cloned from 'van', the nearest existing comparable
-- category's already-committee-set rate card — same discipline 757
-- established, never an invented number. Adda/Routes seat fares are
-- set per-route by the driver anyway (fare_per_seat_pkr), so these
-- numbers only matter for the registration screen's rate-card preview
-- and the (for these vehicle types, effectively unused) point-to-point
-- dispatch commission fallback.
--
-- ride_group = 'shared_ride' is a new tag, not one of the 5 keys
-- ride_group_options() (781) hardcodes for the point-to-point dispatch
-- grid — inert there, used only by the registration-screen grouping
-- added alongside this migration.
INSERT INTO vehicle_categories (tenant_id, key, name, name_ur, emoji, base_fare_pkr, per_km_pkr, intercity_commission_pct, out_of_city_commission_pct, category_group, out_of_city_eligible, ride_group, display_order)
SELECT src.tenant_id, tier.key, tier.name, tier.name_ur, tier.emoji, src.base_fare_pkr, src.per_km_pkr, src.intercity_commission_pct, src.out_of_city_commission_pct, tier.category_group, src.out_of_city_eligible, tier.ride_group,
  (SELECT COALESCE(MAX(vc.display_order), 0) FROM vehicle_categories vc WHERE vc.tenant_id = src.tenant_id) + tier.order_offset
FROM vehicle_categories src
JOIN (VALUES
  ('bus', 'Bus', 'بس', '🚌', 'passenger', 'shared_ride', 1),
  ('coaster', 'Coaster', 'کوسٹر', '🚐', 'passenger', 'shared_ride', 2),
  ('hiace', 'Hiace', 'ہائس', '🚐', 'passenger', 'shared_ride', 3),
  ('suzuki_bolan', 'Suzuki Bolan', 'سوزوکی بولان', '🚐', 'passenger', 'shared_ride', 4)
) AS tier(key, name, name_ur, emoji, category_group, ride_group, order_offset)
ON src.key = 'van' AND src.is_active
ON CONFLICT (tenant_id, key) DO NOTHING;
