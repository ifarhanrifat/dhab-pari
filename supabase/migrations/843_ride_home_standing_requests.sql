-- Migration 843: real ask, 2026-11-11 — "ghar chalain" should be more
-- than a one-shot lookup. Today's Go Home flow (729/796) asks which
-- city you're in, looks up today's already-posted return-leg seats,
-- and if nothing matches, shows nothing — the rider has to come back
-- and check again later themselves. New ask: save the request, keep
-- checking for the rider, and push a notification the moment a real
-- match appears.
--
-- Deliberately NOT a trigger fan-out across create_vehicle_route_self /
-- book_trip / rental-return-offer creation (three separate live, often-
-- edited functions) — that would mean touching working booking code to
-- add this. Instead a single, separate, cron-only matcher function re-
-- checks every open request on a timer, the same "don't touch the live
-- path" discipline as 837/838 this session. Notification delivery
-- reuses the existing pipeline completely unchanged: inserting into
-- portal_notifications already fires dispatch_push_notification (348)
-- straight to the rider's phone — no new push plumbing needed.

CREATE TABLE IF NOT EXISTS ride_home_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  city_id uuid NOT NULL REFERENCES cities(id),
  -- Free-text village/home label, matched loosely against vehicle_routes
  -- / vehicle_trip_offers' own free-text origin field — same looseness
  -- find_rides_home (729/796) already uses for the city side of the
  -- same match (lower(trim(x)) = lower(trim(y))), not a new standard.
  origin_label varchar NOT NULL,
  desired_time timestamptz,  -- NULL = "leave as soon as possible"
  expires_at timestamptz NOT NULL,
  status varchar NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matched', 'expired', 'cancelled')),
  matched_kind varchar,
  matched_id uuid,
  created_at timestamptz DEFAULT now()
);
-- One active standing request at a time, same discipline as
-- ride_dispatch_requests' own "you already have one open" rule (746).
CREATE UNIQUE INDEX IF NOT EXISTS ride_home_requests_one_open ON ride_home_requests (portal_user_id) WHERE status = 'open';
ALTER TABLE ride_home_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ride_home_requests_own" ON ride_home_requests FOR ALL TO authenticated
  USING (current_admin_permission('manage_parties') OR portal_user_id = current_portal_user_id())
  WITH CHECK (current_admin_permission('manage_parties') OR portal_user_id = current_portal_user_id());

CREATE OR REPLACE FUNCTION create_ride_home_request(
  p_city_id uuid, p_origin_label varchar, p_desired_time timestamptz DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_tenant_id uuid;
  v_expires_at timestamptz;
  v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF trim(coalesce(p_origin_label, '')) = '' THEN RAISE EXCEPTION 'Tell us which village you''re going home to.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cities WHERE id = p_city_id) THEN RAISE EXCEPTION 'Unknown city.' USING ERRCODE = 'P0001'; END IF;
  SELECT tenant_id INTO v_tenant_id FROM portal_users WHERE id = v_portal_user_id;
  IF EXISTS (SELECT 1 FROM ride_home_requests WHERE portal_user_id = v_portal_user_id AND status = 'open') THEN
    RAISE EXCEPTION 'You already have a ride-home request waiting. Cancel it first if you want to change it.' USING ERRCODE = 'P0001';
  END IF;
  IF p_desired_time IS NOT NULL AND p_desired_time < now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'That time has already passed.' USING ERRCODE = 'P0001';
  END IF;

  -- No desired time = "as soon as possible", default 4-hour window.
  -- A chosen time gets a 2-hour grace window past it — same shape as
  -- ride_dispatch_requests' own schedule-ahead rule (759), not new.
  v_expires_at := CASE WHEN p_desired_time IS NOT NULL THEN p_desired_time + interval '2 hours' ELSE now() + interval '4 hours' END;

  INSERT INTO ride_home_requests (portal_user_id, tenant_id, city_id, origin_label, desired_time, expires_at)
  VALUES (v_portal_user_id, v_tenant_id, p_city_id, trim(p_origin_label), p_desired_time, v_expires_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION create_ride_home_request(uuid, varchar, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_ride_home_request(uuid, varchar, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION cancel_ride_home_request(p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE ride_home_requests SET status = 'cancelled'
  WHERE id = p_id AND portal_user_id = current_portal_user_id() AND status = 'open';
END;
$$;
REVOKE ALL ON FUNCTION cancel_ride_home_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancel_ride_home_request(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION my_open_ride_home_request() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'city_id', r.city_id, 'city_name', c.name, 'city_name_ur', c.name_ur,
    'origin_label', r.origin_label, 'desired_time', r.desired_time, 'expires_at', r.expires_at,
    'status', r.status, 'matched_kind', r.matched_kind, 'matched_id', r.matched_id
  )
  FROM ride_home_requests r JOIN cities c ON c.id = r.city_id
  WHERE r.portal_user_id = current_portal_user_id() AND r.status IN ('open', 'matched')
  ORDER BY r.created_at DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION my_open_ride_home_request() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_open_ride_home_request() TO authenticated;

-- Cron-only matcher — never granted to anon/authenticated, same reason
-- 629's run_platform_monthly_invoicing() isn't gated with an admin
-- check: cron.schedule runs with no auth.uid() at all, so there is no
-- caller identity to gate on. Self-contained (does not call the
-- existing find_rides_home) so it can filter by the request's own
-- tenant_id directly rather than depending on another function's
-- current behaviour.
CREATE OR REPLACE FUNCTION match_ride_home_requests() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_dow int := extract(dow FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
  req record; hit record;
BEGIN
  UPDATE ride_home_requests SET status = 'expired' WHERE status = 'open' AND expires_at < now();

  FOR req IN SELECT r.*, c.name AS city_name FROM ride_home_requests r JOIN cities c ON c.id = r.city_id WHERE r.status = 'open' LOOP
    SELECT kind, id INTO hit FROM (
      SELECT 'route' AS kind, rt.id, rt.created_at FROM vehicle_routes rt JOIN vehicles v ON v.id = rt.vehicle_id
      WHERE v.tenant_id = req.tenant_id AND rt.is_active AND rt.is_two_way
        AND lower(trim(rt.destination)) = lower(trim(req.city_name)) AND lower(trim(rt.origin)) = lower(trim(req.origin_label))
        AND v_dow = ANY(rt.days_of_week) AND return_seats_available(rt.id, v_today) > 0
      UNION ALL
      SELECT 'trip' AS kind, o.id, o.created_at FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id
      WHERE v.tenant_id = req.tenant_id AND o.trip_type = 'return' AND o.travel_date = v_today
        AND lower(trim(o.destination)) = lower(trim(req.city_name)) AND lower(trim(o.origin)) = lower(trim(req.origin_label))
        AND trip_return_seats_available(o.id) > 0
      ORDER BY created_at DESC LIMIT 1
    ) m;
    IF hit.id IS NOT NULL THEN
      UPDATE ride_home_requests SET status = 'matched', matched_kind = hit.kind, matched_id = hit.id WHERE id = req.id;
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (req.portal_user_id, 'ride_home_matched', 'A ride home is available',
        'A driver heading to ' || req.origin_label || ' from ' || req.city_name || ' has a free seat — tap to book it before it''s gone.',
        '/portal/marketplace/travel?openGoHome=1');
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION match_ride_home_requests() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  PERFORM cron.schedule('ride-home-request-matcher', '*/10 * * * *', $cron$SELECT match_ride_home_requests()$cron$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available — ride_home_requests will only ever be matched manually: %', SQLERRM;
END $$;
