-- Migration 757: real ask, 2026-10-28 — the category list should
-- reflect actual Pakistani village transport, not abstract size tiers.
-- Real vehicles in rural Punjab are known by MODEL, not "small car AC"
-- — a Mehran, an Alto, a Corolla, a Ravi are each their own distinct,
-- recognizable option to a villager, priced and trusted differently.
--
-- Purely additive — the existing generic tiers (small_car_ac etc.,
-- 749) are left exactly as they are; nothing here reassigns or
-- deactivates them. Every real vehicle in the live system right now
-- is evidently seed/test data (Bulldozer D6, Excavator, Mobile Crane —
-- none of the model names the user actually asked for exist yet), so
-- there is nothing real to re-backfill; these categories exist for
-- real drivers to register into going forward.
--
-- Rate basis: cloned from the nearest existing comparable category's
-- already-committee-set rate card, same discipline 749 already
-- established — never an invented number. Electric bike from bike,
-- the two loading types from loader, 9-seat Ravi and 7-seat Carry Dabba
-- from van, every named car model from the generic 'car' row (all four
-- exist on every tenant today, confirmed).
INSERT INTO vehicle_categories (tenant_id, key, name, name_ur, emoji, base_fare_pkr, per_km_pkr, intercity_commission_pct, out_of_city_commission_pct, category_group, display_order)
SELECT src.tenant_id, tier.key, tier.name, tier.name_ur, tier.emoji, src.base_fare_pkr, src.per_km_pkr, src.intercity_commission_pct, src.out_of_city_commission_pct, tier.category_group, tier.display_order
FROM vehicle_categories src
JOIN (VALUES
  ('electric_bike', 'Electric Bike', 'الیکٹرک بائیک', '🛵', 'bike', 'passenger', 21),
  ('suzuki_ravi', 'Suzuki Ravi (9-seater)', 'سوزوکی راوی (9 سیٹر)', '🚐', 'van', 'passenger', 22),
  ('suzuki_carry_dabba', 'Suzuki Carry Dabba (7-seater)', 'سوزوکی کیری ڈبہ (7 سیٹر)', '🚐', 'van', 'passenger', 23),
  ('suzuki_mehran_ac', 'Suzuki Mehran — AC', 'سوزوکی مہران — اے سی', '🚗', 'car', 'passenger', 24),
  ('suzuki_mehran_non_ac', 'Suzuki Mehran — Non-AC', 'سوزوکی مہران — بغیر اے سی', '🚙', 'car', 'passenger', 25),
  ('suzuki_alto', 'Suzuki Alto 660cc', 'سوزوکی آلٹو 660cc', '🚗', 'car', 'passenger', 26),
  ('toyota_corolla', 'Toyota Corolla', 'ٹویوٹا کرولا', '🚘', 'car', 'passenger', 27),
  ('rickshaw_loading', 'Loading Rickshaw', 'لوڈنگ رکشہ', '🛺', 'rickshaw', 'equipment', 28),
  ('suzuki_ravi_dala', 'Suzuki Ravi Dala (loading)', 'سوزوکی راوی ڈالہ (لوڈنگ)', '🚚', 'loader', 'equipment', 29)
) AS tier(key, name, name_ur, emoji, source_key, category_group, display_order)
ON src.key = tier.source_key AND src.is_active
ON CONFLICT (tenant_id, key) DO NOTHING;
