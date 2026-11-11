-- Migration 847: driver route-creation redesign, piece 4 of 4.
--
-- 1. create_vehicle_route_self: fleet-aware ownership (844's
--    can_manage_vehicle instead of a plain portal_user_id equality
--    check), server-derived fare_mode by vehicle_kind (no more driver
--    toggle — see the naming-trap note below), and a new one-off-date
--    mode so a true single-day post (what the retired home-page quick-
--    poster used to cover) doesn't have to recur forever.
--
-- 2. fare_mode naming trap: vehicle_routes.fare_mode = 'fixed' means
--    per-stop FRACTIONAL fare (route_fraction_remaining, 723); 'flex'
--    means FLAT full-seat fare, stops rejected (832). Backwards from
--    what either word suggests. Not renaming the column now — too many
--    existing call sites (place_ride_booking, book_standalone_return_
--    seat, apply_for_monthly_seat, reschedule_ride_booking, every
--    routes/page.tsx display branch) for a safe single-pass rename.
--    From here on, p_fare_mode is accepted on create_vehicle_route_self
--    only so no existing call site breaks — its value is ignored, the
--    real mode is always derived from vehicle_kind inside this
--    function. No other new code should ever branch on 'fixed'/'flex'
--    by name again outside this one resolver.
--
-- 3. 'van' already groups van/suzuki_ravi/suzuki_carry_dabba/bus/
--    coaster/hiace/suzuki_bolan as one vehicle_kind (833's backfill);
--    car/suv are separate. That single check is the exact split asked
--    for — no new classification column needed.

ALTER TABLE vehicle_routes ADD COLUMN IF NOT EXISTS one_off_date date;

DROP FUNCTION IF EXISTS public.create_vehicle_route_self(uuid, character varying, character varying, character varying, character varying, numeric, time without time zone, integer[], character varying, character varying, numeric, numeric, numeric, numeric, numeric, jsonb, numeric, time without time zone, boolean, numeric, boolean, int);

CREATE OR REPLACE FUNCTION public.create_vehicle_route_self(p_vehicle_id uuid, p_origin character varying, p_destination character varying, p_classification character varying, p_fare_mode character varying, p_total_fare_pkr numeric DEFAULT NULL::numeric, p_departure_time time without time zone DEFAULT NULL::time without time zone, p_days_of_week integer[] DEFAULT '{}'::integer[], p_origin_ur character varying DEFAULT NULL::character varying, p_destination_ur character varying DEFAULT NULL::character varying, p_origin_lat numeric DEFAULT NULL::numeric, p_origin_lng numeric DEFAULT NULL::numeric, p_destination_lat numeric DEFAULT NULL::numeric, p_destination_lng numeric DEFAULT NULL::numeric, p_distance_km numeric DEFAULT NULL::numeric, p_route_path jsonb DEFAULT NULL::jsonb, p_route_duration_min numeric DEFAULT NULL::numeric, p_return_departure_time time without time zone DEFAULT NULL::time without time zone, p_is_monthly_fixed boolean DEFAULT false, p_monthly_reference_fee_pkr numeric DEFAULT NULL::numeric, p_is_two_way boolean DEFAULT false, p_return_wait_minutes int DEFAULT NULL, p_one_off_date date DEFAULT NULL::date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_tenant_id uuid;
  v_seats int;
  v_per_seat decimal;
  v_id uuid;
  v_fair_per_seat decimal;
  v_vehicle_kind varchar;
  v_fare_mode varchar;
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required';
  END IF;

  IF NOT can_manage_vehicle(p_vehicle_id) THEN
    RAISE EXCEPTION 'You can only post a route for your own vehicle, or one in a fleet you own';
  END IF;
  SELECT v.tenant_id, v.total_seats, vc.vehicle_kind INTO v_tenant_id, v_seats, v_vehicle_kind
    FROM vehicles v LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
    WHERE v.id = p_vehicle_id AND v.is_active = true;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'That vehicle is not available';
  END IF;

  -- Server-derived, not driver-chosen — see this migration's header.
  v_fare_mode := CASE WHEN v_vehicle_kind = 'van' THEN 'fixed' ELSE 'flex' END;

  IF EXISTS (SELECT 1 FROM vehicle_routes WHERE vehicle_id = p_vehicle_id AND is_active = true) THEN
    RAISE EXCEPTION 'You already have an active route posted — close it before posting a new one.' USING ERRCODE = 'P0001';
  END IF;

  IF coalesce(trim(p_origin), '') = '' OR coalesce(trim(p_destination), '') = '' THEN
    RAISE EXCEPTION 'Origin and destination are required';
  END IF;
  IF p_days_of_week IS NULL OR array_length(p_days_of_week, 1) IS NULL THEN
    RAISE EXCEPTION 'Pick at least one day';
  END IF;

  PERFORM assert_no_route_conflict(p_vehicle_id, NULL, p_days_of_week, p_departure_time,
    CASE WHEN p_is_two_way THEN p_return_departure_time ELSE NULL END, p_route_duration_min);

  IF p_one_off_date IS NOT NULL THEN
    IF p_is_monthly_fixed THEN RAISE EXCEPTION 'A monthly-fixed route can''t also be a one-off date.' USING ERRCODE = 'P0001'; END IF;
    IF p_one_off_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
    IF NOT (extract(dow FROM p_one_off_date)::int = ANY(p_days_of_week)) THEN
      RAISE EXCEPTION 'That date does not fall on the day you picked.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_is_monthly_fixed THEN
    IF p_monthly_reference_fee_pkr IS NULL OR p_monthly_reference_fee_pkr <= 0 THEN
      RAISE EXCEPTION 'Enter the monthly reference fee';
    END IF;
    p_total_fare_pkr := 0;
    v_per_seat := 0;
  ELSE
    IF p_distance_km IS NOT NULL THEN
      v_fair_per_seat := (fare_band_for('route', p_distance_km)->>'fair')::decimal;
      IF v_fair_per_seat IS NOT NULL THEN
        IF p_total_fare_pkr IS NULL THEN
          p_total_fare_pkr := round(v_fair_per_seat * greatest(1, coalesce(v_seats, 1)));
        ELSIF round(p_total_fare_pkr / greatest(1, coalesce(v_seats, 1))) > round(v_fair_per_seat) THEN
          RAISE EXCEPTION 'The fair fare per seat for this distance is ₨% (₨% total across % seats) — you can list that or less, not more.', round(v_fair_per_seat), round(v_fair_per_seat * greatest(1, coalesce(v_seats, 1))), greatest(1, coalesce(v_seats, 1)) USING ERRCODE = 'P0001';
        END IF;
      END IF;
    END IF;

    IF p_total_fare_pkr IS NULL OR p_total_fare_pkr <= 0 THEN
      RAISE EXCEPTION 'Enter the total fare';
    END IF;

    v_per_seat := round(p_total_fare_pkr / greatest(1, coalesce(v_seats, 1)));
  END IF;

  INSERT INTO vehicle_routes (
    vehicle_id, tenant_id, origin, origin_ur, destination, destination_ur,
    classification, fare_mode, total_fare_pkr, fare_per_seat_pkr,
    departure_time, days_of_week, is_active,
    origin_lat, origin_lng, destination_lat, destination_lng, distance_km,
    route_path, route_duration_min, return_departure_time,
    is_monthly_fixed, monthly_reference_fee_pkr,
    is_two_way, return_wait_minutes, one_off_date
  ) VALUES (
    p_vehicle_id, v_tenant_id, trim(p_origin), nullif(trim(coalesce(p_origin_ur, '')), ''), trim(p_destination), nullif(trim(coalesce(p_destination_ur, '')), ''),
    p_classification, v_fare_mode, p_total_fare_pkr, v_per_seat,
    p_departure_time, p_days_of_week, true,
    p_origin_lat, p_origin_lng, p_destination_lat, p_destination_lng, p_distance_km,
    p_route_path, p_route_duration_min, p_return_departure_time,
    p_is_monthly_fixed, p_monthly_reference_fee_pkr,
    p_is_two_way, p_return_wait_minutes, p_one_off_date
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;
GRANT EXECUTE ON FUNCTION create_vehicle_route_self(uuid, character varying, character varying, character varying, character varying, numeric, time without time zone, integer[], character varying, character varying, numeric, numeric, numeric, numeric, numeric, jsonb, numeric, time without time zone, boolean, numeric, boolean, int, date) TO authenticated;

-- Guards place_ride_booking against someone booking a different date
-- than the one-off route was actually meant for — recurrence by
-- days_of_week alone would otherwise let a future same-weekday date
-- slip through. book_standalone_return_seat does not yet carry the
-- same guard — flagged as a known gap, not solved here, matching the
-- waitlist-seat and substitute-vehicle gaps already flagged in 845/846.
CREATE OR REPLACE FUNCTION place_ride_booking(
  p_route_id uuid, p_travel_date date, p_seats int, p_method varchar, p_proof_url text,
  p_board_stop_id uuid DEFAULT NULL, p_alight_stop_id uuid DEFAULT NULL, p_seat_numbers int[] DEFAULT NULL
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

  IF (p_board_stop_id IS NOT NULL) != (p_alight_stop_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Pick both a board and an alight stop, or leave both blank for the full route.' USING ERRCODE = 'P0001';
  END IF;

  IF p_board_stop_id IS NOT NULL THEN
    IF v_route.fare_mode = 'flex' THEN RAISE EXCEPTION 'A specific board/alight stop isn''t supported on a flex-fare route yet — book the full route.' USING ERRCODE = 'P0001'; END IF;
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

  IF v_vehicle.commission_mode = 'monthly_lumpsum' THEN
    IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  ELSE
    IF NOT v_vehicle.is_active THEN
      RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings — try another one.' USING ERRCODE = 'P0001';
    END IF;
    v_commission_pct := vehicle_commission_pct(v_vehicle.vehicle_type, v_route.classification);
    v_expected_commission := round(v_total * v_commission_pct / 100, 2);
    IF seller_account_balance(ensure_vehicle_account(v_vehicle.id)) < v_expected_commission THEN
      RAISE EXCEPTION 'This vehicle''s wallet balance is too low to cover this booking''s commission — the driver needs to top up first.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO ride_bookings (route_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at, board_stop_id, alight_stop_id)
  VALUES (p_route_id, v_portal_user_id, p_travel_date, p_seats, v_total, 'announced', v_total, p_method, p_proof_url, now(), p_board_stop_id, p_alight_stop_id)
  RETURNING id INTO v_booking_id;

  IF p_seat_numbers IS NOT NULL THEN
    BEGIN
      INSERT INTO ride_booking_seat_numbers (ride_booking_id, route_id, travel_date, direction, seat_number)
      SELECT v_booking_id, p_route_id, p_travel_date, 'outbound', sn FROM unnest(p_seat_numbers) sn;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'One of those seats was just taken by someone else — pick again.' USING ERRCODE = 'P0001';
    END;
  END IF;

  IF v_vehicle.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_vehicle.portal_user_id, 'route_seat_booked', 'New seat booked — confirm once paid',
      p_seats || ' seat(s) for ' || to_char(p_travel_date, 'DD Mon') || ' — Rs ' || round(v_total) || '. Confirm their seat once they''ve paid you directly, to add them to your ride group.', '/portal/my-vehicle/routes');
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_portal_user_id, 'ride_booking_pending', 'Seat booked — not confirmed yet',
    'Pay the driver directly to confirm this seat. Until the driver confirms your payment, another paying rider could take it, and you won''t yet see the live map/chat/group for this ride.',
    '/portal/marketplace/trips');

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION place_ride_booking(uuid, date, int, varchar, text, uuid, uuid, int[]) TO authenticated;

-- run_stale_booking_sweep (711/826): two additions — close a one-off
-- route once its date has passed (so it stops recurring-by-weekday in
-- every rider's eyes and driver can post a new one), and free any seat
-- numbers held by a booking this same sweep expires (845 postdates
-- 826, so that cleanup was never there).
CREATE OR REPLACE FUNCTION run_stale_booking_sweep() RETURNS void AS $$
DECLARE v_days int; r record;
BEGIN
  SELECT COALESCE(value::int, 3) INTO v_days FROM site_settings WHERE key = 'stale_booking_expiry_days' LIMIT 1;

  FOR r IN SELECT id, portal_user_id FROM rental_bookings WHERE status IN ('requested', 'accepted') AND requested_at < now() - (v_days || ' days')::interval LOOP
    UPDATE rental_bookings SET status = 'cancelled' WHERE id = r.id;
    PERFORM close_booking_thread('rental_booking', r.id, 'cancelled');
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.portal_user_id, 'rental_booking_cancelled', 'Booking auto-cancelled', 'No driver responded in time, so this request was automatically cancelled.', '/portal/marketplace');
  END LOOP;

  FOR r IN SELECT id, portal_user_id FROM hourly_bookings WHERE status IN ('requested', 'accepted') AND requested_at < now() - (v_days || ' days')::interval LOOP
    UPDATE hourly_bookings SET status = 'cancelled' WHERE id = r.id;
    PERFORM close_booking_thread('hourly_booking', r.id, 'cancelled');
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.portal_user_id, 'hourly_booking_cancelled', 'Booking auto-cancelled', 'No driver responded in time, so this request was automatically cancelled.', '/portal/marketplace');
  END LOOP;

  FOR r IN SELECT id, portal_user_id FROM equipment_bookings WHERE status IN ('requested', 'accepted') AND requested_at < now() - (v_days || ' days')::interval LOOP
    UPDATE equipment_bookings SET status = 'cancelled' WHERE id = r.id;
    PERFORM close_booking_thread('equipment_booking', r.id, 'cancelled');
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.portal_user_id, 'equipment_booking_cancelled', 'Booking auto-cancelled', 'No owner responded in time, so this request was automatically cancelled.', '/portal/marketplace');
  END LOOP;

  FOR r IN SELECT id, portal_user_id FROM shadi_events WHERE status = 'collecting' AND created_at < now() - (v_days || ' days')::interval LOOP
    UPDATE shadi_vehicle_requests SET status = 'cancelled' WHERE event_id = r.id AND status IN ('requested', 'accepted');
    UPDATE shadi_events SET status = 'cancelled' WHERE id = r.id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.portal_user_id, 'shadi_event_cancelled', 'Wedding booking auto-cancelled', 'No driver responded in time, so this request was automatically cancelled.', '/portal/marketplace/shadi');
  END LOOP;

  FOR r IN SELECT id, initiator_portal_user_id FROM city_purchase_requests WHERE status IN ('ringing', 'no_answer') AND created_at < now() - (v_days || ' days')::interval LOOP
    UPDATE city_purchase_requests SET status = 'cancelled' WHERE id = r.id;
    UPDATE city_purchase_invitations SET status = 'expired', responded_at = now() WHERE request_id = r.id AND status = 'ringing';
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.initiator_portal_user_id, 'city_purchase_cancelled', 'Request auto-cancelled', 'No driver responded in time, so this request was automatically cancelled.', '/portal/marketplace/city-purchase');
  END LOOP;

  FOR r IN SELECT id, initiator_portal_user_id FROM parcel_deliveries WHERE status IN ('ringing', 'no_answer') AND created_at < now() - (v_days || ' days')::interval LOOP
    UPDATE parcel_deliveries SET status = 'cancelled' WHERE id = r.id;
    UPDATE parcel_delivery_invitations SET status = 'expired', responded_at = now() WHERE delivery_id = r.id AND status = 'ringing';
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.initiator_portal_user_id, 'parcel_delivery_cancelled', 'Request auto-cancelled', 'No driver responded in time, so this request was automatically cancelled.', '/portal/marketplace/parcel');
  END LOOP;

  FOR r IN SELECT id, portal_user_id, route_id FROM ride_bookings
    WHERE status = 'announced' AND travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date
  LOOP
    UPDATE ride_bookings SET status = 'cancelled', rejected_reason = 'Expired — the driver never responded before the travel date passed.' WHERE id = r.id;
    DELETE FROM ride_booking_seat_numbers WHERE ride_booking_id = r.id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.portal_user_id, 'ride_booking_expired', 'Booking expired',
      'Your seat booking''s travel date passed without the driver responding, so it was automatically cancelled.',
      CASE WHEN r.route_id IS NOT NULL THEN '/portal/marketplace/route/' || r.route_id ELSE '/portal/marketplace' END);
  END LOOP;

  -- 847: one-off routes stop existing once their single date has run.
  UPDATE vehicle_routes SET is_active = false WHERE is_active AND one_off_date IS NOT NULL AND one_off_date < (now() AT TIME ZONE 'Asia/Karachi')::date;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION run_stale_booking_sweep() FROM PUBLIC, anon;
