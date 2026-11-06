-- Migration 817: real ask, 2026-11-06 — "when driver select all his
-- vehicle bookings on board them like a real school present system
-- works then the ride floating button is now shown on board... and
-- this floating booking button will disappear when the booking end at
-- destination." Confirmed bug: the driver's floating button
-- (FloatingBookingsHub) never queried routes/adda by vehicle ownership
-- at all — only by the viewer's own portal_user_id as a rider. Fixing
-- that properly means building the onboard concept this asks for,
-- which then drives the floating button, rather than patching the old
-- query.
--
-- take_attendance (724/775) already is the "school register" roster
-- model, scoped to monthly route_subscriptions only. ride_bookings
-- (ad-hoc route + adda seat bookings) has never had any per-rider
-- boarding concept — only offboard_rider (727), which excludes a rider
-- from a two-way route's RETURN leg, a different thing entirely.

ALTER TABLE ride_bookings ADD COLUMN boarded_at timestamptz;
ALTER TABLE ride_bookings ADD COLUMN dropped_off_at timestamptz;

-- Bulk onboard — mirrors take_attendance's own array-batch convention
-- ("check several, confirm once"). Owner-gated per row since a single
-- call could in principle span more than one of the caller's vehicles.
CREATE OR REPLACE FUNCTION board_ride_bookings(p_booking_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; b ride_bookings%ROWTYPE; v_owner_ok boolean;
BEGIN
  FOREACH v_id IN ARRAY p_booking_ids LOOP
    SELECT * INTO b FROM ride_bookings WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF b.status NOT IN ('announced', 'confirmed') OR b.boarded_at IS NOT NULL THEN CONTINUE; END IF;

    IF b.route_id IS NOT NULL THEN
      SELECT EXISTS (SELECT 1 FROM vehicle_routes r JOIN vehicles v ON v.id = r.vehicle_id WHERE r.id = b.route_id AND v.portal_user_id = current_portal_user_id()) INTO v_owner_ok;
    ELSE
      SELECT EXISTS (SELECT 1 FROM adda_queue_entries e JOIN vehicles v ON v.id = e.vehicle_id WHERE e.id = b.adda_queue_entry_id AND v.portal_user_id = current_portal_user_id()) INTO v_owner_ok;
    END IF;
    IF NOT v_owner_ok THEN RAISE EXCEPTION 'You do not manage this booking''s vehicle.' USING ERRCODE = 'P0001'; END IF;

    UPDATE ride_bookings SET boarded_at = now() WHERE id = v_id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (b.portal_user_id, 'rider_boarded', 'You''re on board', 'The driver has marked you as boarded.',
      CASE WHEN b.route_id IS NOT NULL THEN '/portal/marketplace/route/' || b.route_id ELSE '/portal/marketplace/buses' END);
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION board_ride_bookings(uuid[]) TO authenticated;

-- end_route_run (775): ending the run IS "we reached the destination"
-- for ad-hoc riders on that route — no separate per-rider drop-off tap
-- needed. Everything else in this function is unchanged from 775.
CREATE OR REPLACE FUNCTION end_route_run(p_route_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route vehicle_routes%ROWTYPE; v_direction varchar; v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only end your own route''s run.' USING ERRCODE = 'P0001'; END IF;
  UPDATE route_runs SET ended_at = now() WHERE route_id = p_route_id AND ended_at IS NULL
    RETURNING direction INTO v_direction;

  IF v_direction IS NULL THEN RETURN; END IF;

  UPDATE ride_bookings SET dropped_off_at = now()
    WHERE route_id = p_route_id AND travel_date = v_today AND boarded_at IS NOT NULL AND dropped_off_at IS NULL;

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
GRANT EXECUTE ON FUNCTION end_route_run(uuid) TO authenticated;

-- Adda has no route/run concept to hook a "we arrived" signal to at all
-- (an entry's own lifecycle ends at 'departed') — one new, simple,
-- manually-tapped action for the one case that genuinely has nothing
-- to reuse.
CREATE OR REPLACE FUNCTION complete_adda_trip(p_entry_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE e adda_queue_entries%ROWTYPE; v vehicles%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
BEGIN
  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Queue entry not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = e.vehicle_id;
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF e.status <> 'departed' THEN RAISE EXCEPTION 'This vehicle has not departed yet.' USING ERRCODE = 'P0001'; END IF;
  UPDATE ride_bookings SET dropped_off_at = now()
    WHERE adda_queue_entry_id = p_entry_id AND boarded_at IS NOT NULL AND dropped_off_at IS NULL;
END;
$$;
GRANT EXECUTE ON FUNCTION complete_adda_trip(uuid) TO authenticated;

-- Roster reads for the two onboard UIs (owner-gated, returns empty for
-- anyone else rather than erroring — same defensive style as
-- route_group_detail/route_monthly_detail elsewhere in this codebase).
CREATE OR REPLACE FUNCTION route_today_ad_hoc_bookings(p_route_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RETURN '[]'::jsonb; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', rb.id, 'name', pu.full_name, 'seats', rb.seats, 'boarded_at', rb.boarded_at, 'dropped_off_at', rb.dropped_off_at
    ) ORDER BY rb.created_at), '[]'::jsonb)
    FROM ride_bookings rb JOIN portal_users pu ON pu.id = rb.portal_user_id
    WHERE rb.route_id = p_route_id AND rb.travel_date = (now() AT TIME ZONE 'Asia/Karachi')::date
      AND rb.status IN ('announced', 'confirmed')
  );
END;
$$;
GRANT EXECUTE ON FUNCTION route_today_ad_hoc_bookings(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION adda_entry_today_bookings(p_entry_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner_ok boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM adda_queue_entries e JOIN vehicles v ON v.id = e.vehicle_id WHERE e.id = p_entry_id AND v.portal_user_id = current_portal_user_id()) INTO v_owner_ok;
  IF NOT v_owner_ok THEN RETURN '[]'::jsonb; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', rb.id, 'name', pu.full_name, 'seats', rb.seats, 'boarded_at', rb.boarded_at, 'dropped_off_at', rb.dropped_off_at
    ) ORDER BY rb.created_at), '[]'::jsonb)
    FROM ride_bookings rb JOIN portal_users pu ON pu.id = rb.portal_user_id
    WHERE rb.adda_queue_entry_id = p_entry_id AND rb.status IN ('announced', 'confirmed')
  );
