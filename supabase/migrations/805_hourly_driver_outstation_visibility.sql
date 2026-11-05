-- Migration 805: real question, 2026-11-05 — "how will the driver
-- know this is outstation?" Checking vehicle_hourly_bookings (the
-- driver's own job-list/accept RPC, last touched in 787) found it
-- never returned hourly_rate_pkr, overage_per_km_pkr, destination_lat
-- or destination_lng at all — only destination_address and
-- is_outstation, which the driver's screen (BookingLifecycleSheet)
-- doesn't even read. Two real consequences:
-- 1. A driver deciding whether to accept a job has no visibility into
--    its destination or outstation status at all.
-- 2. HourlyMeter, the live running-total the driver sees once a trip
--    starts, has been rendering Number(undefined ?? 0) for its overage
--    rate this whole time — it has always shown Rs 0 extra per km,
--    regardless of the real rate. The final bill end_hourly_trip
--    computes at trip-end reads the correct column straight off the
--    row and was never wrong — only the driver's live in-trip preview
--    was silently blank.
-- Fix: surface the missing fields; the frontend change (next commit)
-- is what actually puts them on screen.

CREATE OR REPLACE FUNCTION vehicle_hourly_bookings(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_result jsonb; v_tier varchar; v_year int; v_tenant uuid;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT rental_tier, model_year, tenant_id INTO v_tier, v_year, v_tenant FROM vehicles WHERE id = p_vehicle_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'hours', b.hours, 'status', b.status, 'pickup_address', b.pickup_address, 'pickup_lat', b.pickup_lat, 'pickup_lng', b.pickup_lng, 'decline_reason', b.decline_reason,
    'destination_address', b.destination_address, 'destination_lat', b.destination_lat, 'destination_lng', b.destination_lng, 'is_outstation', b.is_outstation, 'vehicle_id', b.vehicle_id,
    'base_amount_pkr', b.base_amount_pkr, 'total_amount_pkr', b.total_amount_pkr, 'distance_km', b.distance_km,
    'hourly_rate_pkr', b.hourly_rate_pkr, 'overage_per_km_pkr', b.overage_per_km_pkr,
    'included_km', b.included_km, 'overage_km', b.overage_km, 'overage_amount_pkr', b.overage_amount_pkr,
    'overtime_minutes', b.overtime_minutes, 'overtime_amount_pkr', b.overtime_amount_pkr,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at, 'status_confirmed', b.status_confirmed,
    'notes', b.notes, 'payment_method', b.payment_method,
    'customer_portal_user_id', pu.id, 'customer_name', pu.full_name, 'customer_mobile', pu.mobile, 'customer_trust', portal_user_trust(pu.id)
  ) ORDER BY b.requested_at DESC), '[]'::jsonb) INTO v_result
  FROM hourly_bookings b JOIN portal_users pu ON pu.id = b.portal_user_id
  WHERE b.vehicle_id = p_vehicle_id
    OR (
      b.vehicle_id IS NULL AND b.status = 'requested' AND b.rental_tier = v_tier AND v_tier IS NOT NULL
      AND (
        b.preferred_year IS NULL OR v_year = b.preferred_year
        OR NOT EXISTS (SELECT 1 FROM vehicles v2 WHERE v2.rental_tier = b.rental_tier AND v2.is_active AND v2.offers_hourly AND v2.tenant_id = v_tenant AND v2.model_year = b.preferred_year)
      )
    );
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_hourly_bookings(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_hourly_bookings(uuid) TO authenticated;
