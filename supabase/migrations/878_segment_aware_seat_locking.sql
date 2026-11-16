-- Migration 878: real capacity bug confirmed directly against schema —
-- ride_booking_seat_numbers was UNIQUE(route_id, travel_date, direction,
-- seat_number), a flat per-date lock with zero segment awareness. Two
-- riders who never actually share the road (A: Peshawar→Multan, B:
-- Multan→Karachi, same seat, same bus, same day) could not both hold
-- seat 5 even though their journeys never overlap — real lost capacity
-- on every long route with mid-route boarding, confirmed as a design
-- gap against a reference bus-ops dashboard's own explicit rule:
-- "store seat occupancy for the exact segment, not the whole trip."
--
-- Design: each seat-number row now stores the [board_order, alight_order)
-- interval it actually occupies, in route_stops.stop_order terms (NULL
-- board/alight already means "route's own start/end" everywhere in this
-- app, resolved here to -1 / +a large sentinel so the interval math
-- needs no special-casing for the common full-route case). The flat
-- UNIQUE constraint is dropped and replaced with an explicit overlap
-- check serialized by a transaction-scoped advisory lock (keyed to the
-- exact route+date+direction+seat being contended) — the same kind of
-- "lock then check then insert" shape this codebase already uses
-- elsewhere (FOR UPDATE on the owning row), just needed here on a
-- cross-row invariant a simple FOR UPDATE can't express.
--
-- A mid-route "catch" booking (live GPS, no discrete board_stop_id) is
-- deliberately NOT given a fractional position — it resolves to -1 (the
-- same as "boards at the very start") via the same NULL-coalesce every
-- other full-route booking already uses, so it stays fully blocking for
-- that seat/date exactly as before. Safer to under-utilize a seat than
-- to guess a GPS-based position wrong and double-sell it.

-- ═════════════════════════════════════════════════════════════════════
-- 1. Schema — new interval columns (safe defaults: every existing row
--    becomes "occupies the whole route", so no retroactive conflict is
--    ever introduced for a booking made before this migration), and the
--    old flat UNIQUE constraint dropped by dynamic lookup (never
--    hand-typed a Postgres-generated constraint name — see this
--    session's own prior overload-ambiguity incident for why).
-- ═════════════════════════════════════════════════════════════════════
ALTER TABLE ride_booking_seat_numbers ADD COLUMN IF NOT EXISTS board_order int NOT NULL DEFAULT -1;
ALTER TABLE ride_booking_seat_numbers ADD COLUMN IF NOT EXISTS alight_order int NOT NULL DEFAULT 2000000000;

DO $$
DECLARE v_conname text;
BEGIN
  SELECT con.conname INTO v_conname
  FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'ride_booking_seat_numbers' AND con.contype = 'u';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE ride_booking_seat_numbers DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ride_booking_seat_numbers_lookup_idx ON ride_booking_seat_numbers(route_id, travel_date, direction, seat_number);

-- ═════════════════════════════════════════════════════════════════════
-- 2. Helpers.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION seat_stop_order(p_stop_id uuid, p_sentinel int) RETURNS int
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT stop_order FROM route_stops WHERE id = p_stop_id), p_sentinel);
$$;

-- Raises if the given seat is already occupied, on this route/date/
-- direction, for any part of [p_lo, p_hi) — half-open so a new rider
-- boarding exactly where an earlier one got off is NOT a conflict
-- (the whole point of this migration). The advisory lock is
-- transaction-scoped (auto-released at commit/rollback) and keyed
-- tightly enough that unrelated seats/dates/routes never contend.
CREATE OR REPLACE FUNCTION assert_seat_segment_free(p_route_id uuid, p_travel_date date, p_direction varchar, p_seat_number int, p_lo int, p_hi int) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_route_id::text || p_travel_date::text || p_direction || p_seat_number::text, 0));
  IF EXISTS (
    SELECT 1 FROM ride_booking_seat_numbers
    WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction AND seat_number = p_seat_number
      AND alight_order > p_lo AND board_order < p_hi
  ) THEN
    RAISE EXCEPTION 'That seat is already booked for an overlapping part of this journey — pick a different seat.' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 3. place_ride_booking — same signature as 871's live version, true
