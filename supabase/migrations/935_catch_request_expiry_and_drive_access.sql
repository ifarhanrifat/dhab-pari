-- ═════════════════════════════════════════════════════════════════════
-- Mid-route catch requests get a real accept/decline response window,
-- and the accept/decline/read RPCs are widened so a co-driver / active
-- substitute / active shift-driver on /portal/drive (is_route_operator)
-- can use them too, not just the primary route owner.
--
-- check_catch_feasibility/route_catch_feasibility (859) are untouched —
-- the "rider must be ahead of the bus, on the actual route road" gate
-- stays exactly as-is. This migration only governs what happens to a
-- request AFTER it already passed that gate.
-- ═════════════════════════════════════════════════════════════════════

ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS catch_request_expires_at timestamptz;

INSERT INTO site_settings (key, value, description) VALUES
  ('mid_route_catch_response_window_minutes', '2', 'How long a driver has to accept a mid-route catch request before it can no longer be accepted (decline still always works)')
ON CONFLICT (tenant_id, key) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════
-- place_ride_booking (final body: 920) — true-replace, same 10-arg
-- signature. Only change: a catch booking now gets a response-window
-- deadline. Non-catch bookings are unaffected (catch_request_expires_at
-- stays NULL).
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION place_ride_booking(
  p_route_id uuid, p_travel_date date, p_seats int, p_method varchar, p_proof_url text,
  p_board_stop_id uuid DEFAULT NULL, p_alight_stop_id uuid DEFAULT NULL, p_seat_numbers int[] DEFAULT NULL,
  p_board_lat numeric DEFAULT NULL, p_board_lng numeric DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE;
  v_vehicle vehicles%ROWTYPE;
  v_vehicle_kind varchar;
  v_available int;
  v_total decimal;
  v_per_seat decimal;
  v_seats_booked_so_far int;
  v_booking_id uuid;
  v_weekday int;
  v_commission_pct decimal;
  v_expected_commission decimal;
  v_board_stop route_stops%ROWTYPE;
  v_alight_stop route_stops%ROWTYPE;
  v_segment_fraction numeric := 1;
  v_is_catch boolean := false;
  v_catch_expires_at timestamptz;
  v_feas jsonb;
  v_lo int; v_hi int; v_sn int;
  v_board_city varchar; v_alight_city varchar;
BEGIN
  -- NOTE: this true-replaces the final body from migration 920. The
  -- only change from that body is v_catch_expires_at (declared above,
  -- computed below once v_is_catch is known) and its new column in the
  -- INSERT further down — every other line is unchanged.
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND OR NOT v_route.is_active THEN RAISE EXCEPTION 'Route not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  IF v_vehicle.tenant_id != my_tenant_id() AND NOT has_share_agreement(v_vehicle.tenant_id, my_tenant_id(), 'route') THEN
    RAISE EXCEPTION 'This route is not shared with your village yet.' USING ERRCODE = 'P0001';
  END IF;

  IF p_seats IS NULL OR p_seats <= 0 THEN RAISE EXCEPTION 'Pick at least one seat.' USING ERRCODE = 'P0001'; END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
  IF v_route.one_off_date IS NOT NULL AND p_travel_date != v_route.one_off_date THEN
    RAISE EXCEPTION 'This ride only runs once, on %.', to_char(v_route.one_off_date, 'DD Mon YYYY') USING ERRCODE = 'P0001';
  END IF;

  v_weekday := extract(dow FROM p_travel_date)::int;
  IF NOT (v_weekday = ANY(v_route.days_of_week)) THEN
    RAISE EXCEPTION 'This route does not run on that day.' USING ERRCODE = 'P0001';
  END IF;

  v_is_catch := p_board_lat IS NOT NULL AND p_board_lng IS NOT NULL;

  IF p_board_stop_id IS NULL AND NOT v_is_catch
     AND p_travel_date = (now() AT TIME ZONE 'Asia/Karachi')::date
     AND EXISTS (SELECT 1 FROM route_runs WHERE route_id = p_route_id AND direction = 'outbound' AND ended_at IS NULL AND (started_at AT TIME ZONE 'Asia/Karachi')::date = p_travel_date)
  THEN
    RAISE EXCEPTION 'This bus has already left % today — book from a stop further along the route, or choose another date.', v_route.origin USING ERRCODE = 'P0001';
  END IF;

  v_available := route_seats_available(p_route_id, p_travel_date);
  IF p_seats > v_available THEN
    RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001';
  END IF;

  SELECT vc.vehicle_kind INTO v_vehicle_kind FROM vehicle_categories vc WHERE vc.id = v_vehicle.category_id;
  IF v_vehicle_kind = 'van' THEN
    IF p_seat_numbers IS NULL OR array_length(p_seat_numbers, 1) IS DISTINCT FROM p_seats THEN
      RAISE EXCEPTION 'Pick exactly % seat(s).', p_seats USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_seat_numbers) sn WHERE sn < 1 OR sn > route_effective_seats(p_route_id)) THEN
      RAISE EXCEPTION 'That seat doesn''t exist on this vehicle.' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_seat_numbers IS NOT NULL THEN
    RAISE EXCEPTION 'This vehicle doesn''t use seat numbers.' USING ERRCODE = 'P0001';
  END IF;

  IF p_board_stop_id IS NOT NULL AND (p_board_lat IS NOT NULL OR p_board_lng IS NOT NULL) THEN
    RAISE EXCEPTION 'Pick either a board stop or a live catch point, not both.' USING ERRCODE = 'P0001';
  END IF;

  IF v_is_catch THEN
    IF p_alight_stop_id IS NULL THEN
      RAISE EXCEPTION 'Pick where you''re getting off.' USING ERRCODE = 'P0001';
    END IF;
    v_feas := check_catch_feasibility(p_route_id, p_board_lat, p_board_lng);
    IF NOT (v_feas->>'eligible')::boolean THEN
      RAISE EXCEPTION '%', coalesce(v_feas->>'reason', 'You can''t catch this ride right now.') USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_alight_stop FROM route_stops WHERE id = p_alight_stop_id AND route_id = p_route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real alight stop on this route.' USING ERRCODE = 'P0001'; END IF;
    v_segment_fraction := route_fraction_remaining(p_route_id, p_board_lat, p_board_lng) - route_fraction_remaining(p_route_id, v_alight_stop.lat, v_alight_stop.lng);
    IF v_segment_fraction <= 0 THEN RAISE EXCEPTION 'The alight stop must be further along the route than where you''re catching it.' USING ERRCODE = 'P0001'; END IF;
    SELECT now() + (COALESCE((SELECT value::int FROM site_settings WHERE key = 'mid_route_catch_response_window_minutes'), 2) * interval '1 minute')
      INTO v_catch_expires_at;
  ELSIF (p_board_stop_id IS NOT NULL) != (p_alight_stop_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Pick both a board and an alight stop, or leave both blank for the full route.' USING ERRCODE = 'P0001';
  ELSIF p_board_stop_id IS NOT NULL THEN
    SELECT * INTO v_board_stop FROM route_stops WHERE id = p_board_stop_id AND route_id = p_route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real board stop on this route.' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO v_alight_stop FROM route_stops WHERE id = p_alight_stop_id AND route_id = p_route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real alight stop on this route.' USING ERRCODE = 'P0001'; END IF;
    v_segment_fraction := route_fraction_remaining(p_route_id, v_board_stop.lat, v_board_stop.lng) - route_fraction_remaining(p_route_id, v_alight_stop.lat, v_alight_stop.lng);
    IF v_segment_fraction <= 0 THEN RAISE EXCEPTION 'The alight stop must be further along the route than the board stop.' USING ERRCODE = 'P0001'; END IF;
  END IF;

  IF v_route.fare_mode = 'terminal_zone' THEN
    -- Real rule: a free-GPS catch is never a listed terminal, so it
    -- always costs the full route fare, same as a counter sale from
    -- outside a listed city — route_zone_fare_by_city already returns
    -- the full fare whenever either city is NULL.
    IF NOT v_is_catch THEN
      v_board_city := CASE WHEN p_board_stop_id IS NOT NULL THEN (SELECT fc.city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id WHERE rs.id = p_board_stop_id)
        ELSE (SELECT fc.city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id WHERE rs.route_id = p_route_id ORDER BY rs.stop_order ASC LIMIT 1) END;
      v_alight_city := CASE WHEN p_alight_stop_id IS NOT NULL THEN (SELECT fc.city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id WHERE rs.id = p_alight_stop_id)
        ELSE (SELECT fc.city FROM route_stops rs JOIN fleet_counters fc ON fc.id = rs.counter_id WHERE rs.route_id = p_route_id ORDER BY rs.stop_order DESC LIMIT 1) END;
    END IF;
    v_total := p_seats * route_zone_fare_by_city(p_route_id, v_board_city, v_alight_city);
  ELSIF v_route.fare_mode = 'flex' THEN
    SELECT COALESCE(SUM(seats), 0) INTO v_seats_booked_so_far FROM ride_bookings
      WHERE route_id = p_route_id AND travel_date = p_travel_date AND status IN ('announced', 'confirmed');
    v_per_seat := v_route.total_fare_pkr / (v_seats_booked_so_far + p_seats);
    v_total := p_seats * v_per_seat;
  ELSE
    v_total := round(p_seats * v_route.fare_per_seat_pkr * v_segment_fraction);
  END IF;

  IF v_vehicle.commission_mode != 'monthly_lumpsum' THEN
    IF NOT v_vehicle.is_active THEN
      RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings — try another one.' USING ERRCODE = 'P0001';
    END IF;
    v_commission_pct := vehicle_commission_pct(v_vehicle.vehicle_type, v_route.classification);
    v_expected_commission := round(v_total * v_commission_pct / 100, 2);
    IF seller_account_balance(ensure_vehicle_account(v_vehicle.id)) < v_expected_commission THEN
      RAISE EXCEPTION 'This vehicle''s wallet balance is too low to cover this booking''s commission — the driver needs to top up first.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO ride_bookings (route_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at, board_stop_id, alight_stop_id, is_mid_route_catch, catch_request_expires_at)
  VALUES (p_route_id, v_portal_user_id, p_travel_date, p_seats, v_total, 'announced', v_total, p_method, p_proof_url, now(), p_board_stop_id, p_alight_stop_id, v_is_catch, v_catch_expires_at)
  RETURNING id INTO v_booking_id;

  IF p_seat_numbers IS NOT NULL THEN
    v_lo := seat_stop_order(p_board_stop_id, -1);
    v_hi := seat_stop_order(p_alight_stop_id, 2000000000);
    FOREACH v_sn IN ARRAY (SELECT array_agg(x ORDER BY x) FROM unnest(p_seat_numbers) x) LOOP
      PERFORM assert_seat_segment_free(p_route_id, p_travel_date, 'outbound', v_sn, v_lo, v_hi);
      INSERT INTO ride_booking_seat_numbers (ride_booking_id, route_id, travel_date, direction, seat_number, board_order, alight_order)
      VALUES (v_booking_id, p_route_id, p_travel_date, 'outbound', v_sn, v_lo, v_hi);
    END LOOP;
  END IF;

  IF v_is_catch THEN
    INSERT INTO ride_booking_catch_locations (ride_booking_id, lat, lng) VALUES (v_booking_id, p_board_lat, p_board_lng);
  END IF;

  IF v_vehicle.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_vehicle.portal_user_id,
      CASE WHEN v_is_catch THEN 'route_catch_request' ELSE 'route_seat_booked' END,
      CASE WHEN v_is_catch THEN 'Someone is trying to catch your ride' ELSE 'New seat booked — confirm once paid' END,
      CASE WHEN v_is_catch THEN p_seats || ' seat(s) requested near your current position — view their live location before accepting.'
        ELSE p_seats || ' seat(s) for ' || to_char(p_travel_date, 'DD Mon') || ' — Rs ' || round(v_total) || '. Confirm their seat once they''ve paid you directly, to add them to your ride group.' END,
      '/portal/my-vehicle/routes');
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_portal_user_id, 'ride_booking_pending', 'Seat booked — not confirmed yet',
    'Pay the driver directly to confirm this seat. Until the driver confirms your payment, another paying rider could take it, and you won''t yet see the live map/chat/group for this ride.',
    '/portal/marketplace/trips');

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total, 'is_mid_route_catch', v_is_catch);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════
-- accept_ride_booking_seat (final body: 831) — true-replace: widen the
-- gate to is_route_operator (owner, co-driver, active substitute,
-- active shift-driver), and reject accepting a catch request past its
-- response window. Decline is unaffected by expiry (see below).
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION accept_ride_booking_seat(p_booking_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b ride_bookings%ROWTYPE; v_route vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND OR b.route_id IS NULL OR NOT (is_route_owner(b.route_id) OR is_route_operator(b.route_id)) THEN
    RAISE EXCEPTION 'You can only manage your own route''s bookings.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status != 'announced' THEN RAISE EXCEPTION 'This booking is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  IF b.is_mid_route_catch AND b.catch_request_expires_at IS NOT NULL AND now() > b.catch_request_expires_at THEN
    RAISE EXCEPTION 'This catch request has expired.' USING ERRCODE = 'P0001';
  END IF;
  IF b.seat_accepted_at IS NOT NULL THEN RETURN; END IF;

  UPDATE ride_bookings SET seat_accepted_at = now() WHERE id = p_booking_id;

  INSERT INTO route_participants (route_id, portal_user_id, is_active)
  VALUES (b.route_id, b.portal_user_id, true)
  ON CONFLICT (route_id, portal_user_id) DO UPDATE SET is_active = true;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = b.route_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'ride_booking_seat_accepted', 'Your seat is confirmed',
    'The driver confirmed your seat for ' || v_route.origin || ' → ' || v_route.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || '. You''re now in the ride group — live map, chat and boarding are open.',
    '/portal/marketplace/trips');
