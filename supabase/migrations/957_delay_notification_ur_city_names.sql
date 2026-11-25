-- Migration 957: small follow-up to 956, caught by testing it live —
-- the Urdu notification text built the sentence structure in Urdu but
-- still spliced in origin/destination literally (v_route.origin), so a
-- route with real origin_ur/destination_ur set (every other bilingual
-- surface in this app already prefers those) ended up with English
-- city names sitting inside an otherwise-Urdu sentence. True-replace of
-- both functions 956 added — same bodies, only the two bilingual
-- notification inserts changed to COALESCE(origin_ur, origin) /
-- COALESCE(destination_ur, destination) for the _ur columns specifically.

CREATE OR REPLACE FUNCTION set_route_day_delay(
  p_route_id uuid, p_travel_date date, p_direction varchar DEFAULT 'outbound',
  p_delay_minutes int DEFAULT NULL, p_note varchar DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_vehicle_id uuid; v_route vehicle_routes%ROWTYPE; v_was_delayed boolean;
  v_origin_ur varchar; v_destination_ur varchar;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  v_origin_ur := COALESCE(v_route.origin_ur, v_route.origin);
  v_destination_ur := COALESCE(v_route.destination_ur, v_route.destination);

  v_was_delayed := EXISTS (SELECT 1 FROM route_day_delays WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction);

  IF p_delay_minutes IS NULL OR p_delay_minutes <= 0 THEN
    DELETE FROM route_day_delays WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction;
    IF v_was_delayed THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, title_ur, body, body_ur, link)
      SELECT DISTINCT rb.portal_user_id, 'route_delay_cleared', 'Back on time', 'وقت پر واپس آ گئی',
        v_route.origin || ' → ' || v_route.destination || ' is running on time again.',
        v_origin_ur || ' سے ' || v_destination_ur || ' کا سفر دوبارہ وقت پر چل رہا ہے۔',
        '/portal/marketplace/route/' || p_route_id
      FROM ride_bookings rb WHERE rb.route_id = p_route_id AND rb.travel_date = p_travel_date AND rb.direction = p_direction
        AND rb.status IN ('announced', 'confirmed');
    END IF;
  ELSE
    INSERT INTO route_day_delays (route_id, travel_date, direction, delay_minutes, note, marked_by, auto_detected)
    VALUES (p_route_id, p_travel_date, p_direction, p_delay_minutes, nullif(trim(coalesce(p_note, '')), ''), current_portal_user_id(), false)
    ON CONFLICT (route_id, travel_date, direction) DO UPDATE SET
      delay_minutes = p_delay_minutes, note = nullif(trim(coalesce(p_note, '')), ''), marked_by = current_portal_user_id(), marked_at = now(), auto_detected = false;

    INSERT INTO portal_notifications (portal_user_id, event_type, title, title_ur, body, body_ur, link)
    SELECT DISTINCT rb.portal_user_id, 'route_delayed', 'Running late', 'تاخیر سے چل رہی ہے',
      v_route.origin || ' → ' || v_route.destination || ' is running about ' || p_delay_minutes || ' minutes late.'
        || CASE WHEN p_note IS NOT NULL AND trim(p_note) != '' THEN ' ' || p_note ELSE '' END,
      v_origin_ur || ' سے ' || v_destination_ur || ' کا سفر تقریباً ' || p_delay_minutes || ' منٹ تاخیر سے چل رہا ہے۔'
        || CASE WHEN p_note IS NOT NULL AND trim(p_note) != '' THEN ' ' || p_note ELSE '' END,
      '/portal/marketplace/route/' || p_route_id
    FROM ride_bookings rb WHERE rb.route_id = p_route_id AND rb.travel_date = p_travel_date AND rb.direction = p_direction
      AND rb.status IN ('announced', 'confirmed');
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION set_route_day_delay(uuid, date, varchar, int, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_route_day_delay(uuid, date, varchar, int, varchar) TO authenticated;

CREATE OR REPLACE FUNCTION auto_check_route_delay(p_route_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_route vehicle_routes%ROWTYPE;
  v_run route_runs%ROWTYPE;
  v_existing route_day_delays%ROWTYPE;
  v_driver_portal_user_id uuid;
  v_driver_lat numeric; v_driver_lng numeric;
  v_elapsed_min numeric; v_actual_fraction numeric; v_expected_fraction numeric; v_behind_min numeric;
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_origin_ur varchar; v_destination_ur varchar;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF v_route.route_duration_min IS NULL OR v_route.route_duration_min <= 0 THEN RETURN; END IF;
  v_origin_ur := COALESCE(v_route.origin_ur, v_route.origin);
  v_destination_ur := COALESCE(v_route.destination_ur, v_route.destination);

  SELECT * INTO v_run FROM route_runs WHERE route_id = p_route_id AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1;
  IF v_run.id IS NULL THEN RETURN; END IF;

  SELECT * INTO v_existing FROM route_day_delays WHERE route_id = p_route_id AND travel_date = v_today AND direction = v_run.direction;
  IF v_existing.id IS NOT NULL AND NOT v_existing.auto_detected THEN RETURN; END IF;

  SELECT sh.driver_portal_user_id INTO v_driver_portal_user_id
    FROM route_run_driver_shifts sh WHERE sh.route_run_id = v_run.id AND sh.ended_at IS NULL LIMIT 1;
  IF v_driver_portal_user_id IS NULL THEN RETURN; END IF;

  SELECT rl.lat, rl.lng INTO v_driver_lat, v_driver_lng
    FROM route_live_locations rl WHERE rl.route_id = p_route_id AND rl.portal_user_id = v_driver_portal_user_id;
  IF v_driver_lat IS NULL THEN RETURN; END IF;

  SELECT fraction_remaining INTO v_actual_fraction FROM route_catch_feasibility(p_route_id, v_driver_lat, v_driver_lng);
  IF v_actual_fraction IS NULL THEN RETURN; END IF;

  v_elapsed_min := extract(epoch FROM (now() - v_run.started_at)) / 60;
  IF v_run.direction = 'return' THEN
    v_expected_fraction := least(1, greatest(0, v_elapsed_min / v_route.route_duration_min));
    v_behind_min := (v_expected_fraction - v_actual_fraction) * v_route.route_duration_min;
  ELSE
    v_expected_fraction := least(1, greatest(0, 1 - v_elapsed_min / v_route.route_duration_min));
    v_behind_min := (v_actual_fraction - v_expected_fraction) * v_route.route_duration_min;
  END IF;

  IF v_existing.id IS NULL THEN
    IF v_behind_min >= 10 THEN
      INSERT INTO route_day_delays (route_id, travel_date, direction, delay_minutes, note, marked_by, auto_detected)
      VALUES (p_route_id, v_today, v_run.direction, round(v_behind_min)::int, 'Estimated automatically from the vehicle''s live location.', v_driver_portal_user_id, true);

      INSERT INTO portal_notifications (portal_user_id, event_type, title, title_ur, body, body_ur, link)
      SELECT DISTINCT rb.portal_user_id, 'route_delayed', 'Running late', 'تاخیر سے چل رہی ہے',
        v_route.origin || ' → ' || v_route.destination || ' is running about ' || round(v_behind_min)::int || ' minutes late (estimated from its live location).',
        v_origin_ur || ' سے ' || v_destination_ur || ' کا سفر تقریباً ' || round(v_behind_min)::int || ' منٹ تاخیر سے چل رہا ہے (گاڑی کی لائیو لوکیشن سے تخمینہ)۔',
        '/portal/marketplace/route/' || p_route_id
      FROM ride_bookings rb WHERE rb.route_id = p_route_id AND rb.travel_date = v_today AND rb.direction = v_run.direction
        AND rb.status IN ('announced', 'confirmed');
    END IF;
  ELSE
    IF v_behind_min <= 5 THEN
      DELETE FROM route_day_delays WHERE id = v_existing.id;
      INSERT INTO portal_notifications (portal_user_id, event_type, title, title_ur, body, body_ur, link)
      SELECT DISTINCT rb.portal_user_id, 'route_delay_cleared', 'Back on time', 'وقت پر واپس آ گئی',
        v_route.origin || ' → ' || v_route.destination || ' is running on time again.',
        v_origin_ur || ' سے ' || v_destination_ur || ' کا سفر دوبارہ وقت پر چل رہا ہے۔',
        '/portal/marketplace/route/' || p_route_id
      FROM ride_bookings rb WHERE rb.route_id = p_route_id AND rb.travel_date = v_today AND rb.direction = v_run.direction
        AND rb.status IN ('announced', 'confirmed');
    ELSIF round(v_behind_min)::int != v_existing.delay_minutes THEN
      UPDATE route_day_delays SET delay_minutes = round(v_behind_min)::int WHERE id = v_existing.id;
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION auto_check_route_delay(uuid) FROM PUBLIC, anon, authenticated;
