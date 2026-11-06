-- Migration 813: real ask, 2026-11-06 — a driver on an hourly booking is
-- locked to the rider's clock for the whole reserved duration even
-- during pure waiting time, with no way to step away for a few minutes
-- (fuel, food, a quick errand) without either eating into the rider's
-- paid hours or quietly driving off and padding the GPS-tracked
-- distance/overage. "he just click the pause and go any where he want
-- to go and then after arriving... he will unpause the button again and
-- now the waiting time again starts."
--
-- paused_at: set the moment the driver pauses; NULL while running.
-- paused_minutes: running total of every past pause, added up on each
-- resume — this is what gets subtracted from the elapsed time end_hourly_
-- trip (776) bills against, so time spent away never counts as part of
-- the rider's booked hours (no overtime charged for it) and never
-- advances the GPS distance total either (ping_hourly_trip_location,
-- 476, now a no-op while paused) — the driver can drive anywhere during
-- a pause with zero effect on the rider's bill either way.

ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS paused_at timestamptz;
ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS paused_minutes numeric NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION pause_hourly_trip(p_booking_id uuid) RETURNS void AS $$
DECLARE b hourly_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'in_progress' THEN RAISE EXCEPTION 'This trip is not in progress.' USING ERRCODE = 'P0001'; END IF;
  IF b.paused_at IS NOT NULL THEN RAISE EXCEPTION 'Already paused.' USING ERRCODE = 'P0001'; END IF;

  UPDATE hourly_bookings SET paused_at = now() WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'hourly_trip_paused', 'Wait time paused',
    v.owner_name || ' stepped away for a bit — your clock is paused, not running.', '/portal/marketplace');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION pause_hourly_trip(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pause_hourly_trip(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION resume_hourly_trip(p_booking_id uuid) RETURNS void AS $$
DECLARE b hourly_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'in_progress' THEN RAISE EXCEPTION 'This trip is not in progress.' USING ERRCODE = 'P0001'; END IF;
  IF b.paused_at IS NULL THEN RAISE EXCEPTION 'Not paused.' USING ERRCODE = 'P0001'; END IF;

  UPDATE hourly_bookings SET paused_minutes = paused_minutes + extract(epoch FROM (now() - paused_at)) / 60, paused_at = NULL
  WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'hourly_trip_resumed', 'Wait time resumed',
    v.owner_name || ' is back — your clock is running again.', '/portal/marketplace');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION resume_hourly_trip(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION resume_hourly_trip(uuid) TO authenticated;

-- Distance tracking: a ping that arrives while paused is the driver's
-- own errand travel, not the rider's — ignored outright (no distance
-- add, no reference-point advance), same early-return shape the
-- existing status<>'in_progress' guard already uses right above it.
CREATE OR REPLACE FUNCTION ping_hourly_trip_location(p_booking_id uuid, p_lat decimal, p_lng decimal) RETURNS void AS $$
DECLARE
  b hourly_bookings%ROWTYPE;
  v_segment_km decimal;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicles v2 WHERE v2.id = b.vehicle_id AND v2.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'in_progress' THEN RAISE EXCEPTION 'This trip is not in progress.' USING ERRCODE = 'P0001'; END IF;
  IF b.paused_at IS NOT NULL THEN RETURN; END IF;

  INSERT INTO hourly_booking_locations (booking_id, lat, lng) VALUES (p_booking_id, p_lat, p_lng);

  IF b.last_lat IS NULL THEN
    UPDATE hourly_bookings SET last_lat = p_lat, last_lng = p_lng WHERE id = p_booking_id;
    RETURN;
  END IF;

  v_segment_km := haversine_km(b.last_lat, b.last_lng, p_lat, p_lng);

  IF v_segment_km >= 1.5 THEN
    RETURN;
  END IF;

  IF v_segment_km > 0.02 THEN
    UPDATE hourly_bookings SET distance_km = distance_km + v_segment_km, last_lat = p_lat, last_lng = p_lng WHERE id = p_booking_id;
  ELSE
    UPDATE hourly_bookings SET last_lat = p_lat, last_lng = p_lng WHERE id = p_booking_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- end_hourly_trip: elapsed time for overtime purposes now excludes every
-- past paused interval. Ending while still paused is refused rather than
-- silently folding in the open interval — one extra tap (resume, then
-- end) beats guessing whether "still paused" at the exact moment of
-- ending was deliberate or forgotten.
CREATE OR REPLACE FUNCTION end_hourly_trip(p_booking_id uuid) RETURNS jsonb AS $$
DECLARE
  b hourly_bookings%ROWTYPE; v vehicles%ROWTYPE; pol service_fare_policies;
  v_overage_km decimal; v_overage_amount decimal; v_total decimal;
  v_elapsed_min numeric; v_over_min numeric; v_blocks int; v_overtime_min int; v_overtime_amount decimal;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'in_progress' THEN RAISE EXCEPTION 'This trip is not in progress.' USING ERRCODE = 'P0001'; END IF;
  IF b.paused_at IS NOT NULL THEN RAISE EXCEPTION 'Resume the trip before ending it.' USING ERRCODE = 'P0001'; END IF;

  v_overage_km := greatest(0, b.distance_km - b.included_km);
  v_overage_amount := round(v_overage_km * b.overage_per_km_pkr, 2);

  pol := fare_policy(v.tenant_id, 'hourly');
  v_elapsed_min := greatest(0, extract(epoch FROM (now() - COALESCE(b.started_at, now()))) / 60 - b.paused_minutes);
  v_over_min := v_elapsed_min - b.hours * 60 - pol.overtime_grace_minutes;
  IF v_over_min > 0 THEN
    v_blocks := ceil(v_over_min / pol.overtime_block_minutes);
    v_overtime_min := v_blocks * pol.overtime_block_minutes;
    v_overtime_amount := round(b.hourly_rate_pkr * v_overtime_min / 60.0 * pol.overtime_rate_pct / 100);
  ELSE
    v_overtime_min := 0;
    v_overtime_amount := 0;
  END IF;

  v_total := b.base_amount_pkr + v_overage_amount + v_overtime_amount;

  UPDATE hourly_bookings SET status = 'completed', ended_at = now(),
    overage_km = v_overage_km, overage_amount_pkr = v_overage_amount,
    overtime_minutes = v_overtime_min, overtime_amount_pkr = v_overtime_amount, total_amount_pkr = v_total
  WHERE id = p_booking_id;
  PERFORM close_booking_thread('hourly_booking', p_booking_id, 'agreed');

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'hourly_booking_completed', 'Trip completed',
    'Distance: ' || round(b.distance_km, 1) || 'km'
      || CASE WHEN v_overtime_min > 0 THEN ' — Overtime: ' || v_overtime_min || ' min' ELSE '' END
      || ' — Total: Rs ' || round(v_total), '/portal/marketplace');

  RETURN jsonb_build_object('distance_km', b.distance_km, 'overage_km', v_overage_km, 'overage_amount_pkr', v_overage_amount,
    'overtime_minutes', v_overtime_min, 'overtime_amount_pkr', v_overtime_amount, 'total_amount_pkr', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Expose pause state to both sides so the UI can show a live "Paused"
-- status and a running (non-advancing) wait-clock, not just the driver
-- who has the buttons.
CREATE OR REPLACE FUNCTION public.my_hourly_bookings()
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'hours', b.hours, 'status', b.status, 'pickup_address', b.pickup_address, 'pickup_lat', b.pickup_lat, 'pickup_lng', b.pickup_lng, 'decline_reason', b.decline_reason,
    'base_amount_pkr', b.base_amount_pkr, 'total_amount_pkr', b.total_amount_pkr, 'distance_km', b.distance_km, 'pin', b.pin,
    'notes', b.notes, 'payment_method', b.payment_method,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'vehicle_id', b.vehicle_id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color
  ) || jsonb_build_object(
    'hourly_rate_pkr', b.hourly_rate_pkr, 'included_km', b.included_km, 'overage_per_km_pkr', b.overage_per_km_pkr,
    'overage_km', b.overage_km, 'overage_amount_pkr', b.overage_amount_pkr,
    'overtime_minutes', b.overtime_minutes, 'overtime_amount_pkr', b.overtime_amount_pkr,
    'paused_at', b.paused_at, 'paused_minutes', b.paused_minutes
  ) ORDER BY b.requested_at DESC), '[]'::jsonb)
  FROM hourly_bookings b JOIN vehicles v ON v.id = b.vehicle_id
  WHERE b.portal_user_id = current_portal_user_id();
