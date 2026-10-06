-- Phase 2, slice 5 (functions, part 2): cross-tenant booking-creation gaps
-- and admin-bypass mutators with no tenant filter on the target row.
-- Every function below is reproduced from its real, current body (pulled
-- live via pg_get_functiondef) with only the minimal tenant-scoping fix
-- applied -- no other logic, parameter, or return-type change.
--
-- Cross-tenant booking creation: each of these is a portal-user-facing
-- "create/respond to a request against this specific id" function where
-- the caller's own identity was correctly scoped, but a SECONDARY row
-- (a vehicle/shop/city/village/city_shop id passed straight from the
-- client, or loaded by a FK that was never itself tenant-checked) was
-- looked up with no tenant filter at all -- a user from tenant A could
-- pass tenant B's id and transact against it directly: create_city_purchase_request,
-- create_dispatch_call, create_hourly_booking, create_shadi_event,
-- add_shadi_vehicle_request, invite_shadi_replacement, start_negotiation,
-- place_shop_order.
--
-- Admin-bypass / unscoped-lookup mutators: each loads its target row by id
-- with no tenant filter at all (admin-permission-gated, or gated only by
-- "do you manage this vehicle/shop", neither of which checked the row's
-- tenant before now) -- an admin or portal user from tenant B could act on
-- tenant A's request/booking/charge by id: accept_shop_order,
-- advance_shop_order_fulfillment, admin_approve_vehicle_registration (both
-- overloads), admin_reject_vehicle_registration, cancel_shadi_event,
-- complete_dispatch_call, confirm_ride_booking, confirm_shadi_advance,
-- confirm_shop_order, confirm_shop_wallet_topup, confirm_vehicle_wallet_topup,
-- end_hourly_trip, invite_shadi_replacement, reject_ride_booking,
-- reject_shadi_advance, reject_shop_wallet_topup, reject_vehicle_wallet_topup,
-- respond_hourly_booking, respond_shadi_request, review_mentor_request,
-- withdraw_shadi_request. Several of these also had a chart-of-account
-- (accounts WHERE code = ...) or site_settings business-key lookup with no
-- tenant filter, now fixed using the already-loaded source row's own
-- tenant_id: complete_dispatch_call, confirm_ride_booking,
-- confirm_shadi_advance, confirm_shop_order, confirm_shop_wallet_topup,
-- confirm_vehicle_wallet_topup.
--
-- check_seller_balance_notify reads two site_settings thresholds with no
-- tenant filter -- fixed by deriving the tenant from the shop/vehicle row
-- it was already loading.

