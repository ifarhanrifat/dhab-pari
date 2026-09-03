-- Migration 434: purchase entry ("سٹاک شامل کریں" restock flow, design
-- spec §3) — supplier + item quantities at cost, committing increments
-- quantity_on_hand AND updates cost_price_pkr to the new buying price
-- (the design's own wording: "updates costPrice"). Same shape and RLS
-- pattern as shop_sales/record_shop_sale (391) — a real accounting
-- record, never touching the committee's own ledger (this is the
-- shop's own private stock-keeping, exactly like a walk-in sale).

CREATE TABLE IF NOT EXISTS shop_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  supplier varchar,
  total_cost_pkr decimal NOT NULL DEFAULT 0,
  recorded_by_portal_user_id uuid REFERENCES portal_users(id),
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shop_purchase_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL REFERENCES shop_purchases(id) ON DELETE CASCADE,
  product_id uuid REFERENCES shop_products(id),
  product_name_snapshot varchar NOT NULL,
  quantity decimal NOT NULL CHECK (quantity > 0),
  unit_cost_pkr decimal NOT NULL,
  line_total_pkr decimal NOT NULL
);
CREATE INDEX IF NOT EXISTS shop_purchases_shop_id_idx ON shop_purchases(shop_id);
CREATE INDEX IF NOT EXISTS shop_purchase_items_purchase_id_idx ON shop_purchase_items(purchase_id);

ALTER TABLE shop_purchases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shop_purchases_owner_read" ON shop_purchases FOR SELECT TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id())
  );
ALTER TABLE shop_purchase_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shop_purchase_items_owner_read" ON shop_purchase_items FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM shop_purchases pu JOIN shops s ON s.id = pu.shop_id
      WHERE pu.id = purchase_id AND (current_admin_permission('manage_parties') OR s.portal_user_id = current_portal_user_id())
    )
  );
-- No direct INSERT policy — writes only happen through
-- record_shop_purchase() below (SECURITY DEFINER), so the stock
-- increment and the purchase row can never drift apart.

