-- Migration 724: two real gaps in the Teacher Van flow found live —
-- (1) a two-way daily route had no way to start the trip back home,
-- stops needed to show reversed on the way back; (2) billing was a
-- flat monthly lump, but the real ask is attendance-based: "if anyone
-- was not present he will not be counted his fare," confirmed with the
-- user — each day's fare share only accrues for riders actually marked
-- present, not a fixed amount regardless of attendance. Also: not
-- every rider has a phone/app login (a student with no phone, or who
-- lost it) — the driver takes roll call himself and marks them
-- present, same as any other rider.

ALTER TABLE route_runs ADD COLUMN IF NOT EXISTS direction varchar NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'return'));

CREATE TABLE IF NOT EXISTS route_run_attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES vehicle_routes(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES route_subscriptions(id) ON DELETE CASCADE,
  run_date date NOT NULL,
  present boolean NOT NULL,
  marked_at timestamptz NOT NULL DEFAULT now(),
  marked_by uuid,
  UNIQUE (subscription_id, run_date)
);
CREATE INDEX IF NOT EXISTS route_run_attendance_route_id_idx ON route_run_attendance(route_id, run_date);

ALTER TABLE route_run_attendance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "route_run_attendance_read" ON route_run_attendance FOR SELECT TO authenticated
  USING (is_route_owner(route_id) OR EXISTS (SELECT 1 FROM route_subscriptions rs WHERE rs.id = subscription_id AND rs.portal_user_id = current_portal_user_id()));

-- How many of this month's calendar days this route actually runs —
-- the denominator for "monthly fee ÷ scheduled days = one day's share."
CREATE OR REPLACE FUNCTION scheduled_days_in_month(p_route_id uuid, p_month int, p_year int) RETURNS int LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_days int[]; v_count int := 0; v_date date; v_last date;
BEGIN
  SELECT days_of_week INTO v_days FROM vehicle_routes WHERE id = p_route_id;
  IF v_days IS NULL THEN RETURN 1; END IF;
  v_date := make_date(p_year, p_month, 1);
  v_last := (v_date + interval '1 month - 1 day')::date;
  WHILE v_date <= v_last LOOP
    IF extract(dow FROM v_date)::int = ANY(v_days) THEN v_count := v_count + 1; END IF;
    v_date := v_date + 1;
  END LOOP;
  RETURN greatest(v_count, 1);
END;
$$;
GRANT EXECUTE ON FUNCTION scheduled_days_in_month(uuid, int, int) TO authenticated;

