-- Migration 820: real bug found via live production data (not
-- inspection) — route be84df83's outbound run was started 2026-10-28
-- and left un-ended until 2026-11-06 (more than a week later). The
-- instant it was finally ended, the driver got "Start Ride" again
-- instead of "Start Return Trip", because route_group_detail's
-- todays_runs only matched runs whose started_at fell on today's
-- date — a run that started on an earlier day and only ENDED today
-- doesn't match, so RouteGroupPanel's nextDirection calc saw zero
-- "today's runs" and reset to outbound. Widened to also match a run
-- that ENDED today, so finishing a long-open run correctly flips the
-- button to "Start Return Trip" the same day it's actually ended —
-- while a run that both started AND ended on an earlier day still
-- correctly resets the next calendar day back to a fresh "outbound".
-- Also fixed in passing: the date comparison used the session's
-- default timezone (likely UTC) instead of explicitly Asia/Karachi,
-- same as every other date comparison in this function.
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