CREATE OR REPLACE FUNCTION record_shop_purchase(p_shop_id uuid, p_supplier text, p_items jsonb) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_purchase_id uuid;
  v_total decimal := 0;
  item jsonb;
  v_product shop_products%ROWTYPE;
  v_qty decimal;
  v_unit_cost decimal;
  v_line_total decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM shops WHERE id = p_shop_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this shop.' USING ERRCODE = 'P0001';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one item to the purchase.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO shop_purchases (shop_id, supplier, recorded_by_portal_user_id)
  VALUES (p_shop_id, NULLIF(trim(COALESCE(p_supplier, '')), ''), v_portal_user_id)
  RETURNING id INTO v_purchase_id;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := (item->>'quantity')::decimal;
    v_unit_cost := (item->>'unit_cost_pkr')::decimal;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Invalid quantity in purchase.' USING ERRCODE = 'P0001'; END IF;
    IF v_unit_cost IS NULL OR v_unit_cost < 0 THEN RAISE EXCEPTION 'Invalid cost in purchase.' USING ERRCODE = 'P0001'; END IF;

    SELECT * INTO v_product FROM shop_products WHERE id = (item->>'product_id')::uuid AND shop_id = p_shop_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'One of the items in this purchase is no longer in your catalog.' USING ERRCODE = 'P0001'; END IF;

    v_line_total := v_qty * v_unit_cost;
    v_total := v_total + v_line_total;

    INSERT INTO shop_purchase_items (purchase_id, product_id, product_name_snapshot, quantity, unit_cost_pkr, line_total_pkr)
    VALUES (v_purchase_id, v_product.id, v_product.name, v_qty, v_unit_cost, v_line_total);

    -- Stock goes up, cost price rolls forward to the new buying price —
    -- exactly the design's own "committing increments qtyOnHand and
    -- records the purchase; updates costPrice" (§3). Sale price is
    -- deliberately never touched here — repricing to the customer is
    -- always a separate, explicit keeper decision (Stock List/edit
    -- modal), never an automatic side effect of a purchase.
    UPDATE shop_products SET quantity_on_hand = quantity_on_hand + v_qty, cost_price_pkr = v_unit_cost WHERE id = v_product.id;
  END LOOP;

  UPDATE shop_purchases SET total_cost_pkr = v_total WHERE id = v_purchase_id;
  RETURN v_purchase_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION record_shop_purchase(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_shop_purchase(uuid, text, jsonb) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- shop_dashboard_summary (393) — add today's purchase total and stock
-- value at cost, the two dashboard tiles the design's ڈیش بورڈ tab wants
-- that genuinely needed purchase data to exist first.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION shop_dashboard_summary(p_shop_id uuid) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_shop shops%ROWTYPE;
  v_account_id uuid;
  v_balance decimal := 0;
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_today_walkin decimal; v_today_market decimal;
  v_month_walkin decimal; v_month_market decimal;
  v_month_cost_walkin decimal; v_month_cost_market decimal;
  v_today_purchase decimal; v_stock_value decimal;
  v_pending_orders int; v_low_stock int; v_expiring int;
  v_last_settle RECORD;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in required.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_shop FROM shops WHERE id = p_shop_id AND portal_user_id = v_portal_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'You do not manage this shop.' USING ERRCODE = 'P0001'; END IF;

  SELECT id INTO v_account_id FROM accounts WHERE shop_id = p_shop_id;
  IF v_account_id IS NOT NULL THEN
    SELECT a.opening_balance - (
      COALESCE((SELECT SUM(debit) FROM ledger_entries WHERE account_id = a.id), 0) -
      COALESCE((SELECT SUM(credit) FROM ledger_entries WHERE account_id = a.id), 0)
    ) INTO v_balance FROM accounts a WHERE a.id = v_account_id;
  END IF;

  SELECT COALESCE(SUM(total_amount_pkr), 0) INTO v_today_walkin FROM shop_sales
    WHERE shop_id = p_shop_id AND (created_at AT TIME ZONE 'Asia/Karachi')::date = v_today;
  SELECT COALESCE(SUM(total_amount_pkr), 0) INTO v_today_market FROM shop_orders
    WHERE shop_id = p_shop_id AND status = 'confirmed' AND (confirmed_at AT TIME ZONE 'Asia/Karachi')::date = v_today;
  SELECT COALESCE(SUM(total_amount_pkr), 0) INTO v_month_walkin FROM shop_sales
    WHERE shop_id = p_shop_id AND date_trunc('month', created_at AT TIME ZONE 'Asia/Karachi') = date_trunc('month', v_today::timestamp);
  SELECT COALESCE(SUM(total_amount_pkr), 0) INTO v_month_market FROM shop_orders
    WHERE shop_id = p_shop_id AND status = 'confirmed' AND date_trunc('month', confirmed_at AT TIME ZONE 'Asia/Karachi') = date_trunc('month', v_today::timestamp);

  SELECT COALESCE(SUM(si.quantity * COALESCE(p.cost_price_pkr, 0)), 0) INTO v_month_cost_walkin
    FROM shop_sale_items si JOIN shop_sales sa ON sa.id = si.sale_id LEFT JOIN shop_products p ON p.id = si.product_id
    WHERE sa.shop_id = p_shop_id AND date_trunc('month', sa.created_at AT TIME ZONE 'Asia/Karachi') = date_trunc('month', v_today::timestamp);
  SELECT COALESCE(SUM(oi.quantity * COALESCE(p.cost_price_pkr, 0)), 0) INTO v_month_cost_market
    FROM shop_order_items oi JOIN shop_orders o ON o.id = oi.order_id LEFT JOIN shop_products p ON p.id = oi.product_id
    WHERE o.shop_id = p_shop_id AND o.status = 'confirmed' AND date_trunc('month', o.confirmed_at AT TIME ZONE 'Asia/Karachi') = date_trunc('month', v_today::timestamp);

  SELECT COALESCE(SUM(total_cost_pkr), 0) INTO v_today_purchase FROM shop_purchases
    WHERE shop_id = p_shop_id AND (created_at AT TIME ZONE 'Asia/Karachi')::date = v_today;
  SELECT COALESCE(SUM(cost_price_pkr * quantity_on_hand), 0) INTO v_stock_value FROM shop_products
    WHERE shop_id = p_shop_id AND is_active;

  SELECT count(*) INTO v_pending_orders FROM shop_orders WHERE shop_id = p_shop_id AND status = 'announced';
  SELECT count(*) INTO v_low_stock FROM shop_products WHERE shop_id = p_shop_id AND is_active AND quantity_on_hand <= 5;
  SELECT count(*) INTO v_expiring FROM shop_products WHERE shop_id = p_shop_id AND is_active AND expiry_date IS NOT NULL AND expiry_date BETWEEN v_today AND v_today + 7;

  SELECT settled_date, amount_pkr INTO v_last_settle FROM collector_settlements WHERE shop_id = p_shop_id ORDER BY settled_date DESC LIMIT 1;

  RETURN jsonb_build_object(
    'balance_pkr', v_balance, 'commission_mode', v_shop.commission_mode, 'lumpsum_fee_pkr', v_shop.lumpsum_fee_pkr,
    'today_earnings_pkr', v_today_walkin + v_today_market, 'month_earnings_pkr', v_month_walkin + v_month_market,
    'month_profit_pkr', (v_month_walkin + v_month_market) - (v_month_cost_walkin + v_month_cost_market),
    'today_purchase_pkr', v_today_purchase, 'stock_value_pkr', v_stock_value,
    'pending_orders_count', v_pending_orders, 'low_stock_count', v_low_stock, 'expiring_count', v_expiring,
    'last_settlement_date', v_last_settle.settled_date, 'last_settlement_amount', v_last_settle.amount_pkr
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
