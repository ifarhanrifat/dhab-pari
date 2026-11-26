-- Migration 960: closes the three remaining gaps found during the
-- full rider/driver floating-button lifecycle test on 2026-11-26.
--
-- 1. "What if the rider still remains unconfirmed... what if the rider
--    could not catch the bus" — audited every RPC touching
--    ride_bookings and confirmed there was NO no-show mechanism for an
--    app booking at all. mark_manual_ticket_no_show (924-928) only
--    ever worked on manual_ride_bookings (counter-sold tickets). A
--    rider who booked through the app and simply never boarded just
--    sat there as status='announced' forever, until this session's
--    959 fix made the nightly sweep correctly ignore it (it's now
--    correctly NOT auto-cancelled — but nothing else ever resolves it
--    either). mark_ride_booking_no_show closes that gap, mirroring the
--    manual-ticket version's own shape.
--
-- 2. "What is the status when fleet manager will confirm his seat to
--    the next available bus" — reschedule_ride_booking (866) only
--    ever moves a booking to a different DATE on the SAME route/
--    vehicle; there was no way to move a rider to a different bus at
--    all. reassign_ride_booking_to_route adds exactly that: closes the
--    old booking, opens an already-confirmed one on the new route.
--
-- 3. route_group_detail (latest: 952) never told a rider their own
--    boarded/dropped-off status, or today's reported lateness — both
--    already existed in the database, confirmed live via screenshot
--    that neither ever reached the rider's screen anywhere. Added as
--    two new read-only fields; RouteGroupPanel.tsx now renders them.

-- ─────────────────────────────────────────────────────────────────────
-- New columns — additive, no existing behavior changes.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS no_show_at timestamptz;
ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS reassigned_to_booking_id uuid REFERENCES ride_bookings(id);
ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS reassigned_from_booking_id uuid REFERENCES ride_bookings(id);

-- ─────────────────────────────────────────────────────────────────────
-- mark_ride_booking_no_show — same shape as mark_manual_ticket_no_show
-- (928), for an app (ride_bookings) seat instead of a counter ticket.
-- Only a booking the driver actually confirmed (seat_accepted_at set)
-- and that never boarded can be marked — a booking still awaiting the
-- driver's own decision is accept/decline's job, not this one's.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mark_ride_booking_no_show(p_booking_id uuid, p_reason text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b ride_bookings%ROWTYPE; v_route vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND OR b.route_id IS NULL OR NOT (is_route_owner(b.route_id) OR is_route_operator(b.route_id)) THEN
    RAISE EXCEPTION 'You can only manage your own route''s bookings.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status != 'announced' THEN RAISE EXCEPTION 'This booking is not eligible for no-show.' USING ERRCODE = 'P0001'; END IF;
  IF b.seat_accepted_at IS NULL THEN RAISE EXCEPTION 'This seat was never confirmed — decline it instead.' USING ERRCODE = 'P0001'; END IF;
  IF b.boarded_at IS NOT NULL THEN RAISE EXCEPTION 'This rider already boarded.' USING ERRCODE = 'P0001'; END IF;
  IF b.travel_date > (now() AT TIME ZONE 'Asia/Karachi')::date THEN
    RAISE EXCEPTION 'You can only mark a no-show on or after the travel date.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE ride_bookings SET status = 'no_show', no_show_at = now(), rejected_reason = p_reason WHERE id = p_booking_id;
  DELETE FROM ride_booking_seat_numbers WHERE ride_booking_id = p_booking_id;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = b.route_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'ride_booking_no_show', 'Marked as a no-show',
    'You were marked as not having boarded for ' || v_route.origin || ' → ' || v_route.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || '.' || COALESCE(' ' || p_reason, '') || ' If this is wrong, contact the driver or fleet office.',
    '/portal/marketplace/trips');