$function$;

CREATE OR REPLACE FUNCTION public.vehicle_hourly_bookings(p_vehicle_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'hours', b.hours, 'status', b.status, 'pickup_address', b.pickup_address, 'pickup_lat', b.pickup_lat, 'pickup_lng', b.pickup_lng, 'decline_reason', b.decline_reason,
    'base_amount_pkr', b.base_amount_pkr, 'total_amount_pkr', b.total_amount_pkr, 'distance_km', b.distance_km,
    'included_km', b.included_km, 'overage_km', b.overage_km, 'overage_amount_pkr', b.overage_amount_pkr,
    'notes', b.notes, 'payment_method', b.payment_method,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at, 'status_confirmed', b.status_confirmed,
    'customer_portal_user_id', pu.id, 'customer_name', pu.full_name, 'customer_mobile', pu.mobile, 'customer_trust', portal_user_trust(pu.id)
  ) || jsonb_build_object(
    'hourly_rate_pkr', b.hourly_rate_pkr, 'overage_per_km_pkr', b.overage_per_km_pkr,
    'overtime_minutes', b.overtime_minutes, 'overtime_amount_pkr', b.overtime_amount_pkr,
    'paused_at', b.paused_at, 'paused_minutes', b.paused_minutes
  ) ORDER BY b.requested_at DESC), '[]'::jsonb) INTO v_result
  FROM hourly_bookings b JOIN portal_users pu ON pu.id = b.portal_user_id
  WHERE b.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$function$;
