-- Migration 826: real bug found during the 2026-11-07 deep audit —
-- "there are still rides appearing even a rider booked for one day and
-- its now expired but appearing somewhere in the rider and driver end."
-- run_stale_booking_sweep (711) already auto-expires a stale
-- rental/hourly/equipment/shadi/city-purchase/parcel request after N
-- days of no response — ride_bookings (Routes + Adda seats) was simply
-- never added to it, so an 'announced' seat the driver never confirmed
-- or rejected just sat there forever once its travel_date passed,
-- cluttering both the rider's own list and the driver's confirmation
-- queue indefinitely. Expiry here is keyed to the booking's own
-- travel_date (not a fixed day-count like the others), since that's the
-- date the ride was actually for — once it's passed with no response,
-- it is unambiguously stale regardless of how old the booking itself is.
-- A 'confirmed' booking is deliberately left untouched here — the
-- driver already committed to it, so a day passing without the route
-- ever running is a real no-show situation a rider should still be able
-- to see and act on, not something that should silently vanish.

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

  -- New: a Route/Adda seat booking the driver never confirmed OR
  -- rejected before its own travel_date passed. Keyed to travel_date,
  -- not booking age, unlike every loop above.
  FOR r IN SELECT id, portal_user_id, route_id FROM ride_bookings
    WHERE status = 'announced' AND travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date
  LOOP
    UPDATE ride_bookings SET status = 'cancelled', rejected_reason = 'Expired — the driver never responded before the travel date passed.' WHERE id = r.id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.portal_user_id, 'ride_booking_expired', 'Booking expired',
      'Your seat booking''s travel date passed without the driver responding, so it was automatically cancelled.',
      CASE WHEN r.route_id IS NOT NULL THEN '/portal/marketplace/route/' || r.route_id ELSE '/portal/marketplace' END);
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION run_stale_booking_sweep() FROM PUBLIC, anon;
