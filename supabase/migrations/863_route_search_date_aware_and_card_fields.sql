-- Migration 863: Phase 2 slice of the booking-system overhaul plan —
-- real ask: "select the date then the all busses will be appear under
-- that with there seat avaialblity details etc in the beautifull card
-- base styles." Checked directly: routes_to_destination (698) — the
-- weekly-route half of the unified destination search results/page.tsx
-- uses — only ever returned id/origin/destination/fare_per_seat_pkr/
-- vehicle_id/owner_name. A rider has never been able to see a weekly
-- route's departure time, bus type, or seat availability from the
-- results card, only after tapping through to the full detail page.
-- Confirmed live: the frontend's own RouteRow interface matches this
-- exact thin shape, so this was never a frontend-only display bug.
--
-- browse_open_trip_offers (698) already has a real travel_date per row
-- (trip offers are one-off), so it's untouched here — only given a
-- date filter so the two sources behave the same way from the rider's
-- side. routes_to_destination gains the fields a real card needs,
-- date-aware (only show routes that actually run on the picked day),
-- with today's seat availability via the existing route_seats_
-- available() (822/851/855) — no seat-counting logic duplicated here.

-- Both functions gain a parameter — CREATE OR REPLACE alone would
-- create a second overload alongside the old 1-arg signature (the
-- exact overload-ambiguity bug already hit and fixed once this session,
-- migration 849) rather than truly replacing it. Drop the old
-- signatures explicitly first.
DROP FUNCTION IF EXISTS public.routes_to_destination(text);
DROP FUNCTION IF EXISTS public.browse_open_trip_offers(text);

CREATE OR REPLACE FUNCTION public.routes_to_destination(p_city_name text, p_travel_date date DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_date date := COALESCE(p_travel_date, (now() AT TIME ZONE 'Asia/Karachi')::date); v_dow int;
BEGIN
  v_dow := extract(dow FROM v_date)::int;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', r.id, 'origin', r.origin, 'origin_ur', r.origin_ur, 'destination', r.destination, 'destination_ur', r.destination_ur,
      'fare_per_seat_pkr', r.fare_per_seat_pkr, 'vehicle_id', r.vehicle_id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type,
      'departure_time', r.departure_time, 'return_departure_time', r.return_departure_time, 'is_two_way', r.is_two_way,
      'classification', r.classification, 'is_monthly_fixed', r.is_monthly_fixed, 'is_sleeper', v.is_sleeper,
      'total_seats', coalesce(r.seat_override, v.total_seats),
      'seats_available', route_seats_available(r.id, v_date)
    ) ORDER BY r.departure_time ASC NULLS LAST), '[]'::jsonb)
    FROM vehicle_routes r
    JOIN vehicles v ON v.id = r.vehicle_id
    WHERE r.is_active = true AND r.destination ILIKE '%' || p_city_name || '%'
      AND v_dow = ANY(r.days_of_week)
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.routes_to_destination(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.routes_to_destination(text, date) TO authenticated;

-- Same date-awareness for the one-off trip-offer side (698) — a rider
-- picking "day after tomorrow" should only see trips actually running
-- that day, not every upcoming date mixed together.
CREATE OR REPLACE FUNCTION public.browse_open_trip_offers(p_city_key text, p_travel_date date DEFAULT NULL)
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
    AND o.travel_date = COALESCE(p_travel_date, o.travel_date)
    AND o.travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
    AND lower(trim(o.destination)) = lower(trim(p_city_key));
$function$;
REVOKE ALL ON FUNCTION public.browse_open_trip_offers(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.browse_open_trip_offers(text, date) TO authenticated;
