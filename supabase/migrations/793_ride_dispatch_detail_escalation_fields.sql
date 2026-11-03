-- Migration 793: real feedback, 2026-11-03, right after 792 shipped.
--
-- "the fare was Rs 4,949 and it was still remain 4949 even after 10
-- minutes past and there was no animated ping like radar which was
-- displaying before" — confirmed with the rider: it was an outstation
-- request, and they came back to check it later (not watching the
-- popup the whole time). Two real, separate problems:
--
-- 1. Outstation requests now step up every 15 minutes (792), not 4 —
--    on purpose, since fewer drivers can take a long trip. A flat fare
--    at the 10-minute mark is correct, not a bug. But nothing on
--    screen said that, so it read as broken.
-- 2. The radar-ping "searching" visual and the "fare may rise" wording
--    only ever got built into the popup sheet shown right when a
--    request is sent (RideRequestShell, 10-30). The separate full-page
--    screen reached from the notification link / a reopened app
--    (ride-dispatch/[requestId]) is an older screen that was never
--    brought up to that same design — exactly the "two disconnected
--    shells" gap already on file. That's the screen the rider landed
--    back on, and it never had a radar to begin with.
--
-- This migration only adds what the UI fix (next commit) needs to
-- compute "next possible increase in about N min" on BOTH screens:
-- is_out_of_city and escalation_count, so the step-timing math can run
-- client-side from data the page already fetches once per poll.
CREATE OR REPLACE FUNCTION ride_dispatch_request_detail(p_request_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'status', r.status, 'pickup_label', r.pickup_label, 'dropoff_label', r.dropoff_label,
    'pickup_lat', r.pickup_lat, 'pickup_lng', r.pickup_lng, 'dropoff_lat', r.dropoff_lat, 'dropoff_lng', r.dropoff_lng,
    'distance_km', r.distance_km, 'fare_pkr', r.fare_pkr, 'reference_village_fare_pkr', r.reference_village_fare_pkr, 'created_at', r.created_at,
    'category_name', c.name, 'category_name_ur', c.name_ur, 'category_emoji', c.emoji,
    'is_mine_as_rider', r.initiator_portal_user_id = current_portal_user_id(),
    'trip_offer_id', r.trip_offer_id, 'tier_used', r.tier_used, 'matched_tenant_name', mt.name,
    'rider_trust', portal_user_trust(r.initiator_portal_user_id), 'rider_tenant_name', rt.name,
    'scheduled_for', r.scheduled_for, 'activated_at', r.activated_at,
    'is_out_of_city', r.is_out_of_city, 'escalation_count', r.escalation_count
  )
  FROM ride_dispatch_requests r
  JOIN vehicle_categories c ON c.id = r.category_id
  JOIN portal_users ipu ON ipu.id = r.initiator_portal_user_id
  JOIN tenants rt ON rt.id = ipu.tenant_id
  LEFT JOIN tenants mt ON mt.id = r.matched_tenant_id
  WHERE r.id = p_request_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
