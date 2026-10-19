-- Migration 709: wires the new vehicle_categories commission card into
-- real settlement for the five flows confirmed in scope — trip bookings,
-- equipment, dispatch, parcel delivery, city purchase. Shadi/hourly/
-- rental/pro-service keep their own existing, separate, already-working
-- mechanisms untouched — explicitly out of scope.
--
-- Every vehicle approved before this migration has category_id = NULL
-- (the column is new) — every rewritten function below falls back to
-- its EXACT prior behavior whenever category_id is NULL, so nothing
-- changes for an existing vehicle until it's re-approved or an admin
-- assigns it a category directly. This is deliberate: a behavior change
-- should only ever be opt-in per vehicle, never silently sitewide.

-- 1. complete_trip_booking: vehicle_commission_pct(vehicle_type, classification)
-- -> vehicle_category_commission_pct(category_id, classification) when set,
-- else the exact prior free-text lookup (same table, same function, untouched).
CREATE OR REPLACE FUNCTION public.complete_trip_booking(p_trip_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  b vehicle_trip_bookings%ROWTYPE; v vehicles%ROWTYPE; o vehicle_trip_offers%ROWTYPE;
  v_vehicle_account uuid; v_commission_account uuid; v_commission_pct decimal; v_commission_amount decimal := 0;
  v_commission_voucher_id uuid; v_trip_label text;
BEGIN
  SELECT * INTO b FROM vehicle_trip_bookings WHERE id = p_trip_booking_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'confirmed' THEN RAISE EXCEPTION 'This trip is not awaiting completion.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  SELECT * INTO o FROM vehicle_trip_offers WHERE id = b.trip_offer_id;
  IF v.portal_user_id IS DISTINCT FROM current_portal_user_id() AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicle_trip_bookings SET status = 'completed', completed_at = now() WHERE id = p_trip_booking_id;

  v_trip_label := CASE WHEN o.trip_type = 'return' THEN 'return trip' ELSE 'trip' END;

  IF v.commission_mode = 'per_order' THEN
    v_vehicle_account := ensure_vehicle_account(v.id);
    SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050' AND tenant_id = my_tenant_id();
    v_commission_pct := CASE WHEN v.category_id IS NOT NULL THEN vehicle_category_commission_pct(v.category_id, o.classification) ELSE vehicle_commission_pct(v.vehicle_type, o.classification) END;
    v_commission_amount := round(b.total_amount_pkr * v_commission_pct / 100, 2);
    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — ' || o.origin || ' → ' || o.destination || ' ' || v_trip_label || ' (paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
      RETURNING id INTO v_commission_voucher_id;
      UPDATE vehicle_trip_bookings SET commission_voucher_id = v_commission_voucher_id WHERE id = p_trip_booking_id;
    END IF;
    PERFORM check_seller_balance_notify('vehicle', v.id);
  END IF;

  RETURN jsonb_build_object('amount', b.total_amount_pkr, 'commission', v_commission_amount);
END;
$function$;

-- 2. confirm_equipment_booking: flat marketplace_equipment_commission_pct
-- -> vehicle's own category commission (machinery/tractor/loader kinds
-- map onto exactly those 3 of the new categories), same fallback rule.
CREATE OR REPLACE FUNCTION public.confirm_equipment_booking(p_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  b equipment_bookings%ROWTYPE; v vehicles%ROWTYPE;
  v_vehicle_account uuid; v_cash_account uuid; v_commission_account uuid;
  v_commission_pct decimal; v_commission_amount decimal;
  v_gross_voucher_id uuid; v_gross_voucher_no varchar; v_commission_voucher_id uuid;
  v_is_keeper boolean;
BEGIN
  SELECT * INTO b FROM equipment_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'completed' THEN RAISE EXCEPTION 'This job has not been completed yet.' USING ERRCODE = 'P0001'; END IF;
  IF b.status_confirmed THEN RAISE EXCEPTION 'This booking has already been settled.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;

  v_is_keeper := v.portal_user_id IS NOT NULL AND v.portal_user_id = current_portal_user_id() AND v.commission_mode = 'per_order';
  IF NOT (COALESCE(current_admin_permission('post_transactions'), false) OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  v_vehicle_account := ensure_vehicle_account(v.id);
  SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050';

  IF v.commission_mode = 'per_order' THEN
    v_commission_pct := CASE WHEN v.category_id IS NOT NULL THEN vehicle_category_commission_pct(v.category_id, 'intercity') ELSE COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_equipment_commission_pct'), 0) END;
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

  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-1001';

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    initcap(b.kind) || ' booking — confirmed', b.total_amount_pkr, v_vehicle_account, v_cash_account, v.owner_name)
  RETURNING id, voucher_no INTO v_gross_voucher_id, v_gross_voucher_no;

  UPDATE equipment_bookings SET status_confirmed = true, gross_voucher_id = v_gross_voucher_id WHERE id = p_booking_id;
  RETURN jsonb_build_object('voucher_no', v_gross_voucher_no, 'amount', b.total_amount_pkr);
END;
$function$;

-- 3. dispatch_commission_pct / confirm_parcel_delivery_received's shared
-- fallback: distance-band logic (dispatch_commission_bands) is left
-- completely untouched when a band actually matches. Only the fallback
-- branch (today a flat site_settings key) now needs the vehicle's own
-- category — which this function doesn't have, since it's keyed only on
-- tenant_id/distance. Add an overload that also takes a vehicle_id so
-- callers that have one can get the category-aware fallback; the
-- original 2-arg signature is untouched for anywhere that doesn't.
CREATE OR REPLACE FUNCTION dispatch_commission_pct(p_tenant_id uuid, p_distance_km decimal, p_vehicle_id uuid) RETURNS decimal AS $$
DECLARE v_pct decimal; v_category_id uuid;
BEGIN
  SELECT commission_pct INTO v_pct FROM dispatch_commission_bands
  WHERE tenant_id = p_tenant_id AND p_distance_km >= min_distance_km AND (max_distance_km IS NULL OR p_distance_km < max_distance_km)
  ORDER BY min_distance_km DESC LIMIT 1;
  IF v_pct IS NOT NULL THEN RETURN v_pct; END IF;

  SELECT category_id INTO v_category_id FROM vehicles WHERE id = p_vehicle_id;
  IF v_category_id IS NOT NULL THEN
    RETURN vehicle_category_commission_pct(v_category_id, 'intercity');
  END IF;
  RETURN COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_dispatch_commission_pct' AND tenant_id = p_tenant_id), 0);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION dispatch_commission_pct(uuid, decimal, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION complete_dispatch_call(p_call_id uuid) RETURNS void AS $$
DECLARE
  c dispatch_calls%ROWTYPE; v vehicles%ROWTYPE; v_distance_km decimal;
  v_vehicle_account uuid; v_commission_account uuid; v_commission_pct decimal; v_fee_portion decimal; v_commission_amount decimal := 0;
  v_commission_voucher_id uuid;
BEGIN
  SELECT * INTO c FROM dispatch_calls WHERE id = p_call_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Call not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = c.accepted_vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this delivery.' USING ERRCODE = 'P0001';
  END IF;
  IF c.status <> 'approved' THEN RAISE EXCEPTION 'This call is not awaiting completion.' USING ERRCODE = 'P0001'; END IF;
  UPDATE dispatch_calls SET status = 'completed', completed_at = now() WHERE id = p_call_id;

  IF v.commission_mode = 'per_order' THEN
    v_fee_portion := GREATEST(0, COALESCE(c.total_pkr, 0) - COALESCE(c.goods_budget_pkr, 0));
    IF v_fee_portion > 0 THEN
      v_vehicle_account := ensure_vehicle_account(v.id);
      SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050' AND tenant_id = c.tenant_id;
      SELECT ci.distance_km INTO v_distance_km FROM city_shops cs JOIN cities ci ON ci.id = cs.city_id WHERE cs.id = c.city_shop_id;
      v_commission_pct := dispatch_commission_pct(c.tenant_id, COALESCE(v_distance_km, 0), v.id);
      v_commission_amount := round(v_fee_portion * v_commission_pct / 100, 2);
      IF v_commission_amount > 0 THEN
        INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
        VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
          'Marketplace commission — city dispatch: ' || c.item || ' (paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
        RETURNING id INTO v_commission_voucher_id;
        UPDATE dispatch_calls SET commission_voucher_id = v_commission_voucher_id WHERE id = p_call_id;
      END IF;
      PERFORM check_seller_balance_notify('vehicle', v.id);
    END IF;
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
  VALUES (c.initiator_portal_user_id, 'dispatch_completed', 'Delivered', c.item, '/portal/marketplace/dispatch/' || p_call_id, c.tenant_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION confirm_parcel_delivery_received(p_delivery_id uuid) RETURNS void AS $$
DECLARE
  d parcel_deliveries%ROWTYPE; v vehicles%ROWTYPE; ci cities%ROWTYPE;
  v_vehicle_account uuid; v_commission_account uuid; v_commission_pct decimal; v_commission_amount decimal := 0; v_commission_voucher_id uuid;
BEGIN
  SELECT * INTO d FROM parcel_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND OR d.initiator_portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this delivery.' USING ERRCODE = 'P0001';
  END IF;
  IF d.status <> 'delivered' THEN RAISE EXCEPTION 'This delivery is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  UPDATE parcel_deliveries SET status = 'completed', completed_at = now() WHERE id = p_delivery_id;

  SELECT * INTO v FROM vehicles WHERE id = d.accepted_vehicle_id;
  IF v.commission_mode = 'per_order' AND COALESCE(d.total_fare_pkr, 0) > 0 THEN
    v_vehicle_account := ensure_vehicle_account(v.id);
    SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050' AND tenant_id = v.tenant_id;
    SELECT * INTO ci FROM cities WHERE id = d.city_id;
    v_commission_pct := dispatch_commission_pct(v.tenant_id, COALESCE(ci.distance_km, 0), v.id);
    v_commission_amount := round(d.total_fare_pkr * v_commission_pct / 100, 2);
    IF v_commission_amount > 0 AND v_commission_account IS NOT NULL THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — parcel delivery: ' || d.description || ' (paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
      RETURNING id INTO v_commission_voucher_id;
      UPDATE parcel_deliveries SET commission_voucher_id = v_commission_voucher_id WHERE id = p_delivery_id;
    END IF;
    PERFORM check_seller_balance_notify('vehicle', v.id);
  END IF;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'parcel_delivery_completed', 'Confirmed delivered', d.description, '/portal/marketplace/parcel/' || p_delivery_id);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4. confirm_city_purchase_received: gains a commission step for the
-- first time (none existed before) — same MKT-4050 voucher pattern,
-- category-based, only when the vehicle has one (no fallback needed:
-- no commission ever existed here, so "no category" just means "still
-- no commission," not a regression from some prior non-zero number).
ALTER TABLE city_purchase_requests ADD COLUMN IF NOT EXISTS commission_voucher_id uuid REFERENCES vouchers(id);

CREATE OR REPLACE FUNCTION confirm_city_purchase_received(p_request_id uuid) RETURNS void AS $$
DECLARE
  r city_purchase_requests%ROWTYPE; v vehicles%ROWTYPE;
  v_vehicle_account uuid; v_commission_account uuid; v_commission_pct decimal; v_commission_amount decimal := 0; v_commission_voucher_id uuid;
BEGIN
  SELECT * INTO r FROM city_purchase_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.initiator_portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this request.' USING ERRCODE = 'P0001';
  END IF;
  IF r.status <> 'delivered' THEN RAISE EXCEPTION 'This request is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  UPDATE city_purchase_requests SET status = 'completed', completed_at = now() WHERE id = p_request_id;

  SELECT * INTO v FROM vehicles WHERE id = r.accepted_vehicle_id;
  IF v.commission_mode = 'per_order' AND v.category_id IS NOT NULL AND COALESCE(r.total_fare_pkr, 0) > 0 THEN
    v_vehicle_account := ensure_vehicle_account(v.id);
    SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050' AND tenant_id = v.tenant_id;
    v_commission_pct := vehicle_category_commission_pct(v.category_id, 'intercity');
    v_commission_amount := round(r.total_fare_pkr * v_commission_pct / 100, 2);
    IF v_commission_amount > 0 AND v_commission_account IS NOT NULL THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — city purchase: ' || r.item || ' (paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
      RETURNING id INTO v_commission_voucher_id;
      UPDATE city_purchase_requests SET commission_voucher_id = v_commission_voucher_id WHERE id = p_request_id;
    END IF;
    PERFORM check_seller_balance_notify('vehicle', v.id);
  END IF;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'city_purchase_completed', 'Confirmed received', r.item, '/portal/marketplace/city-purchase/' || p_request_id);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
