-- Part 2 of the multi-owner/staff retrofit (458 did the RLS policies) —
-- every RPC in the daily-operations surface that checked shop ownership
-- INLINE inside its own SECURITY DEFINER body (RLS doesn't apply inside
-- those at all, so 458's policy changes alone don't reach them). Same
-- scope boundary as 458: kits/deals RPCs and order/wallet-topup
-- fulfillment are NOT included here, still owner-only.

CREATE OR REPLACE FUNCTION record_shop_sale(p_shop_id uuid, p_items jsonb, p_customer_id uuid DEFAULT NULL) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_sale_id uuid;
  v_total decimal := 0;
  item jsonb;
  v_product shop_products%ROWTYPE;
  v_pack shop_product_packs%ROWTYPE;
  v_pack_id uuid;
  v_qty decimal;
  v_unit_price decimal;
  v_line_total decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required.';
  END IF;
  IF NOT user_manages_shop(p_shop_id) THEN
    RAISE EXCEPTION 'You do not manage this shop.';
  END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one item to the bill.';
  END IF;
  IF p_customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM shop_customers WHERE id = p_customer_id AND shop_id = p_shop_id) THEN
    RAISE EXCEPTION 'That customer is not registered at this shop.';
  END IF;

  INSERT INTO shop_sales (shop_id, sold_by_portal_user_id, total_amount_pkr, customer_id, payment_method)
  VALUES (p_shop_id, v_portal_user_id, 0, p_customer_id, CASE WHEN p_customer_id IS NULL THEN 'cash' ELSE 'credit' END)
  RETURNING id INTO v_sale_id;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_product FROM shop_products WHERE id = (item->>'product_id')::uuid AND shop_id = p_shop_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found in this shop.';
    END IF;

    v_pack_id := NULLIF(item->>'pack_id', '')::uuid;
    v_pack := NULL;
    IF v_pack_id IS NOT NULL THEN
      SELECT * INTO v_pack FROM shop_product_packs WHERE id = v_pack_id AND shop_product_id = v_product.id AND is_active;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'That bulk pack is no longer available for %.', v_product.name;
      END IF;
      v_qty := v_pack.pack_qty;
      v_unit_price := v_pack.pack_price_pkr / v_pack.pack_qty;
      v_line_total := v_pack.pack_price_pkr;
    ELSE
      v_qty := (item->>'quantity')::decimal;
      IF v_qty IS NULL OR v_qty <= 0 THEN
        RAISE EXCEPTION 'Quantity must be greater than zero for %.', v_product.name;
      END IF;
      v_unit_price := v_product.unit_price_pkr;
      v_line_total := v_product.unit_price_pkr * v_qty;
    END IF;

    IF v_product.quantity_on_hand < v_qty THEN
      RAISE EXCEPTION 'Not enough stock for % — % left.', v_product.name, v_product.quantity_on_hand;
    END IF;
    v_total := v_total + v_line_total;

    UPDATE shop_products SET quantity_on_hand = quantity_on_hand - v_qty WHERE id = v_product.id;
    INSERT INTO shop_sale_items (sale_id, product_id, product_name_snapshot, quantity, unit_price_pkr, line_total_pkr, pack_id, pack_label_snapshot)
    VALUES (v_sale_id, v_product.id, v_product.name, v_qty, v_unit_price, v_line_total, v_pack_id, v_pack.label);
  END LOOP;

  UPDATE shop_sales SET total_amount_pkr = v_total WHERE id = v_sale_id;
  RETURN v_sale_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION edit_shop_sale(p_sale_id uuid, p_items jsonb) RETURNS void AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_sale shop_sales%ROWTYPE;
  v_old_item RECORD;
  v_new_total decimal := 0;
  item jsonb;
  v_product shop_products%ROWTYPE;
  v_pack shop_product_packs%ROWTYPE;
  v_pack_id uuid;
  v_qty decimal;
  v_unit_price decimal;
  v_line_total decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required.';
  END IF;
  SELECT * INTO v_sale FROM shop_sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found.';
  END IF;
  IF NOT user_manages_shop(v_sale.shop_id) THEN
    RAISE EXCEPTION 'You do not manage this shop.';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'A bill needs at least one item.';
  END IF;

  FOR v_old_item IN SELECT * FROM shop_sale_items WHERE sale_id = p_sale_id LOOP
    UPDATE shop_products SET quantity_on_hand = quantity_on_hand + v_old_item.quantity WHERE id = v_old_item.product_id;
  END LOOP;
  DELETE FROM shop_sale_items WHERE sale_id = p_sale_id;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_product FROM shop_products WHERE id = (item->>'product_id')::uuid AND shop_id = v_sale.shop_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found in this shop.';
    END IF;

    v_pack_id := NULLIF(item->>'pack_id', '')::uuid;
    v_pack := NULL;
    IF v_pack_id IS NOT NULL THEN
      SELECT * INTO v_pack FROM shop_product_packs WHERE id = v_pack_id AND shop_product_id = v_product.id AND is_active;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'That bulk pack is no longer available for %.', v_product.name;
      END IF;
      v_qty := v_pack.pack_qty;
      v_unit_price := v_pack.pack_price_pkr / v_pack.pack_qty;
      v_line_total := v_pack.pack_price_pkr;
    ELSE
      v_qty := (item->>'quantity')::decimal;
      IF v_qty IS NULL OR v_qty <= 0 THEN
        RAISE EXCEPTION 'Quantity must be greater than zero for %.', v_product.name;
      END IF;
      v_unit_price := v_product.unit_price_pkr;
      v_line_total := v_product.unit_price_pkr * v_qty;
    END IF;

    IF v_product.quantity_on_hand < v_qty THEN
      RAISE EXCEPTION 'Not enough stock for % — % left.', v_product.name, v_product.quantity_on_hand;
    END IF;
    v_new_total := v_new_total + v_line_total;

    UPDATE shop_products SET quantity_on_hand = quantity_on_hand - v_qty WHERE id = v_product.id;
    INSERT INTO shop_sale_items (sale_id, product_id, product_name_snapshot, quantity, unit_price_pkr, line_total_pkr, pack_id, pack_label_snapshot)
    VALUES (p_sale_id, v_product.id, v_product.name, v_qty, v_unit_price, v_line_total, v_pack_id, v_pack.label);
  END LOOP;

  UPDATE shop_sales SET total_amount_pkr = v_new_total WHERE id = p_sale_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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
  v_new_avg_cost decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT user_manages_shop(p_shop_id) THEN
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

    v_new_avg_cost := (GREATEST(v_product.quantity_on_hand, 0) * v_product.cost_price_pkr + v_qty * v_unit_cost)
      / (GREATEST(v_product.quantity_on_hand, 0) + v_qty);
    UPDATE shop_products SET quantity_on_hand = quantity_on_hand + v_qty, cost_price_pkr = ROUND(v_new_avg_cost, 2) WHERE id = v_product.id;
  END LOOP;

  UPDATE shop_purchases SET total_cost_pkr = v_total WHERE id = v_purchase_id;
  RETURN v_purchase_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION record_shop_credit_payment(p_customer_id uuid, p_amount_pkr decimal, p_note text DEFAULT NULL) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_payment_id uuid;
  v_shop_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required.';
  END IF;
  IF p_amount_pkr IS NULL OR p_amount_pkr <= 0 THEN
    RAISE EXCEPTION 'Enter a payment amount greater than zero.';
  END IF;
  SELECT shop_id INTO v_shop_id FROM shop_customers WHERE id = p_customer_id;
  IF v_shop_id IS NULL OR NOT user_manages_shop(v_shop_id) THEN
    RAISE EXCEPTION 'You do not manage this customer''s shop.';
  END IF;

  INSERT INTO shop_customer_payments (customer_id, amount_pkr, note, recorded_by_portal_user_id)
  VALUES (p_customer_id, p_amount_pkr, NULLIF(trim(COALESCE(p_note, '')), ''), v_portal_user_id)
  RETURNING id INTO v_payment_id;
  RETURN v_payment_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION shop_customer_statement(p_customer_id uuid)
