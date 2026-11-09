-- Migration 830: Phase 1+3 of bringing Trip Offers (one-off "Shared
-- Ride" bookings, vehicle_trip_bookings) up to the same standard Routes
-- already has. Confirmed via a full read-only audit before writing any
-- of this — see /Users/azaan/.claude/plans/proud-tickling-glacier.md.
--
-- (1) trip_booking_lifecycle_detail gains has_pin — the body already
--     withholds the real pin from a driver's own copy
--     (CASE WHEN v_role='rider' THEN b.pin ELSE NULL END), so a driver
--     had no way to tell "this booking has no PIN at all" (every
--     ordinary Shared Ride booking today) apart from "I have a PIN but
--     can't see it" — RideLifecycleSheet's driver-start step required
--     typing 4 digits regardless, which would have blocked every
--     ordinary trip from ever starting. has_pin is safe to expose to
--     both roles (it reveals nothing but whether one exists).
-- (2) start_trip_booking / complete_trip_booking gain real
--     notifications — confirmed via the audit that both were
--     completely silent to the rider (only cancel ever notified).
-- (3) cancel_trip_booking: the confirmed policy — ordinary (non-PIN)
--     Shared Ride cancellations now get the exact same rule Routes
--     already has (cancel_ride_booking, 436): full fare kept by the
--     driver if the rider self-cancels within 2 hours of departure (or
--     after the ride has already started), nothing if cancelled
--     earlier. Only a RIDER'S OWN cancellation is ever subject to this —
--     a driver cancelling is never the rider's fault, matching Routes'
--     own distinction exactly. The existing PIN/ride-dispatch flat-fee
--     branch (50/200, applies to either party) is untouched — a
--     separate, already-tested sub-flow, not in scope here.
-- (4) mark_trip_booking_no_show — the Routes-side equivalent
--     (mark_rider_no_show, 828) didn't have a trip-bookings counterpart.
--     Driver-only, only while still 'confirmed' (not yet started),
--     always keeps the full fare — this IS the rider's fault by
--     definition, unlike an ordinary driver-initiated cancellation.

CREATE OR REPLACE FUNCTION trip_booking_lifecycle_detail(p_trip_booking_id uuid) RETURNS jsonb AS $$
DECLARE
  b vehicle_trip_bookings%ROWTYPE; o vehicle_trip_offers%ROWTYPE; v vehicles%ROWTYPE;
  v_portal_user_id uuid := current_portal_user_id();
  v_role varchar; v_pickup_lat decimal; v_pickup_lng decimal; v_pickup_label text; v_is_out_of_city boolean;
BEGIN
  SELECT * INTO b FROM vehicle_trip_bookings WHERE id = p_trip_booking_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO o FROM vehicle_trip_offers WHERE id = b.trip_offer_id;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;

  IF b.portal_user_id = v_portal_user_id THEN v_role := 'rider';
  ELSIF v.portal_user_id = v_portal_user_id THEN v_role := 'driver';
  ELSE RETURN NULL;
  END IF;

  SELECT pickup_lat, pickup_lng, pickup_label, is_out_of_city INTO v_pickup_lat, v_pickup_lng, v_pickup_label, v_is_out_of_city
  FROM ride_dispatch_requests WHERE trip_offer_id = b.trip_offer_id;

  RETURN jsonb_build_object(
    'booking_id', b.id, 'role', v_role, 'status', b.status, 'trip_offer_id', b.trip_offer_id,
    'origin', o.origin, 'origin_ur', o.origin_ur, 'destination', o.destination, 'destination_ur', o.destination_ur,
    'pickup_lat', v_pickup_lat, 'pickup_lng', v_pickup_lng, 'pickup_label', v_pickup_label,
    'dest_lat', o.dest_lat, 'dest_lng', o.dest_lng,
    'pin', CASE WHEN v_role = 'rider' THEN b.pin ELSE NULL END,
    'has_pin', b.pin IS NOT NULL,
    'vehicle_id', b.vehicle_id, 'rider_portal_user_id', b.portal_user_id,
    'total_amount_pkr', b.total_amount_pkr, 'is_out_of_city', COALESCE(v_is_out_of_city, false)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS start_trip_booking(uuid, varchar);
CREATE OR REPLACE FUNCTION start_trip_booking(p_trip_booking_id uuid, p_pin varchar DEFAULT NULL) RETURNS void AS $$
DECLARE b vehicle_trip_bookings%ROWTYPE; v vehicles%ROWTYPE; o vehicle_trip_offers%ROWTYPE;
BEGIN
  SELECT * INTO b FROM vehicle_trip_bookings WHERE id = p_trip_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'confirmed' THEN RAISE EXCEPTION 'This trip is not ready to start.' USING ERRCODE = 'P0001'; END IF;
  IF b.pin IS NOT NULL AND trim(COALESCE(p_pin, '')) <> b.pin THEN
    RAISE EXCEPTION 'Incorrect code — ask the rider for the 4-digit code shown in their app.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE vehicle_trip_bookings SET status = 'in_progress', started_at = now() WHERE id = p_trip_booking_id;

  SELECT * INTO o FROM vehicle_trip_offers WHERE id = b.trip_offer_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'trip_booking_started', 'Your ride has started',
    o.origin || ' → ' || o.destination || ' is now underway.', '/portal/marketplace/shared');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION start_trip_booking(uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION start_trip_booking(uuid, varchar) TO authenticated;

CREATE OR REPLACE FUNCTION complete_trip_booking(p_trip_booking_id uuid) RETURNS jsonb AS $$
DECLARE
  b vehicle_trip_bookings%ROWTYPE; v vehicles%ROWTYPE; o vehicle_trip_offers%ROWTYPE;
  v_vehicle_account uuid; v_commission_account uuid; v_commission_pct decimal; v_commission_amount decimal := 0;
  v_commission_voucher_id uuid;
BEGIN
  SELECT * INTO b FROM vehicle_trip_bookings WHERE id = p_trip_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status NOT IN ('confirmed', 'in_progress') THEN RAISE EXCEPTION 'This trip is not awaiting completion.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  SELECT * INTO o FROM vehicle_trip_offers WHERE id = b.trip_offer_id;
  IF v.portal_user_id IS DISTINCT FROM current_portal_user_id() AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicle_trip_bookings SET status = 'completed', completed_at = now() WHERE id = p_trip_booking_id;

  IF v.commission_mode = 'per_order' THEN
    v_vehicle_account := ensure_vehicle_account(v.id);
    SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050';
    v_commission_pct := vehicle_commission_pct(v.vehicle_type, o.classification);
    v_commission_amount := round(b.total_amount_pkr * v_commission_pct / 100, 2);
    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — ' || o.origin || ' → ' || o.destination || ' return trip (paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
      RETURNING id INTO v_commission_voucher_id;
      UPDATE vehicle_trip_bookings SET commission_voucher_id = v_commission_voucher_id WHERE id = p_trip_booking_id;
    END IF;
    PERFORM check_seller_balance_notify('vehicle', v.id);
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'trip_booking_completed', 'Ride completed',
    o.origin || ' → ' || o.destination || ' has finished. Fare: Rs ' || round(b.total_amount_pkr), '/portal/marketplace/shared');

  RETURN jsonb_build_object('amount', b.total_amount_pkr, 'commission', v_commission_amount);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION cancel_trip_booking(p_trip_booking_id uuid, p_reason text DEFAULT NULL) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  b vehicle_trip_bookings%ROWTYPE; v vehicles%ROWTYPE; o vehicle_trip_offers%ROWTYPE;
  v_is_rider boolean; v_is_driver boolean; v_is_admin boolean;
  v_fee decimal := 0; v_fee_note text := '';
  v_departure timestamptz; v_within_cutoff boolean;
BEGIN
  SELECT * INTO b FROM vehicle_trip_bookings WHERE id = p_trip_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status = 'cancelled' THEN RAISE EXCEPTION 'This booking is already cancelled.' USING ERRCODE = 'P0001'; END IF;
  IF b.status = 'completed' THEN RAISE EXCEPTION 'This trip is already complete — it can''t be cancelled.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  SELECT * INTO o FROM vehicle_trip_offers WHERE id = b.trip_offer_id FOR UPDATE;

  v_is_rider := v_portal_user_id IS NOT NULL AND b.portal_user_id = v_portal_user_id;
  v_is_driver := v.portal_user_id IS NOT NULL AND v.portal_user_id = v_portal_user_id;
  v_is_admin := COALESCE(current_admin_permission('post_transactions'), false);
  IF NOT (v_is_rider OR v_is_driver OR v_is_admin) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  IF b.pin IS NOT NULL AND (v_is_rider OR v_is_driver) THEN
    -- Ride-dispatch 1:1 acceptance — existing, untouched flat-fee rule.
    IF b.status = 'in_progress' THEN v_fee := 200;
    ELSIF b.status = 'confirmed' THEN v_fee := 50;
    END IF;
    IF v_fee > 0 THEN v_fee_note := ' A cancellation fee of Rs ' || v_fee::text || ' applies — settle in person.'; END IF;
  ELSIF b.pin IS NULL AND v_is_rider THEN
    -- Ordinary Shared Ride — same rule as Routes (cancel_ride_booking,
    -- 436): the rider's own cancellation keeps the full fare if it's
    -- within 2 hours of departure, or the ride's already under way.
    -- Never applies to a driver-initiated cancellation — that's never
    -- the rider's fault, same distinction Routes makes.
    IF b.status = 'in_progress' THEN
      v_fee := b.total_amount_pkr;
    ELSE
      v_departure := (o.travel_date + COALESCE(CASE WHEN b.leg = 'return' THEN o.return_departure_time_estimate ELSE o.departure_time_estimate END, '00:00'::time)) AT TIME ZONE 'Asia/Karachi';
      v_within_cutoff := (CASE WHEN b.leg = 'return' THEN o.return_departure_time_estimate ELSE o.departure_time_estimate END) IS NOT NULL AND v_departure - now() < interval '2 hours';
      IF v_within_cutoff THEN v_fee := b.total_amount_pkr; END IF;
    END IF;
    IF v_fee > 0 THEN v_fee_note := ' This was cancelled too close to departure, so the fare is non-refundable.'; END IF;
  END IF;

  UPDATE vehicle_trip_bookings SET status = 'cancelled', cancelled_at = now(),
    cancelled_by_portal_user_id = v_portal_user_id, cancellation_reason = trim(p_reason), cancellation_fee_pkr = NULLIF(v_fee, 0)
    WHERE id = p_trip_booking_id;

  IF b.pin IS NULL THEN
    UPDATE vehicle_trip_offers SET seats_available = o.seats_available + b.seats,
      status = CASE WHEN status = 'closed' AND travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date THEN 'open' ELSE status END
      WHERE id = o.id;
  END IF;

  IF v.portal_user_id IS NOT NULL AND v.portal_user_id <> b.portal_user_id THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'trip_booking_cancelled',
      CASE WHEN v_is_driver THEN 'You cancelled a booking' ELSE 'A rider cancelled' END,
      (CASE WHEN v_is_driver
        THEN 'You cancelled the seat booking for ' || o.origin || ' → ' || o.destination || ' on ' || to_char(o.travel_date, 'DD Mon YYYY') || '.' || COALESCE(' ' || trim(p_reason), '')
        ELSE 'A seat booking for ' || o.origin || ' → ' || o.destination || ' on ' || to_char(o.travel_date, 'DD Mon YYYY') || ' was cancelled.' || COALESCE(' ' || trim(p_reason), '') END) || v_fee_note,
      '/portal/my-vehicle/trips');
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'trip_booking_cancelled',
    CASE WHEN v_is_rider THEN 'You cancelled your booking' ELSE 'Your booking was cancelled' END,
    (CASE WHEN v_is_rider
      THEN 'You cancelled your seat booking for ' || o.origin || ' → ' || o.destination || ' on ' || to_char(o.travel_date, 'DD Mon YYYY') || '.'
      ELSE 'Your seat booking for ' || o.origin || ' → ' || o.destination || ' on ' || to_char(o.travel_date, 'DD Mon YYYY') || ' was cancelled by the driver.' || COALESCE(' ' || trim(p_reason), '') END) || v_fee_note,
    '/portal/marketplace/shared');

  RETURN jsonb_build_object('status', 'cancelled', 'fee_pkr', v_fee);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- New: a driver marking a specific rider a no-show, distinct from an
