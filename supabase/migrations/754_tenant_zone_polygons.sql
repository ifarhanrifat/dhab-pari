-- Migration 754: real ask, 2026-10-28 — a circle is a rough stand-in
-- for a village/city's actual shape; the admin wants to trace a real
-- boundary by hand instead. Reuses Laari's own proven point_in_polygon
-- (057_fuel_inclusion_and_hilly_zones.sql) rather than re-deriving
-- ray-casting from scratch — same algorithm, just typed decimal to
-- match this schema's own convention instead of double precision.
--
-- A polygon zone still gets a center_lat/center_lng (the centroid of
-- its own points, computed once at save time) so every existing piece
-- of code that reads a zone's center for distance-ordering or detour
-- fare math (751's cross-tenant partner selection, accept_ride_
-- dispatch's village-detour calc) keeps working completely unchanged
-- for a polygon zone too — nothing downstream needed to learn a second
-- "what is this zone's location" concept.

ALTER TABLE tenant_service_zones ADD COLUMN IF NOT EXISTS area_type varchar NOT NULL DEFAULT 'circle' CHECK (area_type IN ('circle', 'polygon'));
ALTER TABLE tenant_service_zones ADD COLUMN IF NOT EXISTS points jsonb;
ALTER TABLE tenant_service_zones ALTER COLUMN radius_km DROP NOT NULL;
ALTER TABLE tenant_service_zones ADD CONSTRAINT tenant_service_zones_shape_check CHECK (
  (area_type = 'circle' AND radius_km IS NOT NULL AND radius_km > 0)
  OR (area_type = 'polygon' AND points IS NOT NULL AND jsonb_array_length(points) >= 3)
);

CREATE OR REPLACE FUNCTION point_in_polygon(p_lat decimal, p_lng decimal, p_points jsonb) RETURNS boolean AS $$
DECLARE
  n integer := jsonb_array_length(p_points);
  i integer; j integer;
  xi decimal; yi decimal; xj decimal; yj decimal;
  inside boolean := false;
BEGIN
  IF n < 3 THEN RETURN false; END IF;
  j := n - 1;
  FOR i IN 0..n - 1 LOOP
    xi := (p_points -> i ->> 'lng')::decimal; yi := (p_points -> i ->> 'lat')::decimal;
    xj := (p_points -> j ->> 'lng')::decimal; yj := (p_points -> j ->> 'lat')::decimal;
    IF ((yi > p_lat) <> (yj > p_lat)) AND (p_lng < (xj - xi) * (p_lat - yi) / NULLIF(yj - yi, 0) + xi) THEN
      inside := NOT inside;
    END IF;
    j := i;
  END LOOP;
  RETURN inside;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION point_in_tenant_zone(p_lat decimal, p_lng decimal, p_tenant_id uuid, p_zone_kind varchar) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM tenant_service_zones z
    WHERE z.tenant_id = p_tenant_id AND z.zone_kind = p_zone_kind AND z.is_active
      AND (
        (z.area_type = 'circle' AND haversine_km(z.center_lat, z.center_lng, p_lat, p_lng) <= z.radius_km)
        OR (z.area_type = 'polygon' AND point_in_polygon(p_lat, p_lng, z.points))
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS platform_upsert_tenant_zone(uuid, varchar, decimal, decimal, decimal, uuid, varchar, uuid);

CREATE OR REPLACE FUNCTION platform_upsert_tenant_zone(
  p_tenant_id uuid, p_zone_kind varchar, p_area_type varchar, p_center_lat decimal, p_center_lng decimal,
  p_radius_km decimal DEFAULT NULL, p_points jsonb DEFAULT NULL, p_city_id uuid DEFAULT NULL, p_label varchar DEFAULT NULL, p_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_existing_id uuid; v_id uuid;
  v_centroid_lat decimal; v_centroid_lng decimal;
BEGIN
  IF NOT is_platform_admin() THEN RAISE EXCEPTION 'Platform admin access required.' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN RAISE EXCEPTION 'Unknown tenant.' USING ERRCODE = 'P0001'; END IF;
  IF p_zone_kind NOT IN ('village', 'city') THEN RAISE EXCEPTION 'zone_kind must be village or city.' USING ERRCODE = 'P0001'; END IF;
  IF p_area_type NOT IN ('circle', 'polygon') THEN RAISE EXCEPTION 'area_type must be circle or polygon.' USING ERRCODE = 'P0001'; END IF;
  IF p_zone_kind = 'city' AND NOT EXISTS (SELECT 1 FROM cities WHERE id = p_city_id AND is_active) THEN
    RAISE EXCEPTION 'A real, active city is required for a city zone.' USING ERRCODE = 'P0001';
  END IF;
  IF p_zone_kind = 'village' AND p_city_id IS NOT NULL THEN
    RAISE EXCEPTION 'A village zone is centered on the map directly, not tied to a city.' USING ERRCODE = 'P0001';
  END IF;
  IF p_area_type = 'circle' THEN
    IF p_radius_km IS NULL OR p_radius_km <= 0 THEN RAISE EXCEPTION 'A positive radius is required.' USING ERRCODE = 'P0001'; END IF;
    v_centroid_lat := p_center_lat; v_centroid_lng := p_center_lng;
  ELSE
    IF p_points IS NULL OR jsonb_array_length(p_points) < 3 THEN RAISE EXCEPTION 'At least 3 points are required to draw a boundary.' USING ERRCODE = 'P0001'; END IF;
    SELECT avg((pt ->> 'lat')::decimal), avg((pt ->> 'lng')::decimal) INTO v_centroid_lat, v_centroid_lng FROM jsonb_array_elements(p_points) pt;
  END IF;

  IF p_id IS NOT NULL THEN
    v_existing_id := p_id;
  ELSIF p_zone_kind = 'village' THEN
    SELECT id INTO v_existing_id FROM tenant_service_zones WHERE tenant_id = p_tenant_id AND zone_kind = 'village' AND is_active;
  ELSE
    SELECT id INTO v_existing_id FROM tenant_service_zones WHERE tenant_id = p_tenant_id AND zone_kind = 'city' AND city_id = p_city_id AND is_active;
  END IF;

  IF v_existing_id IS NULL THEN
    INSERT INTO tenant_service_zones (tenant_id, zone_kind, area_type, city_id, label, center_lat, center_lng, radius_km, points, created_by)
    VALUES (p_tenant_id, p_zone_kind, p_area_type, p_city_id, p_label, v_centroid_lat, v_centroid_lng, p_radius_km, p_points, current_platform_admin_id())
    RETURNING id INTO v_id;
  ELSE
    UPDATE tenant_service_zones SET
      area_type = p_area_type, center_lat = v_centroid_lat, center_lng = v_centroid_lng,
      radius_km = p_radius_km, points = p_points, label = p_label, updated_at = now()
    WHERE id = v_existing_id
    RETURNING id INTO v_id;
  END IF;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION platform_upsert_tenant_zone(uuid, varchar, varchar, decimal, decimal, decimal, jsonb, uuid, varchar, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION platform_upsert_tenant_zone(uuid, varchar, varchar, decimal, decimal, decimal, jsonb, uuid, varchar, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION platform_tenant_zones(p_tenant_id uuid) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', z.id, 'zone_kind', z.zone_kind, 'area_type', z.area_type, 'city_id', z.city_id, 'city_name', c.name,
    'label', z.label, 'center_lat', z.center_lat, 'center_lng', z.center_lng, 'radius_km', z.radius_km, 'points', z.points
  ) ORDER BY z.zone_kind, c.name), '[]'::jsonb)
  FROM tenant_service_zones z LEFT JOIN cities c ON c.id = z.city_id
  WHERE z.tenant_id = p_tenant_id AND z.is_active AND is_platform_admin();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION platform_all_tenant_zones() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', z.id, 'tenant_id', z.tenant_id, 'tenant_name', t.name, 'zone_kind', z.zone_kind, 'area_type', z.area_type,
    'city_id', z.city_id, 'city_name', c.name, 'label', z.label,
    'center_lat', z.center_lat, 'center_lng', z.center_lng, 'radius_km', z.radius_km, 'points', z.points
  ) ORDER BY t.name, z.zone_kind), '[]'::jsonb)
  FROM tenant_service_zones z JOIN tenants t ON t.id = z.tenant_id LEFT JOIN cities c ON c.id = z.city_id
  WHERE z.is_active AND is_platform_admin();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
