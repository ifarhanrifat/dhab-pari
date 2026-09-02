-- Migration 418: a driver could only set how many seats he's offering at
-- the moment of check-in (415's p_seats_available) — nothing let him
-- adjust it afterwards. Real case: he checks in with 5 free (already
-- carrying 7 off-app), then two of those get off along the way and he
-- actually has 7 free now, or the opposite — picks up more than planned
-- and needs to lower the count so the board doesn't overpromise seats.
--
-- adda_update_seats() edits adda_queue_entries.seats_total on his own
-- still-live entry (waiting or current), refusing to drop it below
-- whatever's already genuinely booked against it — computed per fare
-- mode, since a 'fixed' entry's bookings live in ride_bookings
-- (adda_entry_seats_available) while a 'request' entry's already-accepted
-- seats are reflected in its vehicle_trip_offers.seats_available instead.
-- The linked trip offer's seats_available is nudged by the same delta so
-- it stays consistent for whichever downstream reader depends on it (the
-- adda board, the live nearby map) without re-deriving from scratch.
CREATE OR REPLACE FUNCTION adda_update_seats(p_entry_id uuid, p_seats_total int) RETURNS void AS $$
DECLARE
  e adda_queue_entries%ROWTYPE; v vehicles%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
  v_committed int; v_delta int; v_offer_available int;
BEGIN
  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Queue entry not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = e.vehicle_id;
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF e.status NOT IN ('waiting', 'current') THEN
    RAISE EXCEPTION 'This vehicle is no longer waiting at the adda.' USING ERRCODE = 'P0001';
  END IF;
  IF p_seats_total IS NULL OR p_seats_total <= 0 OR p_seats_total > v.total_seats THEN
    RAISE EXCEPTION 'Enter how many seats are actually free (1 to %).', v.total_seats USING ERRCODE = 'P0001';
  END IF;

  IF e.fare_mode = 'fixed' THEN
    v_committed := e.seats_total - adda_entry_seats_available(p_entry_id);
  ELSE
    SELECT seats_available INTO v_offer_available FROM vehicle_trip_offers WHERE id = e.trip_offer_id;
    v_committed := e.seats_total - COALESCE(v_offer_available, e.seats_total);
  END IF;
  IF p_seats_total < v_committed THEN
    RAISE EXCEPTION 'Already % seat(s) booked — can''t set free seats below that.', v_committed USING ERRCODE = 'P0001';
  END IF;

  v_delta := p_seats_total - e.seats_total;
  UPDATE adda_queue_entries SET seats_total = p_seats_total WHERE id = p_entry_id;
  IF e.trip_offer_id IS NOT NULL THEN
    UPDATE vehicle_trip_offers SET seats_available = seats_available + v_delta WHERE id = e.trip_offer_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION adda_update_seats(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION adda_update_seats(uuid, int) TO authenticated;
