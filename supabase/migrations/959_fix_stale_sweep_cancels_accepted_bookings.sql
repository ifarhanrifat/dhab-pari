-- Critical bug found live, 2026-11-26, during a full rider-lifecycle
-- test of the floating booking button: accept_ride_booking_seat (831)
-- has never moved ride_bookings.status off 'announced' — the real
-- "driver confirmed" signal is seat_accepted_at, status stays
-- 'announced' all the way through boarding and drop-off (confirmed
-- live: a booking that was accepted, boarded AND dropped off at its
-- destination still read status='announced' afterwards).
--
-- run_stale_booking_sweep's ride_bookings loop (826, latest body 847)
-- only checks `status = 'announced' AND travel_date < today` — with
-- status never changing on acceptance, this nightly sweep cancels
-- EVERY completed trip's booking the morning after, overwriting it
-- with rejected_reason 'Expired — the driver never responded before
-- the travel date passed' and sending the rider a false "Booking
-- expired" notification, even though the driver responded and the
-- trip completed successfully. Reproduced live: backdated a real
-- accepted+boarded+dropped-off booking's travel_date, ran the sweep,
-- watched it flip to cancelled with that exact false message.
--
-- Fix: only ever auto-expire a booking the driver genuinely never
-- responded to. True-replace, copied verbatim from 847's body except
-- the one added condition on this single loop.
CREATE OR REPLACE FUNCTION run_stale_booking_sweep() RETURNS void AS $$
DECLARE v_days int; r record;
BEGIN
  SELECT COALESCE(value::int, 3) INTO v_days FROM site_settings WHERE key = 'stale_booking_expiry_days' LIMIT 1;

  FOR r IN SELECT id, portal_user_id FROM rental_bookings WHERE status IN ('requested', 'accepted') AND requested_at < now() - (v_days || ' days')::interval LOOP
    UPDATE rental_bookings SET status = 'cancelled' WHERE id = r.id;
    PERFORM close_booking_thread('rental_booking', r.id, 'cancelled');
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.portal_user_id, 'rental_booking_cancelled', 'Booking auto-cancelled', 'No driver responded in time, so this request was automatically cancelled.', '/portal/marketplace');
  END LOOP;

  FOR r IN SELECT id, portal_user_id FROM hourly_bookings WHERE status IN ('requested', 'accepted') AND requested_at < now() - (v_days || ' days')::interval LOOP
    UPDATE hourly_bookings SET status = 'cancelled' WHERE id = r.id;
    PERFORM close_booking_thread('hourly_booking', r.id, 'cancelled');
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.portal_user_id, 'hourly_booking_cancelled', 'Booking auto-cancelled', 'No driver responded in time, so this request was automatically cancelled.', '/portal/marketplace');
  END LOOP;

  FOR r IN SELECT id, portal_user_id FROM equipment_bookings WHERE status IN ('requested', 'accepted') AND requested_at < now() - (v_days || ' days')::interval LOOP
    UPDATE equipment_bookings SET status = 'cancelled' WHERE id = r.id;
    PERFORM close_booking_thread('equipment_booking', r.id, 'cancelled');
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.portal_user_id, 'equipment_booking_cancelled', 'Booking auto-cancelled', 'No owner responded in time, so this request was automatically cancelled.', '/portal/marketplace');
  END LOOP;

  FOR r IN SELECT id, portal_user_id FROM shadi_events WHERE status = 'collecting' AND created_at < now() - (v_days || ' days')::interval LOOP
    UPDATE shadi_vehicle_requests SET status = 'cancelled' WHERE event_id = r.id AND status IN ('requested', 'accepted');
    UPDATE shadi_events SET status = 'cancelled' WHERE id = r.id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.portal_user_id, 'shadi_event_cancelled', 'Wedding booking auto-cancelled', 'No driver responded in time, so this request was automatically cancelled.', '/portal/marketplace/shadi');
  END LOOP;

  FOR r IN SELECT id, initiator_portal_user_id FROM city_purchase_requests WHERE status IN ('ringing', 'no_answer') AND created_at < now() - (v_days || ' days')::interval LOOP
    UPDATE city_purchase_requests SET status = 'cancelled' WHERE id = r.id;
    UPDATE city_purchase_invitations SET status = 'expired', responded_at = now() WHERE request_id = r.id AND status = 'ringing';
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.initiator_portal_user_id, 'city_purchase_cancelled', 'Request auto-cancelled', 'No driver responded in time, so this request was automatically cancelled.', '/portal/marketplace/city-purchase');
  END LOOP;

  FOR r IN SELECT id, initiator_portal_user_id FROM parcel_deliveries WHERE status IN ('ringing', 'no_answer') AND created_at < now() - (v_days || ' days')::interval LOOP
    UPDATE parcel_deliveries SET status = 'cancelled' WHERE id = r.id;
    UPDATE parcel_delivery_invitations SET status = 'expired', responded_at = now() WHERE delivery_id = r.id AND status = 'ringing';
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.initiator_portal_user_id, 'parcel_delivery_cancelled', 'Request auto-cancelled', 'No driver responded in time, so this request was automatically cancelled.', '/portal/marketplace/parcel');
  END LOOP;

  -- 959: only a booking the driver never responded to at all — not one
  -- that was accepted (seat_accepted_at set), however long ago.
  FOR r IN SELECT id, portal_user_id, route_id FROM ride_bookings
    WHERE status = 'announced' AND seat_accepted_at IS NULL AND travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date
  LOOP
    UPDATE ride_bookings SET status = 'cancelled', rejected_reason = 'Expired — the driver never responded before the travel date passed.' WHERE id = r.id;
    DELETE FROM ride_booking_seat_numbers WHERE ride_booking_id = r.id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.portal_user_id, 'ride_booking_expired', 'Booking expired',
      'Your seat booking''s travel date passed without the driver responding, so it was automatically cancelled.',
      CASE WHEN r.route_id IS NOT NULL THEN '/portal/marketplace/route/' || r.route_id ELSE '/portal/marketplace' END);
  END LOOP;

  -- 847: one-off routes stop existing once their single date has run.
  UPDATE vehicle_routes SET is_active = false WHERE is_active AND one_off_date IS NOT NULL AND one_off_date < (now() AT TIME ZONE 'Asia/Karachi')::date;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION run_stale_booking_sweep() FROM PUBLIC, anon;