-- ordinary driver-initiated cancellation (which stays fee-free, same
-- as today) — this IS the rider's fault by definition, so the full
-- fare is kept, mirroring mark_rider_no_show (828) for Routes.
CREATE OR REPLACE FUNCTION mark_trip_booking_no_show(p_trip_booking_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b vehicle_trip_bookings%ROWTYPE; v vehicles%ROWTYPE; o vehicle_trip_offers%ROWTYPE;
BEGIN
  SELECT * INTO b FROM vehicle_trip_bookings WHERE id = p_trip_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF v.portal_user_id IS DISTINCT FROM current_portal_user_id() THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'confirmed' THEN RAISE EXCEPTION 'This booking is not awaiting pickup.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO o FROM vehicle_trip_offers WHERE id = b.trip_offer_id FOR UPDATE;

  UPDATE vehicle_trip_bookings SET status = 'cancelled', cancelled_at = now(),
    cancelled_by_portal_user_id = current_portal_user_id(), cancellation_reason = 'Marked as a no-show by the driver.', cancellation_fee_pkr = b.total_amount_pkr
    WHERE id = p_trip_booking_id;

  IF b.pin IS NULL THEN
    UPDATE vehicle_trip_offers SET seats_available = o.seats_available + b.seats,
      status = CASE WHEN status = 'closed' AND travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date THEN 'open' ELSE status END
      WHERE id = o.id;
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'trip_booking_no_show', 'Marked as a no-show',
    'The driver marked you absent for ' || o.origin || ' → ' || o.destination || ' and closed the booking. The fare is non-refundable.',
    '/portal/marketplace/shared');
END;
$$;
GRANT EXECUTE ON FUNCTION mark_trip_booking_no_show(uuid) TO authenticated;
