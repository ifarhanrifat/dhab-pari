-- Migration 952: real bug found live, 2026-11-24 — join_route_group
-- (717) let ANY authenticated rider self-insert into route_participants
-- with zero checks, completely bypassing the driver-confirmation model
-- this app is built around ("the terminal officer/driver confirms
-- payment, then the rider is automatically added to the group, that's
-- it" — accept_ride_booking_seat, 831). A rider with a genuinely
-- pending (announced, not yet seat_accepted) ad-hoc seat booking on
-- this exact route saw a plain "Join this group" button that, if
-- tapped, handed them chat/live-map access the driver never actually
-- approved — and the RPC itself had no gate at all, so it wasn't just
-- a UI affordance, it was a real authorization hole reachable directly.
--
-- True-replacing both: the gate on join_route_group (raises instead of
-- silently joining whenever a pending booking exists), and the read RPC
-- (route_group_detail, final body: 898) so the client can tell "has a
-- real pending seat" apart from "never booked, this is a genuine
-- self-join" — which keeps working completely unchanged for whatever
-- legitimate case join_route_group originally existed for (an informal
-- carpool rider with no per-seat booking record at all).

CREATE OR REPLACE FUNCTION join_route_group(p_route_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (
    SELECT 1 FROM ride_bookings
    WHERE route_id = p_route_id AND portal_user_id = v_portal_user_id
      AND status = 'announced' AND seat_accepted_at IS NULL AND dropped_off_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Your seat needs the driver''s confirmation first — you''ll be added to the group automatically once they confirm it.' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO route_participants (route_id, portal_user_id, is_active)
  VALUES (p_route_id, v_portal_user_id, true)
  ON CONFLICT (route_id, portal_user_id) DO UPDATE SET is_active = true;
END;
$$;
GRANT EXECUTE ON FUNCTION join_route_group(uuid) TO authenticated;

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
  v_pending_booking jsonb;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  SELECT v.portal_user_id INTO v_owner_portal_user_id FROM vehicles v WHERE v.id = v_route.vehicle_id;
  SELECT * INTO v_active_run FROM route_runs WHERE route_id = p_route_id AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1;

  IF v_is_member THEN
    SELECT sharing_location INTO v_sharing FROM route_participants WHERE route_id = p_route_id AND portal_user_id = v_portal_user_id;
  ELSE
    SELECT jsonb_build_object('booking_id', rb.id, 'travel_date', rb.travel_date, 'seats', rb.seats)
    INTO v_pending_booking
    FROM ride_bookings rb
    WHERE rb.route_id = p_route_id AND rb.portal_user_id = v_portal_user_id
      AND rb.status = 'announced' AND rb.seat_accepted_at IS NULL AND rb.dropped_off_at IS NULL
    ORDER BY rb.created_at DESC LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'is_owner', v_is_owner,
    'can_run_ride', v_can_run_ride,
    'is_member', v_is_member,
    'pending_seat_booking', v_pending_booking,
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
GRANT EXECUTE ON FUNCTION route_group_detail(uuid) TO authenticated;