RETURNS TABLE (entry_id uuid, entry_type text, entry_at timestamptz, description text, debit decimal, credit decimal, running_balance decimal) AS $$
DECLARE
  v_shop_id uuid;
BEGIN
  SELECT shop_id INTO v_shop_id FROM shop_customers WHERE id = p_customer_id;
  IF v_shop_id IS NULL OR NOT (current_admin_permission('manage_parties') OR user_manages_shop(v_shop_id)) THEN
    RAISE EXCEPTION 'You do not manage this customer''s shop.';
  END IF;

  RETURN QUERY
  WITH entries AS (
    SELECT sa.id AS e_id, 'sale'::text AS e_type, sa.created_at AS e_at,
      'Sale #' || substr(sa.id::text, 1, 8) AS e_description, sa.total_amount_pkr AS e_debit, 0::decimal AS e_credit
    FROM shop_sales sa WHERE sa.customer_id = p_customer_id
    UNION ALL
    SELECT pmt.id, 'payment', pmt.created_at, COALESCE(pmt.note, 'Payment received'), 0::decimal, pmt.amount_pkr
    FROM shop_customer_payments pmt WHERE pmt.customer_id = p_customer_id
    UNION ALL
    SELECT inv.id, 'invoice', inv.created_at, 'Invoice #' || inv.invoice_number || ' generated', 0::decimal, 0::decimal
    FROM shop_customer_invoices inv WHERE inv.customer_id = p_customer_id
  )
  SELECT entries.e_id, entries.e_type, entries.e_at, entries.e_description, entries.e_debit, entries.e_credit,
    SUM(entries.e_debit - entries.e_credit) OVER (ORDER BY entries.e_at, entries.e_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance
  FROM entries
  ORDER BY entries.e_at DESC, entries.e_id DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION shop_customers_with_balance(p_shop_id uuid)
RETURNS TABLE (id uuid, name text, name_ur text, phone text, is_active boolean, balance decimal) AS $$
BEGIN
  IF NOT (current_admin_permission('manage_parties') OR user_manages_shop(p_shop_id)) THEN
    RAISE EXCEPTION 'You do not manage this shop.';
  END IF;

  RETURN QUERY
  SELECT c.id, c.name, c.name_ur, c.phone, c.is_active,
    COALESCE((SELECT SUM(sa.total_amount_pkr) FROM shop_sales sa WHERE sa.customer_id = c.id), 0)
    - COALESCE((SELECT SUM(pmt.amount_pkr) FROM shop_customer_payments pmt WHERE pmt.customer_id = c.id), 0) AS balance
  FROM shop_customers c
  WHERE c.shop_id = p_shop_id
  ORDER BY c.name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION generate_shop_customer_invoice(p_customer_id uuid) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_shop_id uuid;
  v_invoice_id uuid;
  v_number int;
  v_total decimal;
  v_period_start timestamptz;
  v_sale_ids uuid[];
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required.';
  END IF;
  SELECT shop_id INTO v_shop_id FROM shop_customers WHERE id = p_customer_id;
  IF v_shop_id IS NULL OR NOT user_manages_shop(v_shop_id) THEN
    RAISE EXCEPTION 'You do not manage this customer''s shop.';
  END IF;

  SELECT array_agg(sa.id), COALESCE(SUM(sa.total_amount_pkr), 0), MIN(sa.created_at)
    INTO v_sale_ids, v_total, v_period_start
    FROM shop_sales sa
    WHERE sa.customer_id = p_customer_id
      AND NOT EXISTS (SELECT 1 FROM shop_customer_invoice_sales cis WHERE cis.sale_id = sa.id);

  IF v_sale_ids IS NULL THEN
    RAISE EXCEPTION 'Nothing to bill — every sale for this customer is already on an earlier invoice.';
  END IF;

  SELECT COUNT(*) + 1 INTO v_number FROM shop_customer_invoices WHERE customer_id = p_customer_id;

  INSERT INTO shop_customer_invoices (customer_id, invoice_number, period_start, total_amount_pkr)
  VALUES (p_customer_id, v_number, v_period_start, v_total)
  RETURNING id INTO v_invoice_id;

  INSERT INTO shop_customer_invoice_sales (invoice_id, sale_id)
  SELECT v_invoice_id, sale_id FROM unnest(v_sale_ids) AS sale_id;

  RETURN v_invoice_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION shop_best_sellers(p_shop_id uuid, p_days int DEFAULT 30) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF v_portal_user_id IS NULL OR NOT user_manages_shop(p_shop_id) THEN
    RAISE EXCEPTION 'You do not manage this shop.' USING ERRCODE = 'P0001';
  END IF;

  RETURN (
    WITH combined AS (
      SELECT si.product_id, si.product_name_snapshot AS name, si.quantity, si.line_total_pkr
      FROM shop_sale_items si JOIN shop_sales sa ON sa.id = si.sale_id
      WHERE sa.shop_id = p_shop_id AND sa.created_at >= now() - (p_days || ' days')::interval
      UNION ALL
      SELECT oi.product_id, COALESCE(p.name, 'Unknown'), oi.quantity, oi.line_total_pkr
      FROM shop_order_items oi JOIN shop_orders o ON o.id = oi.order_id LEFT JOIN shop_products p ON p.id = oi.product_id
      WHERE o.shop_id = p_shop_id AND o.status = 'confirmed' AND o.confirmed_at >= now() - (p_days || ' days')::interval
    )
    SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
      SELECT product_id, MAX(name) AS name, SUM(quantity) AS quantity, SUM(line_total_pkr) AS revenue_pkr
      FROM combined GROUP BY product_id ORDER BY SUM(line_total_pkr) DESC LIMIT 10
    ) x
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION shop_daily_earnings(p_shop_id uuid, p_days int DEFAULT 14) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_result jsonb;
BEGIN
  IF v_portal_user_id IS NULL OR NOT user_manages_shop(p_shop_id) THEN
    RAISE EXCEPTION 'You do not manage this shop.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('date', d.day, 'walkin_pkr', COALESCE(w.total, 0), 'marketplace_pkr', COALESCE(m.total, 0)) ORDER BY d.day), '[]'::jsonb)
  INTO v_result
  FROM generate_series((now() AT TIME ZONE 'Asia/Karachi')::date - (p_days - 1), (now() AT TIME ZONE 'Asia/Karachi')::date, '1 day') d(day)
  LEFT JOIN (
    SELECT (created_at AT TIME ZONE 'Asia/Karachi')::date AS day, SUM(total_amount_pkr) AS total
    FROM shop_sales WHERE shop_id = p_shop_id GROUP BY 1
  ) w ON w.day = d.day
  LEFT JOIN (
    SELECT (confirmed_at AT TIME ZONE 'Asia/Karachi')::date AS day, SUM(total_amount_pkr) AS total
    FROM shop_orders WHERE shop_id = p_shop_id AND status = 'confirmed' GROUP BY 1
  ) m ON m.day = d.day;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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
  SELECT * INTO v_shop FROM shops WHERE id = p_shop_id;
  IF NOT FOUND OR NOT user_manages_shop(p_shop_id) THEN RAISE EXCEPTION 'You do not manage this shop.' USING ERRCODE = 'P0001'; END IF;

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

CREATE OR REPLACE FUNCTION submit_catalog_brand(p_shop_id uuid, p_brand_name text, p_brand_name_ur text, p_category text, p_items jsonb) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_submission_id uuid;
  item jsonb;
  v_name text; v_name_ur text; v_flavor text; v_flavor_ur text;
  v_cost decimal; v_sale decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in required.' USING ERRCODE = 'P0001'; END IF;
  IF NOT user_manages_shop(p_shop_id) THEN
    RAISE EXCEPTION 'You do not manage this shop.' USING ERRCODE = 'P0001';
  END IF;
  IF p_brand_name IS NULL OR trim(p_brand_name) = '' THEN RAISE EXCEPTION 'Brand name is required.' USING ERRCODE = 'P0001'; END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'Add at least one item.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO catalog_brand_submissions (shop_id, submitted_by_portal_user_id, brand_name, brand_name_ur, category, items)
  VALUES (p_shop_id, v_portal_user_id, trim(p_brand_name), NULLIF(trim(COALESCE(p_brand_name_ur, '')), ''), p_category, p_items)
  RETURNING id INTO v_submission_id;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_name := item->>'name'; v_name_ur := NULLIF(item->>'name_ur', '');
    v_flavor := NULLIF(item->>'flavor', ''); v_flavor_ur := NULLIF(item->>'flavor_ur', '');
    v_cost := COALESCE((item->>'cost_price_pkr')::decimal, 0);
    v_sale := COALESCE((item->>'unit_price_pkr')::decimal, 0);
    IF v_name IS NULL OR trim(v_name) = '' THEN CONTINUE; END IF;

    INSERT INTO shop_products (shop_id, name, name_ur, company, category, flavor, flavor_ur, cost_price_pkr, unit_price_pkr, quantity_on_hand, is_active)
    VALUES (p_shop_id, trim(v_name), v_name_ur, trim(p_brand_name), p_category, v_flavor, v_flavor_ur, v_cost, v_sale, 0, true);
  END LOOP;

  RETURN v_submission_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
