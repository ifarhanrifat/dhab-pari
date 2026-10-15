-- Migration 660: the rider-facing "Shared Ride" browse screen (design's
-- v.rShared: a city grid, then a seat-stepper + ride list for the picked
-- city) was routing to a completely unrelated old feature (the weekly
-- commute-matcher). Real backend for one-off shared trips already exists
-- (vehicle_trip_offers/vehicle_trip_fare_offers/vehicle_trip_bookings,
-- migration 400+) and already powers the driver's own "publish a ride"
-- panel — just never had a rider-side browse read. Two read RPCs, same
-- "one RPC builds the whole response" convention as nearby_open_trips.
--
-- Destinations are free text, not FK'd to a cities row (a driver can
-- type anything), so the "city" grouping key is a normalized lowercase
-- trim of the destination string — pragmatic given the real schema,
-- not a design artifact.

CREATE OR REPLACE FUNCTION open_trip_destinations() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(row_data ORDER BY (row_data->>'ride_count')::int DESC), '[]'::jsonb) FROM (
    SELECT jsonb_build_object(
      'city_key', lower(trim(destination)),
      'destination', (array_agg(destination ORDER BY created_at DESC))[1],
      'destination_ur', (array_agg(destination_ur ORDER BY created_at DESC))[1],
      'ride_count', count(*)
    ) AS row_data
    FROM vehicle_trip_offers
    WHERE status = 'open' AND seats_available > 0
      AND travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
    GROUP BY lower(trim(destination))
  ) x;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION open_trip_destinations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION open_trip_destinations() TO authenticated;

CREATE OR REPLACE FUNCTION browse_open_trip_offers(p_city_key text) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', o.id, 'vehicle_id', o.vehicle_id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
    'avg_rating', (SELECT round(avg(r.stars)::numeric, 1) FROM ratings r WHERE r.target_party_type = 'vehicle' AND r.target_party_id = v.id),
    'origin', o.origin, 'origin_ur', o.origin_ur, 'destination', o.destination, 'destination_ur', o.destination_ur,
    'classification', o.classification, 'travel_date', o.travel_date, 'departure_time_estimate', o.departure_time_estimate,
    'seats_available', o.seats_available, 'listed_fare_per_seat_pkr', o.listed_fare_per_seat_pkr
  ) ORDER BY o.travel_date ASC, o.departure_time_estimate ASC NULLS LAST), '[]'::jsonb)
  FROM vehicle_trip_offers o
  JOIN vehicles v ON v.id = o.vehicle_id
  WHERE o.status = 'open' AND o.seats_available > 0
    AND o.travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
    AND lower(trim(o.destination)) = lower(trim(p_city_key));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION browse_open_trip_offers(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION browse_open_trip_offers(text) TO authenticated;
