-- Migration 965: real bug caught live immediately after 960, while
-- doing a full click-through test of the floating button's modules —
-- a rider who had BOTH an old completed booking (dropped_off_at set,
-- same travel_date) and a brand-new boarded-not-yet-dropped booking on
-- the same route got the OLD one back from my_booking, because
-- `ORDER BY (travel_date = today) DESC, travel_date DESC` ties when
-- both rows share today's date, and Postgres then falls back to
-- arbitrary row order. Confirmed live: the group panel's new "you're
-- on board" banner never appeared because of this. Fixed by preferring
-- a still-open booking (dropped_off_at IS NULL) first, before the date
-- tiebreak, with created_at DESC as the final tiebreak. Everything
-- else in route_group_detail (final body: 960) copied verbatim.
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
  v_my_booking jsonb;
  v_today_delay jsonb;
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

  SELECT jsonb_build_object('booking_id', rb.id, 'travel_date', rb.travel_date, 'seat_accepted_at', rb.seat_accepted_at, 'boarded_at', rb.boarded_at, 'dropped_off_at', rb.dropped_off_at)
  INTO v_my_booking
  FROM ride_bookings rb
  WHERE rb.route_id = p_route_id AND rb.portal_user_id = v_portal_user_id AND rb.status = 'announced'
  ORDER BY (rb.dropped_off_at IS NULL) DESC, (rb.travel_date = v_today) DESC, rb.travel_date DESC, rb.created_at DESC LIMIT 1;

  SELECT jsonb_build_object('delay_minutes', d.delay_minutes, 'note', d.note, 'auto_detected', d.auto_detected, 'direction', d.direction)
  INTO v_today_delay
  FROM route_day_delays d
  WHERE d.route_id = p_route_id AND d.travel_date = v_today
  ORDER BY (v_active_run.id IS NOT NULL AND d.direction = v_active_run.direction) DESC LIMIT 1;

  RETURN jsonb_build_object(
    'is_owner', v_is_owner,
    'can_run_ride', v_can_run_ride,
    'is_member', v_is_member,
    'pending_seat_booking', v_pending_booking,
    'my_booking', v_my_booking,
    'today_delay', v_today_delay,
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
