-- Real ask, 2026-10-26: "the driver commission will be deducted right
-- after he post the route or save the route and this will be notified
-- before he click the save button... same with the monthly daily ride,
-- there commission will be deducted right after there start of the
-- vehicle ride daily" — "30 rs daily per ride."
--
-- Traced the real gap first: commission for a shared-ride booking or a
-- route booking only ever gets deducted at completion (complete_trip_
-- booking, 709) — nothing happens, financially, the moment a driver
-- posts a one-off trip or starts a recurring route's daily run. A
-- driver can post or start either and walk away with zero consequence.
--
-- At POST/START time nobody has booked a seat yet, so there's no fare
-- total to take a percentage commission from — what's being asked for
-- is a separate, small, flat, non-refundable stake charged at the
-- moment of commitment (posting a trip, or starting that day's route
-- run), on top of the normal per-seat commission that still applies
-- later to whatever actually gets booked. Confirmed with the user: Rs
-- 30, flat, per ride/run — not a percentage, not deferred to month-end
-- (deferring just recreates the same "nothing stops a driver walking
-- away" problem this is meant to close).
--
-- Scoped to commission_mode = 'per_order' only, same gate used
-- everywhere else in the marketplace commission system (394/709) —
-- 'monthly_lumpsum' vehicles already pay their flat monthly fee
-- (migration 396) and, per the user, that mode is just a placeholder on
-- today's test vehicles due to be switched to 'per_order' anyway, not a
-- second mode to build new behavior around.
--
-- Reuses the exact real ledger pattern complete_trip_booking (709)
-- already uses for vehicle commission: ensure_vehicle_account +
-- seller_account_balance + a 'marketplace'/'MKT-4050' income voucher +
-- check_seller_balance_notify — nothing new invented on the accounting
-- side, just a new, earlier trigger point for it.

INSERT INTO site_settings (key, value, description) VALUES
  ('vehicle_ride_posting_stake_pkr', '30', 'Flat, non-refundable fee charged from a per_order vehicle''s wallet the moment they post a shared ride or start a route''s daily run — binds the driver to what they post instead of letting them walk away owing nothing. Not committee-approved pricing, just the number the user gave directly — admin-editable like every other fare knob.')
ON CONFLICT (tenant_id, key) DO NOTHING;

-- Internal helper, called by place_trip_offer and start_route_run
-- below — not exposed directly to the client (no GRANT to
-- authenticated), same as check_seller_balance_notify itself.
CREATE OR REPLACE FUNCTION charge_vehicle_ride_stake(p_vehicle_id uuid, p_context text) RETURNS void AS $$
DECLARE
  v vehicles%ROWTYPE; v_stake decimal; v_vehicle_account uuid; v_commission_account uuid; v_voucher_id uuid; v_balance decimal;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vehicle not found.' USING ERRCODE = 'P0001'; END IF;
  IF v.commission_mode <> 'per_order' THEN RETURN; END IF;

  SELECT COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'vehicle_ride_posting_stake_pkr'), 30) INTO v_stake;
  IF v_stake <= 0 THEN RETURN; END IF;

  v_vehicle_account := ensure_vehicle_account(p_vehicle_id);
  v_balance := seller_account_balance(v_vehicle_account);
  IF v_balance < v_stake THEN
    RAISE EXCEPTION 'Your wallet balance (Rs %) is too low to cover this Rs % posting fee — top up first.', round(v_balance), v_stake USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050' AND tenant_id = v.tenant_id;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    p_context || ' — posting fee (non-refundable)', v_stake, v_commission_account, v_vehicle_account, v.owner_name)
  RETURNING id INTO v_voucher_id;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'vehicle_ride_stake_charged', 'Posting fee charged',
      'Rs ' || v_stake || ' was charged from your wallet for ' || p_context || ' — this is not refundable.', '/portal/my-vehicle');
  END IF;

  PERFORM check_seller_balance_notify('vehicle', p_vehicle_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Read-only: lets the client show "posting this costs Rs X — your
-- wallet has Rs Y" inline BEFORE the driver taps save/start, per the
-- direct ask ("notified before he click the save button").
CREATE OR REPLACE FUNCTION vehicle_ride_stake_info(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v vehicles%ROWTYPE; v_stake decimal;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = current_portal_user_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF v.commission_mode <> 'per_order' THEN
    RETURN jsonb_build_object('applies', false, 'stake_pkr', 0, 'balance_pkr', 0, 'can_afford', true);
  END IF;
  SELECT COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'vehicle_ride_posting_stake_pkr'), 30) INTO v_stake;
  RETURN jsonb_build_object('applies', true, 'stake_pkr', v_stake, 'balance_pkr', seller_account_balance(ensure_vehicle_account(p_vehicle_id)),
    'can_afford', seller_account_balance(ensure_vehicle_account(p_vehicle_id)) >= v_stake);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_ride_stake_info(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_ride_stake_info(uuid) TO authenticated;

-- place_trip_offer: same signature as 728's real current body — one
-- addition, charge the stake right after the existing validations
-- pass and right before the insert, so a failed charge means nothing
-- was posted at all.
DROP FUNCTION IF EXISTS public.place_trip_offer(uuid, character varying, character varying, character varying, character varying, character varying, character varying, date, time without time zone, integer, numeric, numeric, numeric, numeric, time without time zone, int);

CREATE OR REPLACE FUNCTION public.place_trip_offer(p_vehicle_id uuid, p_trip_type character varying, p_origin character varying, p_origin_ur character varying, p_destination character varying, p_destination_ur character varying, p_classification character varying, p_travel_date date, p_departure_time_estimate time without time zone, p_seats_available integer, p_listed_fare_per_seat_pkr numeric DEFAULT NULL::numeric, p_distance_km numeric DEFAULT NULL::numeric, p_dest_lat numeric DEFAULT NULL::numeric, p_dest_lng numeric DEFAULT NULL::numeric, p_return_departure_time_estimate time without time zone DEFAULT NULL, p_return_wait_minutes int DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid; v_allows_out_of_city boolean; v_is_online boolean; v_fair decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT allows_out_of_city, is_online INTO v_allows_out_of_city, v_is_online FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF NOT v_is_online THEN RAISE EXCEPTION 'Go online first — you can''t post a new trip while offline.' USING ERRCODE = 'P0001'; END IF;
  IF NOT vehicle_ride_eligible(p_vehicle_id) THEN
    RAISE EXCEPTION 'Your vehicle''s class is not enabled for rides — ask the committee.' USING ERRCODE = 'P0001';
  END IF;
  IF p_trip_type NOT IN ('oneway', 'return') THEN RAISE EXCEPTION 'Pick one-way or return.' USING ERRCODE = 'P0001'; END IF;
  IF p_classification = 'out_of_city' AND NOT v_allows_out_of_city THEN
    RAISE EXCEPTION 'This vehicle is only set up for trips within the home city — ask the committee if you need out-of-station enabled.' USING ERRCODE = 'P0001';
  END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
  IF p_seats_available IS NULL OR p_seats_available <= 0 THEN RAISE EXCEPTION 'Enter how many seats are free.' USING ERRCODE = 'P0001'; END IF;

  IF EXISTS (
    SELECT 1 FROM vehicle_trip_offers
     WHERE vehicle_id = p_vehicle_id
       AND status = 'open'
       AND travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
  ) THEN
    RAISE EXCEPTION 'You already have an open trip posted — close it (or wait for its date to pass) before posting a new one.' USING ERRCODE = 'P0001';
  END IF;

  IF p_distance_km IS NOT NULL THEN
    v_fair := (fare_band_for('trip_share', p_distance_km)->>'fair')::decimal;
    IF v_fair IS NOT NULL THEN
      IF p_listed_fare_per_seat_pkr IS NULL THEN
        p_listed_fare_per_seat_pkr := round(v_fair);
      ELSIF round(p_listed_fare_per_seat_pkr) > round(v_fair) THEN
        RAISE EXCEPTION 'The fair fare per seat for this distance is ₨% — you can list that or less, not more.', round(v_fair) USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  IF p_listed_fare_per_seat_pkr IS NULL OR p_listed_fare_per_seat_pkr < 0 THEN
    RAISE EXCEPTION 'Enter the fare per seat.' USING ERRCODE = 'P0001';
  END IF;

  PERFORM charge_vehicle_ride_stake(p_vehicle_id, 'Shared ride posted (' || p_origin || ' → ' || p_destination || ')');

  INSERT INTO vehicle_trip_offers (vehicle_id, trip_type, origin, origin_ur, destination, destination_ur, classification, travel_date, departure_time_estimate, seats_available, listed_fare_per_seat_pkr, distance_km, dest_lat, dest_lng, return_departure_time_estimate, return_wait_minutes)
  VALUES (p_vehicle_id, p_trip_type, p_origin, NULLIF(p_origin_ur, ''), p_destination, NULLIF(p_destination_ur, ''), p_classification, p_travel_date, p_departure_time_estimate, p_seats_available, p_listed_fare_per_seat_pkr, p_distance_km, p_dest_lat, p_dest_lng,
    CASE WHEN p_trip_type = 'return' THEN p_return_departure_time_estimate ELSE NULL END,
    CASE WHEN p_trip_type = 'return' THEN p_return_wait_minutes ELSE NULL END)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;
-- 728's own DROP+CREATE never re-issued a REVOKE/GRANT for this new
-- 16-param signature (a genuinely different function object than
-- 496's 14-param one it replaced) — Postgres defaults a freshly
-- created function to PUBLIC-executable, so this had been callable by
-- anon ever since. Closing that here while already touching this body.
REVOKE ALL ON FUNCTION public.place_trip_offer(uuid, character varying, character varying, character varying, character varying, character varying, character varying, date, time without time zone, integer, numeric, numeric, numeric, numeric, time without time zone, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_trip_offer(uuid, character varying, character varying, character varying, character varying, character varying, character varying, date, time without time zone, integer, numeric, numeric, numeric, numeric, time without time zone, int) TO authenticated;

-- start_route_run: same signature as 724's real current body — stake
-- charged per run (each outbound/return start is its own "ride"),
-- right after the "already has an active run" guard and before the
-- insert, same reasoning as place_trip_offer above.
DROP FUNCTION IF EXISTS start_route_run(uuid, varchar);

CREATE OR REPLACE FUNCTION start_route_run(p_route_id uuid, p_direction varchar DEFAULT 'outbound') RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_route vehicle_routes%ROWTYPE;
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only start your own route.' USING ERRCODE = 'P0001'; END IF;
  IF p_direction NOT IN ('outbound', 'return') THEN RAISE EXCEPTION 'Invalid direction.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM route_runs WHERE route_id = p_route_id AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'This route already has an active run — end it before starting another.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;

  PERFORM charge_vehicle_ride_stake(v_route.vehicle_id, 'Route run started (' ||
    (CASE WHEN p_direction = 'return' THEN v_route.destination || ' → ' || v_route.origin ELSE v_route.origin || ' → ' || v_route.destination END) || ')');

  INSERT INTO route_runs (route_id, direction) VALUES (p_route_id, p_direction) RETURNING id INTO v_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT rp.portal_user_id, 'route_run_started', 'The van is on its way',
    (CASE WHEN p_direction = 'return' THEN v_route.destination || ' → ' || v_route.origin ELSE v_route.origin || ' → ' || v_route.destination END) || ' — live arrival times are now showing.',
    '/portal/marketplace/route/' || p_route_id
  FROM route_participants rp WHERE rp.route_id = p_route_id AND rp.is_active = true;

  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION start_route_run(uuid, varchar) TO authenticated;
