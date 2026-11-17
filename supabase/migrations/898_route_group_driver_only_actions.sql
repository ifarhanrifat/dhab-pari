-- Migration 898: real bug confirmed live, 2026-11-17 — the "Group"
-- button's modal (RouteGroupPanel.tsx) renders its whole driver
-- workflow (Start Ride, Take Attendance, Mark Arrived, End Ride,
-- Board/No-Show, offboard-during-layover) gated on route_group_
-- detail's is_owner, which comes from is_route_owner(), which still
-- calls the OLD can_manage_vehicle() — the exact conflated owner/
-- staff/driver check 893 was meant to retire. So a fleet owner or any
-- staff member who taps Group on a route they don't personally drive
-- still sees and can use the full driver-operational workflow.
--
-- Found while fixing this: the server-side RPCs behind those buttons
-- have the SAME bug, independent of what the frontend shows. 880
-- already noticed this exact class of problem once (a mid-route
-- handover co-driver couldn't end their own run) and built
-- is_route_operator() for end_route_run/mark_run_arrived/
-- board_ride_bookings — but is_route_operator's own definition is
-- `is_route_owner() OR shift-substitute`, so it inherits the same
-- owner/staff-inclusion bug it was trying to fix. take_attendance
-- (775) and mark_rider_no_show (828) were never even switched to it,
-- still calling is_route_owner() directly.
--
-- is_route_owner() itself is NOT touched — 27 other migrations call
-- it for route configuration/pricing, far too wide a blast radius.
-- is_route_operator() IS safely narrowed here: grepped the whole repo
-- first, it has exactly one caller file (880, which defines it and
-- uses it only for the 3 RPCs above) — no other migration calls it,
-- so redefining its body with the same signature is a true, safe fix
-- for all of its existing callers at once.

-- Narrower: the vehicle's actual current driver, or an active
-- substitute/handover-shift driver — never the broad is_route_owner()
-- (which still means can_manage_vehicle: owner + any staff + driver).
CREATE OR REPLACE FUNCTION is_route_operator(p_route_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id
    WHERE vr.id = p_route_id AND v.portal_user_id = current_portal_user_id()
  ) OR EXISTS (
    SELECT 1 FROM route_run_substitutions s JOIN vehicles v ON v.id = s.substitute_vehicle_id
    WHERE s.route_id = p_route_id AND s.run_date = (now() AT TIME ZONE 'Asia/Karachi')::date
      AND s.status = 'active' AND v.portal_user_id = current_portal_user_id()
  ) OR EXISTS (
    SELECT 1 FROM route_runs rr JOIN route_run_driver_shifts sh ON sh.route_run_id = rr.id
    WHERE rr.route_id = p_route_id AND rr.ended_at IS NULL AND sh.ended_at IS NULL AND sh.driver_portal_user_id = current_portal_user_id()
  );
$$;
REVOKE ALL ON FUNCTION is_route_operator(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_route_operator(uuid) TO authenticated;

-- take_attendance (775) — true replace, only the gate line changed.
CREATE OR REPLACE FUNCTION take_attendance(p_route_id uuid, p_run_date date, p_present_subscription_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r route_subscriptions%ROWTYPE;
  v_existing route_run_attendance%ROWTYPE;
  v_new_present boolean;
  v_changed boolean;
  v_daily_share numeric;
  v_month int := extract(month FROM p_run_date)::int;
  v_year int := extract(year FROM p_run_date)::int;
  v_route vehicle_routes%ROWTYPE;
BEGIN
  IF NOT is_route_operator(p_route_id) THEN RAISE EXCEPTION 'You can only manage your own route.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;

  FOR r IN SELECT * FROM route_subscriptions WHERE route_id = p_route_id AND status IN ('active', 'pending_cancellation') LOOP
    v_new_present := r.id = ANY(p_present_subscription_ids);
    v_daily_share := round(r.monthly_fee_pkr / scheduled_days_in_month(p_route_id, v_month, v_year));
    v_changed := false;

    SELECT * INTO v_existing FROM route_run_attendance WHERE subscription_id = r.id AND run_date = p_run_date;

    IF NOT FOUND THEN
      INSERT INTO route_run_attendance (route_id, subscription_id, run_date, present, marked_by)
      VALUES (p_route_id, r.id, p_run_date, v_new_present, current_portal_user_id());
      v_changed := true;

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
      v_changed := true;
    END IF;

    IF v_changed THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (r.portal_user_id, 'route_attendance_marked',
        CASE WHEN v_new_present THEN 'On board' ELSE 'Marked absent today' END,
        v_route.origin || ' → ' || v_route.destination || ' · ' || to_char(p_run_date, 'DD Mon')
          || CASE WHEN v_new_present THEN ' — the driver has marked your seat present.' ELSE ' — the driver marked this seat absent. If that''s wrong, message the driver.' END,
        '/portal/marketplace/route/' || p_route_id);
    END IF;
  END LOOP;
END;
$$;

-- mark_rider_no_show (828) — true replace, only the route branch's
-- gate changed; the adda_queue_entries branch (non-route bookings)
-- is untouched since it already checks vehicle.portal_user_id
-- directly, not is_route_owner, and was never part of this bug.
CREATE OR REPLACE FUNCTION mark_rider_no_show(p_booking_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b ride_bookings%ROWTYPE; v_owner_ok boolean;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF b.status NOT IN ('announced', 'confirmed') THEN RAISE EXCEPTION 'This booking is not active.' USING ERRCODE = 'P0001'; END IF;
  IF b.boarded_at IS NOT NULL THEN RAISE EXCEPTION 'This rider has already boarded.' USING ERRCODE = 'P0001'; END IF;

  IF b.route_id IS NOT NULL THEN
    v_owner_ok := is_route_operator(b.route_id);
  ELSE
    SELECT EXISTS (SELECT 1 FROM adda_queue_entries e JOIN vehicles v ON v.id = e.vehicle_id WHERE e.id = b.adda_queue_entry_id AND v.portal_user_id = current_portal_user_id()) INTO v_owner_ok;
  END IF;
  IF NOT v_owner_ok THEN RAISE EXCEPTION 'You do not manage this booking''s vehicle.' USING ERRCODE = 'P0001'; END IF;

  UPDATE ride_bookings SET status = 'cancelled', rejected_reason = 'Marked as a no-show by the driver.' WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'ride_booking_no_show', 'Marked as a no-show',
    'The driver marked you absent for this ride and closed the booking.',
    CASE WHEN b.route_id IS NOT NULL THEN '/portal/marketplace/route/' || b.route_id ELSE '/portal/marketplace' END);
END;
$$;

-- route_group_detail (831) — true replace. Adds can_run_ride
-- (= is_route_operator, now correctly narrowed above) as a separate
-- field from is_owner; is_owner itself is untouched, so pending_seat_
-- requests/pending_monthly_applications approval (a legitimate owner/
-- staff administrative action, not a driving one) stays exactly as it
-- was. RouteGroupPanel.tsx is updated separately to gate its Start/
-- Attendance/Arrived/End/Board/No-Show/offboard controls on
-- can_run_ride instead of is_owner.
CREATE OR REPLACE FUNCTION route_group_detail(p_route_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_is_owner boolean := is_route_owner(p_route_id);
  v_can_run_ride boolean := is_route_operator(p_route_id);
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
    'can_run_ride', v_can_run_ride,
    'is_member', v_is_member,
    'sharing_location', coalesce(v_sharing, false),
    'owner_portal_user_id', v_owner_portal_user_id,
    'route_path', v_route.route_path,
    'route_duration_min', v_route.route_duration_min,
    'is_two_way', v_route.is_two_way,
    'return_wait_minutes', v_route.return_wait_minutes,
    'return_seats_available_today', CASE WHEN v_route.is_two_way THEN return_seats_available(p_route_id, v_today) ELSE NULL END,
    'active_run', CASE WHEN v_active_run.id IS NOT NULL THEN jsonb_build_object('id', v_active_run.id, 'started_at', v_active_run.started_at, 'direction', v_active_run.direction, 'outbound_arrived_at', v_active_run.outbound_arrived_at) ELSE NULL END,
    'todays_runs', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'direction', direction, 'started_at', started_at, 'ended_at', ended_at) ORDER BY started_at), '[]'::jsonb)
      FROM route_runs WHERE route_id = p_route_id
        AND ((started_at AT TIME ZONE 'Asia/Karachi')::date = v_today
          OR (ended_at IS NOT NULL AND (ended_at AT TIME ZONE 'Asia/Karachi')::date = v_today))),
    'stops', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'label', s.label, 'label_ur', s.label_ur, 'lat', s.lat, 'lng', s.lng) ORDER BY s.stop_order), '[]'::jsonb) FROM route_stops s WHERE s.route_id = p_route_id),
    'roster_today', CASE WHEN v_is_owner THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'subscription_id', rs.id, 'name', pu.full_name,
        'on_leave_today', EXISTS (SELECT 1 FROM route_subscription_leave_days ld WHERE ld.subscription_id = rs.id AND ld.leave_date = v_today),
        'present', COALESCE((SELECT present FROM route_run_attendance ra WHERE ra.subscription_id = rs.id AND ra.run_date = v_today),
          NOT EXISTS (SELECT 1 FROM route_subscription_leave_days ld WHERE ld.subscription_id = rs.id AND ld.leave_date = v_today))
      ) ORDER BY rs.applied_at), '[]'::jsonb)
      FROM route_subscriptions rs JOIN portal_users pu ON pu.id = rs.portal_user_id
      WHERE rs.route_id = p_route_id AND rs.status IN ('active', 'pending_cancellation')
    ) ELSE '[]'::jsonb END,
    'pending_seat_requests', CASE WHEN v_is_owner THEN route_pending_seat_requests(p_route_id) ELSE '[]'::jsonb END,
    'pending_monthly_applications', CASE WHEN v_is_owner THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', rs.id, 'name', pu.full_name, 'monthly_fee_pkr', rs.monthly_fee_pkr, 'stop_label', rst.label, 'applied_at', rs.applied_at,
        'deposit_pkr', rsc.amount_pkr, 'proof_url', rsc.proof_url, 'payment_method', rsc.payment_method
      ) ORDER BY rs.applied_at), '[]'::jsonb)
      FROM route_subscriptions rs JOIN portal_users pu ON pu.id = rs.portal_user_id
        LEFT JOIN route_stops rst ON rst.id = rs.board_stop_id
        LEFT JOIN route_subscription_charges rsc ON rsc.subscription_id = rs.id AND rsc.status = 'due'
      WHERE rs.route_id = p_route_id AND rs.status = 'pending'
    ) ELSE '[]'::jsonb END,
    'todays_outbound_bookings', CASE WHEN v_is_owner THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'booking_id', rb.id, 'name', pu.full_name, 'seats', rb.seats,
        'offboarded', EXISTS (SELECT 1 FROM route_run_offboards o WHERE o.ride_booking_id = rb.id)
      ) ORDER BY rb.created_at), '[]'::jsonb)
      FROM ride_bookings rb JOIN portal_users pu ON pu.id = rb.portal_user_id
      WHERE rb.route_id = p_route_id AND rb.travel_date = v_today AND rb.direction = 'outbound' AND rb.status IN ('announced', 'confirmed')
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
