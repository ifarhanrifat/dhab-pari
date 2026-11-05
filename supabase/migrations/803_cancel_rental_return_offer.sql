-- Migration 803: real bug, 2026-11-05 — "one vehicle is carrying two
-- wapsi rides on the same floating button, how is that possible?"
--
-- It's not a bug in the sense of bad data: respond_rental_booking (796)
-- spins up a brand new rental_return_offers row every time a driver
-- accepts ANY one-way booking over 25km, with no link to or awareness
-- of any return offer that vehicle already has open. A driver who
-- accepts a second long one-way job (to the same city or not) before
-- their first return offer is booked/cancelled/used ends up with two
-- (or more) simultaneous 'pending'/'activated' rows for the same
-- vehicle_id — each one its own entry on the floating hub and on
-- vehicle_rental_return_offers.
--
-- The real gap this migration fixes: there was no way to withdraw one.
-- cancel_rental_booking (796) only ever auto-cancels a PENDING offer,
-- and only as a side effect of cancelling the *original* one-way
-- booking — which is usually already 'completed' by the time an offer
-- is 'activated', so that path can't reach it. There was no owner-
-- facing "cancel this return offer" action anywhere, so a stale or
-- unwanted offer (or a duplicate) had no way to be removed — it just
-- sat there forever showing on the hub and on my-vehicle/rental,
-- bookable by riders, until every seat filled.
CREATE OR REPLACE FUNCTION cancel_rental_return_offer(p_offer_id uuid, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE o rental_return_offers%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO o FROM rental_return_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Return offer not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = o.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF o.status NOT IN ('pending', 'activated') THEN
    RAISE EXCEPTION 'This return offer is already closed.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE rental_return_offers SET status = 'cancelled' WHERE id = p_offer_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT ob.portal_user_id, 'rental_return_offer_cancelled', 'Return seat cancelled',
    'The driver withdrew this return trip from ' || o.from_address || '.' || COALESCE(' — ' || p_reason, ''), '/portal/marketplace'
  FROM rental_return_offer_bookings ob WHERE ob.offer_id = p_offer_id AND ob.status = 'booked';
  UPDATE rental_return_offer_bookings SET status = 'cancelled' WHERE offer_id = p_offer_id AND status = 'booked';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION cancel_rental_return_offer(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancel_rental_return_offer(uuid, text) TO authenticated;
