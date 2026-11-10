-- Migration 835: real ask, 2026-11-10 — "there are still many vehicals
-- in the card list of marketplace reference, like suzuki carry dabba,
-- suzuki bolan etc... but currently when i book a point to point ride
-- that rate card is not displaying these vehicals, investigate why."
--
-- Root cause, confirmed by reading ride_group_options() (833:343): that
-- function hardcodes exactly 6 fixed tiles (small_car/compact_car/car/
-- suv/bike/rickshaw). 'van', 'suzuki_carry_dabba' and 'suzuki_ravi' have
-- ride_group = NULL — they never matched any of those 6, so they show in
-- Marketplace Reference (admin) but nowhere rider-facing at all, not even
-- Route/Sharing. Confirmed 8 live active vehicles already registered as
-- 'van' alone, invisible to riders through no fault of the driver.
--
-- Suzuki Bolan/Hiace/Coaster/Bus (814) are untouched here — their
-- ride_group = 'shared_ride' is a deliberate, documented choice (814's
-- own comment: "inert" for point-to-point on purpose, Route/Sharing only,
-- fare set per-seat by the driver). Not the bug being fixed.
--
-- Fix: give van/carry_dabba/ravi their own ride_group so they get a 7th
-- point-to-point tile, "Family Van" — per the user's own description of
-- them ("used to have many seats as compare to the cars... good for
-- family booking"). Rate cards (50/15/km, all 3 identical already) are
-- untouched — same discipline as every prior migration, never invented.

UPDATE vehicle_categories
SET ride_group = 'family_van',
    example_models_hint = COALESCE(example_models_hint, 'Van, Suzuki Carry Dabba, Suzuki Ravi'),
    example_models_hint_ur = COALESCE(example_models_hint_ur, 'وین، سوزوکی کیری ڈبہ، سوزوکی راوی')
WHERE key IN ('van', 'suzuki_carry_dabba', 'suzuki_ravi') AND is_active;

CREATE OR REPLACE FUNCTION ride_group_options() RETURNS jsonb AS $$
  SELECT jsonb_agg(g.row ORDER BY g.sort) FROM (
    SELECT 1 AS sort, jsonb_build_object('ride_group', 'small_car', 'emoji', '🚗', 'filter_dimension', 'ac',
      'filter_options', jsonb_build_array(jsonb_build_object('value', 'ac', 'emoji', '❄️'), jsonb_build_object('value', 'non_ac', 'emoji', '☀️'))) AS row
    UNION ALL
    SELECT 2, jsonb_build_object('ride_group', 'compact_car', 'emoji', '🚗', 'filter_dimension', 'ac',
      'filter_options', jsonb_build_array(jsonb_build_object('value', 'ac', 'emoji', '❄️'), jsonb_build_object('value', 'non_ac', 'emoji', '☀️')))
    UNION ALL
    SELECT 3, jsonb_build_object('ride_group', 'car', 'emoji', '🚘', 'filter_dimension', null, 'filter_options', '[]'::jsonb)
    UNION ALL
    SELECT 4, jsonb_build_object('ride_group', 'suv', 'emoji', '🚙', 'filter_dimension', null, 'filter_options', '[]'::jsonb)
    UNION ALL
    SELECT 5, jsonb_build_object('ride_group', 'family_van', 'emoji', '🚐', 'filter_dimension', null, 'filter_options', '[]'::jsonb)
    UNION ALL
    SELECT 6, jsonb_build_object('ride_group', 'bike', 'emoji', '🛵', 'filter_dimension', 'electric',
      'filter_options', jsonb_build_array(jsonb_build_object('value', 'regular', 'emoji', '🛵'), jsonb_build_object('value', 'electric', 'emoji', '🔋')))
    UNION ALL
    SELECT 7, jsonb_build_object('ride_group', 'rickshaw', 'emoji', '🛺', 'filter_dimension', 'electric',
      'filter_options', jsonb_build_array(jsonb_build_object('value', 'other', 'emoji', '🛺'), jsonb_build_object('value', 'electric', 'emoji', '🔋')))
  ) g
  WHERE EXISTS (SELECT 1 FROM vehicle_categories c WHERE c.tenant_id = my_tenant_id() AND c.is_active AND c.ride_group = g.row->>'ride_group');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
