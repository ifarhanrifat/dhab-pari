-- Migration 880: real gap caught live while verifying 879 — after a
-- mid-route handover, the co-driver who is now actually driving
-- couldn't end the run themselves (confirmed via curl: "You can only
-- end your own route's run"), because end_route_run/mark_run_arrived/
-- board_ride_bookings all gate on is_route_owner(), which only knows
-- about can_manage_vehicle() and the (separate, whole-day)
-- route_run_substitutions mechanism — it has no idea 879's
-- route_run_driver_shifts exists.
--
-- Deliberately NOT widening is_route_owner() itself — it also gates
-- route configuration/pricing (update_vehicle_route_schedule,
-- set_route_monthly_pricing, create_route_stop, ...), and a temporarily
-- shuffled-in co-driver shouldn't pick up rights to edit the route's
-- schedule or fares just by being the one currently driving. A new,
-- narrower function instead, swapped in only for the genuinely
-- operational actions a driver performs WHILE actively driving.

CREATE OR REPLACE FUNCTION is_route_operator(p_route_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT is_route_owner(p_route_id) OR EXISTS (
    SELECT 1 FROM route_runs rr JOIN route_run_driver_shifts sh ON sh.route_run_id = rr.id
    WHERE rr.route_id = p_route_id AND rr.ended_at IS NULL AND sh.ended_at IS NULL AND sh.driver_portal_user_id = current_portal_user_id()
  );
$$;
REVOKE ALL ON FUNCTION is_route_operator(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_route_operator(uuid) TO authenticated;

-- end_route_run — same signature as 879's own version, true replace.
CREATE OR REPLACE FUNCTION end_route_run(p_route_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route vehicle_routes%ROWTYPE; v_direction varchar; v_run_id uuid; v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_dropped_off_riders uuid[];
BEGIN
  IF NOT is_route_operator(p_route_id) THEN RAISE EXCEPTION 'You can only end your own route''s run.' USING ERRCODE = 'P0001'; END IF;
  UPDATE route_runs SET ended_at = now() WHERE route_id = p_route_id AND ended_at IS NULL
    RETURNING id, direction INTO v_run_id, v_direction;

  IF v_direction IS NULL THEN RETURN; END IF;

  UPDATE route_run_driver_shifts SET ended_at = now() WHERE route_run_id = v_run_id AND ended_at IS NULL;

  WITH dropped AS (
    UPDATE ride_bookings SET dropped_off_at = now()
    WHERE route_id = p_route_id AND travel_date = v_today AND boarded_at IS NOT NULL AND dropped_off_at IS NULL
    RETURNING portal_user_id
  )
  SELECT array_agg(portal_user_id) INTO v_dropped_off_riders FROM dropped;

  IF v_dropped_off_riders IS NOT NULL THEN
    UPDATE route_participants SET is_active = false, sharing_location = false
    WHERE route_id = p_route_id AND portal_user_id = ANY(v_dropped_off_riders);
  END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT rp.portal_user_id, 'route_run_ended',
    CASE WHEN v_direction = 'return' THEN 'Back at ' || v_route.origin ELSE 'Trip finished' END,
    CASE WHEN v_direction = 'return'
      THEN 'The return trip from ' || v_route.destination || ' has finished.'
      ELSE v_route.origin || ' → ' || v_route.destination || ' has finished for today.' END,
    '/portal/marketplace/route/' || p_route_id
  FROM route_participants rp WHERE rp.route_id = p_route_id AND rp.is_active = true;
END;
$$;

-- mark_run_arrived — same signature as 775's live version.
CREATE OR REPLACE FUNCTION mark_run_arrived(p_run_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run route_runs%ROWTYPE; v_route vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM route_runs WHERE id = p_run_id;
  IF NOT FOUND OR NOT is_route_operator(v_run.route_id) THEN RAISE EXCEPTION 'You can only manage your own route''s runs.' USING ERRCODE = 'P0001'; END IF;
  IF v_run.direction != 'outbound' THEN RAISE EXCEPTION 'Only the outbound leg has an arrival to mark.' USING ERRCODE = 'P0001'; END IF;
  IF v_run.ended_at IS NOT NULL THEN RAISE EXCEPTION 'This run has already ended.' USING ERRCODE = 'P0001'; END IF;

  UPDATE route_runs SET outbound_arrived_at = now() WHERE id = p_run_id;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = v_run.route_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT rp.portal_user_id, 'route_run_arrived', 'Arrived at ' || v_route.destination,
    'The van has reached ' || v_route.destination || '.',
    '/portal/marketplace/route/' || v_run.route_id
  FROM route_participants rp WHERE rp.route_id = v_run.route_id AND rp.is_active = true;
END;
$$;

-- board_ride_bookings — same signature as 875's live version.
CREATE OR REPLACE FUNCTION board_ride_bookings(p_booking_ids uuid[], p_luggage_note varchar DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; b ride_bookings%ROWTYPE; v_owner_ok boolean;
BEGIN
  FOREACH v_id IN ARRAY p_booking_ids LOOP
    SELECT * INTO b FROM ride_bookings WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF b.status NOT IN ('announced', 'confirmed') OR b.boarded_at IS NOT NULL THEN CONTINUE; END IF;

    IF b.route_id IS NOT NULL THEN
      v_owner_ok := is_route_operator(b.route_id);
    ELSE
      SELECT EXISTS (SELECT 1 FROM adda_queue_entries e JOIN vehicles v ON v.id = e.vehicle_id WHERE e.id = b.adda_queue_entry_id AND v.portal_user_id = current_portal_user_id()) INTO v_owner_ok;
    END IF;
    IF NOT v_owner_ok THEN RAISE EXCEPTION 'You do not manage this booking''s vehicle.' USING ERRCODE = 'P0001'; END IF;

    UPDATE ride_bookings SET boarded_at = now(), luggage_note = COALESCE(nullif(trim(coalesce(p_luggage_note, '')), ''), luggage_note) WHERE id = v_id;
    DELETE FROM ride_booking_catch_locations WHERE ride_booking_id = v_id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (b.portal_user_id, 'rider_boarded', 'You''re on board', 'The driver has marked you as boarded.',
      CASE WHEN b.route_id IS NOT NULL THEN '/portal/marketplace/route/' || b.route_id ELSE '/portal/marketplace/buses' END);
  END LOOP;
END;
$$;