--    replace. Only the seat-number insert block changes.
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
  v_lo int; v_hi int; v_sn int;
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
    v_lo := seat_stop_order(p_board_stop_id, -1);
    v_hi := seat_stop_order(p_alight_stop_id, 2000000000);
    -- Sorted so concurrent multi-seat bookings always acquire these
    -- advisory locks in the same order — avoids a deadlock where two
    -- transactions lock the same two seats in opposite order.
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
-- 4. record_manual_booking — same signature as 874's live version.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION record_manual_booking(
  p_route_id uuid, p_travel_date date, p_seats int, p_passenger_name varchar, p_total_amount_pkr decimal,
  p_counter_id uuid DEFAULT NULL, p_passenger_mobile varchar DEFAULT NULL, p_payment_method varchar DEFAULT 'cash',
  p_board_stop_id uuid DEFAULT NULL, p_alight_stop_id uuid DEFAULT NULL, p_seat_numbers int[] DEFAULT NULL,
  p_emergency_contact_phone varchar DEFAULT NULL, p_passengers jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE; v_vehicle_kind varchar;
  v_available int; v_id uuid; v_ticket_no varchar;
  v_passenger jsonb; v_paid_idx int := 0; v_free_count int := 0;
  v_lo int; v_hi int; v_sn int;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

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

  IF p_passengers IS NOT NULL THEN
    FOR v_passenger IN SELECT * FROM jsonb_array_elements(p_passengers) LOOP
      IF COALESCE((v_passenger->>'is_free_child')::boolean, false) THEN
        v_free_count := v_free_count + 1;
        IF p_seats = 1 AND COALESCE((v_passenger->>'age')::int, 99) > 2 THEN
          RAISE EXCEPTION 'With a single paid seat, only an infant (2 years or younger) can travel free — this child needs their own seat.' USING ERRCODE = 'P0001';
        END IF;
      END IF;
    END LOOP;
  END IF;

  v_ticket_no := generate_ticket_no();

  INSERT INTO manual_ride_bookings (route_id, counter_id, recorded_by_portal_user_id, travel_date, seats, passenger_name, passenger_mobile, board_stop_id, alight_stop_id, total_amount_pkr, payment_method, ticket_no, emergency_contact_phone)
  VALUES (p_route_id, p_counter_id, v_portal_user_id, p_travel_date, p_seats, trim(p_passenger_name), nullif(trim(coalesce(p_passenger_mobile, '')), ''), p_board_stop_id, p_alight_stop_id, p_total_amount_pkr, p_payment_method, v_ticket_no, nullif(trim(coalesce(p_emergency_contact_phone, '')), ''))
  RETURNING id INTO v_id;

  IF p_seat_numbers IS NOT NULL THEN
    v_lo := seat_stop_order(p_board_stop_id, -1);
    v_hi := seat_stop_order(p_alight_stop_id, 2000000000);
    FOREACH v_sn IN ARRAY (SELECT array_agg(x ORDER BY x) FROM unnest(p_seat_numbers) x) LOOP
      PERFORM assert_seat_segment_free(p_route_id, p_travel_date, 'outbound', v_sn, v_lo, v_hi);
      INSERT INTO ride_booking_seat_numbers (manual_ride_booking_id, route_id, travel_date, direction, seat_number, board_order, alight_order)
      VALUES (v_id, p_route_id, p_travel_date, 'outbound', v_sn, v_lo, v_hi);
    END LOOP;
  END IF;

  IF p_passengers IS NOT NULL THEN
    FOR v_passenger IN SELECT * FROM jsonb_array_elements(p_passengers) LOOP
      IF COALESCE((v_passenger->>'is_free_child')::boolean, false) THEN
        INSERT INTO manual_ride_booking_passengers (manual_ride_booking_id, full_name, gender, age, is_free_child, seat_number)
        VALUES (v_id, v_passenger->>'full_name', nullif(v_passenger->>'gender', ''), (v_passenger->>'age')::int, true, NULL);
      ELSE
        v_paid_idx := v_paid_idx + 1;
        INSERT INTO manual_ride_booking_passengers (manual_ride_booking_id, full_name, gender, age, is_free_child, seat_number)
        VALUES (v_id, v_passenger->>'full_name', nullif(v_passenger->>'gender', ''), (v_passenger->>'age')::int, false,
          CASE WHEN p_seat_numbers IS NOT NULL AND array_length(p_seat_numbers, 1) >= v_paid_idx THEN p_seat_numbers[v_paid_idx] ELSE NULL END);
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'ticket_no', v_ticket_no);
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 5. book_standalone_return_seat — same signature as 877's hotfix.
--    Only return bookings ever use direction='return'; the "other end"
--    of a return-leg-only rider's journey is always the origin (-1).
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION book_standalone_return_seat(p_route_id uuid, p_travel_date date, p_board_stop_id uuid DEFAULT NULL, p_method varchar DEFAULT 'cash', p_proof_url text DEFAULT NULL, p_seat_number int DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE;
  v_vehicle vehicles%ROWTYPE;
  v_vehicle_kind varchar;
  v_stop route_stops%ROWTYPE;
  v_available int;
  v_forward_fraction numeric;
  v_total decimal;
  v_booking_id uuid;
  v_commission_pct decimal;
  v_expected_commission decimal;
  v_stop_label text;
  v_weekday int;
  v_lo int; v_hi int;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND is_active;
  IF NOT FOUND OR NOT v_route.is_two_way THEN RAISE EXCEPTION 'This route does not run a separate return leg.' USING ERRCODE = 'P0001'; END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
  IF v_route.one_off_date IS NOT NULL AND p_travel_date != v_route.one_off_date THEN
    RAISE EXCEPTION 'This ride only runs once, on %.', to_char(v_route.one_off_date, 'DD Mon YYYY') USING ERRCODE = 'P0001';
  END IF;

  v_weekday := extract(dow FROM p_travel_date)::int;
  IF NOT (v_weekday = ANY(COALESCE(v_route.return_days_of_week, v_route.days_of_week))) THEN
    RAISE EXCEPTION 'The return leg does not run on that day.' USING ERRCODE = 'P0001';
  END IF;

  IF p_board_stop_id IS NOT NULL THEN
    SELECT * INTO v_stop FROM route_stops WHERE id = p_board_stop_id AND route_id = p_route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real stop on this route.' USING ERRCODE = 'P0001'; END IF;
    v_forward_fraction := 1 - route_fraction_remaining(p_route_id, v_stop.lat, v_stop.lng);
    v_stop_label := v_stop.label;
  ELSE
    v_forward_fraction := 1;
    v_stop_label := v_route.destination;
  END IF;

  v_available := return_seats_available(p_route_id, p_travel_date);
  IF v_available <= 0 THEN RAISE EXCEPTION 'No seats are free on the return leg for that date.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  SELECT vc.vehicle_kind INTO v_vehicle_kind FROM vehicle_categories vc WHERE vc.id = v_vehicle.category_id;
  IF v_vehicle_kind = 'van' THEN
    IF p_seat_number IS NULL OR p_seat_number < 1 OR p_seat_number > route_effective_seats_for_date(p_route_id, p_travel_date) THEN
      RAISE EXCEPTION 'Pick a real seat on this vehicle.' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_seat_number IS NOT NULL THEN
    RAISE EXCEPTION 'This vehicle doesn''t use seat numbers.' USING ERRCODE = 'P0001';
  END IF;

  v_total := round(coalesce(v_route.fare_per_seat_pkr, 0) * v_forward_fraction);

  IF v_vehicle.commission_mode = 'monthly_lumpsum' THEN
    IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  ELSE
    IF NOT v_vehicle.is_active THEN
      RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings.' USING ERRCODE = 'P0001';
    END IF;
    v_commission_pct := vehicle_commission_pct(v_vehicle.vehicle_type, v_route.classification);
    v_expected_commission := round(v_total * v_commission_pct / 100, 2);
    IF seller_account_balance(ensure_vehicle_account(v_vehicle.id)) < v_expected_commission THEN
      RAISE EXCEPTION 'This vehicle''s wallet balance is too low to cover this booking''s commission — the driver needs to top up first.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO ride_bookings (route_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at, direction)
  VALUES (p_route_id, v_portal_user_id, p_travel_date, 1, v_total, 'announced', v_total, p_method, p_proof_url, now(), 'return')
  RETURNING id INTO v_booking_id;

  IF p_seat_number IS NOT NULL THEN
    v_lo := -1;
    v_hi := seat_stop_order(p_board_stop_id, 2000000000);
    PERFORM assert_seat_segment_free(p_route_id, p_travel_date, 'return', p_seat_number, v_lo, v_hi);
    INSERT INTO ride_booking_seat_numbers (ride_booking_id, route_id, travel_date, direction, seat_number, board_order, alight_order)
    VALUES (v_booking_id, p_route_id, p_travel_date, 'return', p_seat_number, v_lo, v_hi);
  END IF;

  IF v_vehicle.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_vehicle.portal_user_id, 'route_seat_booked', 'New one-way return seat booked — confirm once paid',
      '1 seat from ' || v_stop_label || ' on ' || to_char(p_travel_date, 'DD Mon') || ' — Rs ' || round(v_total) || '.', '/portal/my-vehicle/routes');
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_portal_user_id, 'ride_booking_pending', 'Seat booked — not confirmed yet',
    'Pay the driver directly to confirm this seat. Until the driver confirms your payment, another paying rider could take it.',
    '/portal/marketplace/trips');

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total);
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 6. reschedule_manual_booking — same signature as 866's live version.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION reschedule_manual_booking(p_id uuid, p_new_travel_date date, p_seat_numbers int[] DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE mb manual_ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v_available int; v_weekday int; v_lo int; v_hi int; v_sn int;
BEGIN
  SELECT * INTO mb FROM manual_ride_bookings WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_routes WHERE id = mb.route_id;
  IF NOT can_manage_vehicle(r.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF mb.status != 'confirmed' THEN RAISE EXCEPTION 'This booking can no longer be rescheduled.' USING ERRCODE = 'P0001'; END IF;
  IF p_new_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;

  v_weekday := extract(dow FROM p_new_travel_date)::int;
  IF NOT (v_weekday = ANY(r.days_of_week)) THEN RAISE EXCEPTION 'This route does not run on that day.' USING ERRCODE = 'P0001'; END IF;

  v_available := route_seats_available(mb.route_id, p_new_travel_date);
  IF mb.seats > v_available THEN RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001'; END IF;

  UPDATE manual_ride_bookings SET travel_date = p_new_travel_date WHERE id = p_id;

  v_lo := seat_stop_order(mb.board_stop_id, -1);
  v_hi := seat_stop_order(mb.alight_stop_id, 2000000000);

  IF p_seat_numbers IS NOT NULL THEN
    IF array_length(p_seat_numbers, 1) IS DISTINCT FROM mb.seats THEN
      RAISE EXCEPTION 'Pick exactly % seat(s).', mb.seats USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_seat_numbers) sn WHERE sn < 1 OR sn > route_effective_seats_for_date(mb.route_id, p_new_travel_date)) THEN
      RAISE EXCEPTION 'That seat doesn''t exist on this vehicle.' USING ERRCODE = 'P0001';
    END IF;
    DELETE FROM ride_booking_seat_numbers WHERE manual_ride_booking_id = p_id;
    FOREACH v_sn IN ARRAY (SELECT array_agg(x ORDER BY x) FROM unnest(p_seat_numbers) x) LOOP
      PERFORM assert_seat_segment_free(mb.route_id, p_new_travel_date, 'outbound', v_sn, v_lo, v_hi);
      INSERT INTO ride_booking_seat_numbers (manual_ride_booking_id, route_id, travel_date, direction, seat_number, board_order, alight_order)
      VALUES (p_id, mb.route_id, p_new_travel_date, 'outbound', v_sn, v_lo, v_hi);
    END LOOP;
  ELSE
    PERFORM assert_seat_segment_free(mb.route_id, p_new_travel_date, 'outbound', sn.seat_number, v_lo, v_hi)
      FROM ride_booking_seat_numbers sn WHERE sn.manual_ride_booking_id = p_id ORDER BY sn.seat_number;
    UPDATE ride_booking_seat_numbers SET travel_date = p_new_travel_date WHERE manual_ride_booking_id = p_id;
  END IF;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 7. reschedule_ride_booking — same signature as 866's live version.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION reschedule_ride_booking(
  p_booking_id uuid, p_new_travel_date date,
  p_board_stop_id uuid DEFAULT NULL, p_alight_stop_id uuid DEFAULT NULL, p_clear_stops boolean DEFAULT false,
  p_seat_numbers int[] DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v_available int; v_weekday int;
  v_board_stop route_stops%ROWTYPE; v_alight_stop route_stops%ROWTYPE;
  v_segment_fraction numeric := 1; v_new_total numeric;
  v_use_board_stop_id uuid; v_use_alight_stop_id uuid;
  v_changing_stops boolean := p_clear_stops OR p_board_stop_id IS NOT NULL OR p_alight_stop_id IS NOT NULL;
  v_lo int; v_hi int; v_sn int;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_routes WHERE id = b.route_id;
  IF NOT (b.portal_user_id = current_portal_user_id() OR can_manage_vehicle(r.vehicle_id)) THEN
    RAISE EXCEPTION 'That is not your booking.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status NOT IN ('announced', 'confirmed') THEN RAISE EXCEPTION 'This booking can no longer be rescheduled.' USING ERRCODE = 'P0001'; END IF;
  IF b.route_id IS NULL THEN RAISE EXCEPTION 'This booking cannot be rescheduled.' USING ERRCODE = 'P0001'; END IF;
  IF p_new_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
  IF v_changing_stops AND b.status != 'announced' THEN
    RAISE EXCEPTION 'Your seat is already confirmed by the driver — cancel and book again to change your boarding stop.' USING ERRCODE = 'P0001';
  END IF;

  IF r.fare_mode = 'flex' THEN RAISE EXCEPTION 'This route''s fare depends on the date it''s booked for — cancel and rebook instead.' USING ERRCODE = 'P0001'; END IF;

  v_weekday := extract(dow FROM p_new_travel_date)::int;
  IF NOT (v_weekday = ANY(r.days_of_week)) THEN RAISE EXCEPTION 'This route does not run on that day.' USING ERRCODE = 'P0001'; END IF;

  v_available := route_seats_available(b.route_id, p_new_travel_date);
  IF b.seats > v_available THEN RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001'; END IF;

  IF p_clear_stops THEN
    v_use_board_stop_id := NULL; v_use_alight_stop_id := NULL; v_segment_fraction := 1;
  ELSIF p_board_stop_id IS NOT NULL OR p_alight_stop_id IS NOT NULL THEN
    IF (p_board_stop_id IS NULL) != (p_alight_stop_id IS NULL) THEN
      RAISE EXCEPTION 'Pick both a board and an alight stop, or neither.' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_board_stop FROM route_stops WHERE id = p_board_stop_id AND route_id = b.route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real board stop on this route.' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO v_alight_stop FROM route_stops WHERE id = p_alight_stop_id AND route_id = b.route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real alight stop on this route.' USING ERRCODE = 'P0001'; END IF;
    v_segment_fraction := route_fraction_remaining(b.route_id, v_board_stop.lat, v_board_stop.lng) - route_fraction_remaining(b.route_id, v_alight_stop.lat, v_alight_stop.lng);
    IF v_segment_fraction <= 0 THEN RAISE EXCEPTION 'The alight stop must be further along the route than the board stop.' USING ERRCODE = 'P0001'; END IF;
    v_use_board_stop_id := p_board_stop_id; v_use_alight_stop_id := p_alight_stop_id;
  ELSE
    v_use_board_stop_id := b.board_stop_id; v_use_alight_stop_id := b.alight_stop_id;
    IF b.board_stop_id IS NOT NULL AND b.alight_stop_id IS NOT NULL THEN
      SELECT * INTO v_board_stop FROM route_stops WHERE id = b.board_stop_id;
      SELECT * INTO v_alight_stop FROM route_stops WHERE id = b.alight_stop_id;
      v_segment_fraction := route_fraction_remaining(b.route_id, v_board_stop.lat, v_board_stop.lng) - route_fraction_remaining(b.route_id, v_alight_stop.lat, v_alight_stop.lng);
    END IF;
  END IF;

  v_new_total := round(b.seats * r.fare_per_seat_pkr * v_segment_fraction);

  UPDATE ride_bookings SET travel_date = p_new_travel_date, board_stop_id = v_use_board_stop_id, alight_stop_id = v_use_alight_stop_id, total_amount_pkr = v_new_total
  WHERE id = p_booking_id;

  v_lo := seat_stop_order(v_use_board_stop_id, -1);
  v_hi := seat_stop_order(v_use_alight_stop_id, 2000000000);

  IF p_seat_numbers IS NOT NULL THEN
    IF array_length(p_seat_numbers, 1) IS DISTINCT FROM b.seats THEN
      RAISE EXCEPTION 'Pick exactly % seat(s).', b.seats USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_seat_numbers) sn WHERE sn < 1 OR sn > route_effective_seats_for_date(b.route_id, p_new_travel_date)) THEN
      RAISE EXCEPTION 'That seat doesn''t exist on this vehicle.' USING ERRCODE = 'P0001';
    END IF;
    DELETE FROM ride_booking_seat_numbers WHERE ride_booking_id = p_booking_id;
    FOREACH v_sn IN ARRAY (SELECT array_agg(x ORDER BY x) FROM unnest(p_seat_numbers) x) LOOP
      PERFORM assert_seat_segment_free(b.route_id, p_new_travel_date, 'outbound', v_sn, v_lo, v_hi);
      INSERT INTO ride_booking_seat_numbers (ride_booking_id, route_id, travel_date, direction, seat_number, board_order, alight_order)
      VALUES (p_booking_id, b.route_id, p_new_travel_date, 'outbound', v_sn, v_lo, v_hi);
    END LOOP;
  ELSE
    PERFORM assert_seat_segment_free(b.route_id, p_new_travel_date, 'outbound', sn.seat_number, v_lo, v_hi)
      FROM ride_booking_seat_numbers sn WHERE sn.ride_booking_id = p_booking_id ORDER BY sn.seat_number;
    UPDATE ride_booking_seat_numbers SET travel_date = p_new_travel_date, board_order = v_lo, alight_order = v_hi WHERE ride_booking_id = p_booking_id;
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'route_booking_rescheduled', 'A rider rescheduled their seat',
    r.origin || ' → ' || r.destination || ' — moved to ' || to_char(p_new_travel_date, 'DD Mon') || '.', '/portal/my-vehicle/routes'
  FROM vehicles v WHERE v.id = r.vehicle_id AND v.portal_user_id IS NOT NULL;
END;
$$;
