-- Migration 750: per-tenant fleet territory, drawn once on the
-- platform (super-admin) map, not per-tenant-admin -- the whole point
-- (discussed 2026-10-28) is that one person can see every tenant's
-- shapes at once and catch overlaps/gaps between neighbouring villages
-- before a cross-tenant marketplace_share_agreements row is approved
-- between them. Same real-world concept Laari already proved out as
-- company_geofences' green/blue shapes (065_green_blue_jurisdiction_
-- merge.sql) -- one circle for "home village" (village), any number of
-- circles for "a city this tenant's fleet actually works out of"
-- (city) -- just a relationship table on top of the existing shared
-- `cities` list and `tenants`, not a retrofit of either (same move
-- marketplace_share_agreements, 667, already made rather than bolting
-- cross-tenant fields onto `vehicles` directly).
--
-- A 'city' zone is always tied to a real row in the shared `cities`
-- list (not an arbitrary free-text label) so this and the weekly-
-- commute demand card (743) share one city identity. A 'village' zone
-- is centered on wherever the admin actually drops the pin -- cities
-- has no per-tenant "this is MY village, here" row to borrow from (it's
-- a shared, global reference list, not tenant-scoped at all).

CREATE TABLE IF NOT EXISTS tenant_service_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  zone_kind varchar NOT NULL CHECK (zone_kind IN ('village', 'city')),
  city_id uuid REFERENCES cities(id),
  label varchar,
  center_lat decimal NOT NULL,
  center_lng decimal NOT NULL,
  radius_km decimal NOT NULL CHECK (radius_km > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES platform_admins(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CHECK ((zone_kind = 'city' AND city_id IS NOT NULL) OR (zone_kind = 'village' AND city_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_service_zones_one_village_idx
  ON tenant_service_zones (tenant_id) WHERE zone_kind = 'village' AND is_active;
CREATE UNIQUE INDEX IF NOT EXISTS tenant_service_zones_one_per_city_idx
  ON tenant_service_zones (tenant_id, city_id) WHERE zone_kind = 'city' AND is_active;

ALTER TABLE tenant_service_zones ENABLE ROW LEVEL SECURITY;
-- Platform-admin-only, same shape as tenants_platform_manage (617).
-- No tenant-facing policy at all -- every backend consumer reads this
-- through a SECURITY DEFINER function, which bypasses RLS by design;
-- there's no "tenant admin edits their own zone" screen planned.
CREATE POLICY "tenant_service_zones_platform_manage" ON tenant_service_zones FOR ALL TO authenticated
  USING (is_platform_admin()) WITH CHECK (is_platform_admin());

-- The one real geo-check, reused everywhere a "is this point inside
-- this tenant's village/city territory" question comes up (ride-
-- dispatch tiering, the city_return_demand tenant-scoping fix below,
-- and anywhere else this grows into). A 'city' tenant can have several
-- active circles -- true if the point falls in ANY of them.
CREATE OR REPLACE FUNCTION point_in_tenant_zone(p_lat decimal, p_lng decimal, p_tenant_id uuid, p_zone_kind varchar) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM tenant_service_zones z
    WHERE z.tenant_id = p_tenant_id AND z.zone_kind = p_zone_kind AND z.is_active
      AND haversine_km(z.center_lat, z.center_lng, p_lat, p_lng) <= z.radius_km
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION point_in_tenant_zone(decimal, decimal, uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION point_in_tenant_zone(decimal, decimal, uuid, varchar) TO authenticated;

-- ── Platform admin CRUD ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION platform_tenant_zones(p_tenant_id uuid) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', z.id, 'zone_kind', z.zone_kind, 'city_id', z.city_id, 'city_name', c.name,
    'label', z.label, 'center_lat', z.center_lat, 'center_lng', z.center_lng, 'radius_km', z.radius_km
  ) ORDER BY z.zone_kind, c.name), '[]'::jsonb)
  FROM tenant_service_zones z LEFT JOIN cities c ON c.id = z.city_id
  WHERE z.tenant_id = p_tenant_id AND z.is_active AND is_platform_admin();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION platform_tenant_zones(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION platform_tenant_zones(uuid) TO authenticated;

-- For the combined all-tenants overlap-spotting map.
CREATE OR REPLACE FUNCTION platform_all_tenant_zones() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', z.id, 'tenant_id', z.tenant_id, 'tenant_name', t.name, 'zone_kind', z.zone_kind,
    'city_id', z.city_id, 'city_name', c.name, 'label', z.label,
    'center_lat', z.center_lat, 'center_lng', z.center_lng, 'radius_km', z.radius_km
  ) ORDER BY t.name, z.zone_kind), '[]'::jsonb)
  FROM tenant_service_zones z JOIN tenants t ON t.id = z.tenant_id LEFT JOIN cities c ON c.id = z.city_id
  WHERE z.is_active AND is_platform_admin();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION platform_all_tenant_zones() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION platform_all_tenant_zones() TO authenticated;

