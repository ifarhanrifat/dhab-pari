-- Migration 852: real gap the user spotted before asking for the full
-- fleet-accounting system — "machinery system is also having same
-- system of fleet but fleet system working is not matching with bus
-- booking because one owner is having many machinery."
--
-- Investigated first (per the user's own "think about it first"): there
-- is no separate machinery fleet system to reconcile. Machinery/
-- tractor/loader are just flag columns on the same `vehicles` table
-- buses live in, booked through the shared `equipment_bookings` table
-- — so the `fleets`/`vehicles.fleet_id`/`can_manage_vehicle()` system
-- (844) already applies to them structurally. It was simply never
-- wired in: every equipment RPC and the one equipment RLS policy still
-- checked raw `vehicles.portal_user_id` equality, and the equipment
-- page only ever loaded exactly one vehicle per account. Same bug
-- class migration 848 already fixed for routes (ride_bookings_keeper_
-- read, commercial_ilans_advertiser_read) — just never applied here.
-- This is the parity fix, not a new system: swap every raw check below
-- to can_manage_vehicle(), same as everywhere else fleet-aware.

DROP POLICY IF EXISTS "equipment_bookings_parties_read" ON equipment_bookings;
CREATE POLICY "equipment_bookings_parties_read" ON equipment_bookings FOR SELECT TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR portal_user_id = current_portal_user_id()
    OR can_manage_vehicle(vehicle_id)
  );

CREATE OR REPLACE FUNCTION respond_equipment_booking(p_booking_id uuid, p_accept boolean, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE b equipment_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM equipment_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR can_manage_vehicle(v.id)) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'requested' THEN RAISE EXCEPTION 'This booking has already been responded to.' USING ERRCODE = 'P0001'; END IF;

  UPDATE equipment_bookings SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END, responded_at = now(),
    decline_reason = CASE WHEN p_accept THEN NULL ELSE p_reason END
  WHERE id = p_booking_id;
  IF NOT p_accept THEN PERFORM close_booking_thread('equipment_booking', p_booking_id, 'declined'); END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, CASE WHEN p_accept THEN 'equipment_booking_accepted' ELSE 'equipment_booking_declined' END,
    CASE WHEN p_accept THEN 'Booking accepted' ELSE 'Booking declined' END,
    CASE WHEN p_accept THEN v.owner_name || ' accepted your job.'
      ELSE 'This vehicle is not available for your job.' || COALESCE(' — ' || p_reason, '') END,
    '/portal/marketplace');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION start_equipment_job(p_booking_id uuid, p_pin varchar) RETURNS void AS $$
DECLARE b equipment_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM equipment_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR can_manage_vehicle(v.id)) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'accepted' THEN RAISE EXCEPTION 'This booking is not ready to start.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM equipment_bookings other WHERE other.vehicle_id = b.vehicle_id AND other.id <> b.id AND other.status = 'in_progress') THEN
    RAISE EXCEPTION 'This vehicle is already on another job — complete that one first.' USING ERRCODE = 'P0001';
  END IF;
  IF b.pin IS NOT NULL AND trim(COALESCE(p_pin, '')) <> b.pin THEN
    RAISE EXCEPTION 'Incorrect PIN — ask the customer for the 4-digit code shown in their app.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE equipment_bookings SET status = 'in_progress', started_at = now() WHERE id = p_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION start_equipment_job(uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION start_equipment_job(uuid, varchar) TO authenticated;

