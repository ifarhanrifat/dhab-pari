-- ═════════════════════════════════════════════════════════════════════════
-- Real ask, 2026-10-21: "the shared ride system... is not useful for the
-- return ride, make it same like the route creating but this is not for
-- weekly booking this is for same day return and there must be
-- indications for this." The Trip Offer ("Publish a shared ride")
-- system already lets a rider choose 'oneway' (half fare, no return) or
-- 'return' (full fare, round trip) — but ONLY at booking time, before
-- the trip has even happened. There was no live same-day return
-- mechanism at all: return_departure_time_estimate was a pure display
-- label (migration 706's own comment: "not enforced server-side"), no
-- way to mark arrival, no way to release a no-show's return seat, and
-- no way for someone who was never on the outbound leg to join just the
-- return once a seat frees up — the exact same gap Routes had, now
-- fixed there (migration 727) with a wait window + offboard + a
-- standalone one-way booking. This ports that same model here, scoped
-- to a single same-day trip instead of a recurring weekly schedule —
-- there is no route_runs-style separate "run" table to extend, because
-- a trip offer already IS a single same-day event; the wait-window/
-- arrival timestamps live directly on vehicle_trip_offers instead.
--
-- 'leg' already existed (migration 693) for the upfront oneway/return
-- pricing split — a THIRD value, 'return_only', is new: a booking made
-- by someone who was never on the outbound leg, joining only the
-- return once a seat opened up, priced the same symmetric half-fare the
-- existing 'oneway' discount already uses. 'return' bookings are the
-- ones an offboard releases from the return leg; 'oneway' bookings
-- never counted against the return pool at all (their whole point is
-- "I'm not coming back"), so they're untouched by any of this.
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE vehicle_trip_offers ADD COLUMN IF NOT EXISTS return_wait_minutes int;
ALTER TABLE vehicle_trip_offers ADD COLUMN IF NOT EXISTS outbound_arrived_at timestamptz;

ALTER TABLE vehicle_trip_bookings DROP CONSTRAINT IF EXISTS vehicle_trip_bookings_leg_check;
ALTER TABLE vehicle_trip_bookings ADD CONSTRAINT vehicle_trip_bookings_leg_check CHECK (leg IN ('oneway', 'return', 'return_only'));

CREATE TABLE IF NOT EXISTS trip_booking_offboards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_booking_id uuid NOT NULL UNIQUE REFERENCES vehicle_trip_bookings(id) ON DELETE CASCADE,
  trip_offer_id uuid NOT NULL REFERENCES vehicle_trip_offers(id) ON DELETE CASCADE,
  reason text,
  offboarded_at timestamptz NOT NULL DEFAULT now(),
  offboarded_by uuid
);
CREATE INDEX IF NOT EXISTS trip_booking_offboards_offer_idx ON trip_booking_offboards(trip_offer_id);

ALTER TABLE trip_booking_offboards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "trip_booking_offboards_read" ON trip_booking_offboards FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id WHERE o.id = trip_offer_id AND v.portal_user_id = current_portal_user_id())
    OR EXISTS (SELECT 1 FROM vehicle_trip_bookings b WHERE b.id = trip_booking_id AND b.portal_user_id = current_portal_user_id())
  );

