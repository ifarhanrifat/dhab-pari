-- Migration 969: critical fix, caught by a direct live test call right
-- after 968 deployed — run_ghost_departure_sweep referenced
-- v_existing.id in four places, exactly the bug 958 already fixed once
-- for auto_check_route_delay: route_day_delays (900) has composite
-- PRIMARY KEY (route_id, travel_date, direction) and no `id` column at
-- all. I copied 956's pre-958 pattern instead of 958's corrected one
-- when writing 968. Same fix as 958: capture FOUND into a boolean right
-- after the SELECT, and key every UPDATE off the real composite columns.

CREATE OR REPLACE FUNCTION run_ghost_departure_sweep() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_grace_min numeric; v_escalation_min numeric;
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_todow int := extract(dow FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
  r record;
  v_owner_portal_user_id uuid;
  v_minutes_overdue numeric;
  v_existing route_day_delays%ROWTYPE;
  v_existing_found boolean;
BEGIN
  SELECT COALESCE(value::numeric, 15) INTO v_grace_min FROM site_settings WHERE key = 'ghost_departure_grace_minutes' LIMIT 1;
  SELECT COALESCE(value::numeric, 45) INTO v_escalation_min FROM site_settings WHERE key = 'ghost_departure_escalation_minutes' LIMIT 1;

  FOR r IN
    SELECT vr.id AS route_id, vr.vehicle_id, vr.origin, vr.destination, vr.departure_time, vr.tenant_id
    FROM vehicle_routes vr
    WHERE vr.is_active AND vr.departure_time IS NOT NULL
      AND (
        (vr.one_off_date IS NOT NULL AND vr.one_off_date = v_today)
        OR (vr.one_off_date IS NULL AND v_todow = ANY(vr.days_of_week))
      )
      AND NOT EXISTS (SELECT 1 FROM route_runs run WHERE run.route_id = vr.id AND run.started_at::date = v_today)
  LOOP
    v_minutes_overdue := extract(epoch FROM (now() - ((v_today + r.departure_time) AT TIME ZONE 'Asia/Karachi'))) / 60;
    IF v_minutes_overdue < v_grace_min THEN CONTINUE; END IF;

    SELECT v.portal_user_id INTO v_owner_portal_user_id FROM vehicles v WHERE v.id = r.vehicle_id;
    IF v_owner_portal_user_id IS NULL THEN CONTINUE; END IF;

    SELECT * INTO v_existing FROM route_day_delays WHERE route_id = r.route_id AND travel_date = v_today AND direction = 'outbound';
    v_existing_found := FOUND;
    IF v_existing_found AND NOT v_existing.auto_detected THEN CONTINUE; END IF;

    IF NOT v_existing_found THEN
      INSERT INTO route_day_delays (route_id, travel_date, direction, delay_minutes, note, marked_by, auto_detected, pre_departure)
      VALUES (r.route_id, v_today, 'outbound', round(v_minutes_overdue)::int, 'The route has not started yet.', v_owner_portal_user_id, true, true);

      INSERT INTO portal_notifications (portal_user_id, event_type, title, title_ur, body, body_ur, link, tenant_id)
      SELECT DISTINCT rb.portal_user_id, 'route_delayed', 'Running late', 'تاخیر سے چل رہی ہے',
        r.origin || ' → ' || r.destination || ' has not started yet — about ' || round(v_minutes_overdue)::int || ' minutes past its scheduled departure.',
        r.origin || ' سے ' || r.destination || ' کا سفر ابھی شروع نہیں ہوا — مقررہ وقت سے تقریباً ' || round(v_minutes_overdue)::int || ' منٹ تاخیر ہو چکی ہے۔',
        '/portal/marketplace/route/' || r.route_id, r.tenant_id
      FROM ride_bookings rb WHERE rb.route_id = r.route_id AND rb.travel_date = v_today AND rb.direction = 'outbound'
        AND rb.status IN ('announced', 'confirmed');

      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
      SELECT DISTINCT pu_id, 'route_ghost_departure', 'Route has not started',
        r.origin || ' → ' || r.destination || ' was due to depart at ' || to_char(r.departure_time, 'HH12:MI AM')
          || ' and still has no driver activity (' || round(v_minutes_overdue)::int || ' min overdue). Reassign the bus from the Dispatch board if it cannot make it.',
        '/portal/fleet/dispatch', r.tenant_id
      FROM (
        SELECT v_owner_portal_user_id AS pu_id
        UNION
        SELECT fs.portal_user_id FROM fleet_staff fs
        WHERE fs.fleet_id = (SELECT fleet_id FROM vehicles WHERE id = r.vehicle_id)
          AND fs.role NOT IN ('driver', 'accountant')
          AND (fs.counter_id IS NULL OR fs.counter_id = route_origin_counter_id(r.route_id))
      ) recipients;
    ELSIF round(v_minutes_overdue)::int != v_existing.delay_minutes THEN
      UPDATE route_day_delays SET delay_minutes = round(v_minutes_overdue)::int
        WHERE route_id = r.route_id AND travel_date = v_today AND direction = 'outbound';

      IF v_minutes_overdue >= v_escalation_min AND v_existing.escalated_notified_at IS NULL THEN
        UPDATE route_day_delays SET escalated_notified_at = now()
          WHERE route_id = r.route_id AND travel_date = v_today AND direction = 'outbound';

        INSERT INTO portal_notifications (portal_user_id, event_type, title, title_ur, body, body_ur, link, tenant_id)
        SELECT DISTINCT rb.portal_user_id, 'route_ghost_departure_escalated', 'Your bus may not be running', 'آپ کی بس شاید نہیں چل رہی',
          r.origin || ' → ' || r.destination || ' still has not started, ' || round(v_minutes_overdue)::int || ' minutes past departure. You can cancel this booking without any late-cancellation penalty from your ticket.',
          r.origin || ' سے ' || r.destination || ' کا سفر اب تک شروع نہیں ہوا، مقررہ وقت سے ' || round(v_minutes_overdue)::int || ' منٹ تاخیر ہو چکی ہے۔ آپ اپنے ٹکٹ سے بغیر کسی تاخیری جرمانے کے یہ بکنگ منسوخ کر سکتے ہیں۔',
          '/portal/marketplace/route/' || r.route_id, r.tenant_id
        FROM ride_bookings rb WHERE rb.route_id = r.route_id AND rb.travel_date = v_today AND rb.direction = 'outbound'
          AND rb.status IN ('announced', 'confirmed');
      END IF;
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION run_ghost_departure_sweep() FROM PUBLIC, anon, authenticated;
