-- Migration 662: Marketplace becomes its own accounting system (Phase 0,
-- part 2 of 2 — RPC updates). Every function below is reproduced from
-- its real, current body (pulled live via pg_get_functiondef, the same
-- discipline migration 592's own comment describes) with the minimal
-- mechanical substitution applied throughout: every account/voucher
-- lookup or write against system='donors_projects' becomes
-- system='marketplace', and DP-4050/DP-1001/DP-1002/DP-5004 become
-- MKT-4050/MKT-1001/MKT-1002/MKT-5004 (the reclassified/new accounts
-- migration 661 created). No other logic changed — confirmed per
-- function before writing this (grepped every 'donors_projects'
-- occurrence in each body and matched the count against a manual read).
--
-- cancel_hourly_booking was in the original candidate list (it shares a
-- migration file with confirm_hourly_booking) but its real body touches
-- no account/voucher code at all — left untouched, not reproduced here.
--
-- platform_compute_tenant_commission / run_platform_monthly_invoicing
-- are the SaaS platform's own revenue-share billing engine (phase 3,
-- migration 619/629) — they read each tenant's own MKT-4050 to compute
-- the platform's cut of that tenant's marketplace commission income.
-- Confirmed live before writing this: only the dhab-pari tenant has
-- ever had a real DP-4050/MKT-4050 account or any ledger activity
-- against it; the other two real tenants (Dhab Khushal, Dhab Kalan)
-- have zero marketplace footprint so far, so this is a live-but-dormant
-- code path, not a change with any current real invoicing effect.

