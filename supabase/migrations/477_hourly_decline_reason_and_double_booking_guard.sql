-- Two real gaps found thinking through the full accept/decline/start
-- flow before building its UI:
--
-- 1. A driver could accept several hourly requests (fine — nothing
--    physically stops someone asking, and the driver might genuinely
--    not know yet which one they'll actually do first), but nothing
--    stopped them STARTING two at once, which is a physical
--    impossibility — one vehicle can't be on two trips. start_hourly_trip
--    now refuses if this vehicle already has another booking
--    in_progress.
-- 2. Declining had no reason, unlike every other reject flow in this
--    app (reject_shop_order/reject_ride_booking both take one) — a
--    customer whose booking was declined deserves to know why ("vehicle
--    is busy", "too far") rather than a bare "declined."
--
-- Old 2-arg respond_hourly_booking is explicitly dropped before the new
-- 3-arg one is created — CREATE OR REPLACE with an added parameter
-- creates a new overload instead of replacing the old one (the exact
-- bug 460 had to clean up for record_shop_sale).

ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS decline_reason text;

DROP FUNCTION IF EXISTS respond_hourly_booking(uuid, boolean);
CREATE OR REPLACE FUNCTION respond_hourly_booking(p_booking_id uuid, p_accept boolean, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE b hourly_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'requested' THEN RAISE EXCEPTION 'This booking has already been responded to.' USING ERRCODE = 'P0001'; END IF;

  UPDATE hourly_bookings SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END,
    responded_at = now(), decline_reason = CASE WHEN p_accept THEN NULL ELSE p_reason END
  WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, CASE WHEN p_accept THEN 'hourly_booking_accepted' ELSE 'hourly_booking_declined' END,
    CASE WHEN p_accept THEN 'Booking accepted' ELSE 'Booking declined' END,
    CASE WHEN p_accept THEN v.owner_name || ' will pick you up.'
      ELSE 'This vehicle is not available for your booking.' || COALESCE(' — ' || p_reason, '') END,
    '/portal/marketplace');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION respond_hourly_booking(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION respond_hourly_booking(uuid, boolean, text) TO authenticated;

CREATE OR REPLACE FUNCTION start_hourly_trip(p_booking_id uuid) RETURNS void AS $$
DECLARE b hourly_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'accepted' THEN RAISE EXCEPTION 'This booking is not ready to start.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM hourly_bookings other WHERE other.vehicle_id = b.vehicle_id AND other.id <> b.id AND other.status = 'in_progress') THEN
    RAISE EXCEPTION 'This vehicle is already on another trip — end that one first.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE hourly_bookings SET status = 'in_progress', started_at = now(), distance_km = 0, last_lat = NULL, last_lng = NULL WHERE id = p_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Both listing RPCs get decline_reason too, so the UI can actually show it.
CREATE OR REPLACE FUNCTION my_hourly_bookings() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'hours', b.hours, 'status', b.status, 'pickup_address', b.pickup_address, 'decline_reason', b.decline_reason,
    'base_amount_pkr', b.base_amount_pkr, 'total_amount_pkr', b.total_amount_pkr, 'distance_km', b.distance_km,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color
  ) ORDER BY b.requested_at DESC), '[]'::jsonb)
  FROM hourly_bookings b JOIN vehicles v ON v.id = b.vehicle_id
  WHERE b.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION vehicle_hourly_bookings(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'hours', b.hours, 'status', b.status, 'pickup_address', b.pickup_address, 'decline_reason', b.decline_reason,
    'base_amount_pkr', b.base_amount_pkr, 'total_amount_pkr', b.total_amount_pkr, 'distance_km', b.distance_km,
    'included_km', b.included_km, 'overage_km', b.overage_km, 'overage_amount_pkr', b.overage_amount_pkr,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at, 'status_confirmed', b.status_confirmed,
    'customer_name', pu.full_name, 'customer_mobile', pu.mobile
  ) ORDER BY b.requested_at DESC), '[]'::jsonb) INTO v_result
  FROM hourly_bookings b JOIN portal_users pu ON pu.id = b.portal_user_id
  WHERE b.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
