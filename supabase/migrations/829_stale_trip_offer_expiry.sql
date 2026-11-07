-- Migration 829: real bug from a live screenshot, 2026-11-08 — the
-- driver's dashboard and "My Posted Trips" page were cluttered with
-- dozens of weeks-old Trip Offers (vehicle_trip_offers), almost all
-- still sitting at status='open' long after their own travel_date had
-- passed, because nothing ever auto-closed one the way 826 just did for
-- ride_bookings. Same fix, same table this sweep already lives in —
-- reproduces run_stale_booking_sweep's current body (826) verbatim with
-- one new loop added. Only the OPEN LISTING itself is closed; any real
-- bookings already placed under it (vehicle_trip_bookings) have their
-- own separate status lifecycle and are completely untouched here.

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

  FOR r IN SELECT id, portal_user_id, route_id FROM ride_bookings
    WHERE status = 'announced' AND travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date
  LOOP
    UPDATE ride_bookings SET status = 'cancelled', rejected_reason = 'Expired — the driver never responded before the travel date passed.' WHERE id = r.id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.portal_user_id, 'ride_booking_expired', 'Booking expired',
      'Your seat booking''s travel date passed without the driver responding, so it was automatically cancelled.',
      CASE WHEN r.route_id IS NOT NULL THEN '/portal/marketplace/route/' || r.route_id ELSE '/portal/marketplace' END);
  END LOOP;

  -- New: a Trip Offer (one-off "Shared Ride" posting) left open long
  -- after its own travel_date passed. Closing it only stops it from
  -- still counting as "open" (cluttering the driver's own list, and
  -- blocking a new post via place_trip_offer's "already have an open
  -- trip" guard) — any booking already placed under it keeps its own
  -- independent status untouched.
  UPDATE vehicle_trip_offers SET status = 'closed'
    WHERE status = 'open' AND travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION run_stale_booking_sweep() FROM PUBLIC, anon;
