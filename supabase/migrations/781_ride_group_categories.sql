-- Migration 781: real ask, 2026-11-03 — "the available vehicle display
-- card... this is how we need to book every vehicle separately. look
-- this is how the professional apps are showing categories with fare
-- card, like small cars which will include all the small cars with ac
-- and without ac separately we will provide filter for ac... then cars
-- above 1000cc, then suvs, then bikes which will have electric and
-- regular, rickshaws electric and other, so there are only 5 or 6
-- categories will be displayed, there will be no hiace or any other
-- vehicle there in that card."
--
-- Real cause: 707/749/757, each independently reasonable at the time,
-- left results/page.tsx's "request any driver" grid listing every raw
-- vehicle_categories row — 20+ buttons today (every car model, both
-- AC/non-AC tiers, every van) for a point-to-point ride request. 757's
-- own header comment even argued the opposite design on purpose ("real
-- vehicles are known by MODEL, not 'small car AC'") — a reasonable
-- call for how a DRIVER registers their vehicle, wrong for how a RIDER
-- picks a ride-dispatch category. Both can be true: this migration adds
-- a second, coarser dimension purely for the point-to-point request
-- grid, without touching the existing fine-grained categories drivers
-- already registered under (vehicles.category_id is untouched; rental/
-- hourly keep listing individual vehicles exactly as today — confirmed
-- live, that screen was never the complaint).
--
-- ride_group: which of the 5 rider-facing tiles (small_car / car / suv
-- / bike / rickshaw) this category belongs to. NULL means "not offered
-- as a point-to-point ride request" — vans/Hiace/loading/machinery,
-- exactly the "no hiace in that card" ask (they're already reachable
-- via the Adda/Shared-rides sections above the grid, or via Rental).
--
-- variant_filter: the one optional sub-filter within a group ('ac' /
-- 'non_ac' for small_car, 'electric' / 'regular' for bike, 'electric'
-- / 'other' for rickshaw). This is a CATEGORY-level tag, same
-- mechanism 757 already used to split 'electric_bike' out from 'bike'
-- as its own row — not a new per-vehicle attribute — so filtering a
-- group by variant is just "which category ids within this group
-- match," reusing the ride_dispatch_requests.category_ids broadcast
-- array (751) that already exists and is already matched against by
-- accept_ride_dispatch/my_pending_ride_dispatch_requests. No change
-- needed to either of those, or to RLS, or to the cross-tenant/
-- scheduling logic in create_ride_dispatch_request — the new RPCs below
-- are thin wrappers that resolve (ride_group, variant_filter) into a
-- category_ids array and hand off to the real, already-tested function.
--
-- Known, accepted v1 gap: broadcast_ride_dispatch_request's cross-
-- tenant neighbour-village fallback only fires when exactly one
-- category was targeted (array_length(r.category_ids,1) = 1) — a
-- grouped request (2+ ids) that finds zero drivers in the home village
-- will not currently also ask a neighbouring village, same as the
-- fine-grained 'suv'/single-category case already works either way.
-- Flag for a follow-up if this turns out to matter in practice.

ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS ride_group varchar;
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS variant_filter varchar;

UPDATE vehicle_categories SET ride_group = 'small_car', variant_filter = 'ac' WHERE key IN ('small_car_ac', 'suzuki_mehran_ac', 'suzuki_alto');
UPDATE vehicle_categories SET ride_group = 'small_car', variant_filter = 'non_ac' WHERE key IN ('small_car_non_ac', 'suzuki_mehran_non_ac');
UPDATE vehicle_categories SET ride_group = 'car' WHERE key IN ('big_car_ac', 'big_car_non_ac', 'toyota_corolla', 'luxury');
UPDATE vehicle_categories SET ride_group = 'suv' WHERE key = 'suv';
UPDATE vehicle_categories SET ride_group = 'bike', variant_filter = 'regular' WHERE key = 'bike';
UPDATE vehicle_categories SET ride_group = 'bike', variant_filter = 'electric' WHERE key = 'electric_bike';
UPDATE vehicle_categories SET ride_group = 'rickshaw', variant_filter = 'other' WHERE key = 'rickshaw';

-- The two loading categories with no dedicated booking page (loader
-- itself, and the two equipment/machinery ones, all link out via
-- EQUIPMENT_HREF instead) already go through this same ride-dispatch
-- sheet, one raw category at a time — self-mapped to their own key so
-- results/page.tsx can reuse the one ride_group_quote/create_ride_
-- group_dispatch_request path for them too instead of a second,
-- parallel single-category code path.
UPDATE vehicle_categories SET ride_group = key WHERE key IN ('rickshaw_loading', 'suzuki_ravi_dala');

-- A real electric-rickshaw category never existed (only 'rickshaw' and
-- the unrelated, equipment-group 'rickshaw_loading') — the user asked
-- for an electric/other filter on rickshaws, so this adds the missing
-- variant the same way 757 cloned 'electric_bike' from 'bike': rate
-- card inherited from the real, already-committee-set 'rickshaw' row,
-- nothing invented.
INSERT INTO vehicle_categories (tenant_id, key, name, name_ur, emoji, base_fare_pkr, per_km_pkr, intercity_commission_pct, out_of_city_commission_pct, category_group, out_of_city_eligible, ride_group, variant_filter, display_order)
SELECT src.tenant_id, 'electric_rickshaw', 'Electric Rickshaw', 'الیکٹرک رکشا', '🔋', src.base_fare_pkr, src.per_km_pkr, src.intercity_commission_pct, src.out_of_city_commission_pct, 'passenger', src.out_of_city_eligible, 'rickshaw', 'electric', 30
FROM vehicle_categories src WHERE src.key = 'rickshaw' AND src.is_active
ON CONFLICT (tenant_id, key) DO NOTHING;

-- The 5 rider-facing tiles, in a fixed order — hardcoded here rather
-- than driven by display_order on the underlying rows, since several
-- different category rows (e.g. small_car_ac + suzuki_mehran_ac) now
-- collapse into one tile and need exactly one shared label/emoji/
-- filter-options triple, not whichever row happens to sort first.
CREATE OR REPLACE FUNCTION ride_group_options() RETURNS jsonb AS $$
  SELECT jsonb_agg(g.row ORDER BY g.sort) FROM (
    SELECT 1 AS sort, jsonb_build_object('ride_group', 'small_car', 'emoji', '🚗', 'filter_dimension', 'ac',
      'filter_options', jsonb_build_array(jsonb_build_object('value', 'ac', 'emoji', '❄️'), jsonb_build_object('value', 'non_ac', 'emoji', '☀️'))) AS row
    UNION ALL
    SELECT 2, jsonb_build_object('ride_group', 'car', 'emoji', '🚘', 'filter_dimension', null, 'filter_options', '[]'::jsonb)
    UNION ALL
    SELECT 3, jsonb_build_object('ride_group', 'suv', 'emoji', '🚙', 'filter_dimension', null, 'filter_options', '[]'::jsonb)
    UNION ALL
    SELECT 4, jsonb_build_object('ride_group', 'bike', 'emoji', '🛵', 'filter_dimension', 'electric',
      'filter_options', jsonb_build_array(jsonb_build_object('value', 'regular', 'emoji', '🛵'), jsonb_build_object('value', 'electric', 'emoji', '🔋')))
    UNION ALL
    SELECT 5, jsonb_build_object('ride_group', 'rickshaw', 'emoji', '🛺', 'filter_dimension', 'electric',
      'filter_options', jsonb_build_array(jsonb_build_object('value', 'other', 'emoji', '🛺'), jsonb_build_object('value', 'electric', 'emoji', '🔋')))
  ) g
  WHERE EXISTS (SELECT 1 FROM vehicle_categories c WHERE c.tenant_id = my_tenant_id() AND c.is_active AND c.ride_group = g.row->>'ride_group');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION ride_group_options() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ride_group_options() TO authenticated;

-- Same shape ride_dispatch_quote already returns, aggregated across
-- every category id the group (+ optional variant filter) resolves to
-- instead of a single category — every member of a group was cloned
-- from the same source rate card (707/749/757), so AVG() here is exact
-- in practice, not an approximation.
CREATE OR REPLACE FUNCTION ride_group_quote(
  p_ride_group varchar, p_pickup_lat decimal, p_pickup_lng decimal, p_distance_km decimal,
  p_variant_filter varchar DEFAULT NULL, p_dropoff_city_id uuid DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_ids uuid[];
  v_own_tenant uuid := my_tenant_id();
  v_own_tenant_name varchar;
  v_is_out_of_city boolean := false;
  v_online_in_city int; v_active_total int;
  v_base_fare decimal; v_per_km decimal; v_village_lat decimal; v_village_lng decimal; v_village_detour decimal;
  v_out_of_city_eligible boolean;
  v_partner jsonb;
  v_rep_key varchar;
BEGIN
  SELECT array_agg(id ORDER BY display_order) INTO v_ids FROM vehicle_categories
  WHERE tenant_id = v_own_tenant AND is_active AND ride_group = p_ride_group AND (p_variant_filter IS NULL OR variant_filter = p_variant_filter);
  IF v_ids IS NULL OR array_length(v_ids, 1) = 0 THEN RAISE EXCEPTION 'That vehicle category is not available.' USING ERRCODE = 'P0001'; END IF;

  SELECT name INTO v_own_tenant_name FROM tenants WHERE id = v_own_tenant;
  SELECT avg(base_fare_pkr), avg(per_km_pkr), bool_and(out_of_city_eligible), min(key) INTO v_base_fare, v_per_km, v_out_of_city_eligible, v_rep_key
  FROM vehicle_categories WHERE id = ANY(v_ids);

  IF p_dropoff_city_id IS NOT NULL THEN
    SELECT NOT COALESCE(is_home_city, true) INTO v_is_out_of_city FROM cities WHERE id = p_dropoff_city_id;
  END IF;
  IF v_is_out_of_city AND NOT v_out_of_city_eligible THEN
    RAISE EXCEPTION 'This vehicle type is only set up for trips within the home city.' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_online_in_city FROM vehicles v
  WHERE v.category_id = ANY(v_ids) AND v.is_active AND v.is_online AND v.current_lat IS NOT NULL
    AND v.current_location_updated_at > now() - interval '30 minutes'
    AND haversine_km(v.current_lat, v.current_lng, p_pickup_lat, p_pickup_lng) <= 6
    AND (NOT v_is_out_of_city OR v.allows_out_of_city);

  SELECT count(*) INTO v_active_total FROM vehicles v
  WHERE v.category_id = ANY(v_ids) AND v.is_active AND (NOT v_is_out_of_city OR v.allows_out_of_city);

  v_base_fare := round(v_base_fare + v_per_km * p_distance_km);

  SELECT center_lat, center_lng INTO v_village_lat, v_village_lng
  FROM tenant_service_zones WHERE tenant_id = v_own_tenant AND zone_kind = 'village' AND is_active LIMIT 1;
  IF v_village_lat IS NULL THEN
    SELECT lat, lng INTO v_village_lat, v_village_lng FROM cities WHERE is_home_city LIMIT 1;
  END IF;
  v_village_detour := CASE WHEN v_village_lat IS NOT NULL
    THEN round(v_per_km * haversine_km(v_village_lat, v_village_lng, p_pickup_lat, p_pickup_lng) * 2)
    ELSE 0 END;

  v_partner := NULL;
  IF v_active_total = 0 THEN
    SELECT jsonb_build_object(
      'tenant_id', t.id, 'tenant_name', t.name, 'active_count', cnt.n,
      'detour_pkr', COALESCE(round(vc2.per_km_pkr * haversine_km(z.center_lat, z.center_lng, p_pickup_lat, p_pickup_lng) * 2), 0)
    ) INTO v_partner
    FROM marketplace_share_agreements sa
    JOIN tenants t ON t.id = sa.owner_tenant_id
    JOIN vehicle_categories vc2 ON vc2.tenant_id = t.id AND vc2.key = v_rep_key AND vc2.is_active
      AND (NOT v_is_out_of_city OR vc2.out_of_city_eligible)
    JOIN LATERAL (SELECT count(*) AS n FROM vehicles vv WHERE vv.category_id = vc2.id AND vv.is_active AND (NOT v_is_out_of_city OR vv.allows_out_of_city)) cnt ON cnt.n > 0
    LEFT JOIN tenant_service_zones z ON z.tenant_id = t.id AND z.zone_kind = 'village' AND z.is_active
    WHERE sa.target_tenant_id = v_own_tenant AND sa.category = 'ride_dispatch' AND sa.is_active
    ORDER BY (z.center_lat IS NULL), haversine_km(COALESCE(z.center_lat, p_pickup_lat), COALESCE(z.center_lng, p_pickup_lng), p_pickup_lat, p_pickup_lng)
    LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'online_in_city', v_online_in_city, 'active_total', v_active_total,
    'base_fare_pkr', v_base_fare, 'village_detour_pkr', v_village_detour, 'total_with_village_pkr', v_base_fare + v_village_detour,
    'cross_tenant', v_partner, 'own_tenant_name', v_own_tenant_name
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION ride_group_quote(varchar, decimal, decimal, decimal, varchar, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ride_group_quote(varchar, decimal, decimal, decimal, varchar, uuid) TO authenticated;

-- Thin wrapper: resolves (ride_group, variant_filter) into the real
-- category_ids array and hands off to the existing, unchanged
-- create_ride_dispatch_request — every real piece of logic (tiered
-- cascade, scheduling, out-of-city gate, notifications) stays exactly
-- as battle-tested, nothing duplicated here.
CREATE OR REPLACE FUNCTION create_ride_group_dispatch_request(
  p_ride_group varchar, p_pickup_label text, p_pickup_lat decimal, p_pickup_lng decimal,
  p_dropoff_label text, p_dropoff_lat decimal, p_dropoff_lng decimal, p_distance_km decimal,
  p_variant_filter varchar DEFAULT NULL, p_scheduled_for timestamptz DEFAULT NULL, p_dropoff_city_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE v_ids uuid[];
BEGIN
  SELECT array_agg(id ORDER BY display_order) INTO v_ids FROM vehicle_categories
  WHERE tenant_id = my_tenant_id() AND is_active AND ride_group = p_ride_group AND (p_variant_filter IS NULL OR variant_filter = p_variant_filter);
  IF v_ids IS NULL OR array_length(v_ids, 1) = 0 THEN RAISE EXCEPTION 'That vehicle category is not available.' USING ERRCODE = 'P0001'; END IF;

  RETURN create_ride_dispatch_request(
    v_ids[1], p_pickup_label, p_pickup_lat, p_pickup_lng, p_dropoff_label, p_dropoff_lat, p_dropoff_lng, p_distance_km,
    v_ids, true, p_scheduled_for, p_dropoff_city_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_ride_group_dispatch_request(varchar, text, decimal, decimal, text, decimal, decimal, decimal, varchar, timestamptz, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_ride_group_dispatch_request(varchar, text, decimal, decimal, text, decimal, decimal, decimal, varchar, timestamptz, uuid) TO authenticated;
