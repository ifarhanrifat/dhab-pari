-- Migration 818: real ask, 2026-11-06 (phase 3 of the agreed order) —
-- "rider can view their own attendance, can decline their attendance
-- of onboard if driver accidentally onboard them." Builds directly on
-- 817's boarded_at/dropped_off_at (ad-hoc ride_bookings) and the
-- existing route_run_attendance (monthly subscriptions) — no new
-- financial machinery, just a rider-facing read + a self-service undo
-- of a wrong mark, mirroring take_attendance's own billing-delta math
-- exactly so a decline can never leave a charge inconsistent with the
-- attendance record.

-- Ad-hoc route/adda seat bookings: rider undoes a wrong "boarded" mark.
-- Only while still boarded-not-dropped — once a trip is fully
-- resolved (run ended / adda trip finished), the moment has passed.
CREATE OR REPLACE FUNCTION decline_boarding(p_booking_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b ride_bookings%ROWTYPE; v_owner_name varchar; v_vehicle_id uuid;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id AND portal_user_id = current_portal_user_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'That is not your booking.' USING ERRCODE = 'P0001'; END IF;
  IF b.boarded_at IS NULL OR b.dropped_off_at IS NOT NULL THEN
    RAISE EXCEPTION 'There is nothing to decline right now.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE ride_bookings SET boarded_at = NULL WHERE id = p_booking_id;

  IF b.route_id IS NOT NULL THEN
    SELECT v.id, v.owner_name INTO v_vehicle_id, v_owner_name FROM vehicle_routes r JOIN vehicles v ON v.id = r.vehicle_id WHERE r.id = b.route_id;
  ELSE
    SELECT v.id, v.owner_name INTO v_vehicle_id, v_owner_name FROM adda_queue_entries e JOIN vehicles v ON v.id = e.vehicle_id WHERE e.id = b.adda_queue_entry_id;
  END IF;
  IF v_vehicle_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT v2.portal_user_id, 'rider_declined_boarding', 'A rider says they are not on board',
      'One of your riders was marked boarded but says that is wrong — check your roster.',
      CASE WHEN b.route_id IS NOT NULL THEN '/portal/my-vehicle/routes' ELSE '/portal/my-vehicle/adda' END
    FROM vehicles v2 WHERE v2.id = v_vehicle_id AND v2.portal_user_id IS NOT NULL;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION decline_boarding(uuid) TO authenticated;

-- Monthly subscriptions: rider's own attendance history, read-only.
CREATE OR REPLACE FUNCTION my_route_attendance(p_route_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'run_date', ra.run_date, 'present', ra.present, 'marked_at', ra.marked_at
  ) ORDER BY ra.run_date DESC), '[]'::jsonb)
  FROM route_run_attendance ra
  JOIN route_subscriptions rs ON rs.id = ra.subscription_id
  WHERE rs.route_id = p_route_id AND rs.portal_user_id = current_portal_user_id()
    AND ra.run_date >= (now() AT TIME ZONE 'Asia/Karachi')::date - interval '14 days';
$$;
GRANT EXECUTE ON FUNCTION my_route_attendance(uuid) TO authenticated;

-- Monthly subscriptions: rider undoes today's "present" mark, reversing
-- the exact same daily-share math take_attendance itself uses.
CREATE OR REPLACE FUNCTION decline_todays_attendance(p_subscription_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  rs route_subscriptions%ROWTYPE; ra route_run_attendance%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_daily_share numeric; v_owner_name varchar; v_vehicle_id uuid;
BEGIN
  SELECT * INTO rs FROM route_subscriptions WHERE id = p_subscription_id AND portal_user_id = current_portal_user_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'That is not your monthly seat.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO ra FROM route_run_attendance WHERE subscription_id = p_subscription_id AND run_date = v_today FOR UPDATE;
  IF NOT FOUND OR NOT ra.present THEN RAISE EXCEPTION 'There is nothing to decline for today.' USING ERRCODE = 'P0001'; END IF;

  v_daily_share := round(rs.monthly_fee_pkr / scheduled_days_in_month(rs.route_id, extract(month FROM v_today)::int, extract(year FROM v_today)::int));
  UPDATE route_run_attendance SET present = false, marked_at = now(), marked_by = current_portal_user_id() WHERE id = ra.id;
  UPDATE route_subscription_charges SET amount_pkr = greatest(0, amount_pkr - v_daily_share)
    WHERE subscription_id = p_subscription_id AND month = extract(month FROM v_today)::int AND year = extract(year FROM v_today)::int AND status = 'due';

  SELECT v.id, v.owner_name INTO v_vehicle_id, v_owner_name FROM vehicle_routes r JOIN vehicles v ON v.id = r.vehicle_id WHERE r.id = rs.route_id;
  IF v_vehicle_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT v2.portal_user_id, 'rider_declined_boarding', 'A rider says they are not on board',
      'One of your monthly riders was marked present today but says that is wrong.', '/portal/my-vehicle/routes'
    FROM vehicles v2 WHERE v2.id = v_vehicle_id AND v2.portal_user_id IS NOT NULL;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION decline_todays_attendance(uuid) TO authenticated;
