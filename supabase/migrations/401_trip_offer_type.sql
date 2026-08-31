-- Migration 401: a one-off trip posting must say whether it's a one-way
-- leg (driver has room heading somewhere specific) or a return leg (driver
-- is already there, coming back empty) — both use the exact same
-- per-seat, one-way fare/negotiation mechanics already built (there was
-- never a round-trip bundled price to begin with), this is purely a label
-- so a rider browsing understands what they're looking at.
ALTER TABLE vehicle_trip_offers ADD COLUMN IF NOT EXISTS trip_type varchar NOT NULL DEFAULT 'oneway' CHECK (trip_type IN ('oneway', 'return'));

-- place_trip_offer gains a parameter — changing an argument list needs a
-- DROP first, CREATE OR REPLACE alone won't do it for a new signature.
DROP FUNCTION IF EXISTS place_trip_offer(uuid, varchar, varchar, varchar, varchar, varchar, date, time, int, decimal);

CREATE OR REPLACE FUNCTION place_trip_offer(
  p_vehicle_id uuid, p_trip_type varchar, p_origin varchar, p_origin_ur varchar, p_destination varchar, p_destination_ur varchar,
  p_classification varchar, p_travel_date date, p_departure_time_estimate time, p_seats_available int, p_listed_fare_per_seat_pkr decimal
) RETURNS uuid AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF p_trip_type NOT IN ('oneway', 'return') THEN RAISE EXCEPTION 'Pick one-way or return.' USING ERRCODE = 'P0001'; END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;
  IF p_seats_available IS NULL OR p_seats_available <= 0 THEN RAISE EXCEPTION 'Enter how many seats are free.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicle_trip_offers (vehicle_id, trip_type, origin, origin_ur, destination, destination_ur, classification, travel_date, departure_time_estimate, seats_available, listed_fare_per_seat_pkr)
  VALUES (p_vehicle_id, p_trip_type, p_origin, NULLIF(p_origin_ur, ''), p_destination, NULLIF(p_destination_ur, ''), p_classification, p_travel_date, p_departure_time_estimate, p_seats_available, p_listed_fare_per_seat_pkr)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION place_trip_offer(uuid, varchar, varchar, varchar, varchar, varchar, varchar, date, time, int, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION place_trip_offer(uuid, varchar, varchar, varchar, varchar, varchar, varchar, date, time, int, decimal) TO authenticated;