END;
$$;
GRANT EXECUTE ON FUNCTION adda_entry_today_bookings(uuid) TO authenticated;

-- One consolidated feed for FloatingBookingsHub — every route/adda
-- entry this vehicle owns that currently needs the driver's attention
-- (unresolved riders waiting to board) or is already live (boarded
-- riders not yet dropped off).
CREATE OR REPLACE FUNCTION vehicle_route_adda_live_status(p_vehicle_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date; v_todow int := extract(dow FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = current_portal_user_id()) THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(merged.row), '[]'::jsonb) FROM (
      SELECT jsonb_build_object('kind', 'route_ongoing', 'route_id', r.id, 'origin', r.origin, 'destination', r.destination, 'started_at', run.started_at) AS row
      FROM vehicle_routes r JOIN route_runs run ON run.route_id = r.id AND run.ended_at IS NULL
      WHERE r.vehicle_id = p_vehicle_id

      UNION ALL

      SELECT jsonb_build_object('kind', 'route_action', 'route_id', r.id, 'origin', r.origin, 'destination', r.destination,
        'pending_count', (
          (SELECT count(*) FROM ride_bookings rb WHERE rb.route_id = r.id AND rb.travel_date = v_today AND rb.status IN ('announced', 'confirmed') AND rb.boarded_at IS NULL)
          + (SELECT count(*) FROM route_subscriptions rs WHERE rs.route_id = r.id AND rs.status IN ('active', 'pending_cancellation'))
        )) AS row
      FROM vehicle_routes r
      WHERE r.vehicle_id = p_vehicle_id AND r.is_active AND v_todow = ANY(r.days_of_week)
        AND NOT EXISTS (SELECT 1 FROM route_runs run WHERE run.route_id = r.id AND run.ended_at IS NULL)
        AND (
          EXISTS (SELECT 1 FROM ride_bookings rb WHERE rb.route_id = r.id AND rb.travel_date = v_today AND rb.status IN ('announced', 'confirmed') AND rb.boarded_at IS NULL)
          OR EXISTS (SELECT 1 FROM route_subscriptions rs WHERE rs.route_id = r.id AND rs.status IN ('active', 'pending_cancellation'))
        )

      UNION ALL

      SELECT jsonb_build_object('kind', 'adda_ongoing', 'entry_id', e.id, 'adda_name', a.name, 'adda_name_ur', a.name_ur) AS row
      FROM adda_queue_entries e JOIN addas a ON a.id = e.adda_id
      WHERE e.vehicle_id = p_vehicle_id AND e.queue_date = v_today AND e.status = 'departed'
        AND EXISTS (SELECT 1 FROM ride_bookings rb WHERE rb.adda_queue_entry_id = e.id AND rb.boarded_at IS NOT NULL AND rb.dropped_off_at IS NULL)

      UNION ALL

      SELECT jsonb_build_object('kind', 'adda_action', 'entry_id', e.id, 'adda_name', a.name, 'adda_name_ur', a.name_ur,
        'pending_count', (SELECT count(*) FROM ride_bookings rb WHERE rb.adda_queue_entry_id = e.id AND rb.status IN ('announced', 'confirmed') AND rb.boarded_at IS NULL)) AS row
      FROM adda_queue_entries e JOIN addas a ON a.id = e.adda_id
      WHERE e.vehicle_id = p_vehicle_id AND e.queue_date = v_today AND e.status IN ('waiting', 'current')
        AND EXISTS (SELECT 1 FROM ride_bookings rb WHERE rb.adda_queue_entry_id = e.id AND rb.status IN ('announced', 'confirmed') AND rb.boarded_at IS NULL)
    ) merged
  );
END;
$$;
GRANT EXECUTE ON FUNCTION vehicle_route_adda_live_status(uuid) TO authenticated;
