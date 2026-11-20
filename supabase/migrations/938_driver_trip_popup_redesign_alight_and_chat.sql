-- ═════════════════════════════════════════════════════════════════════════
-- Migration 938: porting the new driver-live-trip.html design reference
-- into /portal/drive's trip popup. Two real gaps the user raised while
-- reviewing it, both confirmed by direct code audit before writing any
-- of this:
--
-- 1. "Alight alerts" (the design's per-rider offload button): there was
--    NO per-rider mid-route drop-off action anywhere in this codebase —
--    dropped_off_at was only ever bulk-set when the whole run ends
--    (end_route_run, 817) or an adda trip completes. A driver had no way
--    to mark one specific rider off at their own stop while others stay
--    on. Fixing that for real, not just visually.
--
-- 2. The user's own follow-up worry: "a passenger who wants to offboard
--    on the road near their destination, not at a fixed stop" — also
--    confirmed real: alighting has only ever been tied to a formal
--    route_stops row, picked at booking time, with zero live-GPS
--    equivalent to the catch feature's free-point boarding. Per the
--    user's explicit choice, this migration adds that symmetric
--    capability — a boarded rider can request to get off at any point
--    still ahead of the bus on the actual route road, reusing
--    route_catch_feasibility (859)'s exact projection math (boarding
--    and alighting share the same "is this point on my road, ahead of
--    where the bus is right now" question, just asked by someone
--    already on board instead of someone trying to join).
--
-- 3. The design's chat/"leave group" panel maps to route_chat_messages/
--    route_participants — the village-carpool system, deliberately
--    never used for fleet routes (this file's own driver page has a
--    comment saying so). Per the user's explicit choice, this adds a
--    NEW trip-scoped chat instead of reusing that system: generalizes
--    trip_group_messages (745/799, already generalized once from
--    offer-only to also cover adda) to also key off route_id +
--    travel_date, rather than inventing a third near-identical table.
-- ═════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Free-GPS alight request fields on ride_bookings. Nullable, additive.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS alight_request_lat numeric;
ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS alight_request_lng numeric;
ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS alight_requested_at timestamptz;

INSERT INTO site_settings (key, value, description) VALUES
  ('route_alight_alert_km', '2', 'How close (km) a route''s driver must get to a rider''s alight stop before they are alerted to get ready')
ON CONFLICT (tenant_id, key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. route_onboard_roster — every rider (self-booked or counter-walk-up)
-- currently boarded and not yet dropped off, for the driver's "who's on
-- board right now, where are they getting off" panel. route_today_ad_hoc_
-- bookings (935) already covers unboarded/catch rows for a different
-- card; this is the complementary onboard-only view, across BOTH booking
-- tables, with the alight stop's own coordinates resolved so distance-
-- to-stop can be computed client-side against the driver's live position
-- (same pattern RouteGroupPanel/the catch card already use — no new
-- server-side distance math needed for this part).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION route_onboard_roster(p_route_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
BEGIN
  IF NOT (is_route_owner(p_route_id) OR is_route_operator(p_route_id)) THEN RETURN '[]'::jsonb; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(row ORDER BY row->>'name'), '[]'::jsonb) FROM (
      SELECT jsonb_build_object(
        'source', 'ride_booking', 'id', rb.id, 'name', pu.full_name, 'mobile', pu.mobile, 'seats', rb.seats,
        'alight_stop_id', rb.alight_stop_id,
        'alight_label', CASE WHEN s.counter_id IS NOT NULL THEN fc.name || ' · ' || fc.city ELSE s.label END,
        'alight_lat', s.lat, 'alight_lng', s.lng,
        'alight_request_lat', rb.alight_request_lat, 'alight_request_lng', rb.alight_request_lng, 'alight_requested_at', rb.alight_requested_at,
        'is_mid_route_catch', rb.is_mid_route_catch, 'boarded_at', rb.boarded_at
      ) AS row
      FROM ride_bookings rb
      JOIN portal_users pu ON pu.id = rb.portal_user_id
      LEFT JOIN route_stops s ON s.id = rb.alight_stop_id
      LEFT JOIN fleet_counters fc ON fc.id = s.counter_id
      WHERE rb.route_id = p_route_id AND rb.travel_date = v_today AND rb.direction = 'outbound'
        AND rb.status IN ('announced', 'confirmed') AND rb.boarded_at IS NOT NULL AND rb.dropped_off_at IS NULL

      UNION ALL

      SELECT jsonb_build_object(
        'source', 'manual', 'id', mb.id, 'name', mb.passenger_name, 'mobile', mb.passenger_mobile, 'seats', mb.seats,
        'alight_stop_id', mb.alight_stop_id,
        'alight_label', CASE WHEN s2.counter_id IS NOT NULL THEN fc2.name || ' · ' || fc2.city ELSE s2.label END,
        'alight_lat', s2.lat, 'alight_lng', s2.lng,
        'alight_request_lat', NULL, 'alight_request_lng', NULL, 'alight_requested_at', NULL,
        'is_mid_route_catch', false, 'boarded_at', mb.boarded_at
      ) AS row
      FROM manual_ride_bookings mb
      LEFT JOIN route_stops s2 ON s2.id = mb.alight_stop_id
      LEFT JOIN fleet_counters fc2 ON fc2.id = s2.counter_id
      WHERE mb.route_id = p_route_id AND mb.travel_date = v_today AND mb.direction = 'outbound'
        AND mb.status = 'confirmed' AND mb.boarded_at IS NOT NULL AND mb.dropped_off_at IS NULL
    ) combined
  );
