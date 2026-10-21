-- ═════════════════════════════════════════════════════════════════════════
-- Real ask, 2026-10-21: a two-way route today only has one static,
-- unenforced "return departure time" label. The actual ask is a wait
-- window at the destination (5/6/8 hours), the ability to release a
-- no-show/late rider's seat for the return leg specifically (without
-- touching their outbound booking), and letting someone who was never
-- on the outbound leg book just the return as a one-way ride once a
-- seat opens up — with an alert going to riders who've shown real
-- interest in a ride from that destination village.
--
-- Deliberately reuses the existing seat-booking ledger (ride_bookings,
-- keyed by route_id + travel_date — the same table/shape
-- place_ride_booking already writes, NOT a new parallel booking type)
-- rather than inventing a second booking system. A normal booking's
-- new 'direction' column defaults to 'outbound', meaning "this rider's
-- single daily fare covers both legs of the day's round trip" — the
-- existing, unchanged behavior; route_seats_available (389) already
-- counts every non-cancelled booking for a date against the vehicle's
-- one seat pool regardless of direction, which still holds. 'return' is
-- new: a one-way, return-leg-only booking from someone who was never on
-- the outbound leg. route_runs (the live-tracking "a drive is happening
-- right now" marker) stays exactly what it already is — it is NOT the
-- seat ledger, same as today, so offboarding/seat-counting is keyed by
-- route_id + travel_date like every other seat query already is, not
-- by a run id.
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE vehicle_routes ADD COLUMN IF NOT EXISTS is_two_way boolean NOT NULL DEFAULT false;
ALTER TABLE vehicle_routes ADD COLUMN IF NOT EXISTS return_wait_minutes int;
ALTER TABLE route_runs ADD COLUMN IF NOT EXISTS outbound_arrived_at timestamptz;
ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS direction varchar NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'return'));

CREATE TABLE IF NOT EXISTS route_run_offboards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_booking_id uuid NOT NULL UNIQUE REFERENCES ride_bookings(id) ON DELETE CASCADE,
  route_id uuid NOT NULL REFERENCES vehicle_routes(id) ON DELETE CASCADE,
  reason text,
  offboarded_at timestamptz NOT NULL DEFAULT now(),
  offboarded_by uuid
);
CREATE INDEX IF NOT EXISTS route_run_offboards_route_idx ON route_run_offboards(route_id);

ALTER TABLE route_run_offboards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "route_run_offboards_read" ON route_run_offboards FOR SELECT TO authenticated
  USING (is_route_owner(route_id) OR EXISTS (SELECT 1 FROM ride_bookings rb WHERE rb.id = ride_booking_id AND rb.portal_user_id = current_portal_user_id()));

-- ═════════════════════════════════════════════════════════════════════════
-- create_vehicle_route_self / update_vehicle_route_schedule gain the two
-- new fields. Bodies copied verbatim from their real current definitions
-- (723 and 721 respectively — read directly from the migration files
-- before touching them, not reconstructed from memory) with only the two
-- new trailing params + their two new INSERT/UPDATE targets added.
-- ═════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.create_vehicle_route_self(uuid, character varying, character varying, character varying, character varying, numeric, time without time zone, integer[], character varying, character varying, numeric, numeric, numeric, numeric, numeric, jsonb, numeric, time without time zone, boolean, numeric);

