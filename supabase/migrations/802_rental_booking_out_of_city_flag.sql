-- Migration 802: real ask, 2026-11-04 — on the rider's finish/rating
-- screen for a one-way out-of-city rental, show a "want to go back
-- home?" link into Travel's existing Go Home flow. my_rental_bookings
-- (787) never returned is_out_of_city (797) at all, so the UI has no
-- way to know which completed bookings actually stranded the rider
-- somewhere else.

CREATE OR REPLACE FUNCTION my_rental_bookings() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'from_address', b.from_address, 'from_lat', b.from_lat, 'from_lng', b.from_lng,
    'to_address', b.to_address, 'to_lat', b.to_lat, 'to_lng', b.to_lng, 'trip_type', b.trip_type, 'wait_hours', b.wait_hours,
    'km', b.km, 'status', b.status, 'decline_reason', b.decline_reason, 'pin', b.pin, 'is_out_of_city', b.is_out_of_city,
    'base_amount_pkr', b.base_amount_pkr, 'trip_amount_pkr', b.trip_amount_pkr, 'wait_amount_pkr', b.wait_amount_pkr, 'total_amount_pkr', b.total_amount_pkr,
    'notes', b.notes, 'payment_method', b.payment_method, 'rental_tier', b.rental_tier,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'vehicle_id', b.vehicle_id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color,
    'category_name', vc.name, 'category_name_ur', vc.name_ur
  ) ORDER BY b.requested_at DESC), '[]'::jsonb)
  FROM rental_bookings b LEFT JOIN vehicles v ON v.id = b.vehicle_id LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
  WHERE b.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_rental_bookings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_rental_bookings() TO authenticated;

-- Same gap on the ride-dispatch/Travel side: trip_booking_lifecycle_
-- detail (769) never surfaced ride_dispatch_requests.is_out_of_city
-- (760) either, and that's the one screen that already shows the
-- rider's own rating widget on a completed trip.
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
    'vehicle_id', b.vehicle_id, 'rider_portal_user_id', b.portal_user_id,
    'total_amount_pkr', b.total_amount_pkr, 'is_out_of_city', COALESCE(v_is_out_of_city, false)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