END;
$$;
REVOKE ALL ON FUNCTION route_onboard_roster(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION route_onboard_roster(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. mark_ride_booking_alighted — the actual "offload passenger" button,
-- for one specific rider, works for a formal-stop alert or a free-GPS
-- request alike (both just end with "they're off now"). p_source picks
-- which table, since the two bookings types' ids are drawn from
-- different tables with no shared namespace.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mark_ride_booking_alighted(p_booking_id uuid, p_source varchar DEFAULT 'ride_booking') RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route_id uuid; v_portal_user_id uuid; v_label text;
BEGIN
  IF p_source NOT IN ('ride_booking', 'manual') THEN RAISE EXCEPTION 'Invalid source.' USING ERRCODE = 'P0001'; END IF;

  IF p_source = 'ride_booking' THEN
    SELECT route_id, portal_user_id INTO v_route_id, v_portal_user_id FROM ride_bookings WHERE id = p_booking_id AND boarded_at IS NOT NULL AND dropped_off_at IS NULL FOR UPDATE;
    IF v_route_id IS NULL THEN RAISE EXCEPTION 'That booking is not currently on board.' USING ERRCODE = 'P0001'; END IF;
    IF NOT (is_route_owner(v_route_id) OR is_route_operator(v_route_id)) THEN RAISE EXCEPTION 'You can only manage your own route''s bookings.' USING ERRCODE = 'P0001'; END IF;
    UPDATE ride_bookings SET dropped_off_at = now() WHERE id = p_booking_id;
    SELECT vr.origin || ' → ' || vr.destination INTO v_label FROM vehicle_routes vr WHERE vr.id = v_route_id;
    IF v_portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (v_portal_user_id, 'rider_dropped_off', 'You''ve been dropped off', 'The driver has marked you as alighted' || CASE WHEN v_label IS NOT NULL THEN ' on ' || v_label ELSE '' END || '.', '/portal/marketplace/route/' || v_route_id);
    END IF;
  ELSE
    SELECT route_id INTO v_route_id FROM manual_ride_bookings WHERE id = p_booking_id AND boarded_at IS NOT NULL AND dropped_off_at IS NULL FOR UPDATE;
    IF v_route_id IS NULL THEN RAISE EXCEPTION 'That booking is not currently on board.' USING ERRCODE = 'P0001'; END IF;
    IF NOT (is_route_owner(v_route_id) OR is_route_operator(v_route_id)) THEN RAISE EXCEPTION 'You can only manage your own route''s bookings.' USING ERRCODE = 'P0001'; END IF;
    UPDATE manual_ride_bookings SET dropped_off_at = now() WHERE id = p_booking_id;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION mark_ride_booking_alighted(uuid, varchar) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Free-GPS alight request — feasibility check + submit + driver
-- decline. Reuses route_catch_feasibility (859) exactly as-is: the same
-- "is this point on my road, and not yet behind where the bus already
-- is" question catch asks of a point someone wants to BOARD at applies
-- unchanged to a point someone already on board wants to GET OFF at —
-- fraction_remaining decreases toward the destination either way, so
-- "not yet passed" (point's fraction <= driver's current fraction) means
-- the same thing in both directions. No new projection math needed, and
-- deliberately no "too far ahead" cap (859's v_max_ahead_km) — unlike a
-- catch, which the bus might never reach in time, an alight point is
-- always somewhere the bus is already guaranteed to drive through on
-- its own route before reaching the destination.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_mid_route_alight_feasibility(p_booking_id uuid, p_lat numeric, p_lng numeric) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b ride_bookings%ROWTYPE;
  v_owner_portal_user_id uuid;
  v_driver_lat numeric; v_driver_lng numeric; v_driver_age_minutes numeric;
  v_radius_km numeric;
  v_point_fraction numeric; v_point_distance_km numeric;
  v_driver_fraction numeric;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id;
  IF NOT FOUND OR b.portal_user_id != current_portal_user_id() THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF b.boarded_at IS NULL OR b.dropped_off_at IS NOT NULL THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'You can only request this once you''re on board.');
  END IF;

  SELECT v.portal_user_id INTO v_owner_portal_user_id FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id WHERE vr.id = b.route_id;
  SELECT rl.lat, rl.lng, round(extract(epoch FROM (now() - rl.updated_at)) / 60, 1)
    INTO v_driver_lat, v_driver_lng, v_driver_age_minutes
    FROM route_live_locations rl WHERE rl.route_id = b.route_id AND rl.portal_user_id = v_owner_portal_user_id;

  IF v_driver_lat IS NULL OR v_driver_age_minutes IS NULL OR v_driver_age_minutes > 5 THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'The driver''s live position isn''t available right now — try again in a moment.');
  END IF;

  SELECT COALESCE(value::numeric, 1.5) INTO v_radius_km FROM site_settings WHERE key = 'mid_route_catch_radius_km' LIMIT 1;

  SELECT fraction_remaining, distance_km INTO v_point_fraction, v_point_distance_km FROM route_catch_feasibility(b.route_id, p_lat, p_lng);
  SELECT fraction_remaining INTO v_driver_fraction FROM route_catch_feasibility(b.route_id, v_driver_lat, v_driver_lng);

  IF v_point_distance_km > coalesce(v_radius_km, 1.5) THEN
    RETURN jsonb_build_object('eligible', false, 'reason', format('That point is about %s km from the actual road — pick somewhere on the route.', round(v_point_distance_km, 1)), 'distance_km', v_point_distance_km);
  END IF;
  IF v_point_fraction > v_driver_fraction THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'The bus has already passed that point.', 'distance_km', v_point_distance_km);
  END IF;

  RETURN jsonb_build_object('eligible', true, 'reason', NULL, 'distance_km', v_point_distance_km);