END;
$$;
GRANT EXECUTE ON FUNCTION mark_ride_booking_no_show(uuid, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- reassign_ride_booking_to_route — "move this rider to the next
-- available bus." Caller must manage BOTH the origin and destination
-- routes (same fleet, in practice) — this is a staff action done on
-- the rider's behalf, not a rider self-service rebooking. The new
-- booking is auto-confirmed (seat_accepted_at = now()) since a fleet
-- staff member is the one placing it, carrying the SAME fare the rider
-- already paid — this moves their seat, it doesn't re-charge them.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION reassign_ride_booking_to_route(p_booking_id uuid, p_new_route_id uuid, p_new_travel_date date DEFAULT NULL, p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b ride_bookings%ROWTYPE; v_old_route vehicle_routes%ROWTYPE; v_new_route vehicle_routes%ROWTYPE;
  v_travel_date date; v_available int; v_ticket_no varchar; v_new_booking_id uuid; v_weekday int;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND OR b.route_id IS NULL THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (is_route_owner(b.route_id) OR is_route_operator(b.route_id)) THEN
    RAISE EXCEPTION 'You can only manage your own route''s bookings.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (is_route_owner(p_new_route_id) OR is_route_operator(p_new_route_id)) THEN
    RAISE EXCEPTION 'You can only reassign to a bus you also manage.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status != 'announced' THEN RAISE EXCEPTION 'This booking is not eligible for reassignment.' USING ERRCODE = 'P0001'; END IF;
  IF b.boarded_at IS NOT NULL OR b.dropped_off_at IS NOT NULL THEN
    RAISE EXCEPTION 'This rider has already boarded — reassignment is only for a seat that hasn''t boarded yet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_new_route_id = b.route_id THEN RAISE EXCEPTION 'Pick a different bus to move this seat to.' USING ERRCODE = 'P0001'; END IF;

  v_travel_date := COALESCE(p_new_travel_date, b.travel_date);
  SELECT * INTO v_new_route FROM vehicle_routes WHERE id = p_new_route_id;
  IF NOT FOUND OR NOT v_new_route.is_active THEN RAISE EXCEPTION 'That bus is not available right now.' USING ERRCODE = 'P0001'; END IF;
  IF v_new_route.one_off_date IS NOT NULL AND v_travel_date != v_new_route.one_off_date THEN
    RAISE EXCEPTION 'That bus only runs once, on %.', to_char(v_new_route.one_off_date, 'DD Mon YYYY') USING ERRCODE = 'P0001';
  END IF;
  v_weekday := extract(dow FROM v_travel_date)::int;
  IF NOT (v_weekday = ANY(v_new_route.days_of_week)) THEN
    RAISE EXCEPTION 'That bus does not run on %.', to_char(v_travel_date, 'DD Mon YYYY') USING ERRCODE = 'P0001';
  END IF;

  v_available := route_seats_available(p_new_route_id, v_travel_date);
  IF b.seats > v_available THEN
    RAISE EXCEPTION 'Only % seat(s) left on that bus.', v_available USING ERRCODE = 'P0001';
  END IF;

  v_ticket_no := generate_ticket_no();
  INSERT INTO ride_bookings (
    route_id, portal_user_id, travel_date, seats, total_amount_pkr, status,
    announced_amount_pkr, announced_method, announced_proof_url, announced_at,
    seat_accepted_at, ticket_no, reassigned_from_booking_id
  ) VALUES (
    p_new_route_id, b.portal_user_id, v_travel_date, b.seats, b.total_amount_pkr, 'announced',
    b.announced_amount_pkr, b.announced_method, b.announced_proof_url, now(),
    now(), v_ticket_no, b.id
  ) RETURNING id INTO v_new_booking_id;

  UPDATE ride_bookings SET status = 'rejected', rejected_reason = COALESCE(p_reason, 'Reassigned to another bus by the fleet.'), reassigned_to_booking_id = v_new_booking_id
  WHERE id = p_booking_id;
  DELETE FROM ride_booking_seat_numbers WHERE ride_booking_id = p_booking_id;

  INSERT INTO route_participants (route_id, portal_user_id, is_active)
  VALUES (p_new_route_id, b.portal_user_id, true)
  ON CONFLICT (route_id, portal_user_id) DO UPDATE SET is_active = true;

  SELECT * INTO v_old_route FROM vehicle_routes WHERE id = b.route_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'ride_booking_reassigned', 'Your seat has been moved to another bus',
    'Your seat on ' || v_old_route.origin || ' → ' || v_old_route.destination || ' has been moved to ' ||
    v_new_route.origin || ' → ' || v_new_route.destination || ' on ' || to_char(v_travel_date, 'DD Mon YYYY') ||
    '. Your fare already covers this — no extra payment needed.',
    '/portal/marketplace/trips');

  RETURN jsonb_build_object('new_booking_id', v_new_booking_id, 'ticket_no', v_ticket_no, 'travel_date', v_travel_date);
END;
$$;
GRANT EXECUTE ON FUNCTION reassign_ride_booking_to_route(uuid, uuid, date, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- route_group_detail (final body: 952) — true-replace. Adds my_booking
-- (the viewer's own confirmed booking today, if any — boarded_at/
-- dropped_off_at so the panel can show real status) and today_delay
-- (route_day_delays for today, any direction, preferring the active
-- run's own direction when one exists). Everything else copied
-- verbatim from 952's body.
-- ─────────────────────────────────────────────────────────────────────
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
  ORDER BY (rb.travel_date = v_today) DESC, rb.travel_date DESC LIMIT 1;

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
