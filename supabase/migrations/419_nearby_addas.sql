-- Migration 419: "going home" — a villager outside the village marks
-- where he is (GPS or a manual pin) and should see everything relevant
-- to getting home in one place: the nearby adda(s) with their live queue
-- (public-transport Suzukis, fixed fare, already covered by adda_board())
-- and nearby freeform vehicles (rickshaws/bikes/cars sharing live
-- location, already covered by nearby_open_trips(), 414/415). The one
-- piece that didn't exist yet: finding *which* addas are actually near
-- him in the first place — nearby_addas() is exactly nearby_open_trips()'s
-- own distance-filter shape, just against addas instead of trip offers.
-- The portal page composes this with adda_board() (per adda found) and
-- nearby_open_trips() itself; no change to either of those.
CREATE OR REPLACE FUNCTION nearby_addas(p_lat decimal DEFAULT NULL, p_lng decimal DEFAULT NULL, p_radius_km decimal DEFAULT 50)
RETURNS TABLE(id uuid, name varchar, name_ur varchar, lat decimal, lng decimal, operating_start_time time, operating_end_time time, distance_km decimal) AS $$
  SELECT a.id, a.name, a.name_ur, a.lat, a.lng, a.operating_start_time, a.operating_end_time,
    CASE WHEN p_lat IS NOT NULL AND p_lng IS NOT NULL AND a.lat IS NOT NULL AND a.lng IS NOT NULL THEN
      round((6371 * acos(least(1, greatest(-1,
        cos(radians(p_lat)) * cos(radians(a.lat)) * cos(radians(a.lng) - radians(p_lng))
        + sin(radians(p_lat)) * sin(radians(a.lat))
      ))))::numeric, 1)
    ELSE NULL END AS distance_km
  FROM addas a
  WHERE a.is_active
    AND (
      p_lat IS NULL OR p_lng IS NULL OR a.lat IS NULL OR a.lng IS NULL
      OR (6371 * acos(least(1, greatest(-1,
          cos(radians(p_lat)) * cos(radians(a.lat)) * cos(radians(a.lng) - radians(p_lng))
          + sin(radians(p_lat)) * sin(radians(a.lat))
        )))) <= p_radius_km
    )
  ORDER BY distance_km ASC NULLS LAST, a.name;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION nearby_addas(decimal, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION nearby_addas(decimal, decimal, decimal) TO authenticated;
