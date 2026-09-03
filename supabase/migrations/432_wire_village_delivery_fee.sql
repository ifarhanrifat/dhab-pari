-- Migration 432: wires the flat in-village delivery fee (seeded but
-- deliberately left unused by migration 425 pending a real business
-- decision) into checkout. Decision made: commission is computed on the
-- GOODS subtotal only — the ₨80 delivery fee is added on top and passed
-- straight through to the shop, not treated as commissionable revenue.
--
-- shop_orders.total_amount_pkr keeps meaning what it already means
-- everywhere it's read (shop_dashboard_summary's earnings sums, the
-- monthly_lumpsum gross voucher, every UI total) — the full amount the
-- buyer pays and the shop collects, delivery fee included. The one place
-- that must NOT tax the delivery fee is confirm_shop_order's per_order
-- commission calc, which is why delivery_fee_pkr is stored separately:
-- commission = (total_amount_pkr - delivery_fee_pkr) * pct.

ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS delivery_fee_pkr decimal NOT NULL DEFAULT 0;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. place_shop_order — add the flat fee on top of the goods subtotal.
--    v_total stays the goods-only figure throughout (used unchanged for
--    the per_order pre-flight balance check); v_grand_total is what's
--    actually billed/stored.
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
  v_delivery_fee decimal;
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

  v_delivery_fee := COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'village_delivery_flat_fee_pkr'), 0);
  v_grand_total := v_total + v_delivery_fee;

  UPDATE shop_orders SET total_amount_pkr = v_grand_total, announced_amount_pkr = v_grand_total, delivery_fee_pkr = v_delivery_fee WHERE id = v_order_id;

  IF v_shop.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_shop.portal_user_id, 'shop_order_received', 'New order received',
      'A new order worth Rs ' || round(v_grand_total) || ' just came in.', '/portal/my-shop/reports');
  ELSE
    SELECT popup_enabled INTO v_staff_notify_enabled FROM notification_preferences WHERE event_type = 'shop_order_received';
    IF v_staff_notify_enabled IS DISTINCT FROM false THEN
      FOR v_admin IN SELECT id FROM admin_users WHERE is_active = true AND (role = 'super_admin' OR can_manage_parties) AND access_donors_projects LOOP
        INSERT INTO notifications (recipient_id, event_type, title, body, link)
        VALUES (v_admin.id, 'shop_order_received', 'New marketplace order',
          'New order for ' || v_shop.name || ' worth Rs ' || round(v_grand_total) || '.', '/admin/shops?shop=' || p_shop_id);
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object('order_id', v_order_id, 'total', v_grand_total, 'goods_total', v_total, 'delivery_fee', v_delivery_fee);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. confirm_shop_order — the per_order commission charge, the actual
--    money-moving step (place_shop_order's own commission math above is
--    only ever a pre-flight balance estimate). Must exclude
--    delivery_fee_pkr or the committee would silently start taking a cut
--    of a flat delivery charge that isn't shop revenue.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION confirm_shop_order(p_order_id uuid) RETURNS jsonb AS $$
DECLARE
  o shop_orders%ROWTYPE; s shops%ROWTYPE;
  v_shop_account uuid; v_cash_account uuid; v_commission_account uuid;
  v_commission_pct decimal; v_commission_amount decimal; v_goods_total decimal;
  v_gross_voucher_id uuid; v_gross_voucher_no varchar; v_commission_voucher_id uuid;
  v_is_keeper boolean;
BEGIN
  SELECT * INTO o FROM shop_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0001'; END IF;
  IF o.status <> 'announced' THEN RAISE EXCEPTION 'This order is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO s FROM shops WHERE id = o.shop_id;

  v_is_keeper := s.portal_user_id IS NOT NULL AND s.portal_user_id = current_portal_user_id() AND s.commission_mode = 'per_order';
  IF NOT (COALESCE(current_admin_permission('post_transactions'), false) OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  v_shop_account := ensure_shop_account(o.shop_id);
  SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050';

  IF s.commission_mode = 'per_order' THEN
    v_commission_pct := COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_shop_commission_pct'), 0);
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

    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (o.portal_user_id, 'shop_order_confirmed', 'Order confirmed', 'Your order from ' || s.name || ' has been confirmed.', '/accounts');

    RETURN jsonb_build_object('amount', o.total_amount_pkr, 'commission', v_commission_amount);
  END IF;

  -- monthly_lumpsum: unchanged — the shop keeps 100% of what it collected
  -- (goods + delivery fee both), no commission voucher at all here.
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects'
    AND code = (CASE WHEN o.announced_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Order from ' || s.name || ' — paid via portal, confirmed', o.announced_amount_pkr, v_shop_account, v_cash_account, s.name)
  RETURNING id, voucher_no INTO v_gross_voucher_id, v_gross_voucher_no;

  UPDATE shop_orders SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
    gross_voucher_id = v_gross_voucher_id WHERE id = p_order_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (o.portal_user_id, 'shop_order_confirmed', 'Order confirmed', 'Your order from ' || s.name || ' has been confirmed.', '/accounts');

  RETURN jsonb_build_object('voucher_no', v_gross_voucher_no, 'amount', o.announced_amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