-- ═════════════════════════════════════════════════════════════════════════
-- Mark arrival at the destination — only meaningful for a 'return' trip.
-- Drives the "return opens in Xh Ym" countdown, same as Routes.
-- ═════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION mark_trip_arrived(p_trip_offer_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_offer vehicle_trip_offers%ROWTYPE;
BEGIN
  SELECT o.* INTO v_offer FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id WHERE o.id = p_trip_offer_id AND v.portal_user_id = v_portal_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'You do not manage this trip.' USING ERRCODE = 'P0001'; END IF;
  IF v_offer.trip_type != 'return' THEN RAISE EXCEPTION 'Only a return trip has an arrival to mark.' USING ERRCODE = 'P0001'; END IF;

  UPDATE vehicle_trip_offers SET outbound_arrived_at = now() WHERE id = p_trip_offer_id;
END;
$$;
GRANT EXECUTE ON FUNCTION mark_trip_arrived(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Offboard a specific rider from today's return leg. Their outbound
-- travel is untouched — this only means they won't be on the way back,
-- freeing their seat for a standalone return-only booking.
-- ═════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION alert_trip_return_seat_available(p_trip_offer_id uuid, p_seats int) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o vehicle_trip_offers%ROWTYPE;
BEGIN
  SELECT * INTO o FROM vehicle_trip_offers WHERE id = p_trip_offer_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Same v1 targeting as Routes (727): riders who've recently booked a
  -- seat on another open trip/route whose origin or destination name
  -- matches this trip's destination — no "follow this village" feature
  -- exists yet to target more precisely. Capped at 20 to avoid becoming
  -- a blind broadcast.
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT DISTINCT ON (b.portal_user_id) b.portal_user_id, 'trip_return_seat_available',
    'A return seat just opened up',
    p_seats || ' seat(s) available for a one-way ride from ' || o.destination || ' — Rs ' || round(o.listed_fare_per_seat_pkr / 2) || '/seat.',
    '/portal/marketplace'
  FROM vehicle_trip_bookings b JOIN vehicle_trip_offers o2 ON o2.id = b.trip_offer_id
  WHERE o2.id != p_trip_offer_id AND b.status = 'confirmed'
    AND (o2.origin = o.destination OR o2.destination = o.destination)
    AND b.created_at > now() - interval '60 days'
    AND b.portal_user_id NOT IN (SELECT portal_user_id FROM vehicle_trip_bookings WHERE trip_offer_id = p_trip_offer_id AND status = 'confirmed')
  ORDER BY b.portal_user_id, b.created_at DESC
  LIMIT 20;
END;
$$;

CREATE OR REPLACE FUNCTION offboard_trip_rider(p_trip_offer_id uuid, p_booking_id uuid, p_reason text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_booking vehicle_trip_bookings%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id WHERE o.id = p_trip_offer_id AND v.portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this trip.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_booking FROM vehicle_trip_bookings WHERE id = p_booking_id;
  IF NOT FOUND OR v_booking.trip_offer_id != p_trip_offer_id THEN RAISE EXCEPTION 'That booking is not on this trip.' USING ERRCODE = 'P0001'; END IF;
  IF v_booking.leg != 'return' THEN RAISE EXCEPTION 'Only a round-trip booking can be offboarded from the return leg.' USING ERRCODE = 'P0001'; END IF;
  IF v_booking.status != 'confirmed' THEN RAISE EXCEPTION 'This booking is not active.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO trip_booking_offboards (trip_booking_id, trip_offer_id, reason, offboarded_by)
  VALUES (p_booking_id, p_trip_offer_id, p_reason, v_portal_user_id)
  ON CONFLICT (trip_booking_id) DO UPDATE SET reason = p_reason, offboarded_at = now(), offboarded_by = v_portal_user_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_booking.portal_user_id, 'trip_offboarded', 'Not included on the return trip',
    'The driver has marked you as not returning on today''s trip' || CASE WHEN p_reason IS NOT NULL AND trim(p_reason) != '' THEN ' — ' || p_reason ELSE '' END || '.',
    '/portal/marketplace');

  PERFORM alert_trip_return_seat_available(p_trip_offer_id, v_booking.seats);
END;
$$;
GRANT EXECUTE ON FUNCTION offboard_trip_rider(uuid, uuid, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Return-leg seat availability + the standalone booking itself — same
-- symmetric half-fare the existing 'oneway' discount already uses
-- (migration 693), since a trip offer has no intermediate stops to
-- price proportionally against (unlike a Route).
-- ═════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION trip_return_seats_available(p_trip_offer_id uuid) RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.total_seats - COALESCE((
    SELECT SUM(b.seats)::int FROM vehicle_trip_bookings b
    WHERE b.trip_offer_id = p_trip_offer_id AND b.status = 'confirmed' AND b.leg IN ('return', 'return_only')
      AND NOT EXISTS (SELECT 1 FROM trip_booking_offboards x WHERE x.trip_booking_id = b.id)
  ), 0)
  FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id WHERE o.id = p_trip_offer_id;
$$;
GRANT EXECUTE ON FUNCTION trip_return_seats_available(uuid) TO authenticated, anon;

CREATE OR REPLACE FUNCTION book_trip_return_only_seat(p_trip_offer_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  o vehicle_trip_offers%ROWTYPE;
  v vehicles%ROWTYPE;
  v_available int;
  v_fare_offer_id uuid;
  v_booking_id uuid;
  v_fare_per_seat numeric;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO o FROM vehicle_trip_offers WHERE id = p_trip_offer_id;
  IF NOT FOUND OR o.trip_type != 'return' THEN RAISE EXCEPTION 'This trip does not run a separate return leg.' USING ERRCODE = 'P0001'; END IF;
  IF o.travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'This trip has already passed.' USING ERRCODE = 'P0001'; END IF;

  v_available := trip_return_seats_available(p_trip_offer_id);
  IF v_available <= 0 THEN RAISE EXCEPTION 'No seats are free on the return leg for this trip.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = o.vehicle_id;
  v_fare_per_seat := round(o.listed_fare_per_seat_pkr / 2);

  INSERT INTO vehicle_trip_fare_offers (trip_offer_id, portal_user_id, seats_requested, proposed_fare_per_seat_pkr, status, responded_at)
  VALUES (p_trip_offer_id, v_portal_user_id, 1, v_fare_per_seat, 'accepted', now())
  RETURNING id INTO v_fare_offer_id;

  INSERT INTO vehicle_trip_bookings (trip_offer_id, fare_offer_id, vehicle_id, portal_user_id, seats, agreed_fare_per_seat_pkr, total_amount_pkr, leg)
  VALUES (o.id, v_fare_offer_id, o.vehicle_id, v_portal_user_id, 1, v_fare_per_seat, v_fare_per_seat, 'return_only')
  RETURNING id INTO v_booking_id;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'trip_return_seat_booked', 'Return-only seat booked',
      'A rider joined just the return leg from ' || o.destination || ' — Rs ' || round(v_fare_per_seat), '/portal/my-vehicle/trips');
  END IF;

  RETURN jsonb_build_object('booking_id', v_booking_id, 'fare_per_seat', v_fare_per_seat);
END;
$$;
GRANT EXECUTE ON FUNCTION book_trip_return_only_seat(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- place_trip_offer gains a trailing p_return_wait_minutes (same
-- DROP+CREATE discipline as every trailing-param change this session —
-- body copied verbatim from its real current definition, 706, before
-- editing). my_trip_bookings surfaces the same two new offer fields so
-- a rider sees the live "return opens in..." state too, not just the
-- driver — the "there must be indications for this" part of the ask.
-- ═════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.place_trip_offer(uuid, character varying, character varying, character varying, character varying, character varying, character varying, date, time without time zone, integer, numeric, numeric, numeric, numeric, time without time zone);

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

  INSERT INTO vehicle_trip_offers (vehicle_id, trip_type, origin, origin_ur, destination, destination_ur, classification, travel_date, departure_time_estimate, seats_available, listed_fare_per_seat_pkr, distance_km, dest_lat, dest_lng, return_departure_time_estimate, return_wait_minutes)
  VALUES (p_vehicle_id, p_trip_type, p_origin, NULLIF(p_origin_ur, ''), p_destination, NULLIF(p_destination_ur, ''), p_classification, p_travel_date, p_departure_time_estimate, p_seats_available, p_listed_fare_per_seat_pkr, p_distance_km, p_dest_lat, p_dest_lng,
    CASE WHEN p_trip_type = 'return' THEN p_return_departure_time_estimate ELSE NULL END,
    CASE WHEN p_trip_type = 'return' THEN p_return_wait_minutes ELSE NULL END)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.my_trip_bookings()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'status', b.status, 'seats', b.seats, 'leg', b.leg,
    'agreed_fare_per_seat_pkr', b.agreed_fare_per_seat_pkr, 'total_amount_pkr', b.total_amount_pkr,
    'created_at', b.created_at, 'cancellation_reason', b.cancellation_reason,
    'rider_sharing_location', b.rider_sharing_location,
    'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
    'origin', o.origin, 'origin_ur', o.origin_ur, 'destination', o.destination, 'destination_ur', o.destination_ur,
    'travel_date', o.travel_date, 'departure_time_estimate', o.departure_time_estimate, 'trip_type', o.trip_type,
    'return_departure_time_estimate', o.return_departure_time_estimate,
    'return_wait_minutes', o.return_wait_minutes, 'outbound_arrived_at', o.outbound_arrived_at,
    'offboarded', EXISTS (SELECT 1 FROM trip_booking_offboards x WHERE x.trip_booking_id = b.id)
  ) ORDER BY b.created_at DESC), '[]'::jsonb)
  FROM vehicle_trip_bookings b
  JOIN vehicle_trip_offers o ON o.id = b.trip_offer_id
  JOIN vehicles v ON v.id = b.vehicle_id
  WHERE b.portal_user_id = current_portal_user_id();
$function$;

-- ═════════════════════════════════════════════════════════════════════════
-- Owner-only read: today's return-leg riders, with each one's offboard
-- state — the real roster an owner offboards FROM in the UI. A
-- dedicated RPC rather than a client-side embed since portal_users has
-- no cross-reader RLS policy (rightly so) for a driver to read a
-- rider's name directly.
-- ═════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION trip_offer_outbound_riders(p_trip_offer_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id WHERE o.id = p_trip_offer_id AND v.portal_user_id = v_portal_user_id) THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'booking_id', b.id, 'name', pu.full_name, 'seats', b.seats,
      'offboarded', EXISTS (SELECT 1 FROM trip_booking_offboards x WHERE x.trip_booking_id = b.id)
    ) ORDER BY b.created_at)
    FROM vehicle_trip_bookings b JOIN portal_users pu ON pu.id = b.portal_user_id
    WHERE b.trip_offer_id = p_trip_offer_id AND b.leg = 'return' AND b.status = 'confirmed'
  ), '[]'::jsonb);
