-- Migration 691: same real gap as 690, for the OTHER vehicle-posting
-- product -- close_vehicle_route() (weekly commute) never touched
-- commercial_ilans at all. A route's manually-requested ilan
-- (request_commercial_ilan, vehicle_route_id) kept showing "live" on
-- the driver's own ilan page and kept being eligible to display even
-- after the driver closed the route it was advertising. Reproduced
-- from the real current body, same two-case handling as 690: a
-- still-pending request gets auto-rejected, an approved one gets
-- paused and its end time pulled to now.

CREATE OR REPLACE FUNCTION public.close_vehicle_route(p_route_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r vehicle_routes%ROWTYPE; v vehicles%ROWTYPE;
  v_portal_user_id uuid := current_portal_user_id();
  b RECORD;
  v_cancelled_count int := 0;
BEGIN
  SELECT * INTO r FROM vehicle_routes WHERE id = p_route_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = r.vehicle_id;

  IF NOT ((v.portal_user_id IS NOT NULL AND v.portal_user_id = v_portal_user_id) OR COALESCE(current_admin_permission('post_transactions'), false)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicle_routes SET is_active = false WHERE id = p_route_id;

  FOR b IN
    SELECT id FROM ride_bookings
    WHERE route_id = p_route_id AND status IN ('announced', 'confirmed') AND travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
  LOOP
    PERFORM cancel_ride_booking(b.id, COALESCE(trim(p_reason), 'Route closed by driver'));
    v_cancelled_count := v_cancelled_count + 1;
  END LOOP;

  UPDATE commercial_ilans SET status = 'rejected', rejection_reason = 'Route was closed by the driver before review.', reviewed_at = now()
    WHERE vehicle_route_id = p_route_id AND status = 'pending_approval';

  UPDATE commercial_ilans SET is_paused = true, ends_at = now()
    WHERE vehicle_route_id = p_route_id AND status = 'approved' AND (ends_at IS NULL OR ends_at > now());

  RETURN jsonb_build_object('route_id', p_route_id, 'bookings_cancelled', v_cancelled_count);
END;
$function$;
