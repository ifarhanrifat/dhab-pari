-- Migration 790: real ask, 2026-11-03 — a village↔city ride should
-- only be charged one-way when the specific accepting driver already
-- has a natural reason to be going that way; everyone else (a driver
-- who has to make a dedicated special trip) pays for the round trip,
-- and at night it's always round-trip regardless of who accepts.
--
-- Research finding (confirmed directly, not guessed): accept_ride_dispatch
-- already computes almost exactly this distinction for an entirely
-- different reason — v_in_city (is the accepting vehicle's live GPS
-- within 6km of the pickup, confirmed fresh) combined with whether the
-- vehicle's own tenant matches the rider's home tenant already produces
-- the 4-way tier accept_ride_dispatch stores as tier_used:
--   in_city              — own-village driver, confirmed already nearby
--   in_village            — own-village driver, has to come specially
--   cross_tenant_in_city  — a different village's driver, happened to be nearby
--   cross_tenant_in_village — a different village's driver, has to come specially
-- "in_city" is exactly "a driver who belongs to the rider's own village
-- AND is already out and about near the pickup" — precisely the one
-- real exception described. Everything else is a dedicated trip.
--
-- This only matters for genuinely out-of-city trips (r.is_out_of_city)
-- — a plain in-village local ride was never two-way-priced and stays
-- untouched. The rider-facing QUOTE (ride_dispatch_quote/
-- ride_group_quote/create_ride_dispatch_request) still shows the
-- worst-case round-trip estimate, unchanged — which specific vehicle
-- ends up accepting (and therefore which tier applies) genuinely isn't
-- knowable until someone actually does; accept_ride_dispatch already
-- recomputes and updates the real fare at that point (same pattern
-- v_reference_village_fare vs the original quote already uses), so a
-- same-village driver who happens to be nearby can only ever bring the
-- price DOWN from what was quoted, never up.
CREATE OR REPLACE FUNCTION accept_ride_dispatch(p_request_id uuid) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  r ride_dispatch_requests%ROWTYPE; v vehicles%ROWTYPE; v_cat vehicle_categories%ROWTYPE;
  v_initiator_tenant_id uuid;
  v_in_city boolean; v_village_lat decimal; v_village_lng decimal; v_village_detour decimal; v_fare decimal; v_tier varchar;
  v_reference_village_fare decimal; v_trip_multiplier decimal; v_is_night boolean; v_karachi_hour int;
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

  IF v_in_city THEN
    v_tier := CASE WHEN v.tenant_id = v_initiator_tenant_id THEN 'in_city' ELSE 'cross_tenant_in_city' END;
  ELSE
    v_tier := CASE WHEN v.tenant_id = v_initiator_tenant_id THEN 'in_village' ELSE 'cross_tenant_in_village' END;
  END IF;

  -- Night: 5pm to 6am, Asia/Karachi — real ask, "for the nights after
  -- 5pm then all kinds of rides between cities to village and village
  -- to cities will be two way." Always two-way after dark, no matter
  -- how convenient the accepting driver's own route happens to be —
  -- far less chance of them finding a real return fare once it's dark.
  v_karachi_hour := extract(hour FROM now() AT TIME ZONE 'Asia/Karachi')::int;
  v_is_night := v_karachi_hour >= 17 OR v_karachi_hour < 6;

  -- Only an own-village driver already confirmed nearby, in daylight
  -- hours, gets the one-way rate — they're plainly already out on
  -- their normal route, not making a special trip for this fare.
  v_trip_multiplier := CASE WHEN r.is_out_of_city AND NOT (v_tier = 'in_city' AND NOT v_is_night) THEN 2 ELSE 1 END;

  v_reference_village_fare := round(v_cat.base_fare_pkr + v_cat.per_km_pkr * r.distance_km * v_trip_multiplier) + v_village_detour;

  IF v_in_city THEN
    v_fare := round(v_cat.base_fare_pkr + v_cat.per_km_pkr * r.distance_km * v_trip_multiplier);
  ELSE
    v_fare := v_reference_village_fare;
  END IF;

  -- The request may have escalated (789) while this driver had it
  -- open — charge whatever the rider was actually shown at the moment
  -- of acceptance, never silently less.
  v_fare := GREATEST(v_fare, r.fare_pkr);

  UPDATE vehicle_trip_offers SET share_live_location = false WHERE vehicle_id = v.id AND share_live_location;
  DELETE FROM vehicle_trip_offer_locations WHERE trip_offer_id IN (SELECT id FROM vehicle_trip_offers WHERE vehicle_id = v.id);

  INSERT INTO vehicle_trip_offers (vehicle_id, origin, destination, classification, travel_date, seats_available, listed_fare_per_seat_pkr, trip_type, status, dest_lat, dest_lng, distance_km, share_live_location, live_location_started_at)
  VALUES (v.id, r.pickup_label, r.dropoff_label, 'intercity', (now() AT TIME ZONE 'Asia/Karachi')::date, 1, v_fare, 'oneway', 'closed', r.dropoff_lat, r.dropoff_lng, r.distance_km, true, now())
  RETURNING id INTO v_trip_offer_id;

  INSERT INTO vehicle_trip_fare_offers (trip_offer_id, portal_user_id, seats_requested, proposed_fare_per_seat_pkr, status, responded_at)
  VALUES (v_trip_offer_id, r.initiator_portal_user_id, 1, v_fare, 'accepted', now())
  RETURNING id INTO v_fare_offer_id;

  INSERT INTO vehicle_trip_bookings (trip_offer_id, fare_offer_id, vehicle_id, portal_user_id, seats, agreed_fare_per_seat_pkr, total_amount_pkr, leg, pin)
  VALUES (v_trip_offer_id, v_fare_offer_id, v.id, r.initiator_portal_user_id, 1, v_fare, v_fare, 'oneway', lpad(floor(random() * 10000)::text, 4, '0'));

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
