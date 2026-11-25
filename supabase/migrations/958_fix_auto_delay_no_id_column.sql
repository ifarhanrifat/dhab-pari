-- Migration 958: critical fix caught by live testing — route_day_delays
-- (migration 900) has composite PRIMARY KEY (route_id, travel_date,
-- direction) and NO `id` column at all. auto_check_route_delay (956)
-- referenced v_existing.id in three places, which threw
-- "record v_existing has no field id" (42703) on every call where the
-- route has route_duration_min set and an active run exists — not just
-- breaking delay detection, but making the PERFORM inside
-- ping_route_location raise, which rolled back the whole ping call.
-- Fix: capture FOUND into a boolean right after the SELECT, and key
-- the DELETE off the real composite columns instead of a nonexistent id.

CREATE OR REPLACE FUNCTION auto_check_route_delay(p_route_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_route vehicle_routes%ROWTYPE;
  v_run route_runs%ROWTYPE;
  v_existing route_day_delays%ROWTYPE;
  v_existing_found boolean;
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
  v_existing_found := FOUND;
  IF v_existing_found AND NOT v_existing.auto_detected THEN RETURN; END IF;

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

  IF NOT v_existing_found THEN
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
      DELETE FROM route_day_delays WHERE route_id = p_route_id AND travel_date = v_today AND direction = v_run.direction;
      INSERT INTO portal_notifications (portal_user_id, event_type, title, title_ur, body, body_ur, link)
      SELECT DISTINCT rb.portal_user_id, 'route_delay_cleared', 'Back on time', 'وقت پر واپس آ گئی',
        v_route.origin || ' → ' || v_route.destination || ' is running on time again.',
        v_origin_ur || ' سے ' || v_destination_ur || ' کا سفر دوبارہ وقت پر چل رہا ہے۔',
        '/portal/marketplace/route/' || p_route_id
      FROM ride_bookings rb WHERE rb.route_id = p_route_id AND rb.travel_date = v_today AND rb.direction = v_run.direction
        AND rb.status IN ('announced', 'confirmed');
    ELSIF round(v_behind_min)::int != v_existing.delay_minutes THEN
      UPDATE route_day_delays SET delay_minutes = round(v_behind_min)::int WHERE route_id = p_route_id AND travel_date = v_today AND direction = v_run.direction;
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION auto_check_route_delay(uuid) FROM PUBLIC, anon, authenticated;
