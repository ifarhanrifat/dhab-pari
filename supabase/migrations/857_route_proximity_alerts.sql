-- Migration 857: fleet accounting, Phase 2c — proactive "your bus is
-- approaching" rider notifications. Confirmed mechanically trivial on
-- the delivery side (portal_notifications already auto-delivers via
-- in-app + Web Push + native FCM with zero extra wiring, migration 348/
-- 558) — the only real work is the trigger condition: how close the
-- driver's live position (route_live_locations, 717) has to get to a
-- rider's actual board stop before alerting, and not re-alerting the
-- same stop over and over for the same run.
--
-- Runs as a cron sweep, same idiom as run_stale_booking_sweep (711) —
-- a direct table scan + notification inserts, no session/JWT context
-- needed (cron has none), safe because nothing financial posts here.

CREATE TABLE IF NOT EXISTS route_stop_proximity_alerts_sent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES route_runs(id) ON DELETE CASCADE,
  stop_id uuid NOT NULL REFERENCES route_stops(id) ON DELETE CASCADE,
  sent_at timestamptz DEFAULT now(),
  UNIQUE (run_id, stop_id)
);
REVOKE ALL ON TABLE route_stop_proximity_alerts_sent FROM PUBLIC, anon, authenticated;

INSERT INTO site_settings (key, value, description) VALUES
  ('route_proximity_alert_km', '2', 'How close (km) a route''s driver must get to a stop before riders boarding there are alerted')
ON CONFLICT (tenant_id, key) DO NOTHING;

CREATE OR REPLACE FUNCTION run_route_proximity_alerts() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_threshold_km numeric;
  r record; stop record;
  v_owner_portal_user_id uuid;
  v_driver_lat numeric; v_driver_lng numeric; v_driver_age_minutes numeric;
  v_dist numeric;
BEGIN
  SELECT COALESCE(value::numeric, 2) INTO v_threshold_km FROM site_settings WHERE key = 'route_proximity_alert_km' LIMIT 1;

  FOR r IN
    SELECT run.id AS run_id, vr.id AS route_id, vr.vehicle_id, vr.origin, vr.destination, vr.tenant_id
    FROM route_runs run JOIN vehicle_routes vr ON vr.id = run.route_id
    WHERE run.ended_at IS NULL
  LOOP
    SELECT v.portal_user_id INTO v_owner_portal_user_id FROM vehicles v WHERE v.id = r.vehicle_id;
    IF v_owner_portal_user_id IS NULL THEN CONTINUE; END IF;

    SELECT rl.lat, rl.lng, round(extract(epoch FROM (now() - rl.updated_at)) / 60, 1)
      INTO v_driver_lat, v_driver_lng, v_driver_age_minutes
      FROM route_live_locations rl WHERE rl.route_id = r.route_id AND rl.portal_user_id = v_owner_portal_user_id;
    -- Fails closed, same 5-minute staleness convention as check_catch_
    -- feasibility (850) and nearby_open_trips (415) — no fresh position
    -- on file means no alert, not a guess.
    IF v_driver_lat IS NULL OR v_driver_age_minutes IS NULL OR v_driver_age_minutes > 5 THEN CONTINUE; END IF;

    -- stop_order > 0 skips the route's own backfilled origin stop (848)
    -- — a rider boarding at origin is already there when the vehicle
    -- departs, alerting them about "approaching" their own start point
    -- would just be a false trigger the instant the run starts.
    FOR stop IN SELECT s.id, s.label FROM route_stops s WHERE s.route_id = r.route_id AND s.stop_order > 0
    LOOP
      SELECT haversine_km(v_driver_lat, v_driver_lng, s.lat, s.lng) INTO v_dist FROM route_stops s WHERE s.id = stop.id;

      IF v_dist <= v_threshold_km AND NOT EXISTS (SELECT 1 FROM route_stop_proximity_alerts_sent a WHERE a.run_id = r.run_id AND a.stop_id = stop.id) THEN
        INSERT INTO route_stop_proximity_alerts_sent (run_id, stop_id) VALUES (r.run_id, stop.id);

        INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
        SELECT rb.portal_user_id, 'route_bus_approaching', 'Your bus is approaching',
          'The vehicle for ' || r.origin || ' → ' || r.destination || ' is about ' || round(v_dist, 1) || ' km from ' || stop.label || ' — be ready.',
          '/portal/marketplace/route/' || r.route_id, r.tenant_id
        FROM ride_bookings rb
        WHERE rb.route_id = r.route_id AND rb.board_stop_id = stop.id
          AND rb.travel_date = (now() AT TIME ZONE 'Asia/Karachi')::date AND rb.status IN ('announced', 'confirmed');

        INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
        SELECT rs.portal_user_id, 'route_bus_approaching', 'Your bus is approaching',
          'The vehicle for ' || r.origin || ' → ' || r.destination || ' is about ' || round(v_dist, 1) || ' km from ' || stop.label || ' — be ready.',
          '/portal/marketplace/route/' || r.route_id, r.tenant_id
        FROM route_subscriptions rs
        WHERE rs.route_id = r.route_id AND rs.board_stop_id = stop.id AND rs.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM route_subscription_leave_days ld WHERE ld.subscription_id = rs.id AND ld.leave_date = (now() AT TIME ZONE 'Asia/Karachi')::date);
      END IF;
    END LOOP;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION run_route_proximity_alerts() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('route-proximity-alerts', '*/2 * * * *', $$SELECT run_route_proximity_alerts()$$);