CREATE OR REPLACE FUNCTION public.create_vehicle_route_self(p_vehicle_id uuid, p_origin character varying, p_destination character varying, p_classification character varying, p_fare_mode character varying, p_total_fare_pkr numeric DEFAULT NULL::numeric, p_departure_time time without time zone DEFAULT NULL::time without time zone, p_days_of_week integer[] DEFAULT '{}'::integer[], p_origin_ur character varying DEFAULT NULL::character varying, p_destination_ur character varying DEFAULT NULL::character varying, p_origin_lat numeric DEFAULT NULL::numeric, p_origin_lng numeric DEFAULT NULL::numeric, p_destination_lat numeric DEFAULT NULL::numeric, p_destination_lng numeric DEFAULT NULL::numeric, p_distance_km numeric DEFAULT NULL::numeric, p_route_path jsonb DEFAULT NULL::jsonb, p_route_duration_min numeric DEFAULT NULL::numeric, p_return_departure_time time without time zone DEFAULT NULL::time without time zone, p_is_monthly_fixed boolean DEFAULT false, p_monthly_reference_fee_pkr numeric DEFAULT NULL::numeric, p_is_two_way boolean DEFAULT false, p_return_wait_minutes int DEFAULT NULL)
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
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required';
  END IF;

  SELECT tenant_id, total_seats INTO v_tenant_id, v_seats
    FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id AND is_active = true;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'You can only post a route for your own vehicle';
  END IF;

  IF EXISTS (SELECT 1 FROM vehicle_routes WHERE vehicle_id = p_vehicle_id AND is_active = true) THEN
    RAISE EXCEPTION 'You already have an active route posted — close it before posting a new one.' USING ERRCODE = 'P0001';
  END IF;

  IF coalesce(trim(p_origin), '') = '' OR coalesce(trim(p_destination), '') = '' THEN
    RAISE EXCEPTION 'Origin and destination are required';
  END IF;
  IF p_days_of_week IS NULL OR array_length(p_days_of_week, 1) IS NULL THEN
    RAISE EXCEPTION 'Pick at least one day';
  END IF;

  IF p_is_monthly_fixed THEN
    IF p_monthly_reference_fee_pkr IS NULL OR p_monthly_reference_fee_pkr <= 0 THEN
      RAISE EXCEPTION 'Enter the monthly reference fee';
    END IF;
    -- A monthly-fixed route doesn't sell per-trip seats at all — these
    -- columns stay NOT NULL-satisfying placeholders, never read for
    -- this route.
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
    is_two_way, return_wait_minutes
  ) VALUES (
    p_vehicle_id, v_tenant_id, trim(p_origin), nullif(trim(coalesce(p_origin_ur, '')), ''), trim(p_destination), nullif(trim(coalesce(p_destination_ur, '')), ''),
    p_classification, p_fare_mode, p_total_fare_pkr, v_per_seat,
    p_departure_time, p_days_of_week, true,
    p_origin_lat, p_origin_lng, p_destination_lat, p_destination_lng, p_distance_km,
    p_route_path, p_route_duration_min, p_return_departure_time,
    p_is_monthly_fixed, p_monthly_reference_fee_pkr,
    p_is_two_way, p_return_wait_minutes
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;
GRANT EXECUTE ON FUNCTION create_vehicle_route_self(uuid, character varying, character varying, character varying, character varying, numeric, time without time zone, integer[], character varying, character varying, numeric, numeric, numeric, numeric, numeric, jsonb, numeric, time without time zone, boolean, numeric, boolean, int) TO authenticated;

DROP FUNCTION IF EXISTS public.update_vehicle_route_schedule(uuid, time, integer[], time);

CREATE OR REPLACE FUNCTION update_vehicle_route_schedule(p_route_id uuid, p_departure_time time, p_days_of_week int[], p_return_departure_time time DEFAULT NULL, p_is_two_way boolean DEFAULT NULL, p_return_wait_minutes int DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only edit your own route.' USING ERRCODE = 'P0001'; END IF;
  IF p_days_of_week IS NULL OR array_length(p_days_of_week, 1) IS NULL THEN RAISE EXCEPTION 'Pick at least one day.' USING ERRCODE = 'P0001'; END IF;

  UPDATE vehicle_routes SET departure_time = p_departure_time, days_of_week = p_days_of_week, return_departure_time = p_return_departure_time,
    is_two_way = COALESCE(p_is_two_way, is_two_way), return_wait_minutes = CASE WHEN p_is_two_way IS NOT NULL THEN p_return_wait_minutes ELSE return_wait_minutes END
  WHERE id = p_route_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT DISTINCT riders.portal_user_id, 'route_schedule_changed', 'Route timing changed',
    'The departure time or days for a route you ride changed — check the new schedule.', '/portal/marketplace/route/' || p_route_id
  FROM (
    SELECT portal_user_id FROM ride_bookings WHERE route_id = p_route_id AND status NOT IN ('cancelled', 'rejected')
    UNION
    SELECT portal_user_id FROM route_participants WHERE route_id = p_route_id AND is_active = true
  ) riders;
END;
$$;
GRANT EXECUTE ON FUNCTION update_vehicle_route_schedule(uuid, time, int[], time, boolean, int) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Mark arrival at the destination — drives the "return opens in Xh Ym"
-- countdown and the window the wait-minutes setting is measured from.
-- ═════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION mark_run_arrived(p_run_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run route_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM route_runs WHERE id = p_run_id;
  IF NOT FOUND OR NOT is_route_owner(v_run.route_id) THEN RAISE EXCEPTION 'You can only manage your own route''s runs.' USING ERRCODE = 'P0001'; END IF;
  IF v_run.direction != 'outbound' THEN RAISE EXCEPTION 'Only the outbound leg has an arrival to mark.' USING ERRCODE = 'P0001'; END IF;
  IF v_run.ended_at IS NOT NULL THEN RAISE EXCEPTION 'This run has already ended.' USING ERRCODE = 'P0001'; END IF;

  UPDATE route_runs SET outbound_arrived_at = now() WHERE id = p_run_id;
END;
$$;
GRANT EXECUTE ON FUNCTION mark_run_arrived(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Offboard a specific rider from today's return leg — their outbound
-- booking is untouched; this only means they won't be on the way back,
-- freeing their seat for a standalone one-way return booking.
-- ═════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION alert_return_seat_available(p_route_id uuid, p_travel_date date, p_seats int) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- v1 targeting: riders who've shown real, recent interest in a ride
  -- from this destination village specifically — anyone who's booked a
  -- seat (in either direction) on another active route whose origin or
  -- destination name matches this route's destination, in the last 60
  -- days. No "follow this village" feature exists yet to target more
  -- precisely than a name match; capped to the 20 most recent to avoid
  -- this becoming a blind broadcast.
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT DISTINCT ON (rb.portal_user_id) rb.portal_user_id, 'return_seat_available',
    'A return seat just opened up',
    p_seats || ' seat(s) available for a one-way ride from ' || v_route.destination || ' — book at a distance-based fare.',
    '/portal/marketplace/route/' || p_route_id
  FROM ride_bookings rb JOIN vehicle_routes vr2 ON vr2.id = rb.route_id
  WHERE vr2.id != p_route_id AND vr2.is_active
    AND (vr2.origin = v_route.destination OR vr2.destination = v_route.destination)
    AND rb.created_at > now() - interval '60 days'
    AND rb.portal_user_id NOT IN (SELECT portal_user_id FROM ride_bookings WHERE route_id = p_route_id AND travel_date = p_travel_date AND status NOT IN ('cancelled', 'rejected'))
  ORDER BY rb.portal_user_id, rb.created_at DESC
  LIMIT 20;
END;
$$;

CREATE OR REPLACE FUNCTION offboard_rider(p_run_id uuid, p_booking_id uuid, p_reason text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run route_runs%ROWTYPE; v_booking ride_bookings%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM route_runs WHERE id = p_run_id;
  IF NOT FOUND OR NOT is_route_owner(v_run.route_id) THEN RAISE EXCEPTION 'You can only manage your own route''s runs.' USING ERRCODE = 'P0001'; END IF;
  IF v_run.direction != 'outbound' THEN RAISE EXCEPTION 'Offboarding happens on the outbound leg, before the return starts.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_booking FROM ride_bookings WHERE id = p_booking_id;
  IF NOT FOUND OR v_booking.route_id != v_run.route_id THEN RAISE EXCEPTION 'That booking is not on this route.' USING ERRCODE = 'P0001'; END IF;
  IF v_booking.travel_date != v_run.started_at::date THEN RAISE EXCEPTION 'That booking is not for today''s run.' USING ERRCODE = 'P0001'; END IF;
  IF v_booking.direction != 'outbound' THEN RAISE EXCEPTION 'Only an outbound booking can be offboarded from the return.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO route_run_offboards (ride_booking_id, route_id, reason, offboarded_by)
  VALUES (p_booking_id, v_run.route_id, p_reason, current_portal_user_id())
  ON CONFLICT (ride_booking_id) DO UPDATE SET reason = p_reason, offboarded_at = now(), offboarded_by = current_portal_user_id();

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_booking.portal_user_id, 'route_offboarded', 'Not included on the return trip',
    'The driver has marked you as not returning on today''s trip' || CASE WHEN p_reason IS NOT NULL AND trim(p_reason) != '' THEN ' — ' || p_reason ELSE '' END || '.',
    '/portal/marketplace/route/' || v_run.route_id);

  PERFORM alert_return_seat_available(v_run.route_id, v_booking.travel_date, v_booking.seats);
END;
$$;
GRANT EXECUTE ON FUNCTION offboard_rider(uuid, uuid, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Return-leg seat availability + the standalone one-way booking itself.
-- Same seat-pool math as route_seats_available (389) — total seats
-- minus every non-cancelled booking for that date — except an
-- offboarded outbound booking no longer counts against the RETURN leg
-- specifically (it still counts for the outbound leg, untouched).
-- ═════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION return_seats_available(p_route_id uuid, p_travel_date date) RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.total_seats - COALESCE((
    SELECT SUM(rb.seats)::int FROM ride_bookings rb
    WHERE rb.route_id = p_route_id AND rb.travel_date = p_travel_date AND rb.status IN ('announced', 'confirmed')
      AND NOT EXISTS (SELECT 1 FROM route_run_offboards o WHERE o.ride_booking_id = rb.id)
  ), 0)
  FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id WHERE vr.id = p_route_id;
$$;
GRANT EXECUTE ON FUNCTION return_seats_available(uuid, date) TO authenticated, anon;

CREATE OR REPLACE FUNCTION book_standalone_return_seat(p_route_id uuid, p_travel_date date, p_board_stop_id uuid, p_method varchar, p_proof_url text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE;
  v_vehicle vehicles%ROWTYPE;
  v_stop route_stops%ROWTYPE;
  v_available int;
  v_forward_fraction numeric;
  v_total decimal;
  v_booking_id uuid;
  v_commission_pct decimal;
  v_expected_commission decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND is_active;
  IF NOT FOUND OR NOT v_route.is_two_way THEN RAISE EXCEPTION 'This route does not run a separate return leg.' USING ERRCODE = 'P0001'; END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_stop FROM route_stops WHERE id = p_board_stop_id AND route_id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real stop on this route.' USING ERRCODE = 'P0001'; END IF;

  v_available := return_seats_available(p_route_id, p_travel_date);
  IF v_available <= 0 THEN RAISE EXCEPTION 'No seats are free on the return leg for that date.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;
  -- route_fraction_remaining measures the fraction of the path AHEAD of
  -- this stop, toward the destination — a return-leg rider travels the
  -- OTHER way, from this stop back toward the origin, so their fare is
  -- proportional to the complement: how much of the route is BEHIND
  -- this stop.
  v_forward_fraction := 1 - route_fraction_remaining(p_route_id, v_stop.lat, v_stop.lng);
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

  IF v_vehicle.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_vehicle.portal_user_id, 'route_return_seat_booked', 'Return-only seat booked',
      'A rider joined just the return leg from ' || (CASE WHEN v_stop.label IS NOT NULL THEN v_stop.label ELSE v_route.destination END) || ' — Rs ' || round(v_total), '/portal/my-vehicle/routes');
  END IF;

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total);
END;
$$;
GRANT EXECUTE ON FUNCTION book_standalone_return_seat(uuid, date, uuid, varchar, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- route_group_detail gains is_two_way/return_wait_minutes, the active
-- run's outbound_arrived_at, and (owner-only) today's outbound roster
-- with each booking's offboard state — the real list an owner offboards
-- FROM, distinct from roster_today (which is Teacher Van subscribers
-- only). Body otherwise copied verbatim from its real current
-- definition (724).
-- ═════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS route_group_detail(uuid);

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
        'present', COALESCE((SELECT present FROM route_run_attendance ra WHERE ra.subscription_id = rs.id AND ra.run_date = v_today), true)
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