CREATE OR REPLACE FUNCTION complete_equipment_job(p_booking_id uuid) RETURNS jsonb AS $$
DECLARE b equipment_bookings%ROWTYPE; v vehicles%ROWTYPE; v_hours decimal; v_total decimal;
BEGIN
  SELECT * INTO b FROM equipment_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR can_manage_vehicle(v.id)) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'in_progress' THEN RAISE EXCEPTION 'This job is not in progress.' USING ERRCODE = 'P0001'; END IF;

  v_hours := GREATEST(COALESCE(b.requested_hours, 0), 1);
  v_total := CASE WHEN b.kind = 'loader' THEN b.rate_pkr * GREATEST(COALESCE(b.trip_count, 1), 1) ELSE b.rate_pkr * v_hours + COALESCE(b.mobilization_fee_pkr, 0) END;

  UPDATE equipment_bookings SET status = 'completed', ended_at = now(), actual_hours = v_hours, total_amount_pkr = v_total WHERE id = p_booking_id;
  PERFORM close_booking_thread('equipment_booking', p_booking_id, 'agreed');

  RETURN jsonb_build_object('total_amount_pkr', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION cancel_equipment_booking(p_booking_id uuid) RETURNS void AS $$
DECLARE b equipment_bookings%ROWTYPE; v vehicles%ROWTYPE; v_is_customer boolean; v_is_owner boolean; v_notify_id uuid;
BEGIN
  SELECT * INTO b FROM equipment_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  v_is_customer := b.portal_user_id = current_portal_user_id();
  v_is_owner := can_manage_vehicle(v.id);
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v_is_customer OR v_is_owner) THEN
    RAISE EXCEPTION 'You are not part of this booking.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status IN ('in_progress', 'completed', 'cancelled') THEN
    RAISE EXCEPTION 'This booking can no longer be cancelled.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE equipment_bookings SET status = 'cancelled' WHERE id = p_booking_id;
  PERFORM close_booking_thread('equipment_booking', p_booking_id, 'cancelled');

  v_notify_id := CASE WHEN v_is_customer THEN v.portal_user_id ELSE b.portal_user_id END;
  IF v_notify_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_notify_id, 'equipment_booking_cancelled', 'Booking cancelled', 'An equipment booking was cancelled.', '/portal/marketplace');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION confirm_equipment_booking(p_booking_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b equipment_bookings%ROWTYPE; v vehicles%ROWTYPE;
  v_vehicle_account uuid; v_cash_account uuid; v_commission_account uuid;
  v_commission_pct decimal; v_commission_amount decimal;
  v_gross_voucher_id uuid; v_gross_voucher_no varchar; v_commission_voucher_id uuid;
  v_is_keeper boolean; v_is_admin boolean;
BEGIN
  SELECT * INTO b FROM equipment_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'completed' THEN RAISE EXCEPTION 'This job has not been completed yet.' USING ERRCODE = 'P0001'; END IF;
  IF b.status_confirmed THEN RAISE EXCEPTION 'This booking has already been settled.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;

  -- 852: can_manage_vehicle() so a fleet manager can settle too, not
  -- just the vehicle's own registered portal_user_id.
  v_is_keeper := COALESCE(can_manage_vehicle(v.id) AND v.commission_mode = 'per_order', false);
  v_is_admin := COALESCE(current_admin_permission('post_transactions') AND v.tenant_id = my_tenant_id(), false);
  IF NOT (v_is_admin OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  v_vehicle_account := ensure_vehicle_account(v.id);
  SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050' AND tenant_id = v.tenant_id;

  IF v.commission_mode = 'per_order' THEN
    v_commission_pct := CASE WHEN v.category_id IS NOT NULL
      THEN vehicle_category_commission_pct(v.category_id, 'intercity')
      ELSE COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_equipment_commission_pct' AND tenant_id = v.tenant_id), 0) END;
    v_commission_amount := round(b.total_amount_pkr * v_commission_pct / 100, 2);

    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — ' || b.kind || ' (paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
      RETURNING id INTO v_commission_voucher_id;
    END IF;

    UPDATE equipment_bookings SET status_confirmed = true, commission_voucher_id = v_commission_voucher_id WHERE id = p_booking_id;
    PERFORM check_seller_balance_notify('vehicle', v.id);
    RETURN jsonb_build_object('amount', b.total_amount_pkr, 'commission', v_commission_amount);
  END IF;

  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-1001' AND tenant_id = v.tenant_id;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    initcap(b.kind) || ' booking — confirmed', b.total_amount_pkr, v_vehicle_account, v_cash_account, v.owner_name)
  RETURNING id, voucher_no INTO v_gross_voucher_id, v_gross_voucher_no;

  UPDATE equipment_bookings SET status_confirmed = true, gross_voucher_id = v_gross_voucher_id WHERE id = p_booking_id;
  RETURN jsonb_build_object('voucher_no', v_gross_voucher_no, 'amount', b.total_amount_pkr);
END;
$$;

CREATE OR REPLACE FUNCTION vehicle_equipment_bookings(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR can_manage_vehicle(p_vehicle_id)) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'kind', b.kind, 'service_key', b.service_key, 'site_address', b.site_address, 'site_lat', b.site_lat, 'site_lng', b.site_lng, 'material', b.material,
    'requested_hours', b.requested_hours, 'status', b.status, 'decline_reason', b.decline_reason, 'rate_pkr', b.rate_pkr, 'mobilization_fee_pkr', b.mobilization_fee_pkr,
    'actual_hours', b.actual_hours, 'total_amount_pkr', b.total_amount_pkr, 'status_confirmed', b.status_confirmed,
    'notes', b.notes, 'payment_method', b.payment_method,
    'pickup_address', b.pickup_address, 'pickup_lat', b.pickup_lat, 'pickup_lng', b.pickup_lng, 'trip_count', b.trip_count,
    'scheduled_date', b.scheduled_date, 'scheduled_time', b.scheduled_time,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'customer_portal_user_id', pu.id, 'customer_name', pu.full_name, 'customer_mobile', pu.mobile
  ) ORDER BY b.requested_at DESC), '[]'::jsonb) INTO v_result
  FROM equipment_bookings b JOIN portal_users pu ON pu.id = b.portal_user_id
  WHERE b.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION set_own_machinery_rate(p_vehicle_id uuid, p_rate_pkr decimal) RETURNS void AS $$
