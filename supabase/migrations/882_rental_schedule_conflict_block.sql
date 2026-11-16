-- Migration 882: real gap confirmed directly against code — a vehicle's
-- scheduled route and its hourly/point-to-point rental bookings have
-- never known about each other at all. start_hourly_trip/start_rental_
-- trip already refuse to double-book against ANOTHER hourly/rental trip
-- in progress (477/653), but neither ever checked route_runs, and
-- start_route_run never checked hourly_bookings/rental_bookings either
-- — a vehicle could be mid-charter and still start its scheduled route
-- (or vice versa), which is a physical impossibility, same class of bug
-- 477 already fixed once for hourly-vs-hourly.
--
-- Deliberately scoped to hourly_bookings + rental_bookings only, not
-- shadi — shadi's commitment model is a future event_date on
-- shadi_events, not a live "driving right now" in_progress state the
-- way the other two are, and would need a date-range overlap check,
-- not this live-state check. shadi vehicle-swapping was also already
-- explicitly decided against earlier this session (renters pick a
-- category/model, not one specific unit) — out of scope here too.

-- start_route_run — same signature as 879's live version, true replace.
CREATE OR REPLACE FUNCTION start_route_run(p_route_id uuid, p_direction varchar DEFAULT 'outbound') RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE; v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only start your own route.' USING ERRCODE = 'P0001'; END IF;
  IF p_direction NOT IN ('outbound', 'return') THEN RAISE EXCEPTION 'Invalid direction.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM route_runs WHERE route_id = p_route_id AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'This route already has an active run — end it before starting another.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  IF EXISTS (SELECT 1 FROM hourly_bookings WHERE vehicle_id = v_vehicle.id AND status = 'in_progress') THEN
    RAISE EXCEPTION 'This vehicle is currently out on an hourly rental — finish that trip before starting a scheduled run.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM rental_bookings WHERE vehicle_id = v_vehicle.id AND status = 'in_progress') THEN
    RAISE EXCEPTION 'This vehicle is currently out on a rental trip — finish that trip before starting a scheduled run.' USING ERRCODE = 'P0001';
  END IF;

  PERFORM charge_vehicle_ride_stake(v_route.vehicle_id, 'Route run started (' ||
    (CASE WHEN p_direction = 'return' THEN v_route.destination || ' → ' || v_route.origin ELSE v_route.origin || ' → ' || v_route.destination END) || ')');

  INSERT INTO route_runs (route_id, direction) VALUES (p_route_id, p_direction) RETURNING id INTO v_id;

  IF v_vehicle.portal_user_id IS NOT NULL THEN
    INSERT INTO route_run_driver_shifts (route_run_id, driver_portal_user_id) VALUES (v_id, v_vehicle.portal_user_id);
  END IF;

  INSERT INTO route_participants (route_id, portal_user_id, is_active, sharing_location)
  VALUES (p_route_id, v_portal_user_id, true, true)
  ON CONFLICT (route_id, portal_user_id) DO UPDATE SET sharing_location = true, is_active = true;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT rp.portal_user_id, 'route_run_started', 'The van is on its way',
    (CASE WHEN p_direction = 'return' THEN v_route.destination || ' → ' || v_route.origin ELSE v_route.origin || ' → ' || v_route.destination END) || ' — live arrival times are now showing.',
    '/portal/marketplace/route/' || p_route_id
  FROM route_participants rp WHERE rp.route_id = p_route_id AND rp.is_active = true;

  RETURN v_id;
END;
$$;

