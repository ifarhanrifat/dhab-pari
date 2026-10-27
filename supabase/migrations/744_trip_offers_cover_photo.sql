-- Real ask, 2026-10-27: "i want the ride sharing list must be look
-- beautifull" — browse_open_trip_offers (728's latest body) returns
-- zero visual material at all beyond plain text, even though every
-- vehicle already has a real cover photo (vehicle_media.is_cover, 388)
-- used elsewhere (my-vehicle/catalog). Surfacing it here is the one
-- real missing ingredient the redesigned card needs — everything else
-- is a front-end-only visual pass.

CREATE OR REPLACE FUNCTION browse_open_trip_offers(p_city_key text) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', o.id, 'vehicle_id', o.vehicle_id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
    'avg_rating', (SELECT round(avg(r.stars)::numeric, 1) FROM ratings r WHERE r.target_party_type = 'vehicle' AND r.target_party_id = v.id),
    'cover_photo_url', (SELECT m.url FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.is_cover LIMIT 1),
    'origin', o.origin, 'origin_ur', o.origin_ur, 'destination', o.destination, 'destination_ur', o.destination_ur,
    'classification', o.classification, 'travel_date', o.travel_date, 'departure_time_estimate', o.departure_time_estimate,
    'seats_available', o.seats_available, 'listed_fare_per_seat_pkr', o.listed_fare_per_seat_pkr, 'trip_type', o.trip_type,
    'source', CASE WHEN aqe.id IS NOT NULL THEN 'adda' ELSE 'shared' END,
    'adda_name', a.name, 'adda_name_ur', a.name_ur, 'queue_position', aqe.position,
    'outbound_open', o.status = 'open' AND o.seats_available > 0,
    'return_seats_available', CASE WHEN o.trip_type = 'return' THEN trip_return_seats_available(o.id) ELSE NULL END,
    'return_wait_minutes', o.return_wait_minutes, 'outbound_arrived_at', o.outbound_arrived_at
  ) ORDER BY o.travel_date ASC, o.departure_time_estimate ASC NULLS LAST), '[]'::jsonb)
  FROM vehicle_trip_offers o
  JOIN vehicles v ON v.id = o.vehicle_id
  LEFT JOIN adda_queue_entries aqe ON aqe.trip_offer_id = o.id AND aqe.status IN ('waiting', 'current')
  LEFT JOIN addas a ON a.id = aqe.adda_id
  WHERE ((o.status = 'open' AND o.seats_available > 0) OR (o.trip_type = 'return' AND trip_return_seats_available(o.id) > 0))
    AND o.travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
    AND lower(trim(o.destination)) = lower(trim(p_city_key));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION browse_open_trip_offers(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION browse_open_trip_offers(text) TO authenticated;
