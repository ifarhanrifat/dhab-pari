-- shop_dashboard_summary (393, extended 434) — add today's profit and
-- today's bill count. The design handoff's own دیش بورڈ tab (Shop
-- Portal v3 "S · dashboard") shows a 2x2 tile grid of TODAY SALE / TODAY
-- PROFIT / TODAY PURCHASE / STOCK VALUE — the first, third and fourth
-- already existed here, profit was only ever tracked at month grain.
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
  v_today_cost_walkin decimal; v_today_cost_market decimal;
  v_today_purchase decimal; v_stock_value decimal; v_today_bills int;
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

  SELECT COALESCE(SUM(si.quantity * COALESCE(p.cost_price_pkr, 0)), 0) INTO v_today_cost_walkin
    FROM shop_sale_items si JOIN shop_sales sa ON sa.id = si.sale_id LEFT JOIN shop_products p ON p.id = si.product_id
    WHERE sa.shop_id = p_shop_id AND (sa.created_at AT TIME ZONE 'Asia/Karachi')::date = v_today;
  SELECT COALESCE(SUM(oi.quantity * COALESCE(p.cost_price_pkr, 0)), 0) INTO v_today_cost_market
    FROM shop_order_items oi JOIN shop_orders o ON o.id = oi.order_id LEFT JOIN shop_products p ON p.id = oi.product_id
    WHERE o.shop_id = p_shop_id AND o.status = 'confirmed' AND (o.confirmed_at AT TIME ZONE 'Asia/Karachi')::date = v_today;

  SELECT COALESCE(SUM(total_cost_pkr), 0) INTO v_today_purchase FROM shop_purchases
    WHERE shop_id = p_shop_id AND (created_at AT TIME ZONE 'Asia/Karachi')::date = v_today;
  SELECT COALESCE(SUM(cost_price_pkr * quantity_on_hand), 0) INTO v_stock_value FROM shop_products
    WHERE shop_id = p_shop_id AND is_active;
  SELECT count(*) INTO v_today_bills FROM shop_sales WHERE shop_id = p_shop_id AND (created_at AT TIME ZONE 'Asia/Karachi')::date = v_today;

  SELECT count(*) INTO v_pending_orders FROM shop_orders WHERE shop_id = p_shop_id AND status = 'announced';
  SELECT count(*) INTO v_low_stock FROM shop_products WHERE shop_id = p_shop_id AND is_active AND quantity_on_hand <= 5;
  SELECT count(*) INTO v_expiring FROM shop_products WHERE shop_id = p_shop_id AND is_active AND expiry_date IS NOT NULL AND expiry_date BETWEEN v_today AND v_today + 7;

  SELECT settled_date, amount_pkr INTO v_last_settle FROM collector_settlements WHERE shop_id = p_shop_id ORDER BY settled_date DESC LIMIT 1;

  RETURN jsonb_build_object(
    'balance_pkr', v_balance, 'commission_mode', v_shop.commission_mode, 'lumpsum_fee_pkr', v_shop.lumpsum_fee_pkr,
    'today_earnings_pkr', v_today_walkin + v_today_market, 'month_earnings_pkr', v_month_walkin + v_month_market,
    'month_profit_pkr', (v_month_walkin + v_month_market) - (v_month_cost_walkin + v_month_cost_market),
    'today_profit_pkr', (v_today_walkin + v_today_market) - (v_today_cost_walkin + v_today_cost_market),
    'today_bills_count', v_today_bills,
    'today_purchase_pkr', v_today_purchase, 'stock_value_pkr', v_stock_value,
    'pending_orders_count', v_pending_orders, 'low_stock_count', v_low_stock, 'expiring_count', v_expiring,
    'last_settlement_date', v_last_settle.settled_date, 'last_settlement_amount', v_last_settle.amount_pkr
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION shop_dashboard_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION shop_dashboard_summary(uuid) TO authenticated;