-- respond_hourly_booking — same signature as 787's live version (812
-- already dropped the stale 3-arg overload; nothing to drop here).
CREATE OR REPLACE FUNCTION respond_hourly_booking(p_booking_id uuid, p_accept boolean) RETURNS void AS $$
DECLARE b hourly_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;

  IF b.vehicle_id IS NULL THEN
    IF NOT p_accept THEN RAISE EXCEPTION 'This request is open to every matching driver — there is nothing to decline, just leave it to someone else.' USING ERRCODE = 'P0001'; END IF;
    IF b.status <> 'requested' THEN RAISE EXCEPTION 'Someone else already accepted this request.' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO v FROM vehicles WHERE portal_user_id = current_portal_user_id() AND rental_tier = b.rental_tier AND is_active AND offers_hourly;
    IF NOT FOUND THEN RAISE EXCEPTION 'This request is not for your vehicle category.' USING ERRCODE = 'P0001'; END IF;
    IF EXISTS (SELECT 1 FROM route_runs rr JOIN vehicle_routes vr ON vr.id = rr.route_id WHERE vr.vehicle_id = v.id AND rr.ended_at IS NULL) THEN
      RAISE EXCEPTION 'Your vehicle is currently out on its scheduled route — accept once it finishes.' USING ERRCODE = 'P0001';
    END IF;

    UPDATE hourly_bookings SET vehicle_id = v.id, status = 'accepted', responded_at = now(), pin = lpad(floor(random() * 10000)::text, 4, '0')
    WHERE id = p_booking_id AND vehicle_id IS NULL AND status = 'requested';
    IF NOT FOUND THEN RAISE EXCEPTION 'Someone else already accepted this request.' USING ERRCODE = 'P0001'; END IF;

    PERFORM ensure_booking_thread('hourly_booking', p_booking_id, v.id, b.portal_user_id, trim(coalesce(v.model, v.vehicle_type)) || ' — ' || b.hours || 'h');
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (b.portal_user_id, 'hourly_booking_accepted', 'Booking accepted', v.owner_name || ' will pick you up.', '/portal/marketplace');
    RETURN;
  END IF;

  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'requested' THEN RAISE EXCEPTION 'This booking has already been responded to.' USING ERRCODE = 'P0001'; END IF;

  UPDATE hourly_bookings SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END, responded_at = now() WHERE id = p_booking_id;
  IF NOT p_accept THEN PERFORM close_booking_thread('hourly_booking', p_booking_id, 'declined'); END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, CASE WHEN p_accept THEN 'hourly_booking_accepted' ELSE 'hourly_booking_declined' END,
    CASE WHEN p_accept THEN 'Booking accepted' ELSE 'Booking declined' END,
    CASE WHEN p_accept THEN v.owner_name || ' will pick you up.' ELSE 'This vehicle is not available for your booking.' END,
    '/portal/marketplace');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- start_hourly_trip — same signature as 477's live version, widened
-- with the route_runs + rental_bookings check alongside its existing
-- other-hourly-booking check.
CREATE OR REPLACE FUNCTION start_hourly_trip(p_booking_id uuid) RETURNS void AS $$
DECLARE b hourly_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'accepted' THEN RAISE EXCEPTION 'This booking is not ready to start.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM hourly_bookings other WHERE other.vehicle_id = b.vehicle_id AND other.id <> b.id AND other.status = 'in_progress') THEN
    RAISE EXCEPTION 'This vehicle is already on another trip — end that one first.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM rental_bookings WHERE vehicle_id = b.vehicle_id AND status = 'in_progress') THEN
    RAISE EXCEPTION 'This vehicle is already on a rental trip — end that one first.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM route_runs rr JOIN vehicle_routes vr ON vr.id = rr.route_id WHERE vr.vehicle_id = b.vehicle_id AND rr.ended_at IS NULL) THEN
    RAISE EXCEPTION 'This vehicle is currently out on its scheduled route — end that run first.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE hourly_bookings SET status = 'in_progress', started_at = now(), distance_km = 0, last_lat = NULL, last_lng = NULL WHERE id = p_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- respond_rental_booking — same signature as 797's live version.