CREATE OR REPLACE FUNCTION platform_upsert_tenant_zone(
  p_tenant_id uuid, p_zone_kind varchar, p_center_lat decimal, p_center_lng decimal, p_radius_km decimal,
  p_city_id uuid DEFAULT NULL, p_label varchar DEFAULT NULL, p_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE v_existing_id uuid; v_id uuid;
BEGIN
  IF NOT is_platform_admin() THEN RAISE EXCEPTION 'Platform admin access required.' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN RAISE EXCEPTION 'Unknown tenant.' USING ERRCODE = 'P0001'; END IF;
  IF p_zone_kind NOT IN ('village', 'city') THEN RAISE EXCEPTION 'zone_kind must be village or city.' USING ERRCODE = 'P0001'; END IF;
  IF p_zone_kind = 'city' AND NOT EXISTS (SELECT 1 FROM cities WHERE id = p_city_id AND is_active) THEN
    RAISE EXCEPTION 'A real, active city is required for a city zone.' USING ERRCODE = 'P0001';
  END IF;
  IF p_zone_kind = 'village' AND p_city_id IS NOT NULL THEN
    RAISE EXCEPTION 'A village zone is centered on the map directly, not tied to a city.' USING ERRCODE = 'P0001';
  END IF;
  IF p_radius_km IS NULL OR p_radius_km <= 0 THEN RAISE EXCEPTION 'A positive radius is required.' USING ERRCODE = 'P0001'; END IF;
  IF p_center_lat IS NULL OR p_center_lng IS NULL THEN RAISE EXCEPTION 'A map location is required.' USING ERRCODE = 'P0001'; END IF;

  -- Editing an explicit id always wins. Otherwise redraw the tenant's
  -- existing shape for this zone_kind/city (one village zone per
  -- tenant, one circle per city) instead of erroring on the unique
  -- index -- same convenience Laari's admin_upsert_geofence gives.
  IF p_id IS NOT NULL THEN
    v_existing_id := p_id;
  ELSIF p_zone_kind = 'village' THEN
    SELECT id INTO v_existing_id FROM tenant_service_zones WHERE tenant_id = p_tenant_id AND zone_kind = 'village' AND is_active;
  ELSE
    SELECT id INTO v_existing_id FROM tenant_service_zones WHERE tenant_id = p_tenant_id AND zone_kind = 'city' AND city_id = p_city_id AND is_active;
  END IF;

  IF v_existing_id IS NULL THEN
    INSERT INTO tenant_service_zones (tenant_id, zone_kind, city_id, label, center_lat, center_lng, radius_km, created_by)
    VALUES (p_tenant_id, p_zone_kind, p_city_id, p_label, p_center_lat, p_center_lng, p_radius_km, current_platform_admin_id())
    RETURNING id INTO v_id;
  ELSE
    UPDATE tenant_service_zones SET
      center_lat = p_center_lat, center_lng = p_center_lng, radius_km = p_radius_km, label = p_label, updated_at = now()
    WHERE id = v_existing_id
    RETURNING id INTO v_id;
  END IF;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION platform_upsert_tenant_zone(uuid, varchar, decimal, decimal, decimal, uuid, varchar, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION platform_upsert_tenant_zone(uuid, varchar, decimal, decimal, decimal, uuid, varchar, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION platform_delete_tenant_zone(p_id uuid) RETURNS void AS $$
BEGIN
  IF NOT is_platform_admin() THEN RAISE EXCEPTION 'Platform admin access required.' USING ERRCODE = '42501'; END IF;
  UPDATE tenant_service_zones SET is_active = false, updated_at = now() WHERE id = p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION platform_delete_tenant_zone(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION platform_delete_tenant_zone(uuid) TO authenticated;

-- ── Real tenant-leak bug fix, found reading 743's own definition ────
-- city_return_demand()/city_return_seats_for_day() had no tenant filter
-- at all -- a driver in any one tenant was seeing demand (and counting
-- return seats) aggregated across every other tenant's riders and
-- routes too. rider_weekly_schedules already carries tenant_id
-- directly; vehicle_routes/vehicle_trip_offers don't (only vehicle_id),
-- so their tenant comes from the owning vehicle, same join pattern
-- every other tenant-scoped query over these two tables already uses.
CREATE OR REPLACE FUNCTION city_return_seats_for_day(p_city_id uuid, p_dow int) RETURNS int AS $$
DECLARE
  v_city_name varchar;
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_today_dow int := extract(dow FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
  v_target_date date;
  v_total int := 0;
BEGIN
  SELECT name INTO v_city_name FROM cities WHERE id = p_city_id;
  IF v_city_name IS NULL THEN RETURN 0; END IF;
  v_target_date := v_today + ((p_dow - v_today_dow + 7) % 7);

  SELECT COALESCE(SUM(GREATEST(0, return_seats_available(r.id, v_target_date))), 0) INTO v_total
  FROM vehicle_routes r JOIN vehicles v ON v.id = r.vehicle_id
  WHERE r.is_active AND r.is_two_way AND lower(trim(r.destination)) = lower(trim(v_city_name))
    AND p_dow = ANY(r.days_of_week) AND v.tenant_id = my_tenant_id();

  v_total := v_total + COALESCE((
    SELECT SUM(GREATEST(0, trip_return_seats_available(o.id)))
    FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id
    WHERE o.trip_type = 'return' AND o.travel_date = v_target_date AND lower(trim(o.destination)) = lower(trim(v_city_name))
      AND v.tenant_id = my_tenant_id()
  ), 0);

  RETURN v_total;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION city_return_seats_for_day(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_return_seats_for_day(uuid, int) TO authenticated;

CREATE OR REPLACE FUNCTION city_return_demand() RETURNS jsonb AS $$
DECLARE v_today_dow int := extract(dow FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'city_id', g.work_city_id, 'city_name', c.name, 'city_name_ur', c.name_ur,
      'return_day_of_week', g.return_day_of_week,
      'is_today', g.return_day_of_week = v_today_dow,
      'waiting_riders', g.waiting_riders,
      'seats_available', g.seats_available,
      'chance_pct', LEAST(100, ROUND(100.0 * g.seats_available / g.waiting_riders))
    ) ORDER BY (g.return_day_of_week = v_today_dow) DESC, g.waiting_riders DESC)
    FROM (
      SELECT s.work_city_id, s.return_day_of_week, COUNT(DISTINCT s.portal_user_id) AS waiting_riders,
        city_return_seats_for_day(s.work_city_id, s.return_day_of_week) AS seats_available
      FROM rider_weekly_schedules s
      WHERE s.is_active AND s.tenant_id = my_tenant_id()
      GROUP BY s.work_city_id, s.return_day_of_week
    ) g
    JOIN cities c ON c.id = g.work_city_id
  ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION city_return_demand() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_return_demand() TO authenticated;