create or replace function public.accept_shop_order(p_order_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE o shop_orders%ROWTYPE; s shops%ROWTYPE; v_is_keeper boolean;
BEGIN
  SELECT * INTO o FROM shop_orders WHERE id = p_order_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO s FROM shops WHERE id = o.shop_id;

  v_is_keeper := s.portal_user_id IS NOT NULL AND s.portal_user_id = current_portal_user_id();
  IF NOT (COALESCE(current_admin_permission('post_transactions'), false) OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF o.status = 'rejected' THEN RAISE EXCEPTION 'This order was rejected.' USING ERRCODE = 'P0001'; END IF;
  IF o.fulfillment_status <> 'pending' THEN RAISE EXCEPTION 'This order has already been accepted.' USING ERRCODE = 'P0001'; END IF;

  UPDATE shop_orders SET fulfillment_status = 'accepted', accepted_at = now() WHERE id = p_order_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
  VALUES (o.portal_user_id, 'shop_order_accepted', 'Order accepted', s.name || ' is preparing your order.', '/portal/marketplace', o.tenant_id);
END;
$function$;

create or replace function public.add_shadi_vehicle_request(p_event_id uuid, p_vehicle_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE e shadi_events%ROWTYPE; v vehicles%ROWTYPE; v_request_id uuid;
BEGIN
  SELECT * INTO e FROM shadi_events WHERE id = p_event_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'P0001'; END IF;
  IF e.portal_user_id <> current_portal_user_id() THEN RAISE EXCEPTION 'This is not your booking.' USING ERRCODE = 'P0001'; END IF;
  IF e.status <> 'collecting' THEN RAISE EXCEPTION 'This booking is no longer collecting responses.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active AND offers_shadi AND tenant_id = e.tenant_id;
  IF NOT FOUND OR v.shadi_full_day_rate_pkr IS NULL THEN RAISE EXCEPTION 'This vehicle is not available for wedding booking.' USING ERRCODE = 'P0001'; END IF;
  IF v.portal_user_id = e.portal_user_id THEN RAISE EXCEPTION 'You cannot book your own vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM shadi_vehicle_requests WHERE event_id = p_event_id AND vehicle_id = p_vehicle_id) THEN
    RAISE EXCEPTION 'This vehicle has already been asked for this event.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO shadi_vehicle_requests (event_id, vehicle_id, full_day_rate_pkr) VALUES (p_event_id, p_vehicle_id, v.shadi_full_day_rate_pkr)
  RETURNING id INTO v_request_id;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (v.portal_user_id, 'shadi_request_received', 'Wedding booking request',
      'For ' || to_char(e.event_date, 'DD Mon YYYY') || ' — Rs ' || round(v.shadi_full_day_rate_pkr) || ' full day', '/portal/my-vehicle/shadi', e.tenant_id);
  END IF;
  RETURN v_request_id;
END;
$function$;

create or replace function public.admin_approve_vehicle_registration(p_request_id uuid, p_is_village_resident boolean, p_per_km_pkr numeric DEFAULT NULL::numeric, p_hourly_rate_pkr numeric DEFAULT NULL::numeric, p_hourly_included_km numeric DEFAULT NULL::numeric, p_hourly_overage_per_km_pkr numeric DEFAULT NULL::numeric, p_shadi_full_day_rate_pkr numeric DEFAULT NULL::numeric)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE r vehicle_registration_requests%ROWTYPE; v_vehicle_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_registration_requests WHERE id = p_request_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'This request has already been reviewed.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM vehicles WHERE portal_user_id = r.portal_user_id) THEN
    RAISE EXCEPTION 'This driver already has a linked vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF r.wants_delivers AND p_per_km_pkr IS NULL THEN RAISE EXCEPTION 'Per-km rate is required — this driver requested delivery.' USING ERRCODE = 'P0001'; END IF;
  IF r.wants_hourly AND (p_hourly_rate_pkr IS NULL OR p_hourly_included_km IS NULL OR p_hourly_overage_per_km_pkr IS NULL) THEN
    RAISE EXCEPTION 'Hourly rate, included km and overage rate are required — this driver requested hourly rental.' USING ERRCODE = 'P0001';
  END IF;
  IF r.wants_shadi AND p_shadi_full_day_rate_pkr IS NULL THEN RAISE EXCEPTION 'Shadi day-rate is required — this driver requested shadi bookings.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicles (
    owner_name, vehicle_type, vehicle_number, model, color, total_seats, portal_user_id, is_active,
    delivers, per_km_pkr, offers_hourly, hourly_rate_pkr, hourly_included_km, hourly_overage_per_km_pkr,
    offers_shadi, shadi_full_day_rate_pkr, allows_out_of_city, night_booking_enabled
  ) VALUES (
    r.owner_name, r.vehicle_type, r.vehicle_number, r.model, r.color, r.total_seats, r.portal_user_id, true,
    r.wants_delivers, p_per_km_pkr, r.wants_hourly, p_hourly_rate_pkr, p_hourly_included_km, p_hourly_overage_per_km_pkr,
    r.wants_shadi, p_shadi_full_day_rate_pkr, r.wants_out_of_city, r.wants_night_booking
  ) RETURNING id INTO v_vehicle_id;

  UPDATE portal_users SET full_name = r.owner_name
   WHERE id = r.portal_user_id AND full_name IS DISTINCT FROM r.owner_name;

  UPDATE vehicle_registration_requests SET
    status = 'approved', is_village_resident = p_is_village_resident, reviewed_by = current_admin_user_id(), reviewed_at = now(), vehicle_id = v_vehicle_id
  WHERE id = p_request_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
  VALUES (r.portal_user_id, 'vehicle_registration_approved', 'Vehicle approved', r.owner_name || ' — ' || r.vehicle_type, '/portal/my-vehicle', r.tenant_id);

  RETURN v_vehicle_id;
END;
$function$;

create or replace function public.admin_approve_vehicle_registration(p_request_id uuid, p_is_village_resident boolean, p_per_km_pkr numeric DEFAULT NULL::numeric, p_hourly_rate_pkr numeric DEFAULT NULL::numeric, p_hourly_included_km numeric DEFAULT NULL::numeric, p_hourly_overage_per_km_pkr numeric DEFAULT NULL::numeric, p_shadi_full_day_rate_pkr numeric DEFAULT NULL::numeric, p_service_class_ids uuid[] DEFAULT NULL::uuid[])
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE r vehicle_registration_requests%ROWTYPE; v_vehicle_id uuid; v_class_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_registration_requests WHERE id = p_request_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'This request has already been reviewed.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM vehicles WHERE portal_user_id = r.portal_user_id) THEN
    RAISE EXCEPTION 'This driver already has a linked vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF r.wants_delivers AND p_per_km_pkr IS NULL THEN RAISE EXCEPTION 'Per-km rate is required — this driver requested delivery.' USING ERRCODE = 'P0001'; END IF;
  IF r.wants_hourly AND (p_hourly_rate_pkr IS NULL OR p_hourly_included_km IS NULL OR p_hourly_overage_per_km_pkr IS NULL) THEN
    RAISE EXCEPTION 'Hourly rate, included km and overage rate are required — this driver requested hourly rental.' USING ERRCODE = 'P0001';
  END IF;
  IF r.wants_shadi AND p_shadi_full_day_rate_pkr IS NULL THEN RAISE EXCEPTION 'Shadi day-rate is required — this driver requested shadi bookings.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicles (
    owner_name, vehicle_type, vehicle_number, model, color, total_seats, portal_user_id, is_active,
    delivers, per_km_pkr, offers_hourly, hourly_rate_pkr, hourly_included_km, hourly_overage_per_km_pkr,
    offers_shadi, shadi_full_day_rate_pkr, allows_out_of_city, night_booking_enabled
  ) VALUES (
    r.owner_name, r.vehicle_type, r.vehicle_number, r.model, r.color, r.total_seats, r.portal_user_id, true,
    r.wants_delivers, p_per_km_pkr, r.wants_hourly, p_hourly_rate_pkr, p_hourly_included_km, p_hourly_overage_per_km_pkr,
    r.wants_shadi, p_shadi_full_day_rate_pkr, r.wants_out_of_city, r.wants_night_booking
  ) RETURNING id INTO v_vehicle_id;

  -- Committee-confirmed classes only — p_service_class_ids is what the
  -- admin actually ticked on the review screen (pre-filled from what
  -- the driver requested, but the admin's own selection is what's
  -- trusted, exactly like every other field here).
  IF p_service_class_ids IS NOT NULL THEN
    FOREACH v_class_id IN ARRAY p_service_class_ids LOOP
      INSERT INTO vehicle_service_offers (vehicle_id, service_class_id) VALUES (v_vehicle_id, v_class_id)
      ON CONFLICT (vehicle_id, service_class_id) DO NOTHING;
    END LOOP;
  END IF;

  UPDATE vehicle_registration_requests SET
    status = 'approved', is_village_resident = p_is_village_resident, reviewed_by = current_admin_user_id(), reviewed_at = now(), vehicle_id = v_vehicle_id
  WHERE id = p_request_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
  VALUES (r.portal_user_id, 'vehicle_registration_approved', 'Vehicle approved', r.owner_name || ' — ' || r.vehicle_type, '/portal/my-vehicle', r.tenant_id);

  RETURN v_vehicle_id;
END;
$function$;

create or replace function public.admin_reject_vehicle_registration(p_request_id uuid, p_reason text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE r vehicle_registration_requests%ROWTYPE;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_registration_requests WHERE id = p_request_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'This request has already been reviewed.' USING ERRCODE = 'P0001'; END IF;
  IF trim(coalesce(p_reason, '')) = '' THEN RAISE EXCEPTION 'A reason is required.' USING ERRCODE = 'P0001'; END IF;

  UPDATE vehicle_registration_requests SET
    status = 'rejected', rejection_reason = trim(p_reason), reviewed_by = current_admin_user_id(), reviewed_at = now()
  WHERE id = p_request_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
  VALUES (r.portal_user_id, 'vehicle_registration_rejected', 'Vehicle registration declined', trim(p_reason), '/portal/my-vehicle', r.tenant_id);
END;
$function$;

create or replace function public.advance_shop_order_fulfillment(p_order_id uuid, p_status character varying)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  o shop_orders%ROWTYPE; s shops%ROWTYPE; v_is_keeper boolean; item RECORD;
  v_rank_current int; v_rank_new int;
  v_ranks jsonb := '{"pending":0,"accepted":1,"preparing":2,"out_for_delivery":3,"delivered":4}'::jsonb;
BEGIN
  IF p_status NOT IN ('preparing', 'out_for_delivery', 'delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid status' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO o FROM shop_orders WHERE id = p_order_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO s FROM shops WHERE id = o.shop_id;

  v_is_keeper := s.portal_user_id IS NOT NULL AND s.portal_user_id = current_portal_user_id() AND s.commission_mode = 'per_order';
  IF NOT (COALESCE(current_admin_permission('post_transactions'), false) OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF o.fulfillment_status IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'This order is already closed.' USING ERRCODE = 'P0001';
  END IF;

  IF p_status = 'cancelled' THEN
    IF o.status = 'confirmed' THEN
      RAISE EXCEPTION 'Payment for this order was already confirmed — reverse the voucher instead of cancelling here.' USING ERRCODE = 'P0001';
    END IF;
    FOR item IN SELECT product_id, quantity FROM shop_order_items WHERE order_id = p_order_id LOOP
      UPDATE shop_products SET quantity_on_hand = quantity_on_hand + item.quantity WHERE id = item.product_id;
    END LOOP;
    UPDATE shop_orders SET status = 'rejected', fulfillment_status = 'cancelled',
      rejected_reason = COALESCE(rejected_reason, 'Cancelled by shop') WHERE id = p_order_id;
    UPDATE shop_delivery_invitations SET status = 'expired', responded_at = now() WHERE order_id = p_order_id AND status = 'ringing';
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (o.portal_user_id, 'shop_order_cancelled', 'Order cancelled', 'Your order from ' || s.name || ' was cancelled.', '/portal/marketplace', o.tenant_id);
    RETURN;
  END IF;

  v_rank_current := (v_ranks->>o.fulfillment_status)::int;
  v_rank_new := (v_ranks->>p_status)::int;
  IF v_rank_new <> v_rank_current + 1 THEN
    RAISE EXCEPTION 'Orders must move through each step in order.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE shop_orders SET
    fulfillment_status = p_status,
    out_for_delivery_at = CASE WHEN p_status = 'out_for_delivery' THEN now() ELSE out_for_delivery_at END,
    delivered_at = CASE WHEN p_status = 'delivered' THEN now() ELSE delivered_at END
  WHERE id = p_order_id;

  IF p_status = 'out_for_delivery' THEN
    IF o.fulfillment_mode = 'delivery' THEN
      PERFORM start_shop_delivery_ring(p_order_id);
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
      VALUES (o.portal_user_id, 'shop_order_out_for_delivery', 'Order out for delivery', 'Your order from ' || s.name || ' is on its way — looking for a rider now.', '/portal/marketplace', o.tenant_id);
    ELSE
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
      VALUES (o.portal_user_id, 'shop_order_out_for_delivery', 'Ready for pickup', 'Your order from ' || s.name || ' is ready — come collect it.', '/portal/marketplace', o.tenant_id);
    END IF;
  ELSIF p_status = 'delivered' THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (o.portal_user_id, 'shop_order_delivered', 'Order delivered',
      CASE WHEN o.fulfillment_mode = 'pickup' THEN 'Thanks for shopping at ' || s.name || '!'
        ELSE 'Your order from ' || s.name || ' has been delivered. Thanks for shopping!' END,
      '/portal/marketplace', o.tenant_id);
  END IF;
END;
$function$;

create or replace function public.cancel_shadi_event(p_event_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE e shadi_events%ROWTYPE; r RECORD;
BEGIN
  SELECT * INTO e FROM shadi_events WHERE id = p_event_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR e.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'This is not your booking.' USING ERRCODE = 'P0001';
  END IF;
  IF e.status <> 'collecting' THEN RAISE EXCEPTION 'This booking can no longer be cancelled here — contact the committee.' USING ERRCODE = 'P0001'; END IF;

  FOR r IN SELECT * FROM shadi_vehicle_requests WHERE event_id = p_event_id AND status IN ('requested', 'accepted') LOOP
    IF r.status = 'accepted' THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
      SELECT v.portal_user_id, 'shadi_event_cancelled', 'Wedding booking cancelled', 'The booker cancelled this wedding booking.', '/portal/my-vehicle/shadi', e.tenant_id
      FROM vehicles v WHERE v.id = r.vehicle_id AND v.portal_user_id IS NOT NULL;
    END IF;
  END LOOP;
  UPDATE shadi_vehicle_requests SET status = 'cancelled' WHERE event_id = p_event_id AND status IN ('requested', 'accepted');
  UPDATE shadi_events SET status = 'cancelled' WHERE id = p_event_id;
END;
$function$;

create or replace function public.check_seller_balance_notify(p_kind character varying, p_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_account_id uuid; v_balance decimal; v_min decimal; v_warn decimal;
  v_portal_user_id uuid; v_warned_at timestamptz; v_inactive_at timestamptz; v_link text; v_tenant_id uuid;
BEGIN
  v_link := CASE WHEN p_kind = 'shop' THEN '/portal/my-shop/reports' ELSE '/portal/my-vehicle' END;

  IF p_kind = 'shop' THEN
    SELECT portal_user_id, low_balance_warned_at, inactive_notified_at, tenant_id INTO v_portal_user_id, v_warned_at, v_inactive_at, v_tenant_id FROM shops WHERE id = p_id;
    v_account_id := ensure_shop_account(p_id);
  ELSE
    SELECT portal_user_id, low_balance_warned_at, inactive_notified_at, tenant_id INTO v_portal_user_id, v_warned_at, v_inactive_at, v_tenant_id FROM vehicles WHERE id = p_id;
    v_account_id := ensure_vehicle_account(p_id);
  END IF;
  IF v_portal_user_id IS NULL THEN RETURN; END IF;

  SELECT COALESCE(value::decimal, 0) INTO v_min FROM site_settings WHERE key = 'marketplace_min_balance_to_order_pkr' AND tenant_id = v_tenant_id;
  SELECT COALESCE(value::decimal, 200) INTO v_warn FROM site_settings WHERE key = 'marketplace_low_balance_warning_pkr' AND tenant_id = v_tenant_id;

  v_balance := seller_account_balance(v_account_id);

  IF v_balance <= v_min THEN
    IF v_inactive_at IS NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
      VALUES (v_portal_user_id, 'marketplace_wallet_inactive', 'Your account is now inactive for new orders',
        'Your wallet balance has run out — top up to start receiving new orders/bookings again.', v_link, v_tenant_id);
      IF p_kind = 'shop' THEN UPDATE shops SET inactive_notified_at = now() WHERE id = p_id;
      ELSE UPDATE vehicles SET inactive_notified_at = now() WHERE id = p_id; END IF;
    END IF;
  ELSIF v_balance <= v_warn AND v_warned_at IS NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (v_portal_user_id, 'marketplace_wallet_low', 'Your wallet balance is running low',
      'Top up soon to avoid your account going inactive for new orders/bookings.', v_link, v_tenant_id);
    IF p_kind = 'shop' THEN UPDATE shops SET low_balance_warned_at = now() WHERE id = p_id;
    ELSE UPDATE vehicles SET low_balance_warned_at = now() WHERE id = p_id; END IF;
  END IF;
END;
$function$;

create or replace function public.complete_dispatch_call(p_call_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  c dispatch_calls%ROWTYPE; v vehicles%ROWTYPE;
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
      SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050' AND tenant_id = c.tenant_id;
      v_commission_pct := COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_dispatch_commission_pct' AND tenant_id = c.tenant_id), 0);
      v_commission_amount := round(v_fee_portion * v_commission_pct / 100, 2);
      IF v_commission_amount > 0 THEN
        INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
        VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
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
$function$;

create or replace function public.confirm_ride_booking(p_booking_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  b ride_bookings%ROWTYPE; ctx RECORD; v vehicles%ROWTYPE;
  v_vehicle_account uuid; v_cash_account uuid; v_commission_account uuid;
  v_commission_pct decimal; v_commission_amount decimal;
  v_gross_voucher_id uuid; v_gross_voucher_no varchar; v_commission_voucher_id uuid;
  v_is_keeper boolean;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'announced' THEN RAISE EXCEPTION 'This booking is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO ctx FROM ride_booking_context(p_booking_id);
  SELECT * INTO v FROM vehicles WHERE id = ctx.vehicle_id;

  v_is_keeper := v.portal_user_id IS NOT NULL AND v.portal_user_id = current_portal_user_id() AND v.commission_mode = 'per_order';
  IF NOT (COALESCE(current_admin_permission('post_transactions'), false) OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  v_vehicle_account := ensure_vehicle_account(v.id);
  SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050' AND tenant_id = b.tenant_id;

  IF v.commission_mode = 'per_order' THEN
    v_commission_pct := vehicle_commission_pct(v.vehicle_type, ctx.classification);
    v_commission_amount := round(b.total_amount_pkr * v_commission_pct / 100, 2);

    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — ' || ctx.origin || ' → ' || ctx.destination || ' ride (paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
      RETURNING id INTO v_commission_voucher_id;
    END IF;

    UPDATE ride_bookings SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
      commission_voucher_id = v_commission_voucher_id WHERE id = p_booking_id;

    PERFORM check_seller_balance_notify('vehicle', v.id);

    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (b.portal_user_id, 'ride_booking_confirmed', 'Booking confirmed',
      'Your seat booking for ' || ctx.origin || ' → ' || ctx.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || ' has been confirmed.', '/accounts', b.tenant_id);

    RETURN jsonb_build_object('amount', b.total_amount_pkr, 'commission', v_commission_amount);
  END IF;

  -- monthly_lumpsum: unchanged from 389/393.
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects'
    AND code = (CASE WHEN b.announced_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = b.tenant_id;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    ctx.origin || ' → ' || ctx.destination || ' — ' || b.seats || ' seat(s), ' || to_char(b.travel_date, 'DD Mon YYYY') || ' · paid via portal, confirmed',
    b.announced_amount_pkr, v_vehicle_account, v_cash_account, v.owner_name)
  RETURNING id, voucher_no INTO v_gross_voucher_id, v_gross_voucher_no;

  UPDATE ride_bookings SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
    gross_voucher_id = v_gross_voucher_id WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
  VALUES (b.portal_user_id, 'ride_booking_confirmed', 'Booking confirmed',
    'Your seat booking for ' || ctx.origin || ' → ' || ctx.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || ' has been confirmed.', '/accounts', b.tenant_id);

  RETURN jsonb_build_object('voucher_no', v_gross_voucher_no, 'amount', b.announced_amount_pkr);
END;
$function$;

create or replace function public.confirm_shadi_advance(p_event_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  e shadi_events%ROWTYPE; booker portal_users%ROWTYPE;
  v_liability_account uuid; v_cash_account uuid; v_voucher_id uuid; v_voucher_no varchar;
  r RECORD;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO e FROM shadi_events WHERE id = p_event_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'P0001'; END IF;
  IF e.status <> 'advance_announced' THEN RAISE EXCEPTION 'This advance is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO booker FROM portal_users WHERE id = e.portal_user_id;

  SELECT id INTO v_liability_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-5004' AND tenant_id = e.tenant_id;
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects' AND code = (CASE WHEN e.advance_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = e.tenant_id;

  -- Balance-sheet only — cash received, matched by a liability to the
  -- vehicles it's collected on behalf of. No income is recognised here.
  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'contra', (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Shadi vehicle booking advance held — ' || booker.full_name || ' (' || to_char(e.event_date, 'DD Mon YYYY') || ')', e.advance_amount_pkr, v_liability_account, v_cash_account, booker.full_name)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE shadi_events SET status = 'confirmed', advance_confirmed_at = now(), advance_confirmed_by = current_admin_user_id(), advance_voucher_id = v_voucher_id
  WHERE id = p_event_id;

  UPDATE shadi_vehicle_requests SET advance_share_pkr = round(full_day_rate_pkr * e.advance_pct / 100, 2)
  WHERE event_id = p_event_id AND status = 'accepted';

  FOR r IN SELECT sr.vehicle_id, sr.status, v.portal_user_id, sr.advance_share_pkr, sr.full_day_rate_pkr
           FROM shadi_vehicle_requests sr JOIN vehicles v ON v.id = sr.vehicle_id WHERE sr.event_id = p_event_id LOOP
    IF r.status = 'accepted' AND r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
      VALUES (r.portal_user_id, 'shadi_advance_confirmed', 'Wedding booking confirmed',
        'Confirmed for ' || to_char(e.event_date, 'DD Mon YYYY') || '. Rs ' || round(r.advance_share_pkr) || ' advance is held for you and will be released after the wedding date — collect the remaining Rs ' || round(r.full_day_rate_pkr - r.advance_share_pkr) || ' from the customer on the day.',
        '/portal/my-vehicle/shadi', e.tenant_id);
    END IF;
  END LOOP;

  UPDATE shadi_vehicle_requests SET status = 'cancelled' WHERE event_id = p_event_id AND status = 'requested';
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
  SELECT v.portal_user_id, 'shadi_request_auto_cancelled', 'Wedding request closed', 'This booking has been finalized with other vehicles.', '/portal/my-vehicle/shadi', e.tenant_id
  FROM shadi_vehicle_requests sr JOIN vehicles v ON v.id = sr.vehicle_id
  WHERE sr.event_id = p_event_id AND sr.status = 'cancelled' AND sr.responded_at IS NULL AND v.portal_user_id IS NOT NULL;

  IF e.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (e.portal_user_id, 'shadi_advance_confirmed', 'Advance confirmed', 'Your wedding booking is confirmed.', '/portal/marketplace/shadi/' || e.id, e.tenant_id);
  END IF;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', e.advance_amount_pkr);
END;
$function$;

create or replace function public.confirm_shop_order(p_order_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  o shop_orders%ROWTYPE; s shops%ROWTYPE;
  v_shop_account uuid; v_cash_account uuid; v_commission_account uuid;
  v_commission_pct decimal; v_commission_amount decimal; v_goods_total decimal;
  v_gross_voucher_id uuid; v_gross_voucher_no varchar; v_commission_voucher_id uuid;
  v_is_keeper boolean;
BEGIN
  SELECT * INTO o FROM shop_orders WHERE id = p_order_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0001'; END IF;
  IF o.status <> 'announced' THEN RAISE EXCEPTION 'This order is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO s FROM shops WHERE id = o.shop_id;

  v_is_keeper := s.portal_user_id IS NOT NULL AND s.portal_user_id = current_portal_user_id() AND s.commission_mode = 'per_order';
  IF NOT (COALESCE(current_admin_permission('post_transactions'), false) OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  v_shop_account := ensure_shop_account(o.shop_id);
  SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050' AND tenant_id = o.tenant_id;

  IF s.commission_mode = 'per_order' THEN
    v_commission_pct := COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_shop_commission_pct' AND tenant_id = o.tenant_id), 0);
    v_goods_total := o.total_amount_pkr - COALESCE(o.delivery_fee_pkr, 0);
    v_commission_amount := round(v_goods_total * v_commission_pct / 100, 2);

    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — order from ' || s.name || ' (paid directly to shop)', v_commission_amount, v_commission_account, v_shop_account, s.name)
      RETURNING id INTO v_commission_voucher_id;
    END IF;

    UPDATE shop_orders SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
      commission_voucher_id = v_commission_voucher_id WHERE id = p_order_id;

    PERFORM check_seller_balance_notify('shop', o.shop_id);

    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (o.portal_user_id, 'shop_order_confirmed', 'Order confirmed', 'Your order from ' || s.name || ' has been confirmed.', '/accounts', o.tenant_id);

    RETURN jsonb_build_object('amount', o.total_amount_pkr, 'commission', v_commission_amount);
  END IF;

  -- monthly_lumpsum: unchanged — the shop keeps 100% of what it collected
  -- (goods + delivery fee both), no commission voucher at all here.
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects'
    AND code = (CASE WHEN o.announced_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = o.tenant_id;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Order from ' || s.name || ' — paid via portal, confirmed', o.announced_amount_pkr, v_shop_account, v_cash_account, s.name)
  RETURNING id, voucher_no INTO v_gross_voucher_id, v_gross_voucher_no;

  UPDATE shop_orders SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
    gross_voucher_id = v_gross_voucher_id WHERE id = p_order_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
  VALUES (o.portal_user_id, 'shop_order_confirmed', 'Order confirmed', 'Your order from ' || s.name || ' has been confirmed.', '/accounts', o.tenant_id);

  RETURN jsonb_build_object('voucher_no', v_gross_voucher_no, 'amount', o.announced_amount_pkr);
END;
$function$;

create or replace function public.confirm_shop_wallet_topup(p_topup_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE t shop_wallet_topups%ROWTYPE; s shops%ROWTYPE; v_shop_account uuid; v_cash_account uuid; v_voucher_id uuid; v_voucher_no varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO t FROM shop_wallet_topups WHERE id = p_topup_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Top-up not found' USING ERRCODE = 'P0001'; END IF;
  IF t.status <> 'announced' THEN RAISE EXCEPTION 'This top-up is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO s FROM shops WHERE id = t.shop_id;
  v_shop_account := ensure_shop_account(t.shop_id);
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects' AND code = (CASE WHEN t.announced_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = t.tenant_id;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date, 'Wallet top-up — ' || s.name, t.amount_pkr, v_shop_account, v_cash_account, s.name)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE shop_wallet_topups SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(), voucher_id = v_voucher_id WHERE id = p_topup_id;
  UPDATE shops SET low_balance_warned_at = NULL, inactive_notified_at = NULL WHERE id = t.shop_id;

  IF s.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (s.portal_user_id, 'shop_wallet_topup_confirmed', 'Top-up confirmed', 'Your wallet top-up has been confirmed.', '/portal/my-shop/reports', t.tenant_id);
  END IF;
  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', t.amount_pkr);
END;
$function$;

create or replace function public.confirm_vehicle_wallet_topup(p_topup_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE t vehicle_wallet_topups%ROWTYPE; v vehicles%ROWTYPE; v_vehicle_account uuid; v_cash_account uuid; v_voucher_id uuid; v_voucher_no varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO t FROM vehicle_wallet_topups WHERE id = p_topup_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Top-up not found' USING ERRCODE = 'P0001'; END IF;
  IF t.status <> 'announced' THEN RAISE EXCEPTION 'This top-up is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = t.vehicle_id;
  v_vehicle_account := ensure_vehicle_account(t.vehicle_id);
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects' AND code = (CASE WHEN t.announced_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = t.tenant_id;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date, 'Wallet top-up — ' || v.owner_name, t.amount_pkr, v_vehicle_account, v_cash_account, v.owner_name)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE vehicle_wallet_topups SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(), voucher_id = v_voucher_id WHERE id = p_topup_id;
  UPDATE vehicles SET low_balance_warned_at = NULL, inactive_notified_at = NULL WHERE id = t.vehicle_id;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (v.portal_user_id, 'vehicle_wallet_topup_confirmed', 'Top-up confirmed', 'Your wallet top-up has been confirmed.', '/portal/my-vehicle', t.tenant_id);
  END IF;
  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', t.amount_pkr);
END;
$function$;

create or replace function public.create_city_purchase_request(p_city_id uuid, p_item text, p_item_attachment_path text DEFAULT NULL::text, p_pickup_label text DEFAULT NULL::text, p_pickup_lat numeric DEFAULT NULL::numeric, p_pickup_lng numeric DEFAULT NULL::numeric, p_goods_budget_pkr numeric DEFAULT 0, p_target_vehicle_id uuid DEFAULT NULL::uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id(); v_request_id uuid; v_count int;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_item IS NULL OR trim(p_item) = '' THEN RAISE EXCEPTION 'Describe what you need first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cities WHERE id = p_city_id AND is_active AND tenant_id = my_tenant_id()) THEN RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001'; END IF;
  IF p_goods_budget_pkr IS NULL OR p_goods_budget_pkr < 0 THEN RAISE EXCEPTION 'Enter a valid amount, or 0 if unsure.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO city_purchase_requests (initiator_portal_user_id, city_id, item, item_attachment_path, pickup_label, pickup_lat, pickup_lng, goods_budget_pkr, status)
  VALUES (v_portal_user_id, p_city_id, trim(p_item), NULLIF(p_item_attachment_path, ''), NULLIF(p_pickup_label, ''), p_pickup_lat, p_pickup_lng, p_goods_budget_pkr, 'ringing')
  RETURNING id INTO v_request_id;

  IF p_target_vehicle_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_target_vehicle_id AND is_active AND is_online AND tenant_id = my_tenant_id() AND vehicle_delivery_eligible(id)) THEN
      RAISE EXCEPTION 'That vehicle is not available right now.' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination)
    SELECT v_request_id, c.vehicle_id, c.source, c.reference_destination
    FROM city_purchase_candidate_vehicles(p_city_id, p_pickup_lat, p_pickup_lng) c WHERE c.vehicle_id = p_target_vehicle_id;
    IF NOT FOUND THEN
      INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination) VALUES (v_request_id, p_target_vehicle_id, 'direct', NULL);
    END IF;
  ELSE
    INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination)
    SELECT v_request_id, c.vehicle_id, c.source, c.reference_destination FROM city_purchase_candidate_vehicles(p_city_id, p_pickup_lat, p_pickup_lng) c;
  END IF;

  SELECT count(*) INTO v_count FROM city_purchase_invitations WHERE request_id = v_request_id;
  IF v_count = 0 THEN
    UPDATE city_purchase_requests SET status = 'no_answer' WHERE id = v_request_id;
  ELSE
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT v.portal_user_id, 'city_purchase_invited', 'City purchase request', p_item, '/portal/marketplace/city-purchase/' || v_request_id
    FROM city_purchase_invitations i JOIN vehicles v ON v.id = i.vehicle_id WHERE i.request_id = v_request_id AND v.portal_user_id IS NOT NULL;
  END IF;

  RETURN v_request_id;
END;
$function$;

create or replace function public.create_dispatch_call(p_city_shop_id uuid, p_item text, p_address text, p_goods_budget_pkr numeric)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id(); v_call_id uuid; v_tier1_count int;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_item IS NULL OR trim(p_item) = '' THEN RAISE EXCEPTION 'Describe the order first.' USING ERRCODE = 'P0001'; END IF;
  IF p_address IS NULL OR trim(p_address) = '' THEN RAISE EXCEPTION 'Enter a delivery address.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM city_shops WHERE id = p_city_shop_id AND is_active AND tenant_id = my_tenant_id()) THEN
    RAISE EXCEPTION 'This shop is not available.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO dispatch_calls (initiator_portal_user_id, city_shop_id, item, address, goods_budget_pkr, status)
  VALUES (v_portal_user_id, p_city_shop_id, p_item, p_address, p_goods_budget_pkr, 'tier1')
  RETURNING id INTO v_call_id;

  v_tier1_count := invite_dispatch_tier(v_call_id, 1);
  IF v_tier1_count = 0 THEN
    -- Nobody there right now — go straight to tier 2 instead of ringing
    -- an empty room for 60 seconds.
    PERFORM invite_dispatch_tier(v_call_id, 2);
    UPDATE dispatch_calls SET status = 'tier2', tier2_started_at = now() WHERE id = v_call_id;
  END IF;

  -- Notify everyone invited in whichever tier actually got invitations.
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'dispatch_invited', 'Delivery request', p_item, '/portal/marketplace/dispatch/' || v_call_id
  FROM dispatch_invitations i JOIN vehicles v ON v.id = i.vehicle_id
  WHERE i.call_id = v_call_id AND v.portal_user_id IS NOT NULL;

  RETURN v_call_id;
END;
$function$;

create or replace function public.create_hourly_booking(p_vehicle_id uuid, p_hours integer, p_pickup_address text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v vehicles%ROWTYPE;
  v_booking_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_hours IS NULL OR p_hours <= 0 THEN RAISE EXCEPTION 'Enter how many hours you need.' USING ERRCODE = 'P0001'; END IF;
  IF p_pickup_address IS NULL OR trim(p_pickup_address) = '' THEN RAISE EXCEPTION 'Enter a pickup address.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active AND offers_hourly AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available for hourly booking.' USING ERRCODE = 'P0001'; END IF;
  IF v.hourly_rate_pkr IS NULL THEN RAISE EXCEPTION 'This vehicle has no rate set yet.' USING ERRCODE = 'P0001'; END IF;
  IF v.portal_user_id = v_portal_user_id THEN RAISE EXCEPTION 'You cannot book your own vehicle.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO hourly_bookings (portal_user_id, vehicle_id, hours, pickup_address, hourly_rate_pkr, included_km, overage_per_km_pkr, base_amount_pkr)
  VALUES (v_portal_user_id, p_vehicle_id, p_hours, trim(p_pickup_address), v.hourly_rate_pkr, COALESCE(v.hourly_included_km, 0) * p_hours, COALESCE(v.hourly_overage_per_km_pkr, 0), v.hourly_rate_pkr * p_hours)
  RETURNING id INTO v_booking_id;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'hourly_booking_requested', 'Hourly rental request',
      p_hours || ' hour(s) — Rs ' || round(v.hourly_rate_pkr * p_hours), '/portal/my-vehicle/hourly');
  END IF;

  RETURN v_booking_id;
END;
$function$;

create or replace function public.create_shadi_event(p_event_date date, p_venue_address text, p_distance_km numeric, p_notes text, p_vehicle_ids uuid[])
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_event_id uuid;
  v_vehicle_id uuid;
  v vehicles%ROWTYPE;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_event_date IS NULL OR p_event_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN
    RAISE EXCEPTION 'Pick a wedding date that has not already passed.' USING ERRCODE = 'P0001';
  END IF;
  IF p_venue_address IS NULL OR trim(p_venue_address) = '' THEN RAISE EXCEPTION 'Enter the venue address.' USING ERRCODE = 'P0001'; END IF;
  IF p_distance_km IS NULL OR p_distance_km < 0 THEN RAISE EXCEPTION 'Enter the approximate distance.' USING ERRCODE = 'P0001'; END IF;
  IF p_vehicle_ids IS NULL OR array_length(p_vehicle_ids, 1) IS NULL OR array_length(p_vehicle_ids, 1) = 0 THEN
    RAISE EXCEPTION 'Select at least one vehicle.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO shadi_events (portal_user_id, event_date, venue_address, distance_km, notes)
  VALUES (v_portal_user_id, p_event_date, trim(p_venue_address), p_distance_km, NULLIF(trim(p_notes), ''))
  RETURNING id INTO v_event_id;

  FOREACH v_vehicle_id IN ARRAY p_vehicle_ids LOOP
    SELECT * INTO v FROM vehicles WHERE id = v_vehicle_id AND is_active AND offers_shadi AND tenant_id = my_tenant_id();
    IF NOT FOUND OR v.shadi_full_day_rate_pkr IS NULL THEN
      RAISE EXCEPTION 'One of the selected vehicles is no longer available for wedding booking.' USING ERRCODE = 'P0001';
    END IF;
    IF v.portal_user_id = v_portal_user_id THEN RAISE EXCEPTION 'You cannot book your own vehicle.' USING ERRCODE = 'P0001'; END IF;

    INSERT INTO shadi_vehicle_requests (event_id, vehicle_id, full_day_rate_pkr) VALUES (v_event_id, v_vehicle_id, v.shadi_full_day_rate_pkr);

    IF v.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (v.portal_user_id, 'shadi_request_received', 'Wedding booking request',
        'For ' || to_char(p_event_date, 'DD Mon YYYY') || ' — Rs ' || round(v.shadi_full_day_rate_pkr) || ' full day', '/portal/my-vehicle/shadi');
    END IF;
  END LOOP;

  RETURN v_event_id;
END;
$function$;

create or replace function public.end_hourly_trip(p_booking_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE b hourly_bookings%ROWTYPE; v vehicles%ROWTYPE; v_overage_km decimal; v_overage_amount decimal; v_total decimal;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'in_progress' THEN RAISE EXCEPTION 'This trip is not in progress.' USING ERRCODE = 'P0001'; END IF;

  v_overage_km := greatest(0, b.distance_km - b.included_km);
  v_overage_amount := round(v_overage_km * b.overage_per_km_pkr, 2);
  v_total := b.base_amount_pkr + v_overage_amount;

  UPDATE hourly_bookings SET status = 'completed', ended_at = now(),
    overage_km = v_overage_km, overage_amount_pkr = v_overage_amount, total_amount_pkr = v_total
  WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
  VALUES (b.portal_user_id, 'hourly_booking_completed', 'Trip completed',
    'Distance: ' || round(b.distance_km, 1) || 'km — Total: Rs ' || round(v_total), '/portal/marketplace', b.tenant_id);

  RETURN jsonb_build_object('distance_km', b.distance_km, 'overage_km', v_overage_km, 'overage_amount_pkr', v_overage_amount, 'total_amount_pkr', v_total);
END;
$function$;

create or replace function public.invite_shadi_replacement(p_event_id uuid, p_withdrawn_request_id uuid, p_vehicle_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE e shadi_events%ROWTYPE; withdrawn shadi_vehicle_requests%ROWTYPE; v vehicles%ROWTYPE; v_request_id uuid;
BEGIN
  SELECT * INTO e FROM shadi_events WHERE id = p_event_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'P0001'; END IF;
  IF e.portal_user_id <> current_portal_user_id() THEN RAISE EXCEPTION 'This is not your booking.' USING ERRCODE = 'P0001'; END IF;
  -- Stated explicitly rather than relied on implicitly: a reserved
  -- advance_share_pkr only ever exists once confirm_shadi_advance has
  -- run, which only ever happens once an event reaches 'confirmed' —
  -- but spelling it out here keeps this function correct even if that
  -- invariant ever changes elsewhere.
  IF e.status <> 'confirmed' THEN RAISE EXCEPTION 'This event is not confirmed yet.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO withdrawn FROM shadi_vehicle_requests WHERE id = p_withdrawn_request_id AND event_id = p_event_id;
  IF NOT FOUND OR withdrawn.status <> 'withdrawn' THEN RAISE EXCEPTION 'That vehicle slot is not open for replacement.' USING ERRCODE = 'P0001'; END IF;
  IF withdrawn.advance_share_pkr IS NULL THEN RAISE EXCEPTION 'This slot has no reserved advance to transfer.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM shadi_vehicle_requests WHERE replaces_request_id = p_withdrawn_request_id AND status IN ('requested', 'accepted')) THEN
    RAISE EXCEPTION 'A replacement is already pending or accepted for this slot.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active AND offers_shadi AND tenant_id = e.tenant_id;
  IF NOT FOUND OR v.shadi_full_day_rate_pkr IS NULL THEN RAISE EXCEPTION 'This vehicle is not available for wedding booking.' USING ERRCODE = 'P0001'; END IF;
  IF v.portal_user_id = e.portal_user_id THEN RAISE EXCEPTION 'You cannot book your own vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM shadi_vehicle_requests WHERE event_id = p_event_id AND vehicle_id = p_vehicle_id AND status NOT IN ('declined', 'withdrawn', 'cancelled')) THEN
    RAISE EXCEPTION 'This vehicle already has a live request for this event.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO shadi_vehicle_requests (event_id, vehicle_id, full_day_rate_pkr, replaces_request_id)
  VALUES (p_event_id, p_vehicle_id, v.shadi_full_day_rate_pkr, p_withdrawn_request_id)
  RETURNING id INTO v_request_id;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (v.portal_user_id, 'shadi_request_received', 'Wedding booking request (replacing another vehicle)',
      'For ' || to_char(e.event_date, 'DD Mon YYYY') || ' — Rs ' || round(v.shadi_full_day_rate_pkr) || ' full day', '/portal/my-vehicle/shadi', e.tenant_id);
  END IF;
  RETURN v_request_id;
END;
$function$;

create or replace function public.place_shop_order(p_shop_id uuid, p_items jsonb, p_method character varying, p_proof_url text, p_fulfillment_mode character varying, p_delivery_address text DEFAULT NULL::text, p_village_id uuid DEFAULT NULL::uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_buyer_mobile varchar;
  v_shop shops%ROWTYPE;
  v_order_id uuid;
  v_total decimal := 0;
  v_delivery_fee decimal := 0;
  v_grand_total decimal;
  r jsonb;
  v_product shop_products%ROWTYPE;
  v_qty decimal;
  v_line_total decimal;
  v_admin RECORD;
  v_staff_notify_enabled boolean;
  v_commission_pct decimal;
  v_expected_commission decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_fulfillment_mode NOT IN ('pickup', 'delivery') THEN
    RAISE EXCEPTION 'Choose pickup or delivery.' USING ERRCODE = 'P0001';
  END IF;
  IF p_fulfillment_mode = 'delivery' THEN
    IF p_delivery_address IS NULL OR trim(p_delivery_address) = '' THEN
      RAISE EXCEPTION 'Enter a delivery address.' USING ERRCODE = 'P0001';
    END IF;
    SELECT delivery_fee_pkr INTO v_delivery_fee FROM villages WHERE id = p_village_id AND is_active AND tenant_id = my_tenant_id();
    IF NOT FOUND THEN RAISE EXCEPTION 'Choose where this should be delivered.' USING ERRCODE = 'P0001'; END IF;
  END IF;

  SELECT * INTO v_shop FROM shops WHERE id = p_shop_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Shop not found' USING ERRCODE = 'P0001'; END IF;
  IF v_shop.status <> 'active' THEN RAISE EXCEPTION 'This shop is not currently active.' USING ERRCODE = 'P0001'; END IF;
  IF NOT v_shop.delivery_enabled THEN
    RAISE EXCEPTION 'This shop does not offer online ordering — visit the store to buy.' USING ERRCODE = 'P0001';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'Your cart is empty.' USING ERRCODE = 'P0001'; END IF;

  IF v_shop.commission_mode = 'monthly_lumpsum' THEN
    IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  ELSIF NOT shop_bookable(p_shop_id) THEN
    RAISE EXCEPTION 'This shop is closed or temporarily unable to take new orders — try again later or visit in person.' USING ERRCODE = 'P0001';
  END IF;

  SELECT mobile INTO v_buyer_mobile FROM portal_users WHERE id = v_portal_user_id;

  INSERT INTO shop_orders (shop_id, portal_user_id, status, announced_method, announced_proof_url, announced_at,
    delivery_address, buyer_mobile, fulfillment_mode, village_id)
  VALUES (p_shop_id, v_portal_user_id, 'announced', p_method, p_proof_url, now(),
    NULLIF(trim(COALESCE(p_delivery_address, '')), ''), v_buyer_mobile, p_fulfillment_mode,
    CASE WHEN p_fulfillment_mode = 'delivery' THEN p_village_id ELSE NULL END)
  RETURNING id INTO v_order_id;

  FOR r IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := (r->>'quantity')::decimal;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Invalid quantity in cart.' USING ERRCODE = 'P0001'; END IF;

    SELECT * INTO v_product FROM shop_products WHERE id = (r->>'product_id')::uuid AND shop_id = p_shop_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'One of the items in your cart is no longer available.' USING ERRCODE = 'P0001'; END IF;
    IF NOT v_product.is_active THEN RAISE EXCEPTION '% is no longer available.', v_product.name USING ERRCODE = 'P0001'; END IF;
    IF v_qty > v_product.quantity_on_hand THEN
      RAISE EXCEPTION 'Only % of % left in stock.', v_product.quantity_on_hand, v_product.name USING ERRCODE = 'P0001';
    END IF;

    v_line_total := v_qty * v_product.unit_price_pkr;
    v_total := v_total + v_line_total;

    INSERT INTO shop_order_items (order_id, product_id, quantity, unit_price_pkr)
    VALUES (v_order_id, v_product.id, v_qty, v_product.unit_price_pkr);

    UPDATE shop_products SET quantity_on_hand = quantity_on_hand - v_qty WHERE id = v_product.id;
  END LOOP;

  IF v_shop.commission_mode = 'per_order' THEN
    v_commission_pct := COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_shop_commission_pct' AND tenant_id = v_shop.tenant_id), 0);
    v_expected_commission := round(v_total * v_commission_pct / 100, 2);
    IF seller_account_balance(ensure_shop_account(p_shop_id)) < v_expected_commission THEN
      RAISE EXCEPTION 'This shop''s wallet balance is too low to cover this order''s commission — the shop needs to top up first.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_grand_total := v_total + v_delivery_fee;
  UPDATE shop_orders SET total_amount_pkr = v_grand_total, announced_amount_pkr = v_grand_total, delivery_fee_pkr = v_delivery_fee
    WHERE id = v_order_id;

  IF v_shop.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (v_shop.portal_user_id, 'shop_order_received', 'New order received',
      'A new order worth Rs ' || round(v_grand_total) || ' just came in.', '/portal/my-shop/reports', v_shop.tenant_id);
  ELSE
    SELECT popup_enabled INTO v_staff_notify_enabled FROM notification_preferences WHERE event_type = 'shop_order_received' AND tenant_id = v_shop.tenant_id;
    IF v_staff_notify_enabled IS DISTINCT FROM false THEN
      FOR v_admin IN SELECT id FROM admin_users WHERE is_active = true AND (role = 'super_admin' OR can_manage_parties) AND access_donors_projects AND tenant_id = v_shop.tenant_id LOOP
        INSERT INTO notifications (recipient_id, event_type, title, body, link, tenant_id)
        VALUES (v_admin.id, 'shop_order_received', 'New marketplace order',
          'New order for ' || v_shop.name || ' worth Rs ' || round(v_grand_total) || '.', '/admin/shops?shop=' || p_shop_id, v_shop.tenant_id);
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object('order_id', v_order_id, 'total', v_grand_total, 'goods_total', v_total, 'delivery_fee', v_delivery_fee);
END;
$function$;

create or replace function public.reject_ride_booking(p_booking_id uuid, p_reason text DEFAULT NULL::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE b ride_bookings%ROWTYPE; ctx RECORD; v vehicles%ROWTYPE; v_is_keeper boolean;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'announced' THEN RAISE EXCEPTION 'This booking is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO ctx FROM ride_booking_context(p_booking_id);
  SELECT * INTO v FROM vehicles WHERE id = ctx.vehicle_id;

  v_is_keeper := v.portal_user_id IS NOT NULL AND v.portal_user_id = current_portal_user_id() AND v.commission_mode = 'per_order';
  IF NOT (COALESCE(current_admin_permission('post_transactions'), false) OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  UPDATE ride_bookings SET status = 'rejected', rejected_reason = p_reason WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
  VALUES (b.portal_user_id, 'ride_booking_rejected', 'Booking could not be confirmed',
    'Your seat booking for ' || ctx.origin || ' → ' || ctx.destination || ' could not be confirmed.' || COALESCE(' ' || p_reason, ''), '/accounts', b.tenant_id);
END;
$function$;

create or replace function public.reject_shadi_advance(p_event_id uuid, p_reason text DEFAULT NULL::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE e shadi_events%ROWTYPE;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO e FROM shadi_events WHERE id = p_event_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'P0001'; END IF;
  IF e.status <> 'advance_announced' THEN RAISE EXCEPTION 'This advance is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;

  UPDATE shadi_events SET status = 'collecting', advance_rejected_reason = p_reason WHERE id = p_event_id;
  IF e.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (e.portal_user_id, 'shadi_advance_rejected', 'Advance could not be confirmed',
      'Your payment could not be confirmed.' || COALESCE(' ' || p_reason, '') || ' Please try again.', '/portal/marketplace/shadi/' || e.id, e.tenant_id);
  END IF;
END;
$function$;

create or replace function public.reject_shop_wallet_topup(p_topup_id uuid, p_reason text DEFAULT NULL::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE t shop_wallet_topups%ROWTYPE; s shops%ROWTYPE;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO t FROM shop_wallet_topups WHERE id = p_topup_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Top-up not found' USING ERRCODE = 'P0001'; END IF;
  IF t.status <> 'announced' THEN RAISE EXCEPTION 'This top-up is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO s FROM shops WHERE id = t.shop_id;
  UPDATE shop_wallet_topups SET status = 'rejected', rejected_reason = p_reason WHERE id = p_topup_id;
  IF s.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (s.portal_user_id, 'shop_wallet_topup_rejected', 'Top-up could not be confirmed', 'Your wallet top-up could not be confirmed.' || COALESCE(' ' || p_reason, ''), '/portal/my-shop/reports', t.tenant_id);
  END IF;
END;
$function$;

create or replace function public.reject_vehicle_wallet_topup(p_topup_id uuid, p_reason text DEFAULT NULL::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE t vehicle_wallet_topups%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO t FROM vehicle_wallet_topups WHERE id = p_topup_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Top-up not found' USING ERRCODE = 'P0001'; END IF;
  IF t.status <> 'announced' THEN RAISE EXCEPTION 'This top-up is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = t.vehicle_id;
  UPDATE vehicle_wallet_topups SET status = 'rejected', rejected_reason = p_reason WHERE id = p_topup_id;
  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (v.portal_user_id, 'vehicle_wallet_topup_rejected', 'Top-up could not be confirmed', 'Your wallet top-up could not be confirmed.' || COALESCE(' ' || p_reason, ''), '/portal/my-vehicle', t.tenant_id);
  END IF;
END;
$function$;

create or replace function public.respond_hourly_booking(p_booking_id uuid, p_accept boolean, p_reason text DEFAULT NULL::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE b hourly_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'requested' THEN RAISE EXCEPTION 'This booking has already been responded to.' USING ERRCODE = 'P0001'; END IF;

  UPDATE hourly_bookings SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END,
    responded_at = now(), decline_reason = CASE WHEN p_accept THEN NULL ELSE p_reason END
  WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
  VALUES (b.portal_user_id, CASE WHEN p_accept THEN 'hourly_booking_accepted' ELSE 'hourly_booking_declined' END,
    CASE WHEN p_accept THEN 'Booking accepted' ELSE 'Booking declined' END,
    CASE WHEN p_accept THEN v.owner_name || ' will pick you up.'
      ELSE 'This vehicle is not available for your booking.' || COALESCE(' — ' || p_reason, '') END,
    '/portal/marketplace', b.tenant_id);
END;
$function$;

create or replace function public.respond_shadi_request(p_request_id uuid, p_accept boolean, p_reason text DEFAULT NULL::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE r shadi_vehicle_requests%ROWTYPE; e shadi_events%ROWTYPE; v vehicles%ROWTYPE; v_transfer_share decimal;
BEGIN
  SELECT * INTO r FROM shadi_vehicle_requests WHERE id = p_request_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = r.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF r.status <> 'requested' THEN RAISE EXCEPTION 'This request has already been responded to.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO e FROM shadi_events WHERE id = r.event_id;
  -- A replacement request's event is already 'confirmed' by definition
  -- (that's the only state a withdrawal/replacement can happen in) —
  -- only freeze responses for the normal, pre-confirmation collecting
  -- window.
  IF r.replaces_request_id IS NULL AND e.status <> 'collecting' THEN
    RAISE EXCEPTION 'This booking is no longer accepting responses.' USING ERRCODE = 'P0001';
  END IF;

  IF p_accept AND EXISTS (
    SELECT 1 FROM shadi_vehicle_requests r2 JOIN shadi_events e2 ON e2.id = r2.event_id
    WHERE r2.vehicle_id = r.vehicle_id AND r2.id <> r.id AND r2.status = 'accepted' AND e2.event_date = e.event_date AND e2.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'This vehicle is already booked for another wedding on that date.' USING ERRCODE = 'P0001';
  END IF;

  IF p_accept AND r.replaces_request_id IS NOT NULL THEN
    SELECT advance_share_pkr INTO v_transfer_share FROM shadi_vehicle_requests WHERE id = r.replaces_request_id FOR UPDATE;
    UPDATE shadi_vehicle_requests SET status = 'accepted', responded_at = now(), advance_share_pkr = v_transfer_share WHERE id = p_request_id;
    -- Consumed — prevents a second replacement invite from claiming the same reservation.
    UPDATE shadi_vehicle_requests SET advance_share_pkr = NULL WHERE id = r.replaces_request_id;
  ELSE
    UPDATE shadi_vehicle_requests SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END,
      responded_at = now(), decline_reason = CASE WHEN p_accept THEN NULL ELSE p_reason END
    WHERE id = p_request_id;
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
  VALUES (e.portal_user_id, CASE WHEN p_accept THEN 'shadi_request_accepted' ELSE 'shadi_request_declined' END,
    CASE WHEN p_accept THEN 'A driver accepted your wedding request' ELSE 'A driver declined your wedding request' END,
    CASE WHEN p_accept THEN v.owner_name || ' will be available on ' || to_char(e.event_date, 'DD Mon YYYY') || '.'
      ELSE v.owner_name || ' is not available.' || COALESCE(' — ' || p_reason, '') END,
    '/portal/marketplace/shadi/' || e.id, r.tenant_id);
END;
$function$;

create or replace function public.review_mentor_request(p_portal_user_id uuid, p_approve boolean)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_admin_id uuid;
BEGIN
  v_admin_id := current_admin_user_id();
  IF current_admin_role() NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Only an Admin or Super Admin can review a mentor request';
  END IF;

  UPDATE portal_users SET
    mentor_status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
    mentor_reviewed_at = now(), mentor_reviewed_by = v_admin_id
  WHERE id = p_portal_user_id AND mentor_status = 'pending' AND tenant_id = my_tenant_id();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No pending mentor request for this user';
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT p_portal_user_id, 'mentor_review',
    CASE WHEN p_approve THEN 'You''re approved as a mentor!' ELSE 'Your mentor request wasn''t approved' END,
    CASE WHEN p_approve THEN 'You can now be found in the mentor directory and students can start a chat with you.'
         ELSE 'If you think this was a mistake, message us on WhatsApp.' END,
    '/portal/mentor';
END;
$function$;

create or replace function public.start_negotiation(p_kind character varying, p_vehicle_id uuid, p_item text, p_qty text DEFAULT NULL::text, p_budget_pkr numeric DEFAULT NULL::numeric, p_city_id uuid DEFAULT NULL::uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v vehicles%ROWTYPE; v_thread_id uuid; v_body text;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_kind NOT IN ('fetch', 'share', 'pro') THEN RAISE EXCEPTION 'Invalid request kind.' USING ERRCODE = 'P0001'; END IF;
  IF p_item IS NULL OR trim(p_item) = '' THEN RAISE EXCEPTION 'Describe what you need first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF v.portal_user_id = v_portal_user_id THEN
    RAISE EXCEPTION 'You cannot send a request to your own vehicle.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO negotiation_threads (kind, initiator_portal_user_id, vehicle_id, city_id, item, qty, budget_pkr)
  VALUES (p_kind, v_portal_user_id, p_vehicle_id, p_city_id, p_item, p_qty, p_budget_pkr)
  RETURNING id INTO v_thread_id;

  v_body := p_item || COALESCE(' · ' || p_qty, '') || COALESCE(' · budget Rs ' || p_budget_pkr::text, '');
  INSERT INTO negotiation_messages (thread_id, sender_role, kind, body)
  VALUES (v_thread_id, 'user', 'text', v_body);

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'negotiation_started',
      CASE WHEN p_kind = 'fetch' THEN 'New item request' WHEN p_kind = 'pro' THEN 'New service request' ELSE 'New seat request' END,
      v_body, '/portal/marketplace/negotiations/' || v_thread_id);
  END IF;

  RETURN v_thread_id;
END;
$function$;

create or replace function public.withdraw_shadi_request(p_request_id uuid, p_reason text DEFAULT NULL::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE r shadi_vehicle_requests%ROWTYPE; e shadi_events%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM shadi_vehicle_requests WHERE id = p_request_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = r.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF r.status <> 'accepted' THEN RAISE EXCEPTION 'Only an accepted booking can be withdrawn.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO e FROM shadi_events WHERE id = r.event_id;
  IF e.event_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN
    RAISE EXCEPTION 'The wedding date has already passed — contact the committee directly.' USING ERRCODE = 'P0001';
  END IF;
  IF e.status = 'advance_announced' THEN
    RAISE EXCEPTION 'The customer''s advance payment is awaiting confirmation — wait for that to resolve first.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE shadi_vehicle_requests SET status = 'withdrawn', withdrawn_at = now(), decline_reason = p_reason WHERE id = p_request_id;

  IF e.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (e.portal_user_id, 'shadi_vehicle_withdrawn', 'A vehicle backed out',
      v.owner_name || ' can no longer make your wedding on ' || to_char(e.event_date, 'DD Mon YYYY') || '.' ||
      (CASE WHEN e.status = 'confirmed' THEN ' You can invite a replacement — their share of your advance is still held for whoever takes their place.' ELSE '' END) ||
      COALESCE(' — ' || p_reason, ''),
      '/portal/marketplace/shadi/' || e.id, r.tenant_id);
  END IF;
END;
$function$;
