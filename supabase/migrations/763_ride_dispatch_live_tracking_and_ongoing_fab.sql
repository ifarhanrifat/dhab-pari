-- Migration 763: real bugs found from an actual end-to-end device test,
-- 2026-10-28 — "as a rider... no driver anywhere in the village and
-- neither in chakwal city" and "as a driver... there is no green
-- button whatsoever that can tell me my vehicle is booked."
--
-- Root cause for both, confirmed directly against the real booking's
-- data: accept_ride_dispatch (746-761) creates its vehicle_trip_offers
-- row with status='closed' (correct — it's a direct 1:1 accept, not a
-- browsable multi-seat offer) and NEVER turns on share_live_location
-- at all. Two existing systems both silently assumed 'closed' means
-- "this trip is over, nothing to show" instead of "this trip is fully
-- booked, which may still be very much in progress":
--   1. my_ongoing_ride() (745) — the floating "ongoing ride" button's
--      own driver-side query only ever matched status='open'.
--   2. share_live_location was never true in the first place, so even
--      a fixed my_ongoing_ride() would route the driver to a trip with
--      nothing live on it.
--
-- Fix: accept_ride_dispatch now turns live sharing on for its own new
-- offer immediately (same "one van, one broadcast" dedup
-- set_trip_offer_live_sharing (414) already established — turn off any
-- other already-sharing offer for this same vehicle first), and
-- my_ongoing_ride()'s driver-side match now also catches a closed
-- offer that still has a confirmed, not-yet-completed booking — which
-- is exactly what a ride-dispatch acceptance always is.

CREATE OR REPLACE FUNCTION accept_ride_dispatch(p_request_id uuid) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  r ride_dispatch_requests%ROWTYPE; v vehicles%ROWTYPE; v_cat vehicle_categories%ROWTYPE;
  v_initiator_tenant_id uuid;
  v_in_city boolean; v_village_lat decimal; v_village_lng decimal; v_village_detour decimal; v_fare decimal; v_tier varchar;
  v_reference_village_fare decimal;
  v_trip_offer_id uuid; v_fare_offer_id uuid;
