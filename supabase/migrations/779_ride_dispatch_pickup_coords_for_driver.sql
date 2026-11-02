-- Migration 779: show the rider's pickup location on the driver's
-- incoming ride-dispatch request card, 2026-11-02 ask — "the location
-- of the rider will be also shown on the request in a clear beautiful
-- stylish way." my_pending_ride_dispatch_requests (758) already hands
-- the driver pickup_label/dropoff_label as plain text; ride_dispatch_
-- requests itself already carries pickup_lat/pickup_lng (used by
-- accept_ride_dispatch's own fare math, 764) — just never surfaced to
-- this RPC's output. Reproduced from its real, current body (758) with
-- the two coordinate fields added to the jsonb object; every other
-- line, join and WHERE clause is untouched.

CREATE OR REPLACE FUNCTION my_pending_ride_dispatch_requests(p_vehicle_id uuid) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'pickup_label', r.pickup_label, 'dropoff_label', r.dropoff_label, 'fare_pkr', r.fare_pkr,
    'pickup_lat', r.pickup_lat, 'pickup_lng', r.pickup_lng,
    'category_name', c.name, 'category_name_ur', c.name_ur, 'category_emoji', c.emoji, 'created_at', r.created_at,
    'rider_trust', portal_user_trust(r.initiator_portal_user_id), 'rider_tenant_name', rt.name
  ) ORDER BY r.created_at), '[]'::jsonb)
  FROM ride_dispatch_requests r
  JOIN vehicle_categories c ON c.id = r.category_id
  JOIN vehicles v ON v.id = p_vehicle_id
  JOIN portal_users ipu ON ipu.id = r.initiator_portal_user_id
  JOIN tenants rt ON rt.id = ipu.tenant_id
  WHERE r.status = 'open' AND v.portal_user_id = current_portal_user_id() AND v.is_active
    AND (
      v.category_id = ANY(r.category_ids)
      OR EXISTS (
        SELECT 1 FROM vehicle_categories vc_mine, vehicle_categories vc_req
        WHERE vc_mine.id = v.category_id AND vc_req.id = r.category_id AND vc_mine.key = vc_req.key
          AND EXISTS (
            SELECT 1 FROM marketplace_share_agreements sa
            WHERE sa.owner_tenant_id = v.tenant_id AND sa.target_tenant_id = rt.id
              AND sa.category = 'ride_dispatch' AND sa.is_active
          )
      )
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_pending_ride_dispatch_requests(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_pending_ride_dispatch_requests(uuid) TO authenticated;