CREATE OR REPLACE FUNCTION public.ensure_vehicle_account(p_vehicle_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account_id uuid;
  v_name varchar;
  v_tenant_id uuid;
BEGIN
  SELECT id INTO v_account_id FROM accounts WHERE vehicle_id = p_vehicle_id;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;
  SELECT owner_name, tenant_id INTO v_name, v_tenant_id FROM vehicles WHERE id = p_vehicle_id;
  INSERT INTO accounts (code, name, type, system, vehicle_id, opening_balance, tenant_id)
  VALUES ('VEH-' || substr(replace(p_vehicle_id::text, '-', ''), 1, 8), v_name, 'vehicle_owner', 'marketplace', p_vehicle_id, 0, v_tenant_id)
  RETURNING id INTO v_account_id;
  RETURN v_account_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ensure_shop_account(p_shop_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account_id uuid;
  v_name varchar;
  v_tenant_id uuid;
BEGIN
  SELECT id INTO v_account_id FROM accounts WHERE shop_id = p_shop_id;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;
  SELECT name, tenant_id INTO v_name, v_tenant_id FROM shops WHERE id = p_shop_id;
  INSERT INTO accounts (code, name, type, system, shop_id, opening_balance, tenant_id)
  VALUES ('SHP-' || substr(replace(p_shop_id::text, '-', ''), 1, 8), v_name, 'shop', 'marketplace', p_shop_id, 0, v_tenant_id)
  RETURNING id INTO v_account_id;
  RETURN v_account_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_vehicle_wallet_topup(p_topup_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE t vehicle_wallet_topups%ROWTYPE; v vehicles%ROWTYPE; v_vehicle_account uuid; v_cash_account uuid; v_voucher_id uuid; v_voucher_no varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO t FROM vehicle_wallet_topups WHERE id = p_topup_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Top-up not found' USING ERRCODE = 'P0001'; END IF;
  IF t.status <> 'announced' THEN RAISE EXCEPTION 'This top-up is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = t.vehicle_id;
  v_vehicle_account := ensure_vehicle_account(t.vehicle_id);
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'marketplace' AND code = (CASE WHEN t.announced_method = 'cash' THEN 'MKT-1001' ELSE 'MKT-1002' END) AND tenant_id = t.tenant_id;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date, 'Wallet top-up — ' || v.owner_name, t.amount_pkr, v_vehicle_account, v_cash_account, v.owner_name)
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

CREATE OR REPLACE FUNCTION public.confirm_shop_wallet_topup(p_topup_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE t shop_wallet_topups%ROWTYPE; s shops%ROWTYPE; v_shop_account uuid; v_cash_account uuid; v_voucher_id uuid; v_voucher_no varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO t FROM shop_wallet_topups WHERE id = p_topup_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Top-up not found' USING ERRCODE = 'P0001'; END IF;
  IF t.status <> 'announced' THEN RAISE EXCEPTION 'This top-up is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO s FROM shops WHERE id = t.shop_id;
  v_shop_account := ensure_shop_account(t.shop_id);
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'marketplace' AND code = (CASE WHEN t.announced_method = 'cash' THEN 'MKT-1001' ELSE 'MKT-1002' END) AND tenant_id = t.tenant_id;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date, 'Wallet top-up — ' || s.name, t.amount_pkr, v_shop_account, v_cash_account, s.name)
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

CREATE OR REPLACE FUNCTION public.confirm_ride_booking(p_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050' AND tenant_id = b.tenant_id;

  IF v.commission_mode = 'per_order' THEN
    v_commission_pct := vehicle_commission_pct(v.vehicle_type, ctx.classification);
    v_commission_amount := round(b.total_amount_pkr * v_commission_pct / 100, 2);

    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
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
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'marketplace'
    AND code = (CASE WHEN b.announced_method = 'cash' THEN 'MKT-1001' ELSE 'MKT-1002' END) AND tenant_id = b.tenant_id;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
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

CREATE OR REPLACE FUNCTION public.confirm_shop_order(p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050' AND tenant_id = o.tenant_id;

  IF s.commission_mode = 'per_order' THEN
    v_commission_pct := COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_shop_commission_pct' AND tenant_id = o.tenant_id), 0);
    v_goods_total := o.total_amount_pkr - COALESCE(o.delivery_fee_pkr, 0);
    v_commission_amount := round(v_goods_total * v_commission_pct / 100, 2);

    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
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
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'marketplace'
    AND code = (CASE WHEN o.announced_method = 'cash' THEN 'MKT-1001' ELSE 'MKT-1002' END) AND tenant_id = o.tenant_id;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Order from ' || s.name || ' — paid via portal, confirmed', o.announced_amount_pkr, v_shop_account, v_cash_account, s.name)
  RETURNING id, voucher_no INTO v_gross_voucher_id, v_gross_voucher_no;

  UPDATE shop_orders SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
    gross_voucher_id = v_gross_voucher_id WHERE id = p_order_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
  VALUES (o.portal_user_id, 'shop_order_confirmed', 'Order confirmed', 'Your order from ' || s.name || ' has been confirmed.', '/accounts', o.tenant_id);

  RETURN jsonb_build_object('voucher_no', v_gross_voucher_no, 'amount', o.announced_amount_pkr);
END;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_hourly_booking(p_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  b hourly_bookings%ROWTYPE; v vehicles%ROWTYPE;
  v_vehicle_account uuid; v_cash_account uuid; v_commission_account uuid;
  v_commission_pct decimal; v_commission_amount decimal;
  v_gross_voucher_id uuid; v_gross_voucher_no varchar; v_commission_voucher_id uuid;
  v_is_keeper boolean;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'completed' THEN RAISE EXCEPTION 'This trip has not been completed yet.' USING ERRCODE = 'P0001'; END IF;
  IF b.status_confirmed THEN RAISE EXCEPTION 'This booking has already been settled.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;

  v_is_keeper := v.portal_user_id IS NOT NULL AND v.portal_user_id = current_portal_user_id() AND v.commission_mode = 'per_order';
  IF NOT (COALESCE(current_admin_permission('post_transactions'), false) OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  v_vehicle_account := ensure_vehicle_account(v.id);
  SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050' AND tenant_id = my_tenant_id();

  IF v.commission_mode = 'per_order' THEN
    v_commission_pct := COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_hourly_commission_pct' AND tenant_id = my_tenant_id()), 0);
    v_commission_amount := round(b.total_amount_pkr * v_commission_pct / 100, 2);

    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — hourly rental (' || b.hours || 'h, paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
      RETURNING id INTO v_commission_voucher_id;
    END IF;

    UPDATE hourly_bookings SET status_confirmed = true, commission_voucher_id = v_commission_voucher_id WHERE id = p_booking_id;
    PERFORM check_seller_balance_notify('vehicle', v.id);
    RETURN jsonb_build_object('amount', b.total_amount_pkr, 'commission', v_commission_amount);
  END IF;

  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-1001' AND tenant_id = my_tenant_id();

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Hourly rental (' || b.hours || 'h) — confirmed', b.total_amount_pkr, v_vehicle_account, v_cash_account, v.owner_name)
  RETURNING id, voucher_no INTO v_gross_voucher_id, v_gross_voucher_no;

  UPDATE hourly_bookings SET status_confirmed = true, gross_voucher_id = v_gross_voucher_id WHERE id = p_booking_id;
  RETURN jsonb_build_object('voucher_no', v_gross_voucher_no, 'amount', b.total_amount_pkr);
END;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_rental_booking(p_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  b rental_bookings%ROWTYPE; v vehicles%ROWTYPE;
  v_vehicle_account uuid; v_cash_account uuid; v_commission_account uuid;
  v_commission_pct decimal; v_commission_amount decimal;
  v_gross_voucher_id uuid; v_gross_voucher_no varchar; v_commission_voucher_id uuid;
  v_is_keeper boolean;
BEGIN
  SELECT * INTO b FROM rental_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'completed' THEN RAISE EXCEPTION 'This trip has not been completed yet.' USING ERRCODE = 'P0001'; END IF;
  IF b.status_confirmed THEN RAISE EXCEPTION 'This booking has already been settled.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;

  v_is_keeper := v.portal_user_id IS NOT NULL AND v.portal_user_id = current_portal_user_id() AND v.commission_mode = 'per_order';
  IF NOT (COALESCE(current_admin_permission('post_transactions'), false) OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  v_vehicle_account := ensure_vehicle_account(v.id);
  SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050';

  IF v.commission_mode = 'per_order' THEN
    v_commission_pct := COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_rental_commission_pct'), 0);
    v_commission_amount := round(b.total_amount_pkr * v_commission_pct / 100, 2);

    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — vehicle rental (' || round(b.km) || 'km, paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
      RETURNING id INTO v_commission_voucher_id;
    END IF;

    UPDATE rental_bookings SET status_confirmed = true, commission_voucher_id = v_commission_voucher_id WHERE id = p_booking_id;
    PERFORM check_seller_balance_notify('vehicle', v.id);
    RETURN jsonb_build_object('amount', b.total_amount_pkr, 'commission', v_commission_amount);
  END IF;

  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-1001';

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Vehicle rental (' || round(b.km) || 'km) — confirmed', b.total_amount_pkr, v_vehicle_account, v_cash_account, v.owner_name)
  RETURNING id, voucher_no INTO v_gross_voucher_id, v_gross_voucher_no;

  UPDATE rental_bookings SET status_confirmed = true, gross_voucher_id = v_gross_voucher_id WHERE id = p_booking_id;
  RETURN jsonb_build_object('voucher_no', v_gross_voucher_no, 'amount', b.total_amount_pkr);
END;
$function$;

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
    v_commission_pct := COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_equipment_commission_pct'), 0);
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

CREATE OR REPLACE FUNCTION public.complete_trip_booking(p_trip_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  b vehicle_trip_bookings%ROWTYPE; v vehicles%ROWTYPE; o vehicle_trip_offers%ROWTYPE;
  v_vehicle_account uuid; v_commission_account uuid; v_commission_pct decimal; v_commission_amount decimal := 0;
  v_commission_voucher_id uuid;
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

  IF v.commission_mode = 'per_order' THEN
    v_vehicle_account := ensure_vehicle_account(v.id);
    SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050' AND tenant_id = my_tenant_id();
    v_commission_pct := vehicle_commission_pct(v.vehicle_type, o.classification);
    v_commission_amount := round(b.total_amount_pkr * v_commission_pct / 100, 2);
    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — ' || o.origin || ' → ' || o.destination || ' return trip (paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
      RETURNING id INTO v_commission_voucher_id;
      UPDATE vehicle_trip_bookings SET commission_voucher_id = v_commission_voucher_id WHERE id = p_trip_booking_id;
    END IF;
    PERFORM check_seller_balance_notify('vehicle', v.id);
  END IF;

  RETURN jsonb_build_object('amount', b.total_amount_pkr, 'commission', v_commission_amount);
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_dispatch_call(p_call_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050' AND tenant_id = c.tenant_id;
      v_commission_pct := COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_dispatch_commission_pct' AND tenant_id = c.tenant_id), 0);
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
$function$;

CREATE OR REPLACE FUNCTION public.confirm_shadi_advance(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  SELECT id INTO v_liability_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-5004' AND tenant_id = e.tenant_id;
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'marketplace' AND code = (CASE WHEN e.advance_method = 'cash' THEN 'MKT-1001' ELSE 'MKT-1002' END) AND tenant_id = e.tenant_id;

  -- Balance-sheet only — cash received, matched by a liability to the
  -- vehicles it's collected on behalf of. No income is recognised here.
  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('marketplace', 'contra', (now() AT TIME ZONE 'Asia/Karachi')::date,
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

CREATE OR REPLACE FUNCTION public.sweep_due_shadi_advances()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_liability_account uuid;
  r RECORD;
  v_vehicle_account uuid;
  v_voucher_id uuid;
  v_count int := 0;
BEGIN
  FOR r IN
    SELECT sr.id AS request_id, sr.vehicle_id, sr.advance_share_pkr, se.event_date, v.owner_name, v.portal_user_id, v.tenant_id
    FROM shadi_vehicle_requests sr
    JOIN shadi_events se ON se.id = sr.event_id
    JOIN vehicles v ON v.id = sr.vehicle_id
    WHERE sr.status = 'accepted' AND se.status = 'confirmed' AND se.event_date < (now() AT TIME ZONE 'Asia/Karachi')::date
      AND sr.payout_voucher_id IS NULL AND sr.advance_share_pkr IS NOT NULL AND sr.advance_share_pkr > 0
    FOR UPDATE OF sr SKIP LOCKED
  LOOP
    SELECT id INTO v_liability_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-5004' AND tenant_id = r.tenant_id;
    v_vehicle_account := ensure_vehicle_account(r.vehicle_id);

    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
    VALUES ('marketplace', 'contra', (now() AT TIME ZONE 'Asia/Karachi')::date,
      'Shadi advance released — ' || r.owner_name || ' (' || to_char(r.event_date, 'DD Mon YYYY') || ')', r.advance_share_pkr, v_vehicle_account, v_liability_account, r.owner_name)
    RETURNING id INTO v_voucher_id;

    UPDATE shadi_vehicle_requests SET payout_voucher_id = v_voucher_id, paid_out_at = now() WHERE id = r.request_id;
    v_count := v_count + 1;

    IF r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
      VALUES (r.portal_user_id, 'shadi_advance_released', 'Advance released',
        'Rs ' || round(r.advance_share_pkr) || ' advance for the ' || to_char(r.event_date, 'DD Mon YYYY') || ' wedding has been released to your account.', '/portal/my-vehicle/shadi', r.tenant_id);
    END IF;
  END LOOP;

  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.post_vehicle_lumpsum_charges()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
  v_commission_account uuid;
  v_vehicle_account uuid;
  v_period varchar := to_char((now() AT TIME ZONE 'Asia/Karachi')::date, 'YYYY-MM');
  v_voucher_id uuid;
BEGIN
  FOR r IN
    SELECT * FROM vehicles WHERE commission_mode = 'monthly_lumpsum' AND COALESCE(lumpsum_fee_pkr, 0) > 0 AND is_active = true
  LOOP
    IF EXISTS (SELECT 1 FROM vehicle_lumpsum_charges WHERE vehicle_id = r.id AND period = v_period) THEN CONTINUE; END IF;

    SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050' AND tenant_id = r.tenant_id;
    v_vehicle_account := ensure_vehicle_account(r.id);
    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
    VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
      'Monthly marketplace subscription — ' || r.owner_name || ' (' || v_period || ')', r.lumpsum_fee_pkr, v_commission_account, v_vehicle_account, r.owner_name)
    RETURNING id INTO v_voucher_id;

    INSERT INTO vehicle_lumpsum_charges (vehicle_id, period, amount_pkr, voucher_id, tenant_id) VALUES (r.id, v_period, r.lumpsum_fee_pkr, v_voucher_id, r.tenant_id);

    IF r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
      VALUES (r.portal_user_id, 'shop_lumpsum_charged', 'Monthly fee charged',
        'This month''s marketplace subscription fee has been charged to your account.', '/portal/my-vehicle', r.tenant_id);
    END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.post_shop_lumpsum_charges()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
  v_commission_account uuid;
  v_shop_account uuid;
  v_period varchar := to_char((now() AT TIME ZONE 'Asia/Karachi')::date, 'YYYY-MM');
  v_voucher_id uuid;
BEGIN
  FOR r IN
    SELECT * FROM shops WHERE commission_mode = 'monthly_lumpsum' AND COALESCE(lumpsum_fee_pkr, 0) > 0 AND status = 'active'
  LOOP
    IF EXISTS (SELECT 1 FROM shop_lumpsum_charges WHERE shop_id = r.id AND period = v_period) THEN
      CONTINUE; -- already charged this period (re-run safety)
    END IF;

    SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050' AND tenant_id = r.tenant_id;
    v_shop_account := ensure_shop_account(r.id);
    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
    VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
      'Monthly marketplace subscription — ' || r.name || ' (' || v_period || ')', r.lumpsum_fee_pkr, v_commission_account, v_shop_account, r.name)
    RETURNING id INTO v_voucher_id;

    INSERT INTO shop_lumpsum_charges (shop_id, period, amount_pkr, voucher_id, tenant_id) VALUES (r.id, v_period, r.lumpsum_fee_pkr, v_voucher_id, r.tenant_id);

    IF r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
      VALUES (r.portal_user_id, 'shop_lumpsum_charged', 'Monthly fee charged',
        'This month''s marketplace subscription fee has been charged to your account.', '/portal/my-shop/reports', r.tenant_id);
    END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.platform_compute_tenant_commission(p_tenant_id uuid, p_period_start date, p_period_end date)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_commission_pct decimal;
  v_tenant_marketplace_income decimal;
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT p.commission_pct INTO v_commission_pct
  FROM tenant_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
  WHERE s.tenant_id = p_tenant_id AND s.status IN ('active', 'trialing', 'past_due')
  LIMIT 1;
  IF v_commission_pct IS NULL OR v_commission_pct = 0 THEN RETURN 0; END IF;

  SELECT COALESCE(SUM(l.credit - l.debit), 0) INTO v_tenant_marketplace_income
  FROM ledger_entries l
  JOIN accounts a ON a.id = l.account_id
  WHERE a.tenant_id = p_tenant_id AND a.system = 'marketplace' AND a.code = 'MKT-4050'
    AND l.entry_date BETWEEN p_period_start AND p_period_end;

  RETURN round(GREATEST(v_tenant_marketplace_income, 0) * v_commission_pct / 100, 2);
END;
$function$;

CREATE OR REPLACE FUNCTION public.run_platform_monthly_invoicing()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_period_start date := (date_trunc('month', current_date) - interval '1 month')::date;
  v_period_end date := (date_trunc('month', current_date) - interval '1 day')::date;
  r record;
  v_commission_pct decimal;
  v_tenant_marketplace_income decimal;
  v_commission decimal;
  v_total decimal;
BEGIN
  FOR r IN
    SELECT s.id AS subscription_id, s.tenant_id, p.monthly_price_pkr, p.commission_pct
    FROM tenant_subscriptions s
    JOIN subscription_plans p ON p.id = s.plan_id
    WHERE s.status IN ('active', 'trialing', 'past_due')
  LOOP
    IF EXISTS (SELECT 1 FROM platform_invoices WHERE tenant_id = r.tenant_id AND period_start = v_period_start) THEN
      CONTINUE; -- already invoiced this period
    END IF;

    v_commission := 0;
    IF r.commission_pct IS NOT NULL AND r.commission_pct > 0 THEN
      SELECT COALESCE(SUM(l.credit - l.debit), 0) INTO v_tenant_marketplace_income
      FROM ledger_entries l
      JOIN accounts a ON a.id = l.account_id
      WHERE a.tenant_id = r.tenant_id AND a.system = 'marketplace' AND a.code = 'MKT-4050'
        AND l.entry_date BETWEEN v_period_start AND v_period_end;
      v_commission := round(GREATEST(v_tenant_marketplace_income, 0) * r.commission_pct / 100, 2);
    END IF;

    v_total := r.monthly_price_pkr + v_commission;

    INSERT INTO platform_invoices (
      tenant_id, subscription_id, invoice_number, period_start, period_end,
      subscription_amount_pkr, commission_amount_pkr, total_amount_pkr, status
    ) VALUES (
      r.tenant_id, r.subscription_id, next_platform_invoice_number(), v_period_start, v_period_end,
      r.monthly_price_pkr, v_commission, v_total, 'pending'
    );
  END LOOP;
END;
$function$;