END;
$$;
GRANT EXECUTE ON FUNCTION accept_ride_booking_seat(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- decline_ride_booking_seat (final body: 850) — true-replace: same
-- gate widen only. No expiry check — a driver can always decline.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION decline_ride_booking_seat(p_booking_id uuid, p_reason text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b ride_bookings%ROWTYPE; v_route vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND OR b.route_id IS NULL OR NOT (is_route_owner(b.route_id) OR is_route_operator(b.route_id)) THEN
    RAISE EXCEPTION 'You can only manage your own route''s bookings.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status != 'announced' THEN RAISE EXCEPTION 'This booking is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;

  UPDATE ride_bookings SET status = 'rejected', rejected_reason = p_reason WHERE id = p_booking_id;
  DELETE FROM ride_booking_seat_numbers WHERE ride_booking_id = p_booking_id;
  DELETE FROM ride_booking_catch_locations WHERE ride_booking_id = p_booking_id;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = b.route_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'ride_booking_rejected', 'Your seat request could not be confirmed',
    'The driver could not confirm your seat for ' || v_route.origin || ' → ' || v_route.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || '.' || COALESCE(' ' || p_reason, '') || ' Your payment was not taken through the app — settle directly with the driver if anything was already paid.',
    '/portal/marketplace/trips');
END;
$$;
GRANT EXECUTE ON FUNCTION decline_ride_booking_seat(uuid, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- route_today_ad_hoc_bookings (final body: 850) — true-replace: widen
-- the gate to is_route_operator, and add the fields the /portal/drive
-- catch-request card needs (alight stop, fare, payment method, expiry).
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION route_today_ad_hoc_bookings(p_route_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (is_route_owner(p_route_id) OR is_route_operator(p_route_id)) THEN RETURN '[]'::jsonb; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', rb.id, 'name', pu.full_name, 'seats', rb.seats, 'boarded_at', rb.boarded_at, 'dropped_off_at', rb.dropped_off_at,
      'board_stop_id', rb.board_stop_id, 'seat_accepted_at', rb.seat_accepted_at,
      'is_mid_route_catch', rb.is_mid_route_catch,
      'catch_lat', cl.lat, 'catch_lng', cl.lng, 'catch_updated_at', cl.updated_at,
      'alight_stop_id', rb.alight_stop_id, 'total_amount_pkr', rb.total_amount_pkr,
      'announced_method', rb.announced_method, 'catch_request_expires_at', rb.catch_request_expires_at
    ) ORDER BY rb.created_at), '[]'::jsonb)
    FROM ride_bookings rb JOIN portal_users pu ON pu.id = rb.portal_user_id
    LEFT JOIN ride_booking_catch_locations cl ON cl.ride_booking_id = rb.id
    WHERE rb.route_id = p_route_id AND rb.travel_date = (now() AT TIME ZONE 'Asia/Karachi')::date
      AND rb.status IN ('announced', 'confirmed') AND rb.direction = 'outbound'
  );
END;
$$;
GRANT EXECUTE ON FUNCTION route_today_ad_hoc_bookings(uuid) TO authenticated;