-- Real roll call — the driver marks who's actually on board (a rider
-- with no phone included, same as anyone else), and only a present
-- rider's day's share gets added to this month's running charge.
-- Idempotent per (subscription, date): re-submitting the same roster
-- is a no-op; changing someone's status later adjusts the charge by
-- the difference, not a fresh full charge.
CREATE OR REPLACE FUNCTION take_attendance(p_route_id uuid, p_run_date date, p_present_subscription_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r route_subscriptions%ROWTYPE;
  v_existing route_run_attendance%ROWTYPE;
  v_new_present boolean;
  v_daily_share numeric;
  v_month int := extract(month FROM p_run_date)::int;
  v_year int := extract(year FROM p_run_date)::int;
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only manage your own route.' USING ERRCODE = 'P0001'; END IF;

  FOR r IN SELECT * FROM route_subscriptions WHERE route_id = p_route_id AND status IN ('active', 'pending_cancellation') LOOP
    v_new_present := r.id = ANY(p_present_subscription_ids);
    v_daily_share := round(r.monthly_fee_pkr / scheduled_days_in_month(p_route_id, v_month, v_year));

    SELECT * INTO v_existing FROM route_run_attendance WHERE subscription_id = r.id AND run_date = p_run_date;

    IF NOT FOUND THEN
      INSERT INTO route_run_attendance (route_id, subscription_id, run_date, present, marked_by)
      VALUES (p_route_id, r.id, p_run_date, v_new_present, current_portal_user_id());

      IF v_new_present THEN
        INSERT INTO route_subscription_charges (subscription_id, month, year, amount_pkr)
        VALUES (r.id, v_month, v_year, v_daily_share)
        ON CONFLICT (subscription_id, month, year) DO UPDATE SET amount_pkr = route_subscription_charges.amount_pkr + v_daily_share
          WHERE route_subscription_charges.status = 'due';
      END IF;
    ELSIF v_existing.present != v_new_present THEN
      UPDATE route_run_attendance SET present = v_new_present, marked_at = now(), marked_by = current_portal_user_id() WHERE id = v_existing.id;
      UPDATE route_subscription_charges SET amount_pkr = greatest(0, amount_pkr + (CASE WHEN v_new_present THEN v_daily_share ELSE -v_daily_share END))
        WHERE subscription_id = r.id AND month = v_month AND year = v_year AND status = 'due';
    END IF;
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION take_attendance(uuid, date, uuid[]) TO authenticated;

-- start_route_run gains a direction — "now what is the procedure of
-- starting the ride back to home" — a day's return leg is just a
-- second run, same route, opposite direction; stops/live-ETA read this
-- to show reversed on the way back.
DROP FUNCTION IF EXISTS start_route_run(uuid);

CREATE OR REPLACE FUNCTION start_route_run(p_route_id uuid, p_direction varchar DEFAULT 'outbound') RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_route vehicle_routes%ROWTYPE;
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only start your own route.' USING ERRCODE = 'P0001'; END IF;
  IF p_direction NOT IN ('outbound', 'return') THEN RAISE EXCEPTION 'Invalid direction.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM route_runs WHERE route_id = p_route_id AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'This route already has an active run — end it before starting another.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;

  INSERT INTO route_runs (route_id, direction) VALUES (p_route_id, p_direction) RETURNING id INTO v_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT rp.portal_user_id, 'route_run_started', 'The van is on its way',
    (CASE WHEN p_direction = 'return' THEN v_route.destination || ' → ' || v_route.origin ELSE v_route.origin || ' → ' || v_route.destination END) || ' — live arrival times are now showing.',
    '/portal/marketplace/route/' || p_route_id
  FROM route_participants rp WHERE rp.route_id = p_route_id AND rp.is_active = true;

  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION start_route_run(uuid, varchar) TO authenticated;

-- The monthly cron no longer generates a flat charge — billing now
-- accrues per attended day via take_attendance(). It still handles the
-- notice-period expiry + waitlist promotion, unchanged.
CREATE OR REPLACE FUNCTION run_route_subscription_sweep() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM route_subscriptions WHERE status = 'pending_cancellation' AND scheduled_cancellation_at <= now() LOOP
    UPDATE route_subscriptions SET status = 'cancelled' WHERE id = r.id;
    PERFORM promote_next_waitlisted(r.route_id);
  END LOOP;
END;
$$;

-- route_group_detail gains today's runs (so the client knows whether
-- an outbound run already happened today, to offer "Start Return
-- Trip") and the run's own direction + today's attendance roster for
-- the owner's roll-call step.
CREATE OR REPLACE FUNCTION route_group_detail(p_route_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_is_owner boolean := is_route_owner(p_route_id);
  v_is_member boolean := is_route_member(p_route_id);
  v_sharing boolean := false;
  v_owner_portal_user_id uuid;
  v_route vehicle_routes%ROWTYPE;
  v_active_run route_runs%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  SELECT v.portal_user_id INTO v_owner_portal_user_id FROM vehicles v WHERE v.id = v_route.vehicle_id;
  SELECT * INTO v_active_run FROM route_runs WHERE route_id = p_route_id AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1;

  IF v_is_member THEN
    SELECT sharing_location INTO v_sharing FROM route_participants WHERE route_id = p_route_id AND portal_user_id = v_portal_user_id;
  END IF;

  RETURN jsonb_build_object(
    'is_owner', v_is_owner,
    'is_member', v_is_member,
    'sharing_location', coalesce(v_sharing, false),
    'owner_portal_user_id', v_owner_portal_user_id,
    'route_path', v_route.route_path,
    'route_duration_min', v_route.route_duration_min,
    'active_run', CASE WHEN v_active_run.id IS NOT NULL THEN jsonb_build_object('id', v_active_run.id, 'started_at', v_active_run.started_at, 'direction', v_active_run.direction) ELSE NULL END,
    'todays_runs', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'direction', direction, 'started_at', started_at, 'ended_at', ended_at) ORDER BY started_at), '[]'::jsonb)
      FROM route_runs WHERE route_id = p_route_id AND started_at::date = v_today),
    'stops', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'label', s.label, 'label_ur', s.label_ur, 'lat', s.lat, 'lng', s.lng) ORDER BY s.stop_order), '[]'::jsonb) FROM route_stops s WHERE s.route_id = p_route_id),
    'roster_today', CASE WHEN v_is_owner THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'subscription_id', rs.id, 'name', pu.full_name,
        'present', COALESCE((SELECT present FROM route_run_attendance ra WHERE ra.subscription_id = rs.id AND ra.run_date = v_today), true)
      ) ORDER BY rs.applied_at), '[]'::jsonb)
      FROM route_subscriptions rs JOIN portal_users pu ON pu.id = rs.portal_user_id
      WHERE rs.route_id = p_route_id AND rs.status IN ('active', 'pending_cancellation')
    ) ELSE '[]'::jsonb END,
    'participants', CASE WHEN v_is_member THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'portal_user_id', pu.id, 'name', pu.full_name, 'sharing_location', rp.sharing_location
      ) ORDER BY rp.joined_at), '[]'::jsonb)
      FROM route_participants rp JOIN portal_users pu ON pu.id = rp.portal_user_id
      WHERE rp.route_id = p_route_id AND rp.is_active = true
    ) ELSE '[]'::jsonb END,
    'messages', CASE WHEN v_is_member THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', m.id, 'sender_portal_user_id', m.sender_portal_user_id, 'sender_name', pu.full_name,
        'is_own', m.sender_portal_user_id = v_portal_user_id, 'body', m.body, 'created_at', m.created_at
      ) ORDER BY m.created_at), '[]'::jsonb)
      FROM route_chat_messages m JOIN portal_users pu ON pu.id = m.sender_portal_user_id
      WHERE m.route_id = p_route_id
    ) ELSE '[]'::jsonb END,
    'live_locations', CASE WHEN v_is_member THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'portal_user_id', pu.id, 'name', pu.full_name, 'is_own', rl.portal_user_id = v_portal_user_id,
        'is_owner', rl.portal_user_id = v_owner_portal_user_id,
        'lat', rl.lat, 'lng', rl.lng, 'updated_at', rl.updated_at
      )), '[]'::jsonb)
      FROM route_live_locations rl JOIN portal_users pu ON pu.id = rl.portal_user_id
      WHERE rl.route_id = p_route_id
    ) ELSE '[]'::jsonb END
  );
END;
$$;
GRANT EXECUTE ON FUNCTION route_group_detail(uuid) TO authenticated;