CREATE OR REPLACE FUNCTION respond_rental_booking(p_booking_id uuid, p_accept boolean, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE
  b rental_bookings%ROWTYPE; v vehicles%ROWTYPE; g rental_tier_fare_guides%ROWTYPE;
  v_offer_id uuid; v_home_lat decimal; v_home_lng decimal; v_return_per_km decimal;
BEGIN
  SELECT * INTO b FROM rental_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;

  IF b.vehicle_id IS NULL THEN
    IF NOT p_accept THEN RAISE EXCEPTION 'This request is open to every matching driver — there is nothing to decline, just leave it to someone else.' USING ERRCODE = 'P0001'; END IF;
    IF b.status <> 'requested' THEN RAISE EXCEPTION 'Someone else already accepted this request.' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO v FROM vehicles WHERE portal_user_id = current_portal_user_id() AND rental_tier = b.rental_tier AND is_active AND offers_rental;
    IF NOT FOUND THEN RAISE EXCEPTION 'This request is not for your vehicle category.' USING ERRCODE = 'P0001'; END IF;
    IF EXISTS (SELECT 1 FROM route_runs rr JOIN vehicle_routes vr ON vr.id = rr.route_id WHERE vr.vehicle_id = v.id AND rr.ended_at IS NULL) THEN
      RAISE EXCEPTION 'Your vehicle is currently out on its scheduled route — accept once it finishes.' USING ERRCODE = 'P0001';
    END IF;

    UPDATE rental_bookings SET vehicle_id = v.id, status = 'accepted', responded_at = now(), pin = lpad(floor(random() * 10000)::text, 4, '0')
    WHERE id = p_booking_id AND vehicle_id IS NULL AND status = 'requested';
    IF NOT FOUND THEN RAISE EXCEPTION 'Someone else already accepted this request.' USING ERRCODE = 'P0001'; END IF;

    PERFORM ensure_booking_thread('rental_booking', p_booking_id, v.id, b.portal_user_id, trim(coalesce(v.model, v.vehicle_type)) || ' — ' || b.to_address);
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (b.portal_user_id, 'rental_booking_accepted', 'Booking accepted', v.owner_name || ' will pick you up.', '/portal/marketplace');

    IF b.trip_type = 'one' AND b.is_out_of_city THEN
      SELECT * INTO g FROM rental_tier_fare_guides WHERE tier_key = b.rental_tier AND tenant_id = v.tenant_id;
      v_return_per_km := COALESCE(g.out_of_city_per_km_pkr, g.rental_per_km_pkr, 0);
      INSERT INTO rental_return_offers (
        source_booking_id, vehicle_id, tenant_id, rental_tier, from_address, from_lat, from_lng,
        to_address, to_lat, to_lng, km, per_seat_fare_pkr, total_seats, expected_arrival_at
      ) VALUES (
        b.id, v.id, v.tenant_id, b.rental_tier, b.to_address, b.to_lat, b.to_lng,
        b.from_address, b.from_lat, b.from_lng, b.km, round(v_return_per_km * b.km),
        rental_tier_seat_capacity(b.rental_tier), now() + (b.km / 45.0) * interval '1 hour'
      ) RETURNING id INTO v_offer_id;

      SELECT lat, lng INTO v_home_lat, v_home_lng FROM cities WHERE tenant_id = v.tenant_id AND is_home_city LIMIT 1;
      IF v_home_lat IS NOT NULL THEN
        INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
        SELECT DISTINCT r.initiator_portal_user_id, 'rental_return_offer_available',
          '🔄 A vehicle is heading your way', 'A ' || b.rental_tier || ' will reach ' || b.to_address || ' around ' ||
          to_char(now() + (b.km / 45.0) * interval '1 hour', 'HH12:MI AM') || ' — book a discounted ride back.',
          '/portal/marketplace/travel?goHomeOffer=' || v_offer_id
        FROM ride_dispatch_requests r
        WHERE r.status = 'open' AND r.is_out_of_city
          AND haversine_km(r.pickup_lat, r.pickup_lng, b.to_lat, b.to_lng) < 15
          AND haversine_km(r.dropoff_lat, r.dropoff_lng, v_home_lat, v_home_lng) < 15
        LIMIT 20;
      END IF;
    END IF;
    RETURN;
  END IF;

  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'requested' THEN RAISE EXCEPTION 'This booking has already been responded to.' USING ERRCODE = 'P0001'; END IF;

  UPDATE rental_bookings SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END,
    responded_at = now(), decline_reason = CASE WHEN p_accept THEN NULL ELSE p_reason END
  WHERE id = p_booking_id;
  IF NOT p_accept THEN PERFORM close_booking_thread('rental_booking', p_booking_id, 'declined'); END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, CASE WHEN p_accept THEN 'rental_booking_accepted' ELSE 'rental_booking_declined' END,
    CASE WHEN p_accept THEN 'Booking accepted' ELSE 'Booking declined' END,
    CASE WHEN p_accept THEN v.owner_name || ' will pick you up.'
      ELSE 'This vehicle is not available for your booking.' || COALESCE(' — ' || p_reason, '') END,
    '/portal/marketplace');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- start_rental_trip — same signature as 653's live version, widened
-- with the route_runs + hourly_bookings check alongside its existing
-- other-rental-booking check.
CREATE OR REPLACE FUNCTION start_rental_trip(p_booking_id uuid, p_pin varchar) RETURNS void AS $$
DECLARE b rental_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM rental_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'accepted' THEN RAISE EXCEPTION 'This booking is not ready to start.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM rental_bookings other WHERE other.vehicle_id = b.vehicle_id AND other.id <> b.id AND other.status = 'in_progress') THEN
    RAISE EXCEPTION 'This vehicle is already on another trip — end that one first.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM hourly_bookings WHERE vehicle_id = b.vehicle_id AND status = 'in_progress') THEN
    RAISE EXCEPTION 'This vehicle is already on an hourly trip — end that one first.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM route_runs rr JOIN vehicle_routes vr ON vr.id = rr.route_id WHERE vr.vehicle_id = b.vehicle_id AND rr.ended_at IS NULL) THEN
    RAISE EXCEPTION 'This vehicle is currently out on its scheduled route — end that run first.' USING ERRCODE = 'P0001';
  END IF;
  IF trim(COALESCE(p_pin, '')) <> b.pin THEN
    RAISE EXCEPTION 'Incorrect PIN — ask the rider for the 4-digit code shown in their app.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE rental_bookings SET status = 'in_progress', started_at = now() WHERE id = p_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
