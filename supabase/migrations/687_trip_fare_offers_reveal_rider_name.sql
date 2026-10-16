-- Migration 687: real bug caught live-testing the redesigned trips
-- page -- the driver's pending-fare-offer card showed "—" instead of
-- the rider's name. Root cause: trips/page.tsx reads
-- vehicle_trip_fare_offers with an embedded portal_users(full_name,
-- mobile) select, but portal_users RLS (portal_users_read_own) only
-- lets someone read their OWN row -- a driver has no visibility into
-- a stranger rider's row at all, so the embed silently came back
-- empty. Same shape as every other cross-identity read in this app:
-- a SECURITY DEFINER RPC that names exactly what it reveals, rather
-- than broadening portal_users RLS itself.

CREATE OR REPLACE FUNCTION public.my_vehicle_trip_fare_offers(p_vehicle_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', f.id, 'trip_offer_id', f.trip_offer_id, 'seats_requested', f.seats_requested,
    'proposed_fare_per_seat_pkr', f.proposed_fare_per_seat_pkr, 'counter_fare_per_seat_pkr', f.counter_fare_per_seat_pkr,
    'status', f.status, 'portal_user_id', f.portal_user_id,
    'rider_full_name', pu.full_name, 'rider_mobile', pu.mobile
  ) ORDER BY f.created_at DESC), '[]'::jsonb)
  FROM vehicle_trip_fare_offers f
  JOIN vehicle_trip_offers o ON o.id = f.trip_offer_id
  JOIN vehicles v ON v.id = o.vehicle_id
  JOIN portal_users pu ON pu.id = f.portal_user_id
  WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id()
    AND f.status IN ('pending', 'countered');
$function$;
