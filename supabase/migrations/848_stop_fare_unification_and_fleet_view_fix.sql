-- Migration 848: three real gaps found right after shipping the route-
-- creation redesign (844-847), confirmed against a fresh read of the
-- live code, not just the earlier plan:
--
-- 1. Fare mode ('fixed' = local, per-stop fractional; 'flex' = non-
--    stop, flat fare — see 847's naming-trap note) was made fully
--    automatic by vehicle_kind in 847, with zero driver choice. Real
--    ask, 2026-11-11: "keep this stop to stop and start to destination
--    fare for the cars as well ... keep them all same" — the choice
--    between local and non-stop should be available for EVERY vehicle
--    kind alike, not locked by kind. p_fare_mode goes back to being
--    driver-chosen (routes/page.tsx now shows an explicit Local/
--    Non-stop toggle for every vehicle again, defaulting the same way
--    847 used to auto-pick, but always overridable).
--
-- 2. Stops were entirely hidden/rejected on a 'flex' (non-stop) route
--    — place_ride_booking actively raised "stop isn't supported on a
--    flex-fare route yet". That's backwards from the real ask: a rider
--    should always be able to pick where they board, for convenience,
--    on ANY route — it just shouldn't change the price on a non-stop
--    route. Dropping that rejection; v_total's flex branch already
--    ignores segment_fraction entirely, so this is a pure unlock, no
--    fare-calculation change needed.
--
-- 3. Real ask: "the monthly fix stops and these new stops are visible
--    for booking ... there is no mention of the start and end stop in
--    those list". route_stops (717) only ever held stops a driver
--    manually added in between — never the route's own origin/
--    destination. Leaving board/alight blank silently MEANT "board at
--    origin"/"alight at destination", but neither was ever a real,
--    nameable entry in any picker. create_vehicle_route_self now
--    backfills two real route_stops rows for origin/destination at
--    creation time (stop_order 0 and 1000000, so any stop a driver
--    adds afterwards — which always gets a small explicit order, see
--    create_route_stop call sites in routes/page.tsx and
--    RouteStopsEditor.tsx — sorts between them correctly) whenever
--    their lat/lng were actually captured. Every existing picker
--    (RouteDetailPanel, reschedule, monthly apply) already just reads
--    route_stops with no special-casing, so this alone makes origin/
--    destination show up everywhere automatically.
--
-- Also applies the monthly-seat fee consequence of #1: apply_for_
-- monthly_seat always fractioned the monthly fee by board stop
-- regardless of fare_mode — a monthly route explicitly set to
-- non-stop/flex should charge the full reference fee no matter which
-- stop a rider boards at, same logic as the per-date booking path.
--
-- And a real fleet-booker gap found live, same day: a fleet owner
-- could create a route for another vehicle via 844's picker but never
-- see or manage it afterwards — is_route_owner() (used by every write
-- RPC) was made fleet-aware in 844, but ride_bookings_keeper_read
-- (397) and commercial_ilans_advertiser_read (671), the plain RLS
-- SELECT policies routes/page.tsx's own reload() reads directly
-- through, were never touched and still gated on raw
-- vehicles.portal_user_id / advertiser_portal_user_id equality. Fixed
-- by routing both through can_manage_vehicle()/is_route_owner(),
-- same pattern as everywhere else fleet auth was threaded through.

-- ═════════════════════════════════════════════════════════════════════
-- create_vehicle_route_self — fare_mode driver-chosen again (for every
-- kind), plus backfills origin/destination as real route_stops rows.
-- Signature unchanged from 847.
-- ═════════════════════════════════════════════════════════════════════
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
  v_fare_mode varchar;
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required';
  END IF;

  IF NOT can_manage_vehicle(p_vehicle_id) THEN
    RAISE EXCEPTION 'You can only post a route for your own vehicle, or one in a fleet you own';
  END IF;
  SELECT v.tenant_id, v.total_seats INTO v_tenant_id, v_seats
    FROM vehicles v WHERE v.id = p_vehicle_id AND v.is_active = true;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'That vehicle is not available';
  END IF;

  -- 848: driver-chosen again, for every vehicle kind alike — see this
  -- migration's header. 'fixed' = local/stop-to-stop, 'flex' = non-
  -- stop/flat.
  IF p_fare_mode NOT IN ('fixed', 'flex') THEN
    RAISE EXCEPTION 'Pick a valid fare mode.' USING ERRCODE = 'P0001';
  END IF;
  v_fare_mode := p_fare_mode;

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

  -- 848: real, nameable stop entries for the route's own endpoints —
  -- only when a real coordinate was actually captured for that end
  -- (an older/plain route with no map pin keeps today's silent-blank
  -- behaviour for that end, since route_stops.lat/lng are NOT NULL).
  IF p_origin_lat IS NOT NULL AND p_origin_lng IS NOT NULL THEN
    INSERT INTO route_stops (route_id, label, label_ur, lat, lng, stop_order)
    VALUES (v_id, trim(p_origin), nullif(trim(coalesce(p_origin_ur, '')), ''), p_origin_lat, p_origin_lng, 0);
  END IF;
  IF p_destination_lat IS NOT NULL AND p_destination_lng IS NOT NULL THEN
    INSERT INTO route_stops (route_id, label, label_ur, lat, lng, stop_order)
    VALUES (v_id, trim(p_destination), nullif(trim(coalesce(p_destination_ur, '')), ''), p_destination_lat, p_destination_lng, 1000000);
  END IF;

  RETURN v_id;
END;
$function$;
GRANT EXECUTE ON FUNCTION create_vehicle_route_self(uuid, character varying, character varying, character varying, character varying, numeric, time without time zone, integer[], character varying, character varying, numeric, numeric, numeric, numeric, numeric, jsonb, numeric, time without time zone, boolean, numeric, boolean, int, date) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- place_ride_booking — drop the flex-route stop rejection. The flex
-- branch of the total calc already ignores v_segment_fraction
-- entirely, so letting a board/alight stop through on a flex route
-- changes nothing about the price, only what's recorded for pickup.
-- ═════════════════════════════════════════════════════════════════════
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

  -- 848: no longer rejected on a flex (non-stop) route — a rider can
  -- always pick where they board/alight for pickup convenience; the
  -- flex branch below never uses v_segment_fraction, so the price is
  -- unaffected either way.
  IF p_board_stop_id IS NOT NULL THEN
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

-- ═════════════════════════════════════════════════════════════════════
-- apply_for_monthly_seat — the monthly fee only fractions by board
-- stop under 'fixed' (local) fare_mode now; a monthly route explicitly
-- set to 'flex' (non-stop) always charges the full reference fee, no
-- matter which stop a rider boards at — same split as the per-date
-- path above.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION apply_for_monthly_seat(p_route_id uuid, p_board_stop_id uuid, p_method varchar DEFAULT 'cash', p_proof_url text DEFAULT NULL, p_seat_number int DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE;
  v_vehicle vehicles%ROWTYPE;
  v_vehicle_kind varchar;
  v_stop route_stops%ROWTYPE;
  v_seats int;
  v_active_count int;
  v_fraction numeric;
  v_fee numeric;
  v_status varchar;
  v_queue_position int;
  v_id uuid;
  v_commission_pct decimal;
  v_expected_commission decimal;
  v_est_deposit numeric := 0;
  v_use_seat_number int;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND is_active = true;
  IF NOT FOUND OR NOT v_route.is_monthly_fixed THEN RAISE EXCEPTION 'This route is not a monthly-fixed service.' USING ERRCODE = 'P0001'; END IF;

  IF EXISTS (SELECT 1 FROM route_subscriptions WHERE route_id = p_route_id AND portal_user_id = v_portal_user_id AND status != 'cancelled') THEN
    RAISE EXCEPTION 'You already have a subscription on this route.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_stop FROM route_stops WHERE id = p_board_stop_id AND route_id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real stop on this route.' USING ERRCODE = 'P0001'; END IF;

  -- 848: 'flex' (non-stop) monthly routes always charge the full
  -- reference fee — stop choice is for pickup only, same as the
  -- per-date booking path.
  IF v_route.fare_mode = 'flex' THEN
    v_fraction := 1;
  ELSE
    v_fraction := route_fraction_remaining(p_route_id, v_stop.lat, v_stop.lng);
  END IF;
  v_fee := round(v_route.monthly_reference_fee_pkr * v_fraction);

  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;
  v_seats := route_effective_seats(p_route_id);
  SELECT count(*) INTO v_active_count FROM route_subscriptions WHERE route_id = p_route_id AND status IN ('active', 'pending');

  SELECT vc.vehicle_kind INTO v_vehicle_kind FROM vehicle_categories vc WHERE vc.id = v_vehicle.category_id;
  IF v_vehicle_kind = 'van' THEN
    IF p_seat_number IS NULL OR p_seat_number < 1 OR p_seat_number > v_seats THEN
      RAISE EXCEPTION 'Pick a real seat on this vehicle.' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_seat_number IS NOT NULL THEN
    RAISE EXCEPTION 'This vehicle doesn''t use seat numbers.' USING ERRCODE = 'P0001';
  END IF;

  IF v_active_count < v_seats THEN
    v_status := 'pending'; v_queue_position := NULL;
    v_use_seat_number := p_seat_number;
    v_est_deposit := round(v_fee / scheduled_days_in_month(p_route_id, extract(month FROM (now() AT TIME ZONE 'Asia/Karachi'))::int, extract(year FROM (now() AT TIME ZONE 'Asia/Karachi'))::int))
      * coalesce(array_length(scheduled_days_remaining_in_month(p_route_id), 1), 0);
  ELSE
    v_status := 'waitlisted';
    v_use_seat_number := NULL;
    SELECT coalesce(max(queue_position), 0) + 1 INTO v_queue_position FROM route_subscriptions WHERE route_id = p_route_id AND status = 'waitlisted';
  END IF;

  IF v_status = 'pending' AND v_est_deposit > 0 THEN
    IF v_vehicle.commission_mode = 'monthly_lumpsum' THEN
      IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip for the first month''s advance.' USING ERRCODE = 'P0001'; END IF;
    ELSE
      IF NOT v_vehicle.is_active THEN RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings.' USING ERRCODE = 'P0001'; END IF;
      v_commission_pct := vehicle_commission_pct(v_vehicle.vehicle_type, v_route.classification);
      v_expected_commission := round(v_est_deposit * v_commission_pct / 100, 2);
      IF seller_account_balance(ensure_vehicle_account(v_vehicle.id)) < v_expected_commission THEN
        RAISE EXCEPTION 'This vehicle''s wallet balance is too low to cover this booking''s commission — the driver needs to top up first.' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  BEGIN
    INSERT INTO route_subscriptions (route_id, portal_user_id, board_stop_id, status, monthly_fee_pkr, queue_position, seat_number)
    VALUES (p_route_id, v_portal_user_id, p_board_stop_id, v_status, v_fee, v_queue_position, v_use_seat_number)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'That seat was just taken by someone else — pick again.' USING ERRCODE = 'P0001';
  END;

  IF v_status = 'pending' THEN
    IF v_est_deposit > 0 THEN
      INSERT INTO route_subscription_charges (subscription_id, month, year, amount_pkr, proof_url, payment_method, status)
      VALUES (v_id, extract(month FROM (now() AT TIME ZONE 'Asia/Karachi'))::int, extract(year FROM (now() AT TIME ZONE 'Asia/Karachi'))::int, v_est_deposit, p_proof_url, p_method, 'due')
      ON CONFLICT (subscription_id, month, year) DO NOTHING;
    END IF;

    IF v_vehicle.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      SELECT v_vehicle.portal_user_id, 'route_monthly_application', 'New monthly seat application — confirm to activate',
        coalesce(pu.full_name, 'A rider') || ' applied for a monthly seat — Rs ' || round(v_fee) || '/month. They will only join your ride group once you confirm.',
        '/portal/my-vehicle/routes'
      FROM portal_users pu WHERE pu.id = v_portal_user_id;
    END IF;
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_portal_user_id, 'route_monthly_application_sent',
    CASE WHEN v_status = 'pending' THEN 'Application sent — waiting for the driver' ELSE 'Added to the waitlist' END,
    CASE WHEN v_status = 'pending' THEN 'Your monthly seat application and payment details were sent. The driver must confirm before your seat is final and you join the ride group.'
      ELSE 'No seat is free right now — you''re on the waitlist and will be offered the next free seat.' END,
    '/portal/marketplace/route/' || p_route_id);

  RETURN jsonb_build_object('subscription_id', v_id, 'status', v_status, 'monthly_fee_pkr', v_fee, 'queue_position', v_queue_position, 'deposit_pkr', v_est_deposit);
END;
$$;
GRANT EXECUTE ON FUNCTION apply_for_monthly_seat(uuid, uuid, varchar, text, int) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- Fleet-management-view gap: these two plain RLS SELECT policies are
-- what routes/page.tsx's reload() reads straight through (.from(...),
-- not an RPC) — they were never made fleet-aware when 844 redefined
-- is_route_owner()/can_manage_vehicle(). Without this, a fleet owner
-- could create a route for another vehicle (844's picker) but their
-- own routes/bookings view would stay empty for it forever.
-- ═════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "ride_bookings_keeper_read" ON ride_bookings;
CREATE POLICY "ride_bookings_keeper_read" ON ride_bookings FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM vehicle_routes r WHERE r.id = route_id AND can_manage_vehicle(r.vehicle_id)));

DROP POLICY IF EXISTS commercial_ilans_advertiser_read ON commercial_ilans;
CREATE POLICY commercial_ilans_advertiser_read ON commercial_ilans FOR SELECT TO authenticated
  USING (advertiser_portal_user_id = current_portal_user_id() OR is_route_owner(vehicle_route_id));
