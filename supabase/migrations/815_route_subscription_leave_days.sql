-- Migration 815: real ask, 2026-11-06 — "ride sharing is the core
-- feature... the monthly fixed booking... these fare cards will be
-- separate." Research found the monthly-fixed subscription engine
-- (723/724/775, "Teacher Van") already bills correctly via driver
-- roll-call attendance, but a rider has no way to pre-announce an
-- upcoming absence — billing only ever reacts to what the driver
-- happens to observe at the moment of departure. This adds that,
-- wired into the roster the driver already checks off.
CREATE TABLE route_subscription_leave_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES route_subscriptions(id) ON DELETE CASCADE,
  leave_date date NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (subscription_id, leave_date)
);
ALTER TABLE route_subscription_leave_days ENABLE ROW LEVEL SECURITY;

CREATE POLICY "route_subscription_leave_days_own_select" ON route_subscription_leave_days FOR SELECT TO authenticated
  USING (subscription_id IN (SELECT id FROM route_subscriptions WHERE portal_user_id = current_portal_user_id())
    OR subscription_id IN (SELECT rs.id FROM route_subscriptions rs WHERE is_route_owner(rs.route_id)));

CREATE OR REPLACE FUNCTION mark_subscription_leave_day(p_subscription_id uuid, p_leave_date date)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM route_subscriptions WHERE id = p_subscription_id AND portal_user_id = current_portal_user_id() AND status = 'active') THEN
    RAISE EXCEPTION 'That is not one of your active monthly seats.' USING ERRCODE = 'P0001';
  END IF;
  IF p_leave_date < current_date THEN RAISE EXCEPTION 'Pick today or a future date.' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO route_subscription_leave_days (subscription_id, leave_date) VALUES (p_subscription_id, p_leave_date) ON CONFLICT DO NOTHING;
END;
$$;
GRANT EXECUTE ON FUNCTION mark_subscription_leave_day(uuid, date) TO authenticated;

CREATE OR REPLACE FUNCTION cancel_subscription_leave_day(p_subscription_id uuid, p_leave_date date)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM route_subscriptions WHERE id = p_subscription_id AND portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'That is not one of your monthly seats.' USING ERRCODE = 'P0001';
  END IF;
  IF p_leave_date < current_date THEN RAISE EXCEPTION 'That day has already passed.' USING ERRCODE = 'P0001'; END IF;
  DELETE FROM route_subscription_leave_days WHERE subscription_id = p_subscription_id AND leave_date = p_leave_date;
END;
$$;
GRANT EXECUTE ON FUNCTION cancel_subscription_leave_day(uuid, date) TO authenticated;

-- roster_today (718/719/724/727) gains on_leave_today so the driver's
-- roll-call checkbox can default a pre-announced absence to unchecked
-- and label it, instead of looking like an unexplained no-show.
CREATE OR REPLACE FUNCTION route_group_detail(p_route_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_is_owner boolean := is_route_owner(p_route_id);
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
      FROM route_runs WHERE route_id = p_route_id AND started_at::date = v_today),
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

-- route_monthly_detail (723) gains the caller's own upcoming leave days
-- so the rider's status card can list/cancel them.
CREATE OR REPLACE FUNCTION route_monthly_detail(p_route_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_is_owner boolean := is_route_owner(p_route_id);
  v_route vehicle_routes%ROWTYPE;
  v_seats int;
  v_active_count int;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  SELECT total_seats INTO v_seats FROM vehicles WHERE id = v_route.vehicle_id;
  SELECT count(*) INTO v_active_count FROM route_subscriptions WHERE route_id = p_route_id AND status = 'active';

  RETURN jsonb_build_object(
    'is_monthly_fixed', v_route.is_monthly_fixed,
    'monthly_reference_fee_pkr', v_route.monthly_reference_fee_pkr,
    'seats_total', v_seats,
    'active_count', v_active_count,
    'my_subscription', (
      SELECT jsonb_build_object('id', rs.id, 'status', rs.status, 'monthly_fee_pkr', rs.monthly_fee_pkr, 'queue_position', rs.queue_position, 'scheduled_cancellation_at', rs.scheduled_cancellation_at)
      FROM route_subscriptions rs WHERE rs.route_id = p_route_id AND rs.portal_user_id = v_portal_user_id AND rs.status != 'cancelled'
    ),
    'my_leave_days', (
      SELECT COALESCE(jsonb_agg(ld.leave_date ORDER BY ld.leave_date), '[]'::jsonb)
      FROM route_subscription_leave_days ld JOIN route_subscriptions rs ON rs.id = ld.subscription_id
      WHERE rs.route_id = p_route_id AND rs.portal_user_id = v_portal_user_id AND ld.leave_date >= current_date
    ),
    'subscribers', CASE WHEN v_is_owner THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', rs.id, 'name', pu.full_name, 'stop_label', rst.label, 'monthly_fee_pkr', rs.monthly_fee_pkr,
        'status', rs.status, 'scheduled_cancellation_at', rs.scheduled_cancellation_at
      ) ORDER BY rs.applied_at), '[]'::jsonb)
      FROM route_subscriptions rs JOIN portal_users pu ON pu.id = rs.portal_user_id LEFT JOIN route_stops rst ON rst.id = rs.board_stop_id
      WHERE rs.route_id = p_route_id AND rs.status IN ('active', 'pending_cancellation')
    ) ELSE '[]'::jsonb END,
    'waitlist', CASE WHEN v_is_owner THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', rs.id, 'name', pu.full_name, 'queue_position', rs.queue_position, 'monthly_fee_pkr', rs.monthly_fee_pkr) ORDER BY rs.queue_position), '[]'::jsonb)
      FROM route_subscriptions rs JOIN portal_users pu ON pu.id = rs.portal_user_id
      WHERE rs.route_id = p_route_id AND rs.status = 'waitlisted'
    ) ELSE '[]'::jsonb END,
    'due_charges', CASE WHEN v_is_owner THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', rsc.id, 'rider_name', pu.full_name, 'month', rsc.month, 'year', rsc.year, 'amount_pkr', rsc.amount_pkr) ORDER BY rsc.year, rsc.month), '[]'::jsonb)
      FROM route_subscription_charges rsc JOIN route_subscriptions rs ON rs.id = rsc.subscription_id JOIN portal_users pu ON pu.id = rs.portal_user_id
      WHERE rs.route_id = p_route_id AND rsc.status = 'due'
    ) ELSE '[]'::jsonb END,
    'my_charges', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('month', rsc.month, 'year', rsc.year, 'amount_pkr', rsc.amount_pkr, 'status', rsc.status) ORDER BY rsc.year, rsc.month), '[]'::jsonb)
      FROM route_subscription_charges rsc JOIN route_subscriptions rs ON rs.id = rsc.subscription_id
      WHERE rs.route_id = p_route_id AND rs.portal_user_id = v_portal_user_id
    )
  );
END;
$$;
GRANT EXECUTE ON FUNCTION route_monthly_detail(uuid) TO authenticated;