END;
$$;
REVOKE ALL ON FUNCTION check_mid_route_alight_feasibility(uuid, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION check_mid_route_alight_feasibility(uuid, numeric, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION request_mid_route_alight(p_booking_id uuid, p_lat numeric, p_lng numeric) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b ride_bookings%ROWTYPE; v_feas jsonb; v_route vehicle_routes%ROWTYPE; v_owner_portal_user_id uuid;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND OR b.portal_user_id != current_portal_user_id() THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF b.boarded_at IS NULL OR b.dropped_off_at IS NOT NULL THEN RAISE EXCEPTION 'You can only request this once you''re on board.' USING ERRCODE = 'P0001'; END IF;

  v_feas := check_mid_route_alight_feasibility(p_booking_id, p_lat, p_lng);
  IF NOT (v_feas->>'eligible')::boolean THEN
    RAISE EXCEPTION '%', v_feas->>'reason' USING ERRCODE = 'P0001';
  END IF;

  UPDATE ride_bookings SET alight_request_lat = p_lat, alight_request_lng = p_lng, alight_requested_at = now() WHERE id = p_booking_id;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = b.route_id;
  SELECT v.portal_user_id INTO v_owner_portal_user_id FROM vehicles v WHERE v.id = v_route.vehicle_id;
  IF v_owner_portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_owner_portal_user_id, 'route_alight_request', 'A rider wants off up ahead',
      'A boarded rider has asked to get off at a specific point on the road, not at a regular stop — check the live trip screen.',
      '/portal/drive');
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION request_mid_route_alight(uuid, numeric, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION decline_mid_route_alight_request(p_booking_id uuid, p_reason text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b ride_bookings%ROWTYPE;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND OR NOT (is_route_owner(b.route_id) OR is_route_operator(b.route_id)) THEN
    RAISE EXCEPTION 'You can only manage your own route''s bookings.' USING ERRCODE = 'P0001';
  END IF;
  IF b.alight_requested_at IS NULL THEN RAISE EXCEPTION 'There is no pending alight request on this booking.' USING ERRCODE = 'P0001'; END IF;

  UPDATE ride_bookings SET alight_request_lat = NULL, alight_request_lng = NULL, alight_requested_at = NULL WHERE id = p_booking_id;

  IF b.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (b.portal_user_id, 'route_alight_request_declined', 'Can''t stop there',
      'The driver can''t drop you off at that exact point' || CASE WHEN p_reason IS NOT NULL AND trim(p_reason) != '' THEN ' — ' || p_reason ELSE '' END || ' — you''ll be dropped at your booked stop instead.',
      '/portal/marketplace/route/' || b.route_id);
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION decline_mid_route_alight_request(uuid, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. run_route_proximity_alerts (859, verbatim body below) — add a
-- second loop alerting boarded riders as the bus nears THEIR alight
-- stop, symmetric to the existing board-stop alert. Needs a `kind`
-- column on the sent-tracking table since the same stop can now have
-- two independent alert kinds (someone boards there, someone else
-- alights there) without colliding on the old (run_id, stop_id) key.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE route_stop_proximity_alerts_sent ADD COLUMN IF NOT EXISTS kind varchar NOT NULL DEFAULT 'board';
ALTER TABLE route_stop_proximity_alerts_sent DROP CONSTRAINT IF EXISTS route_stop_proximity_alerts_sent_run_id_stop_id_key;
ALTER TABLE route_stop_proximity_alerts_sent ADD CONSTRAINT route_stop_proximity_alerts_sent_run_stop_kind_key UNIQUE (run_id, stop_id, kind);

CREATE OR REPLACE FUNCTION run_route_proximity_alerts() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_threshold_km numeric; v_alight_threshold_km numeric;
  r record; stop record;
  v_owner_portal_user_id uuid;
  v_driver_lat numeric; v_driver_lng numeric; v_driver_age_minutes numeric;
  v_dist numeric;
BEGIN
  SELECT COALESCE(value::numeric, 2) INTO v_threshold_km FROM site_settings WHERE key = 'route_proximity_alert_km' LIMIT 1;
  SELECT COALESCE(value::numeric, 2) INTO v_alight_threshold_km FROM site_settings WHERE key = 'route_alight_alert_km' LIMIT 1;

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
    IF v_driver_lat IS NULL OR v_driver_age_minutes IS NULL OR v_driver_age_minutes > 5 THEN CONTINUE; END IF;

    FOR stop IN SELECT s.id, s.label, s.lat::decimal AS lat, s.lng::decimal AS lng FROM route_stops s WHERE s.route_id = r.route_id AND s.stop_order > 0
    LOOP
      v_dist := haversine_km(v_driver_lat, v_driver_lng, stop.lat, stop.lng);

      IF v_dist <= v_threshold_km AND NOT EXISTS (SELECT 1 FROM route_stop_proximity_alerts_sent a WHERE a.run_id = r.run_id AND a.stop_id = stop.id AND a.kind = 'board') THEN
        INSERT INTO route_stop_proximity_alerts_sent (run_id, stop_id, kind) VALUES (r.run_id, stop.id, 'board');

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

      -- New: alert a boarded rider that THEIR alight stop is close, so
      -- they start gathering their things before the driver offloads
      -- them — the rider-facing half of the same "approaching" signal
      -- the driver's own live-trip popup shows for the alight card.
      IF v_dist <= v_alight_threshold_km AND NOT EXISTS (SELECT 1 FROM route_stop_proximity_alerts_sent a WHERE a.run_id = r.run_id AND a.stop_id = stop.id AND a.kind = 'alight') THEN
        INSERT INTO route_stop_proximity_alerts_sent (run_id, stop_id, kind) VALUES (r.run_id, stop.id, 'alight');

        INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
        SELECT rb.portal_user_id, 'route_alight_approaching', 'Get ready to get off',
          'Your stop, ' || stop.label || ', is about ' || round(v_dist, 1) || ' km away.',
          '/portal/marketplace/route/' || r.route_id, r.tenant_id
        FROM ride_bookings rb
        WHERE rb.route_id = r.route_id AND rb.alight_stop_id = stop.id
          AND rb.travel_date = (now() AT TIME ZONE 'Asia/Karachi')::date AND rb.status IN ('announced', 'confirmed')
          AND rb.boarded_at IS NOT NULL AND rb.dropped_off_at IS NULL;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION run_route_proximity_alerts() FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Trip-scoped chat — generalize trip_group_messages (745, widened to
-- also cover adda in 799) a second time rather than building a third
-- near-identical table. route_id + travel_date together are the new
-- discriminator (a route trip has no single "entry id" the way an offer
-- or an adda queue entry does — travel_date is what scopes a route's
-- otherwise-persistent id to just today's run, same scoping ride_
-- bookings itself already uses everywhere).
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE trip_group_messages ADD COLUMN IF NOT EXISTS route_trip_route_id uuid REFERENCES vehicle_routes(id) ON DELETE CASCADE;
ALTER TABLE trip_group_messages ADD COLUMN IF NOT EXISTS route_trip_travel_date date;
ALTER TABLE trip_group_messages DROP CONSTRAINT IF EXISTS trip_group_messages_exactly_one_ref;
ALTER TABLE trip_group_messages ADD CONSTRAINT trip_group_messages_exactly_one_ref CHECK (
  (trip_offer_id IS NOT NULL)::int + (adda_queue_entry_id IS NOT NULL)::int + (route_trip_route_id IS NOT NULL)::int = 1
);
ALTER TABLE trip_group_messages ADD CONSTRAINT trip_group_messages_route_trip_date_pairs CHECK (
  (route_trip_route_id IS NULL) = (route_trip_travel_date IS NULL)
);
CREATE INDEX IF NOT EXISTS trip_group_messages_route_trip_idx ON trip_group_messages(route_trip_route_id, route_trip_travel_date, created_at) WHERE route_trip_route_id IS NOT NULL;

-- Route-trip membership: the route's own driver/co-driver/substitute/
-- shift-driver (is_route_operator, already the exact gate the rest of
-- /portal/drive uses), or anyone with a real (not cancelled/rejected)
-- booking on that route for that date. Manual/counter walk-up riders
-- have no portal account and are correctly left out — same as every
-- other app-only feature in this codebase.
CREATE OR REPLACE FUNCTION is_party_to_route_trip(p_route_id uuid, p_travel_date date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(current_admin_permission('manage_parties'), false)
    OR is_route_owner(p_route_id) OR is_route_operator(p_route_id)
    OR EXISTS (
      SELECT 1 FROM ride_bookings rb
      WHERE rb.route_id = p_route_id AND rb.travel_date = p_travel_date
        AND rb.portal_user_id = current_portal_user_id() AND rb.status IN ('announced', 'confirmed')
    );
$$;
REVOKE ALL ON FUNCTION is_party_to_route_trip(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_party_to_route_trip(uuid, date) TO authenticated;

CREATE POLICY "trip_group_messages_route_trip_parties_read" ON trip_group_messages FOR SELECT TO authenticated
  USING (route_trip_route_id IS NOT NULL AND is_party_to_route_trip(route_trip_route_id, route_trip_travel_date));

CREATE OR REPLACE FUNCTION route_trip_chat_messages(p_route_id uuid, p_travel_date date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN NOT is_party_to_route_trip(p_route_id, p_travel_date) THEN '[]'::jsonb ELSE COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', m.id, 'sender_role', m.sender_role, 'sender_name', pu.full_name,
      'is_me', m.sender_portal_user_id = current_portal_user_id(),
      'body', m.body, 'created_at', m.created_at
    ) ORDER BY m.created_at ASC)
    FROM trip_group_messages m JOIN portal_users pu ON pu.id = m.sender_portal_user_id
    WHERE m.route_trip_route_id = p_route_id AND m.route_trip_travel_date = p_travel_date
  ), '[]'::jsonb) END;
$$;
REVOKE ALL ON FUNCTION route_trip_chat_messages(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION route_trip_chat_messages(uuid, date) TO authenticated;

CREATE OR REPLACE FUNCTION send_route_trip_message(p_route_id uuid, p_travel_date date, p_body text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE; v_owner_portal_user_id uuid; v_role varchar; v_msg_id uuid; v_sender_name text;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_body IS NULL OR trim(p_body) = '' THEN RAISE EXCEPTION 'Message cannot be empty.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT v.portal_user_id INTO v_owner_portal_user_id FROM vehicles v WHERE v.id = v_route.vehicle_id;

  IF is_route_owner(p_route_id) OR is_route_operator(p_route_id) THEN v_role := 'driver';
  ELSIF EXISTS (SELECT 1 FROM ride_bookings rb WHERE rb.route_id = p_route_id AND rb.travel_date = p_travel_date AND rb.portal_user_id = v_portal_user_id AND rb.status IN ('announced', 'confirmed')) THEN v_role := 'rider';
  ELSE RAISE EXCEPTION 'You are not part of this trip.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO trip_group_messages (route_trip_route_id, route_trip_travel_date, sender_portal_user_id, sender_role, body)
  VALUES (p_route_id, p_travel_date, v_portal_user_id, v_role, trim(p_body))
  RETURNING id INTO v_msg_id;

  SELECT full_name INTO v_sender_name FROM portal_users WHERE id = v_portal_user_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT DISTINCT pu_id, 'trip_group_message', v_sender_name || ' (' || v_route.origin || ' → ' || v_route.destination || ')', trim(p_body),
    CASE WHEN pu_id = v_owner_portal_user_id THEN '/portal/drive' ELSE '/portal/marketplace/route/' || p_route_id END
  FROM (
    SELECT v_owner_portal_user_id AS pu_id WHERE v_owner_portal_user_id IS NOT NULL AND v_owner_portal_user_id != v_portal_user_id
    UNION
    SELECT rb.portal_user_id FROM ride_bookings rb WHERE rb.route_id = p_route_id AND rb.travel_date = p_travel_date AND rb.status IN ('announced', 'confirmed') AND rb.portal_user_id != v_portal_user_id
  ) parties(pu_id);

  RETURN v_msg_id;
END;
$$;
REVOKE ALL ON FUNCTION send_route_trip_message(uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION send_route_trip_message(uuid, date, text) TO authenticated;
