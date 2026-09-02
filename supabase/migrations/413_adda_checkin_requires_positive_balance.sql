-- Migration 413: a per_order vehicle with an exactly-zero wallet balance
-- could check into an adda queue and occupy the "current" turn slot —
-- vehicle_bookable() only enforces >= marketplace_min_balance_to_order_pkr,
-- which is 0 today. That threshold is shared with shop orders and route
-- bookings, where "still visible for price comparison at zero balance" is
-- a reasonable default; occupying a live, public queue slot at a real
-- stand is a stronger commitment ("every vehicle must be present" — a
-- driver with nothing topped up yet shouldn't be able to hold the front
-- of the line) so adda_check_in gets its own, stricter rule rather than
-- changing the shared global setting and its other callers.
CREATE OR REPLACE FUNCTION adda_check_in(
  p_adda_id uuid, p_vehicle_id uuid, p_fare_mode varchar DEFAULT 'fixed',
  p_fixed_fare_per_seat_pkr decimal DEFAULT NULL, p_share_location_on_depart boolean DEFAULT false
) RETURNS jsonb AS $$
DECLARE
  a addas%ROWTYPE; ap addas%ROWTYPE; v vehicles%ROWTYPE; v_portal_user_id uuid := current_portal_user_id();
  v_queue_date date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_next_position int; v_entry_id uuid; v_trip_offer_id uuid; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
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

  IF EXISTS (SELECT 1 FROM adda_queue_entries WHERE vehicle_id = p_vehicle_id AND queue_date = v_queue_date AND status IN ('waiting', 'current')) THEN
    RAISE EXCEPTION 'This vehicle is already in a queue today.' USING ERRCODE = 'P0001';
  END IF;

  IF p_fare_mode NOT IN ('fixed', 'request') THEN RAISE EXCEPTION 'Invalid fare mode.' USING ERRCODE = 'P0001'; END IF;
  IF p_fare_mode = 'fixed' AND (p_fixed_fare_per_seat_pkr IS NULL OR p_fixed_fare_per_seat_pkr <= 0) THEN
    RAISE EXCEPTION 'Enter the fixed fare per seat.' USING ERRCODE = 'P0001';
  END IF;
  IF p_fare_mode = 'request' AND p_fixed_fare_per_seat_pkr IS NOT NULL THEN
    RAISE EXCEPTION 'A ride-request vehicle should not set a fixed fare.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(MAX(position), 0) + 1 INTO v_next_position FROM adda_queue_entries
    WHERE adda_id = p_adda_id AND queue_date = v_queue_date AND status IN ('waiting', 'current');

  IF p_fare_mode = 'request' THEN
    SELECT * INTO ap FROM addas WHERE id = a.pair_adda_id;
    INSERT INTO vehicle_trip_offers (vehicle_id, origin, origin_ur, destination, destination_ur, classification, travel_date, seats_available, listed_fare_per_seat_pkr)
    VALUES (p_vehicle_id, a.name, a.name_ur, COALESCE(ap.name, 'destination'), ap.name_ur, a.classification, v_queue_date, v.total_seats, 0)
    RETURNING id INTO v_trip_offer_id;
  END IF;

  INSERT INTO adda_queue_entries (adda_id, vehicle_id, queue_date, position, status, fare_mode, fixed_fare_per_seat_pkr, trip_offer_id, seats_total, share_location_on_depart, checked_in_by_admin)
  VALUES (p_adda_id, p_vehicle_id, v_queue_date, v_next_position, 'waiting', p_fare_mode, p_fixed_fare_per_seat_pkr, v_trip_offer_id, v.total_seats, p_share_location_on_depart,
    CASE WHEN v_is_admin AND v.portal_user_id IS DISTINCT FROM v_portal_user_id THEN current_admin_user_id() ELSE NULL END)
  RETURNING id INTO v_entry_id;

  PERFORM adda_promote_next(p_adda_id, v_queue_date);

  RETURN jsonb_build_object('entry_id', v_entry_id, 'trip_offer_id', v_trip_offer_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION adda_check_in(uuid, uuid, varchar, decimal, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION adda_check_in(uuid, uuid, varchar, decimal, boolean) TO authenticated;
