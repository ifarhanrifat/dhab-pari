-- Migration 752: closing the loop the tiered cascade (751) left open —
-- a ride-dispatch request only ever reached a driver through the
-- notification's deep-link to a whole separate page, never through the
-- same auto-popping PendingRequestOverlay/JobQuickActionSheet every
-- other booking type already gets, and never counted in the driver
-- Jobs badge. Also: ride_dispatch_requests_read's RLS policy (746) was
-- written for the single category_id model and never updated for
-- 751's category_ids[] fan-out or cross-tenant acceptance — a vehicle
-- only eligible via one of those two paths couldn't SELECT the row at
-- all (accept_ride_dispatch itself still worked, being SECURITY
-- DEFINER, but nothing could list it as pending first).

DROP POLICY IF EXISTS "ride_dispatch_requests_read" ON ride_dispatch_requests;
CREATE POLICY "ride_dispatch_requests_read" ON ride_dispatch_requests FOR SELECT TO authenticated
  USING (
    initiator_portal_user_id = current_portal_user_id()
    OR (status = 'open' AND EXISTS (
      SELECT 1 FROM vehicles v WHERE v.portal_user_id = current_portal_user_id() AND v.is_active
        AND (
          v.category_id = ANY(ride_dispatch_requests.category_ids)
          OR EXISTS (
            SELECT 1 FROM vehicle_categories vc_mine, vehicle_categories vc_req
            WHERE vc_mine.id = v.category_id AND vc_req.id = ride_dispatch_requests.category_id AND vc_mine.key = vc_req.key
              AND EXISTS (
                SELECT 1 FROM marketplace_share_agreements sa, portal_users pu
                WHERE pu.id = ride_dispatch_requests.initiator_portal_user_id
                  AND sa.owner_tenant_id = v.tenant_id AND sa.target_tenant_id = pu.tenant_id
                  AND sa.category = 'ride_dispatch' AND sa.is_active
              )
          )
        )
    ))
    OR (accepted_vehicle_id IS NOT NULL AND EXISTS (SELECT 1 FROM vehicles v WHERE v.id = accepted_vehicle_id AND v.portal_user_id = current_portal_user_id()))
    OR COALESCE(current_admin_permission('manage_parties'), false)
  );

-- Same eligibility logic as the RLS policy and accept_ride_dispatch's
-- own lookup, as a read RPC — PendingRequestOverlay/the Jobs list need
-- "what can THIS vehicle accept right now," not a raw table read.
CREATE OR REPLACE FUNCTION my_pending_ride_dispatch_requests(p_vehicle_id uuid) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'pickup_label', r.pickup_label, 'dropoff_label', r.dropoff_label, 'fare_pkr', r.fare_pkr,
    'category_name', c.name, 'category_name_ur', c.name_ur, 'category_emoji', c.emoji, 'created_at', r.created_at
  ) ORDER BY r.created_at), '[]'::jsonb)
  FROM ride_dispatch_requests r
  JOIN vehicle_categories c ON c.id = r.category_id
  JOIN vehicles v ON v.id = p_vehicle_id
  WHERE r.status = 'open' AND v.portal_user_id = current_portal_user_id() AND v.is_active
    AND (
      v.category_id = ANY(r.category_ids)
      OR EXISTS (
        SELECT 1 FROM vehicle_categories vc_mine, vehicle_categories vc_req
        WHERE vc_mine.id = v.category_id AND vc_req.id = r.category_id AND vc_mine.key = vc_req.key
          AND EXISTS (
            SELECT 1 FROM marketplace_share_agreements sa, portal_users pu
            WHERE pu.id = r.initiator_portal_user_id
              AND sa.owner_tenant_id = v.tenant_id AND sa.target_tenant_id = pu.tenant_id
              AND sa.category = 'ride_dispatch' AND sa.is_active
          )
      )
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_pending_ride_dispatch_requests(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_pending_ride_dispatch_requests(uuid) TO authenticated;
