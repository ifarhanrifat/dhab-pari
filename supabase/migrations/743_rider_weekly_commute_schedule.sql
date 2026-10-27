-- Real ask, 2026-10-27: a rider who works away from the village all
-- week (travels out Monday, comes home Friday/Saturday) can save that
-- recurring schedule once instead of re-searching "Go Home" every
-- single week. Drivers never see WHO these riders are (their own
-- identity stays private, same spirit as every other "committee sees
-- individuals, the public sees aggregates" screen in this app) — only
-- an aggregate count per city + day, plus a rough chance-of-a-seat
-- estimate, so a driver deciding where to post a route (or run their
-- existing one) can see real demand instead of guessing.
--
-- Deliberately reuses the exact same destination-matching convention
-- find_rides_home (729) already established — vehicle_routes.destination
-- / vehicle_trip_offers.destination are free text, matched case-
-- insensitively against cities.name — rather than inventing a second,
-- possibly-divergent matching rule. Also reuses return_seats_available
-- (727) and trip_return_seats_available (728) as-is for the actual
-- seat counting instead of re-deriving booking math a third time.
--
-- "Home" is never asked for: cities.is_home_city (429) already marks
-- the one city every return leg in this app already resolves to, so a
-- rider here only ever picks which city they work in + which two days.

CREATE TABLE IF NOT EXISTS rider_weekly_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT COALESCE(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) REFERENCES tenants(id),
  portal_user_id uuid NOT NULL UNIQUE REFERENCES portal_users(id) ON DELETE CASCADE,
  work_city_id uuid NOT NULL REFERENCES cities(id),
  depart_day_of_week int NOT NULL CHECK (depart_day_of_week BETWEEN 0 AND 6),
  return_day_of_week int NOT NULL CHECK (return_day_of_week BETWEEN 0 AND 6),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE rider_weekly_schedules ENABLE ROW LEVEL SECURITY;
-- FOR ALL covers SELECT too — intentional: nobody but the rider
-- themselves (or an admin, for support) can read even their own row
-- directly. Drivers only ever see the aggregate via city_return_demand().
CREATE POLICY "rider_weekly_schedules_own" ON rider_weekly_schedules FOR ALL TO authenticated
  USING (portal_user_id = current_portal_user_id() OR current_admin_permission('manage_parties'))
  WITH CHECK (portal_user_id = current_portal_user_id() AND tenant_id = my_tenant_id());

CREATE OR REPLACE FUNCTION my_weekly_schedule() RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'id', s.id, 'work_city_id', s.work_city_id, 'city_name', c.name, 'city_name_ur', c.name_ur,
    'depart_day_of_week', s.depart_day_of_week, 'return_day_of_week', s.return_day_of_week
  )
  FROM rider_weekly_schedules s JOIN cities c ON c.id = s.work_city_id
  WHERE s.portal_user_id = current_portal_user_id() AND s.is_active;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_weekly_schedule() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_weekly_schedule() TO authenticated;

CREATE OR REPLACE FUNCTION save_my_weekly_schedule(p_work_city_id uuid, p_depart_day_of_week int, p_return_day_of_week int) RETURNS uuid AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in required.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cities WHERE id = p_work_city_id AND is_active) THEN
    RAISE EXCEPTION 'Pick a real city.' USING ERRCODE = 'P0001';
  END IF;
  IF p_depart_day_of_week NOT BETWEEN 0 AND 6 OR p_return_day_of_week NOT BETWEEN 0 AND 6 THEN
    RAISE EXCEPTION 'Pick valid days.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO rider_weekly_schedules (portal_user_id, work_city_id, depart_day_of_week, return_day_of_week, is_active, tenant_id)
  VALUES (v_portal_user_id, p_work_city_id, p_depart_day_of_week, p_return_day_of_week, true, COALESCE(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid))
  ON CONFLICT (portal_user_id) DO UPDATE SET
    work_city_id = EXCLUDED.work_city_id, depart_day_of_week = EXCLUDED.depart_day_of_week,
    return_day_of_week = EXCLUDED.return_day_of_week, is_active = true, updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION save_my_weekly_schedule(uuid, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_my_weekly_schedule(uuid, int, int) TO authenticated;

CREATE OR REPLACE FUNCTION cancel_my_weekly_schedule() RETURNS void AS $$
  UPDATE rider_weekly_schedules SET is_active = false, updated_at = now() WHERE portal_user_id = current_portal_user_id();
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION cancel_my_weekly_schedule() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancel_my_weekly_schedule() TO authenticated;

-- Real seats a rider could actually get on the NEXT occurrence of
-- p_dow (today counts if it matches), summed across every two-way
-- route and every return-leg trip offer whose destination resolves to
-- this city — the same two sources find_rides_home already searches,
-- just generalized from "today" to "the next matching weekday."
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
  FROM vehicle_routes r
  WHERE r.is_active AND r.is_two_way AND lower(trim(r.destination)) = lower(trim(v_city_name))
    AND p_dow = ANY(r.days_of_week);

  v_total := v_total + COALESCE((
    SELECT SUM(GREATEST(0, trip_return_seats_available(o.id)))
    FROM vehicle_trip_offers o
    WHERE o.trip_type = 'return' AND o.travel_date = v_target_date AND lower(trim(o.destination)) = lower(trim(v_city_name))
  ), 0);

  RETURN v_total;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION city_return_seats_for_day(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_return_seats_for_day(uuid, int) TO authenticated;

-- The driver-facing aggregate: one row per (city, return day) that has
-- at least one waiting rider right now, newest/most-today-relevant
-- first. Individual riders are never named or identifiable from this —
-- only a count.
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
      WHERE s.is_active
      GROUP BY s.work_city_id, s.return_day_of_week
    ) g
    JOIN cities c ON c.id = g.work_city_id
  ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION city_return_demand() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_return_demand() TO authenticated;