END;
$$;
GRANT EXECUTE ON FUNCTION trip_offer_outbound_riders(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- browse_open_trip_offers (real current body from 698) extended: once a
-- return trip's OUTBOUND seats sell out, its status flips to 'closed'
-- (book_trip_offer's own existing logic) and it vanished from this list
-- entirely — taking any still-open RETURN-only availability down with
-- it, so nobody could ever discover or book a freed return seat. Now
-- also surfaces a closed-but-still-return-available trip, with the
-- live count so the UI can offer the standalone return-only booking
-- specifically (not the now-unavailable outbound one).
-- ═════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.browse_open_trip_offers(p_city_key text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', o.id, 'vehicle_id', o.vehicle_id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
    'avg_rating', (SELECT round(avg(r.stars)::numeric, 1) FROM ratings r WHERE r.target_party_type = 'vehicle' AND r.target_party_id = v.id),
    'origin', o.origin, 'origin_ur', o.origin_ur, 'destination', o.destination, 'destination_ur', o.destination_ur,
    'classification', o.classification, 'travel_date', o.travel_date, 'departure_time_estimate', o.departure_time_estimate,
    'seats_available', o.seats_available, 'listed_fare_per_seat_pkr', o.listed_fare_per_seat_pkr, 'trip_type', o.trip_type,
    'source', CASE WHEN aqe.id IS NOT NULL THEN 'adda' ELSE 'shared' END,
    'adda_name', a.name, 'adda_name_ur', a.name_ur, 'queue_position', aqe.position,
    'outbound_open', o.status = 'open' AND o.seats_available > 0,
    'return_seats_available', CASE WHEN o.trip_type = 'return' THEN trip_return_seats_available(o.id) ELSE NULL END,
    'return_wait_minutes', o.return_wait_minutes, 'outbound_arrived_at', o.outbound_arrived_at
  ) ORDER BY o.travel_date ASC, o.departure_time_estimate ASC NULLS LAST), '[]'::jsonb)
  FROM vehicle_trip_offers o
  JOIN vehicles v ON v.id = o.vehicle_id
  LEFT JOIN adda_queue_entries aqe ON aqe.trip_offer_id = o.id AND aqe.status IN ('waiting', 'current')
  LEFT JOIN addas a ON a.id = aqe.adda_id
  WHERE ((o.status = 'open' AND o.seats_available > 0) OR (o.trip_type = 'return' AND trip_return_seats_available(o.id) > 0))
    AND o.travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
    AND lower(trim(o.destination)) = lower(trim(p_city_key));
$function$;
REVOKE ALL ON FUNCTION public.browse_open_trip_offers(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.browse_open_trip_offers(text) TO authenticated;
