-- Migration 767: real gap found live, 2026-10-29 — "when ride is
-- completed from both end there was no feture appear to give 5 start 4
-- start award to the driver, this thing we have created long ago but
-- you failed to find what we have built." Correct: submit_rating (650)
-- already covers ref_type='trip_booking', vehicle_trust (497) already
-- counts vehicle_trip_bookings completions and ratings into the trust
-- score, and <RateAndReport> (the shared star-picker + report-problem
-- widget) is already used on city-purchase/dispatch/rental/shadi/
-- hourly/equipment detail pages — it was simply never wired into the
-- ride-dispatch popup, and trip_booking_lifecycle_detail doesn't
-- return the two ids RateAndReport needs to resolve "the other party"
-- (vehicle_id for a rider rating the driver, the rider's own
-- portal_user_id for a driver rating the rider).

CREATE OR REPLACE FUNCTION trip_booking_lifecycle_detail(p_trip_booking_id uuid) RETURNS jsonb AS $$
DECLARE
  b vehicle_trip_bookings%ROWTYPE; o vehicle_trip_offers%ROWTYPE; v vehicles%ROWTYPE;
  v_portal_user_id uuid := current_portal_user_id();
  v_role varchar; v_pickup_lat decimal; v_pickup_lng decimal; v_pickup_label text;
BEGIN
  SELECT * INTO b FROM vehicle_trip_bookings WHERE id = p_trip_booking_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO o FROM vehicle_trip_offers WHERE id = b.trip_offer_id;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;

  IF b.portal_user_id = v_portal_user_id THEN v_role := 'rider';
  ELSIF v.portal_user_id = v_portal_user_id THEN v_role := 'driver';
  ELSE RETURN NULL;
  END IF;

  SELECT pickup_lat, pickup_lng, pickup_label INTO v_pickup_lat, v_pickup_lng, v_pickup_label
  FROM ride_dispatch_requests WHERE trip_offer_id = b.trip_offer_id;

  RETURN jsonb_build_object(
    'booking_id', b.id, 'role', v_role, 'status', b.status, 'trip_offer_id', b.trip_offer_id,
    'origin', o.origin, 'origin_ur', o.origin_ur, 'destination', o.destination, 'destination_ur', o.destination_ur,
    'pickup_lat', v_pickup_lat, 'pickup_lng', v_pickup_lng, 'pickup_label', v_pickup_label,
    'dest_lat', o.dest_lat, 'dest_lng', o.dest_lng,
    'pin', CASE WHEN v_role = 'rider' THEN b.pin ELSE NULL END,
    'vehicle_id', b.vehicle_id, 'rider_portal_user_id', b.portal_user_id
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
