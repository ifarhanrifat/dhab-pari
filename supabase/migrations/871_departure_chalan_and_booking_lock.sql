-- Migration 871: real spec given live — a departure "chalan" (manifest)
-- the booking officer sees at the moment the driver starts today's run:
-- full onboard-at-origin passenger list (manual + online, confirmed vs
-- unconfirmed, cash totals), separated from riders booked to board
-- further down the route (grouped by stop) who aren't onboard yet.
-- Policy confirmed directly: a paid no-show always gets offered a
-- next-bus transfer first — reuses the reschedule RPCs already built
-- this session rather than new logic; the officer can still fall back
-- to a plain cancel.
--
-- Also closes a real gap found while building this: once the driver
-- has actually left the origin today, NEITHER record_manual_booking
-- NOR place_ride_booking checked route_runs at all — a counter or an
-- online rider could still "book" a seat departing from a stop the bus
-- had already left. A board point further down the route (still ahead
-- of the vehicle) stays completely unaffected, same reasoning as the
-- rider-facing already_passed check built last round.

-- ═════════════════════════════════════════════════════════════════════
-- 1. place_ride_booking — origin-boarding lock. Same signature as 870's
--    live version, true replace.
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
  v_feas jsonb;
BEGIN
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

  -- 871: origin-boarding lock — a mid-route catch is exempt (it IS the
  -- "board after departure" path), and a real board stop further down
  -- the route is exempt too (the bus hasn't reached it yet).
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

  IF v_route.fare_mode = 'flex' THEN
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

  INSERT INTO ride_bookings (route_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at, board_stop_id, alight_stop_id, is_mid_route_catch)
  VALUES (p_route_id, v_portal_user_id, p_travel_date, p_seats, v_total, 'announced', v_total, p_method, p_proof_url, now(), p_board_stop_id, p_alight_stop_id, v_is_catch)
  RETURNING id INTO v_booking_id;

  IF p_seat_numbers IS NOT NULL THEN
    BEGIN
      INSERT INTO ride_booking_seat_numbers (ride_booking_id, route_id, travel_date, direction, seat_number)
      SELECT v_booking_id, p_route_id, p_travel_date, 'outbound', sn FROM unnest(p_seat_numbers) sn;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'One of those seats was just taken by someone else — pick again.' USING ERRCODE = 'P0001';
    END;
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
-- 2. record_manual_booking — same origin-boarding lock. Same signature
--    as 855's live version, true replace.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION record_manual_booking(
  p_route_id uuid, p_travel_date date, p_seats int, p_passenger_name varchar, p_total_amount_pkr decimal,
  p_counter_id uuid DEFAULT NULL, p_passenger_mobile varchar DEFAULT NULL, p_payment_method varchar DEFAULT 'cash',
  p_board_stop_id uuid DEFAULT NULL, p_alight_stop_id uuid DEFAULT NULL, p_seat_numbers int[] DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE; v_vehicle_kind varchar;
  v_available int; v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  -- 871: same origin-boarding lock as place_ride_booking — the counter
  -- a booking officer sits at is tied to the route's origin city, so a
  -- manual sale for TODAY with no board stop (= boarding at origin) is
  -- exactly the case the bus having already left makes impossible.
  IF p_board_stop_id IS NULL
     AND p_travel_date = (now() AT TIME ZONE 'Asia/Karachi')::date
     AND EXISTS (SELECT 1 FROM route_runs WHERE route_id = p_route_id AND direction = 'outbound' AND ended_at IS NULL AND (started_at AT TIME ZONE 'Asia/Karachi')::date = p_travel_date)
  THEN
    RAISE EXCEPTION 'This bus has already left % today — sell a seat for a stop further along the route, or a different date.', v_route.origin USING ERRCODE = 'P0001';
  END IF;

  IF p_counter_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_counters WHERE id = p_counter_id AND fleet_id = v_vehicle.fleet_id) THEN
    RAISE EXCEPTION 'That counter is not part of this vehicle''s fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_seats IS NULL OR p_seats <= 0 THEN RAISE EXCEPTION 'Enter at least one seat.' USING ERRCODE = 'P0001'; END IF;
  IF trim(coalesce(p_passenger_name, '')) = '' THEN RAISE EXCEPTION 'Enter the passenger''s name.' USING ERRCODE = 'P0001'; END IF;
  IF p_total_amount_pkr IS NULL OR p_total_amount_pkr < 0 THEN RAISE EXCEPTION 'Enter the fare collected.' USING ERRCODE = 'P0001'; END IF;

  v_available := route_seats_available(p_route_id, p_travel_date);
  IF p_seats > v_available THEN RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001'; END IF;

  SELECT vc.vehicle_kind INTO v_vehicle_kind FROM vehicle_categories vc WHERE vc.id = v_vehicle.category_id;
  IF v_vehicle_kind = 'van' THEN
    IF p_seat_numbers IS NULL OR array_length(p_seat_numbers, 1) IS DISTINCT FROM p_seats THEN
      RAISE EXCEPTION 'Pick exactly % seat(s).', p_seats USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_seat_numbers) sn WHERE sn < 1 OR sn > route_effective_seats_for_date(p_route_id, p_travel_date)) THEN
      RAISE EXCEPTION 'That seat doesn''t exist on this vehicle.' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_seat_numbers IS NOT NULL THEN
    RAISE EXCEPTION 'This vehicle doesn''t use seat numbers.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO manual_ride_bookings (route_id, counter_id, recorded_by_portal_user_id, travel_date, seats, passenger_name, passenger_mobile, board_stop_id, alight_stop_id, total_amount_pkr, payment_method)
  VALUES (p_route_id, p_counter_id, v_portal_user_id, p_travel_date, p_seats, trim(p_passenger_name), nullif(trim(coalesce(p_passenger_mobile, '')), ''), p_board_stop_id, p_alight_stop_id, p_total_amount_pkr, p_payment_method)
  RETURNING id INTO v_id;

  IF p_seat_numbers IS NOT NULL THEN
    BEGIN
      INSERT INTO ride_booking_seat_numbers (manual_ride_booking_id, route_id, travel_date, direction, seat_number)
      SELECT v_id, p_route_id, p_travel_date, 'outbound', sn FROM unnest(p_seat_numbers) sn;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'One of those seats was just taken by someone else — pick again.' USING ERRCODE = 'P0001';
    END;
  END IF;

  RETURN v_id;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 3. route_departure_chalan — the manifest itself. Always viewable
