-- Migration 698: Phase 1 of the vehicle-marketplace rebuild — a single
-- "where are you going?" search instead of 4 disconnected screens
-- (Adda board, Shared Ride city-grid, fixed Routes, Nearby). Real ask:
-- "if there is any adda vehical is going to the same destination then
-- the adda vehicals will be display under it... and if there is any
-- shared car going to that destination then the car will be display
-- and then there will be full booking cataogry."
--
-- Key discovery: adda_check_in() (migration 415) already spawns a real
-- vehicle_trip_offers row for EVERY queue entry, fixed-fare or
-- request-fare alike ("Both fare modes get a real trip offer now").
-- So an Adda-queued vehicle is already a normal, bookable trip offer —
-- no second matching system needed. This just tags which trip offers
-- came from an adda queue (still 'waiting'/'current', so still really
-- joinable) vs a freeform post, so the rider-facing screen can group
-- them exactly as asked without a second source of truth for seats/fare.

CREATE OR REPLACE FUNCTION public.browse_open_trip_offers(p_city_key text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', o.id, 'vehicle_id', o.vehicle_id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
    'avg_rating', (SELECT round(avg(r.stars)::numeric, 1) FROM ratings r WHERE r.target_party_type = 'vehicle' AND r.target_party_id = v.id),
    'origin', o.origin, 'origin_ur', o.origin_ur, 'destination', o.destination, 'destination_ur', o.destination_ur,
    'classification', o.classification, 'travel_date', o.travel_date, 'departure_time_estimate', o.departure_time_estimate,
    'seats_available', o.seats_available, 'listed_fare_per_seat_pkr', o.listed_fare_per_seat_pkr, 'trip_type', o.trip_type,
    'source', CASE WHEN aqe.id IS NOT NULL THEN 'adda' ELSE 'shared' END,
    'adda_name', a.name, 'adda_name_ur', a.name_ur, 'queue_position', aqe.position
  ) ORDER BY o.travel_date ASC, o.departure_time_estimate ASC NULLS LAST), '[]'::jsonb)
  FROM vehicle_trip_offers o
  JOIN vehicles v ON v.id = o.vehicle_id
  LEFT JOIN adda_queue_entries aqe ON aqe.trip_offer_id = o.id AND aqe.status IN ('waiting', 'current')
  LEFT JOIN addas a ON a.id = aqe.adda_id
  WHERE o.status = 'open' AND o.seats_available > 0
    AND o.travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
    AND lower(trim(o.destination)) = lower(trim(p_city_key));
$function$;
-- Grants unchanged from 693 (REVOKE ALL FROM PUBLIC, anon; GRANT TO authenticated) — CREATE OR REPLACE keeps them.

-- The fixed (weekly-commute) Routes screen's own query, lifted out of
-- results/page.tsx's page-local .from() call so the combined discovery
-- screen can run the exact same matching logic without duplicating it.
CREATE OR REPLACE FUNCTION public.routes_to_destination(p_city_name text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'origin', r.origin, 'origin_ur', r.origin_ur, 'destination', r.destination, 'destination_ur', r.destination_ur,
    'fare_per_seat_pkr', r.fare_per_seat_pkr, 'vehicle_id', r.vehicle_id, 'owner_name', v.owner_name
  )), '[]'::jsonb)
  FROM vehicle_routes r
  JOIN vehicles v ON v.id = r.vehicle_id
  WHERE r.is_active = true AND r.destination ILIKE '%' || p_city_name || '%';
$function$;
REVOKE ALL ON FUNCTION public.routes_to_destination(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.routes_to_destination(text) TO authenticated;
