-- Migration 406: two real gaps found live-testing the marketplace.
--
-- 1. A portal account could be linked as the self-service keeper of more
--    than one shop/vehicle at once — nothing enforced or even warned
--    about it. The admin UI's "find keeper" step only ever touched local
--    React state; the actual link only persisted once the whole
--    shop/vehicle form was separately saved, so a keeper lookup that
--    "looked" linked in the UI could silently vanish if that save step
--    was missed. A hard uniqueness constraint closes the "two shops, one
--    account" gap for good; the admin pages (client-side) now persist a
--    keeper link the moment it's found, not deferred to a later save.
--
-- 2. place_ride_booking()/place_shop_order() only checked a *flat* site-
--    wide minimum balance (marketplace_min_balance_to_order_pkr, which
--    happens to be configured at 0) before allowing a per_order booking
--    — not whether the balance actually covers *this specific* booking's
--    commission. A vehicle/shop starting at Rs 0 passed that check every
--    time, took the booking, and only went negative — and got flagged
--    "inactive" — once the commission posted on confirm. Now the check
--    is "does the wallet already hold at least this booking's own
--    commission", so a booking that would push the balance negative is
--    refused up front instead of accepted and then penalized after.

-- ═════════════════════════════════════════════════════════════════════════
-- 1. One portal account, one shop/vehicle.
-- ═════════════════════════════════════════════════════════════════════════
CREATE UNIQUE INDEX IF NOT EXISTS shops_portal_user_id_unique ON shops(portal_user_id) WHERE portal_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS vehicles_portal_user_id_unique ON vehicles(portal_user_id) WHERE portal_user_id IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. place_ride_booking — per_order vehicles now need enough wallet
--    balance to cover THIS booking's commission, not just >= a flat
--    site-wide floor.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION place_ride_booking(
  p_route_id uuid, p_travel_date date, p_seats int, p_method varchar, p_proof_url text
) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE;
  v_vehicle vehicles%ROWTYPE;
  v_available int;
  v_total decimal;
  v_booking_id uuid;
  v_weekday int;
  v_commission_pct decimal;
  v_expected_commission decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND OR NOT v_route.is_active THEN RAISE EXCEPTION 'Route not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;
  IF p_seats IS NULL OR p_seats <= 0 THEN RAISE EXCEPTION 'Pick at least one seat.' USING ERRCODE = 'P0001'; END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;

  v_weekday := extract(dow FROM p_travel_date)::int;
  IF NOT (v_weekday = ANY(v_route.days_of_week)) THEN
    RAISE EXCEPTION 'This route does not run on that day.' USING ERRCODE = 'P0001';
  END IF;

  v_total := p_seats * v_route.fare_per_seat_pkr;

  IF v_vehicle.commission_mode = 'monthly_lumpsum' THEN
    IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  ELSE
    IF NOT v_vehicle.is_active THEN
      RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings — try another one.' USING ERRCODE = 'P0001';
    END IF;
    v_commission_pct := vehicle_commission_pct(v_vehicle.vehicle_type, v_route.classification);
    v_expected_commission := round(v_total * v_commission_pct / 100, 2);
    IF seller_account_balance(ensure_vehicle_account(v_vehicle.id)) < v_expected_commission THEN
      RAISE EXCEPTION 'This vehicle''s wallet balance is too low to cover this booking''s commission — the driver needs to top up first.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_available := route_seats_available(p_route_id, p_travel_date);
  IF p_seats > v_available THEN
    RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO ride_bookings (route_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at)
  VALUES (p_route_id, v_portal_user_id, p_travel_date, p_seats, v_total, 'announced', v_total, p_method, p_proof_url, now())
  RETURNING id INTO v_booking_id;

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. place_shop_order — same fix, same reasoning, for shops.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION place_shop_order(
  p_shop_id uuid, p_items jsonb, p_method varchar, p_proof_url text, p_delivery_address text
) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_buyer_mobile varchar;
  v_shop shops%ROWTYPE;
  v_order_id uuid;
  v_total decimal := 0;
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
  IF p_delivery_address IS NULL OR trim(p_delivery_address) = '' THEN
    RAISE EXCEPTION 'Enter a delivery address.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_shop FROM shops WHERE id = p_shop_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shop not found' USING ERRCODE = 'P0001'; END IF;
  IF v_shop.status <> 'active' THEN RAISE EXCEPTION 'This shop is not currently active.' USING ERRCODE = 'P0001'; END IF;
  IF NOT v_shop.delivery_enabled THEN
    RAISE EXCEPTION 'This shop does not offer delivery — visit the store to buy.' USING ERRCODE = 'P0001';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'Your cart is empty.' USING ERRCODE = 'P0001'; END IF;

  IF v_shop.commission_mode = 'monthly_lumpsum' THEN
    IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  ELSIF NOT shop_bookable(p_shop_id) THEN
    RAISE EXCEPTION 'This shop is temporarily unable to take new orders — try again later or visit in person.' USING ERRCODE = 'P0001';
  END IF;

  SELECT mobile INTO v_buyer_mobile FROM portal_users WHERE id = v_portal_user_id;

  INSERT INTO shop_orders (shop_id, portal_user_id, status, announced_method, announced_proof_url, announced_at, delivery_address, buyer_mobile)
  VALUES (p_shop_id, v_portal_user_id, 'announced', p_method, p_proof_url, now(), trim(p_delivery_address), v_buyer_mobile)
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
    v_commission_pct := COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_shop_commission_pct'), 0);
    v_expected_commission := round(v_total * v_commission_pct / 100, 2);
    IF seller_account_balance(ensure_shop_account(p_shop_id)) < v_expected_commission THEN
      RAISE EXCEPTION 'This shop''s wallet balance is too low to cover this order''s commission — the shop needs to top up first.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE shop_orders SET total_amount_pkr = v_total, announced_amount_pkr = v_total WHERE id = v_order_id;

  IF v_shop.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_shop.portal_user_id, 'shop_order_received', 'New order received',
      'A new order worth Rs ' || round(v_total) || ' just came in.', '/portal/my-shop/reports');
  ELSE
    SELECT popup_enabled INTO v_staff_notify_enabled FROM notification_preferences WHERE event_type = 'shop_order_received';
    IF v_staff_notify_enabled IS DISTINCT FROM false THEN
      FOR v_admin IN SELECT id FROM admin_users WHERE is_active = true AND (role = 'super_admin' OR can_manage_parties) AND access_donors_projects LOOP
        INSERT INTO notifications (recipient_id, event_type, title, body, link)
        VALUES (v_admin.id, 'shop_order_received', 'New marketplace order',
          'New order for ' || v_shop.name || ' worth Rs ' || round(v_total) || '.', '/admin/shops?shop=' || p_shop_id);
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object('order_id', v_order_id, 'total', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