DECLARE v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(p_vehicle_id) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT v.offers_machinery THEN
    RAISE EXCEPTION 'Machinery hire is not enabled for this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF v.machinery_hourly_rate_min_pkr IS NULL OR v.machinery_hourly_rate_max_pkr IS NULL THEN
    RAISE EXCEPTION 'Ask the committee to set a rate range for you first.' USING ERRCODE = 'P0001';
  END IF;
  IF p_rate_pkr < v.machinery_hourly_rate_min_pkr OR p_rate_pkr > v.machinery_hourly_rate_max_pkr THEN
    RAISE EXCEPTION 'Pick a rate between % and % per hour.', v.machinery_hourly_rate_min_pkr, v.machinery_hourly_rate_max_pkr USING ERRCODE = 'P0001';
  END IF;
  UPDATE vehicles SET machinery_hourly_rate_pkr = p_rate_pkr WHERE id = p_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION my_machinery_rate_offers(p_vehicle_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', o.id, 'proposed_rate_pkr', o.proposed_rate_pkr, 'counter_rate_pkr', o.counter_rate_pkr, 'status', o.status, 'created_at', o.created_at,
    'rider_full_name', p.full_name, 'rider_mobile', p.mobile
  ) ORDER BY o.created_at DESC), '[]'::jsonb)
  FROM machinery_rate_offers o
  JOIN vehicles v ON v.id = o.vehicle_id
  JOIN portal_users p ON p.id = o.portal_user_id
  WHERE o.vehicle_id = p_vehicle_id AND can_manage_vehicle(o.vehicle_id) AND o.status IN ('pending', 'countered');
$function$;

CREATE OR REPLACE FUNCTION respond_machinery_rate_offer(p_offer_id uuid, p_action varchar, p_counter_rate_pkr decimal DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  o machinery_rate_offers%ROWTYPE;
  v vehicles%ROWTYPE;
BEGIN
  IF p_action NOT IN ('accept', 'reject', 'counter') THEN RAISE EXCEPTION 'Invalid action.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO o FROM machinery_rate_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Offer not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = o.vehicle_id;
  IF NOT FOUND OR NOT can_manage_vehicle(v.id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;

  IF p_action = 'reject' THEN
    IF o.status NOT IN ('pending', 'countered') THEN RAISE EXCEPTION 'This offer is no longer open.' USING ERRCODE = 'P0001'; END IF;
    UPDATE machinery_rate_offers SET status = 'rejected', responded_at = now() WHERE id = p_offer_id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (o.portal_user_id, 'machinery_rate_offer_rejected', 'Rate offer declined', v.owner_name || ' declined your offer.', '/portal/marketplace/machinery');
    RETURN;
  END IF;

  IF o.status <> 'pending' THEN RAISE EXCEPTION 'This offer has already been responded to.' USING ERRCODE = 'P0001'; END IF;

  IF p_action = 'accept' THEN
    UPDATE machinery_rate_offers SET status = 'accepted', responded_at = now() WHERE id = p_offer_id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (o.portal_user_id, 'machinery_rate_offer_accepted', 'Rate offer accepted', v.owner_name || ' accepted your offer of ₨' || o.proposed_rate_pkr || '/hour — book now.', '/portal/marketplace/machinery');
  ELSE
    IF p_counter_rate_pkr IS NULL THEN RAISE EXCEPTION 'Enter a counter rate.' USING ERRCODE = 'P0001'; END IF;
    IF p_counter_rate_pkr < COALESCE(v.machinery_hourly_rate_min_pkr, 0) OR p_counter_rate_pkr > v.machinery_hourly_rate_pkr THEN
      RAISE EXCEPTION 'Counter between % and % per hour.', COALESCE(v.machinery_hourly_rate_min_pkr, 0), v.machinery_hourly_rate_pkr USING ERRCODE = 'P0001';
    END IF;
    UPDATE machinery_rate_offers SET status = 'countered', counter_rate_pkr = p_counter_rate_pkr, responded_at = now() WHERE id = p_offer_id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (o.portal_user_id, 'machinery_rate_offer_countered', 'Counter-offer', v.owner_name || ' countered at ₨' || p_counter_rate_pkr || '/hour.', '/portal/marketplace/machinery');
  END IF;
END;
$function$;