BEGIN
  SELECT * INTO r FROM ride_dispatch_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  IF r.status != 'open' THEN RAISE EXCEPTION 'Someone else already accepted this ride.' USING ERRCODE = 'P0001'; END IF;

  SELECT tenant_id INTO v_initiator_tenant_id FROM portal_users WHERE id = r.initiator_portal_user_id;

  SELECT v2.* INTO v FROM vehicles v2
  WHERE v2.portal_user_id = v_portal_user_id AND v2.is_active
    AND (NOT r.is_out_of_city OR v2.allows_out_of_city)
    AND (
      (v2.category_id = ANY(r.category_ids) AND (NOT r.is_out_of_city OR EXISTS (SELECT 1 FROM vehicle_categories WHERE id = v2.category_id AND out_of_city_eligible)))
      OR EXISTS (
        SELECT 1 FROM vehicle_categories vc_mine, vehicle_categories vc_req
        WHERE vc_mine.id = v2.category_id AND vc_req.id = r.category_id AND vc_mine.key = vc_req.key
          AND (NOT r.is_out_of_city OR vc_mine.out_of_city_eligible)
          AND EXISTS (
            SELECT 1 FROM marketplace_share_agreements sa
            WHERE sa.owner_tenant_id = v2.tenant_id AND sa.target_tenant_id = v_initiator_tenant_id
              AND sa.category = 'ride_dispatch' AND sa.is_active
          )
      )
    )
  ORDER BY (v2.category_id = ANY(r.category_ids)) DESC
  LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'This ride is not for your vehicle category.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_cat FROM vehicle_categories WHERE id = v.category_id;

  v_in_city := v.is_online AND v.current_lat IS NOT NULL
    AND v.current_location_updated_at > now() - interval '30 minutes'
    AND haversine_km(v.current_lat, v.current_lng, r.pickup_lat, r.pickup_lng) <= 6;

  SELECT center_lat, center_lng INTO v_village_lat, v_village_lng
  FROM tenant_service_zones WHERE tenant_id = v.tenant_id AND zone_kind = 'village' AND is_active LIMIT 1;
  IF v_village_lat IS NULL THEN
    SELECT lat, lng INTO v_village_lat, v_village_lng FROM cities WHERE is_home_city LIMIT 1;
  END IF;
  v_village_detour := CASE WHEN v_village_lat IS NOT NULL
    THEN round(v_cat.per_km_pkr * haversine_km(v_village_lat, v_village_lng, r.pickup_lat, r.pickup_lng) * 2)
    ELSE 0 END;
  v_reference_village_fare := round(v_cat.base_fare_pkr + v_cat.per_km_pkr * r.distance_km) + v_village_detour;

  IF v_in_city THEN
    v_fare := round(v_cat.base_fare_pkr + v_cat.per_km_pkr * r.distance_km);
    v_tier := CASE WHEN v.tenant_id = v_initiator_tenant_id THEN 'in_city' ELSE 'cross_tenant_in_city' END;
  ELSE
    v_fare := v_reference_village_fare;
    v_tier := CASE WHEN v.tenant_id = v_initiator_tenant_id THEN 'in_village' ELSE 'cross_tenant_in_village' END;
  END IF;

  -- Same dedup set_trip_offer_live_sharing (414) already uses: only one
  -- live-shared offer per vehicle at a time.
  UPDATE vehicle_trip_offers SET share_live_location = false WHERE vehicle_id = v.id AND share_live_location;
  DELETE FROM vehicle_trip_offer_locations WHERE trip_offer_id IN (SELECT id FROM vehicle_trip_offers WHERE vehicle_id = v.id);

  INSERT INTO vehicle_trip_offers (vehicle_id, origin, destination, classification, travel_date, seats_available, listed_fare_per_seat_pkr, trip_type, status, dest_lat, dest_lng, distance_km, share_live_location, live_location_started_at)
  VALUES (v.id, r.pickup_label, r.dropoff_label, 'intercity', (now() AT TIME ZONE 'Asia/Karachi')::date, 1, v_fare, 'oneway', 'closed', r.dropoff_lat, r.dropoff_lng, r.distance_km, true, now())
  RETURNING id INTO v_trip_offer_id;

  INSERT INTO vehicle_trip_fare_offers (trip_offer_id, portal_user_id, seats_requested, proposed_fare_per_seat_pkr, status, responded_at)
  VALUES (v_trip_offer_id, r.initiator_portal_user_id, 1, v_fare, 'accepted', now())
  RETURNING id INTO v_fare_offer_id;

  INSERT INTO vehicle_trip_bookings (trip_offer_id, fare_offer_id, vehicle_id, portal_user_id, seats, agreed_fare_per_seat_pkr, total_amount_pkr, leg)
  VALUES (v_trip_offer_id, v_fare_offer_id, v.id, r.initiator_portal_user_id, 1, v_fare, v_fare, 'oneway');

  UPDATE ride_dispatch_requests SET status = 'accepted', accepted_vehicle_id = v.id, trip_offer_id = v_trip_offer_id,
    accepted_at = now(), fare_pkr = v_fare, matched_tenant_id = v.tenant_id, tier_used = v_tier, reference_village_fare_pkr = v_reference_village_fare
  WHERE id = p_request_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (r.initiator_portal_user_id, 'ride_dispatch_accepted', 'A driver accepted your ride',
    v.owner_name || ' (' || v.vehicle_type || COALESCE(' · ' || v.vehicle_number, '') || ') is on the way — Rs ' || v_fare::text,
    '/portal/marketplace/ride-dispatch/' || p_request_id);

  RETURN v_trip_offer_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION my_ongoing_ride() RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_driver_trip record; v_rider_booking record;
BEGIN
  IF v_portal_user_id IS NULL THEN RETURN NULL; END IF;

  SELECT o.id AS trip_offer_id, o.origin, o.destination INTO v_driver_trip
  FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id
  WHERE v.portal_user_id = v_portal_user_id AND o.travel_date = v_today
    AND (
      o.status = 'open'
      -- A 'closed' offer is "fully booked", not "trip over" — a
      -- ride-dispatch acceptance is always closed+1-seat and very much
      -- still in progress until its own booking says otherwise.
      OR (o.status = 'closed' AND EXISTS (
        SELECT 1 FROM vehicle_trip_bookings bk WHERE bk.trip_offer_id = o.id AND bk.status = 'confirmed'
      ))
    )
  ORDER BY o.created_at DESC LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('role', 'driver', 'trip_offer_id', v_driver_trip.trip_offer_id,
      'label', v_driver_trip.origin || ' → ' || v_driver_trip.destination,
      'link', '/portal/my-vehicle/trips');
  END IF;

  SELECT b.id AS booking_id, o.origin, o.destination INTO v_rider_booking
  FROM vehicle_trip_bookings b JOIN vehicle_trip_offers o ON o.id = b.trip_offer_id
  WHERE b.portal_user_id = v_portal_user_id AND b.status = 'confirmed' AND o.travel_date = v_today
  ORDER BY b.created_at DESC LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('role', 'rider', 'booking_id', v_rider_booking.booking_id,
      'label', v_rider_booking.origin || ' → ' || v_rider_booking.destination,
      'link', '/portal/marketplace/trip/' || v_rider_booking.booking_id);
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
