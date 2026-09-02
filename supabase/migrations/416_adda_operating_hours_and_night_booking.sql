-- Migration 416: fixed daily operating hours per adda — outside those
-- hours a driver can't check himself in (the stand is simply closed for
-- the day), same admin-exempt pattern as the geofence in 415. Seeded
-- with the two real windows described: Dhab Pari Chowk → Chakwal runs
-- 7:00 AM–5:00 PM, Chakwal Adda → the village runs 7:30 AM–7:00 PM —
-- change these via the admin Adda edit form if they're not quite right.
--
-- "Night booking" is a per-vehicle opt-in flag, not a new booking
-- mechanism — the existing non-adda trip-offer flow (place_trip_offer,
-- migration 400) already has no time-of-day restriction, so a vehicle
-- marked available at night is already bookable through that path any
-- hour; this flag exists so the committee can actually mark and see
-- which vehicles do night service, rather than that being invisible.
ALTER TABLE addas ADD COLUMN IF NOT EXISTS operating_start_time time;
ALTER TABLE addas ADD COLUMN IF NOT EXISTS operating_end_time time;
UPDATE addas SET operating_start_time = '07:00', operating_end_time = '17:00' WHERE id = '00000000-0000-0000-0000-00000000ad01' AND operating_start_time IS NULL;
UPDATE addas SET operating_start_time = '07:30', operating_end_time = '19:00' WHERE id = '00000000-0000-0000-0000-00000000ad02' AND operating_start_time IS NULL;

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS night_booking_enabled boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION adda_check_in(
  p_adda_id uuid, p_vehicle_id uuid, p_fare_mode varchar DEFAULT 'fixed',
  p_share_location_on_depart boolean DEFAULT false,
  p_lat decimal DEFAULT NULL, p_lng decimal DEFAULT NULL, p_seats_available int DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  a addas%ROWTYPE; ap addas%ROWTYPE; v vehicles%ROWTYPE; v_portal_user_id uuid := current_portal_user_id();
  v_queue_date date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_now_time time := (now() AT TIME ZONE 'Asia/Karachi')::time;
  v_next_position int; v_entry_id uuid; v_trip_offer_id uuid; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
  v_distance_km decimal; v_seats int; v_fare decimal;
BEGIN
  SELECT * INTO a FROM addas WHERE id = p_adda_id AND is_active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This adda is not available.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND OR NOT v.is_active THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (v_is_admin OR v.portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT vehicle_bookable(p_vehicle_id) THEN
    RAISE EXCEPTION 'This vehicle''s wallet balance is too low to join the queue — top up first.' USING ERRCODE = 'P0001';
  END IF;
  IF v.commission_mode = 'per_order' AND seller_account_balance(ensure_vehicle_account(p_vehicle_id)) <= 0 THEN
    RAISE EXCEPTION 'Top up your wallet before checking in — an adda slot needs a positive balance.' USING ERRCODE = 'P0001';
  END IF;

  -- The stand only runs its own set hours — a driver checking himself in
  -- outside that window is turned away (an admin can still check a
  -- vehicle in manually, e.g. a genuine early/late exception).
  IF NOT v_is_admin AND a.operating_start_time IS NOT NULL AND a.operating_end_time IS NOT NULL THEN
    IF v_now_time < a.operating_start_time OR v_now_time > a.operating_end_time THEN
      RAISE EXCEPTION 'This adda only runs % to % — check in during those hours, or ask the committee about night service.',
        to_char(a.operating_start_time, 'HH12:MI AM'), to_char(a.operating_end_time, 'HH12:MI AM') USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- A driver checking himself in must actually be at the stand — skipped
  -- for an admin check-in on someone's behalf, and skipped if the adda
  -- has no pin set yet (nothing to compare against).
  IF NOT v_is_admin AND a.lat IS NOT NULL AND a.lng IS NOT NULL THEN
    IF p_lat IS NULL OR p_lng IS NULL THEN
      RAISE EXCEPTION 'Turn on your location to check in — we need to confirm you''re at the adda.' USING ERRCODE = 'P0001';
    END IF;
    v_distance_km := 6371 * acos(least(1, greatest(-1,
      cos(radians(p_lat)) * cos(radians(a.lat)) * cos(radians(p_lng) - radians(a.lng))
      + sin(radians(p_lat)) * sin(radians(a.lat)))));
    IF v_distance_km > 0.3 THEN
      RAISE EXCEPTION 'You need to be at the adda to check in — you appear to be % km away.', round(v_distance_km::numeric, 1) USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM adda_queue_entries WHERE vehicle_id = p_vehicle_id AND queue_date = v_queue_date AND status IN ('waiting', 'current')) THEN
    RAISE EXCEPTION 'This vehicle is already in a queue today.' USING ERRCODE = 'P0001';
  END IF;

  IF p_fare_mode NOT IN ('fixed', 'request') THEN RAISE EXCEPTION 'Invalid fare mode.' USING ERRCODE = 'P0001'; END IF;
  IF p_fare_mode = 'fixed' THEN
    IF a.fixed_fare_per_seat_pkr IS NULL THEN
      RAISE EXCEPTION 'This adda has no fare set yet — ask the committee to set one first.' USING ERRCODE = 'P0001';
    END IF;
    v_fare := a.fixed_fare_per_seat_pkr;
  ELSE
    v_fare := NULL;
  END IF;

  v_seats := COALESCE(p_seats_available, v.total_seats);
  IF v_seats <= 0 OR v_seats > v.total_seats THEN
    RAISE EXCEPTION 'Enter how many seats are actually free (1 to %).', v.total_seats USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(MAX(position), 0) + 1 INTO v_next_position FROM adda_queue_entries
    WHERE adda_id = p_adda_id AND queue_date = v_queue_date AND status IN ('waiting', 'current');

  SELECT * INTO ap FROM addas WHERE id = a.pair_adda_id;
  INSERT INTO vehicle_trip_offers (vehicle_id, origin, origin_ur, destination, destination_ur, classification, travel_date, seats_available, listed_fare_per_seat_pkr)
  VALUES (p_vehicle_id, a.name, a.name_ur, COALESCE(ap.name, 'destination'), ap.name_ur, a.classification, v_queue_date, v_seats, COALESCE(v_fare, 0))
  RETURNING id INTO v_trip_offer_id;

  INSERT INTO adda_queue_entries (adda_id, vehicle_id, queue_date, position, status, fare_mode, fixed_fare_per_seat_pkr, trip_offer_id, seats_total, share_location_on_depart, checked_in_by_admin)
  VALUES (p_adda_id, p_vehicle_id, v_queue_date, v_next_position, 'waiting', p_fare_mode, v_fare, v_trip_offer_id, v_seats, p_share_location_on_depart,
    CASE WHEN v_is_admin AND v.portal_user_id IS DISTINCT FROM v_portal_user_id THEN current_admin_user_id() ELSE NULL END)
  RETURNING id INTO v_entry_id;

  PERFORM adda_promote_next(p_adda_id, v_queue_date);

  RETURN jsonb_build_object('entry_id', v_entry_id, 'trip_offer_id', v_trip_offer_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION adda_check_in(uuid, uuid, varchar, boolean, decimal, decimal, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION adda_check_in(uuid, uuid, varchar, boolean, decimal, decimal, int) TO authenticated;