--    (an officer can prepare it before the bus has actually left); the
--    booking lock above is what actually changes once a run exists.
--    "Onboard now" = boards at the origin (board_stop_id IS NULL);
--    everyone else is grouped by their real board stop, ordered along
--    the route, since they board later, further down the road.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION route_departure_chalan(p_route_id uuid, p_travel_date date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_date date := COALESCE(p_travel_date, (now() AT TIME ZONE 'Asia/Karachi')::date);
  v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE;
  v_run route_runs%ROWTYPE;
  v_result jsonb;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_run FROM route_runs WHERE route_id = p_route_id AND direction = 'outbound' AND (started_at AT TIME ZONE 'Asia/Karachi')::date = v_date ORDER BY started_at DESC LIMIT 1;

  WITH rows AS (
    SELECT
      mb.id, 'manual'::varchar AS source, mb.passenger_name, mb.passenger_mobile, mb.seats, mb.total_amount_pkr AS amount,
      mb.payment_method, true AS is_confirmed, mb.board_stop_id,
      (SELECT array_agg(sn.seat_number ORDER BY sn.seat_number) FROM ride_booking_seat_numbers sn WHERE sn.manual_ride_booking_id = mb.id) AS seat_numbers
    FROM manual_ride_bookings mb
    WHERE mb.route_id = p_route_id AND mb.travel_date = v_date AND mb.status = 'confirmed'
    UNION ALL
    SELECT
      rb.id, 'app'::varchar AS source, pu.full_name, pu.mobile, rb.seats, rb.total_amount_pkr AS amount,
      rb.announced_method, rb.status = 'confirmed' AS is_confirmed, rb.board_stop_id,
      (SELECT array_agg(sn.seat_number ORDER BY sn.seat_number) FROM ride_booking_seat_numbers sn WHERE sn.ride_booking_id = rb.id) AS seat_numbers
    FROM ride_bookings rb JOIN portal_users pu ON pu.id = rb.portal_user_id
    WHERE rb.route_id = p_route_id AND rb.travel_date = v_date AND rb.status IN ('announced', 'confirmed') AND NOT rb.is_mid_route_catch
  ),
  onboard AS (
    SELECT jsonb_build_object('id', id, 'source', source, 'passenger_name', passenger_name, 'passenger_mobile', passenger_mobile,
      'seats', seats, 'seat_numbers', seat_numbers, 'amount', amount, 'payment_method', payment_method, 'is_confirmed', is_confirmed) AS row
    FROM rows WHERE board_stop_id IS NULL
  ),
  next_stop AS (
    SELECT rs.label, rs.stop_order, jsonb_build_object('id', rows.id, 'source', rows.source, 'passenger_name', rows.passenger_name, 'passenger_mobile', rows.passenger_mobile,
      'seats', rows.seats, 'seat_numbers', rows.seat_numbers, 'amount', rows.amount, 'payment_method', rows.payment_method, 'is_confirmed', rows.is_confirmed) AS row
    FROM rows JOIN route_stops rs ON rs.id = rows.board_stop_id
  )
  SELECT jsonb_build_object(
    'route_id', p_route_id, 'origin', v_route.origin, 'destination', v_route.destination, 'travel_date', v_date,
    'owner_name', v_vehicle.owner_name, 'vehicle_type', v_vehicle.vehicle_type,
    'run_started_at', v_run.started_at, 'run_ended_at', v_run.ended_at,
    'onboard_now', (SELECT COALESCE(jsonb_agg(row), '[]'::jsonb) FROM onboard),
    'next_stops', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', label, 'passengers', passengers) ORDER BY stop_order), '[]'::jsonb)
      FROM (SELECT label, stop_order, jsonb_agg(row) AS passengers FROM next_stop GROUP BY label, stop_order) g
    ),
    'total_confirmed_count', (SELECT COALESCE(SUM(seats), 0) FROM rows WHERE is_confirmed),
    'total_unconfirmed_count', (SELECT COALESCE(SUM(seats), 0) FROM rows WHERE NOT is_confirmed),
    'cash_collected_pkr', (SELECT COALESCE(SUM(amount), 0) FROM rows WHERE is_confirmed AND payment_method = 'cash')
  ) INTO v_result;

  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION route_departure_chalan(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION route_departure_chalan(uuid, date) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 4. fleet_booking_summary — real ask: "the current seat positions...
--    datewise how many seats booked... monthwise how much online booked
--    and how much manually booked, how much are confirmed seats with
--    payments and how much are unconfirmed." One daily-grouped report,
--    reused for both a single day and a full month by the date range
--    the caller passes — no separate "monthly" RPC needed.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fleet_booking_summary(p_fleet_id uuid, p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  WITH manual AS (
    SELECT mb.travel_date, COUNT(*) AS cnt, SUM(mb.total_amount_pkr) AS amt
    FROM manual_ride_bookings mb JOIN vehicle_routes vr ON vr.id = mb.route_id JOIN vehicles v ON v.id = vr.vehicle_id
    WHERE v.fleet_id = p_fleet_id AND mb.status = 'confirmed' AND mb.travel_date BETWEEN p_from AND p_to
    GROUP BY mb.travel_date
  ),
  online_confirmed AS (
    SELECT rb.travel_date, COUNT(*) AS cnt, SUM(rb.total_amount_pkr) AS amt
    FROM ride_bookings rb JOIN vehicle_routes vr ON vr.id = rb.route_id JOIN vehicles v ON v.id = vr.vehicle_id
    WHERE v.fleet_id = p_fleet_id AND rb.status = 'confirmed' AND rb.travel_date BETWEEN p_from AND p_to
    GROUP BY rb.travel_date
  ),
  online_unconfirmed AS (
    SELECT rb.travel_date, COUNT(*) AS cnt, SUM(rb.total_amount_pkr) AS amt
    FROM ride_bookings rb JOIN vehicle_routes vr ON vr.id = rb.route_id JOIN vehicles v ON v.id = vr.vehicle_id
    WHERE v.fleet_id = p_fleet_id AND rb.status = 'announced' AND rb.travel_date BETWEEN p_from AND p_to
    GROUP BY rb.travel_date
  ),
  days AS (
    SELECT generate_series(p_from, p_to, interval '1 day')::date AS travel_date
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'travel_date', d.travel_date,
    'manual_count', COALESCE(m.cnt, 0), 'manual_amount_pkr', COALESCE(m.amt, 0),
    'online_confirmed_count', COALESCE(oc.cnt, 0), 'online_confirmed_amount_pkr', COALESCE(oc.amt, 0),
    'online_unconfirmed_count', COALESCE(ou.cnt, 0), 'online_unconfirmed_amount_pkr', COALESCE(ou.amt, 0)
  ) ORDER BY d.travel_date), '[]'::jsonb) INTO v_result
  FROM days d
  LEFT JOIN manual m ON m.travel_date = d.travel_date
  LEFT JOIN online_confirmed oc ON oc.travel_date = d.travel_date
  LEFT JOIN online_unconfirmed ou ON ou.travel_date = d.travel_date;

  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION fleet_booking_summary(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_booking_summary(uuid, date, date) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 5. fleet_notify_route_riders — real gap confirmed in the audit: only
--    a platform-wide admin broadcast existed (every rider on the
--    platform, no scoping at all) — a booking officer had no way to
--    message just the online riders on a specific route/date. Manual
--    (walk-up) passengers are reached via their stored mobile number
--    (tap-to-call/WhatsApp, same migration's frontend) since they have
--    no portal account to push a notification to at all.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fleet_notify_route_riders(p_route_id uuid, p_travel_date date, p_title varchar, p_body text) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vehicle_routes vr WHERE vr.id = p_route_id AND can_manage_vehicle(vr.vehicle_id)) THEN
    RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001';
  END IF;
  IF trim(coalesce(p_title, '')) = '' OR trim(coalesce(p_body, '')) = '' THEN
    RAISE EXCEPTION 'Enter a title and message.' USING ERRCODE = 'P0001';
  END IF;

  WITH riders AS (
    SELECT DISTINCT portal_user_id FROM ride_bookings
    WHERE route_id = p_route_id AND travel_date = p_travel_date AND status IN ('announced', 'confirmed')
  )
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT portal_user_id, 'fleet_message', trim(p_title), trim(p_body), '/portal/marketplace/route/' || p_route_id FROM riders;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION fleet_notify_route_riders(uuid, date, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_notify_route_riders(uuid, date, varchar, text) TO authenticated;
