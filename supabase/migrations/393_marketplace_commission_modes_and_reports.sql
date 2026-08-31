-- Migration 393: Two commission models for a shop (per-order percentage,
-- unchanged default, vs. a staff-set monthly flat fee with zero per-order
-- commission), the demand-search perk that makes the flat-fee tier worth
-- choosing, and a proper back-office for shop keepers — order history,
-- walk-in sales history, cash-flow/earnings, best sellers — none of which
-- existed yet; a keeper could only manage their catalog and ring up a sale,
-- with no way to see their own numbers.

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Commission mode — mutually exclusive per shop, staff-set (same
--    manage_parties gate as everything else about a shop's own record).
--    per_order is every shop's starting point; monthly_lumpsum is an
--    upgrade staff switches a shop into once its volume is known well
--    enough to price a fair flat fee. Switching is never retroactive —
--    already-confirmed orders already posted their vouchers under
--    whichever rule was active at the time, this only changes what
--    confirm_shop_order does for orders confirmed AFTER the switch.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE shops ADD COLUMN IF NOT EXISTS commission_mode varchar NOT NULL DEFAULT 'per_order'
  CHECK (commission_mode IN ('per_order', 'monthly_lumpsum'));
ALTER TABLE shops ADD COLUMN IF NOT EXISTS lumpsum_fee_pkr decimal CHECK (lumpsum_fee_pkr IS NULL OR lumpsum_fee_pkr >= 0);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS commission_mode_changed_at timestamptz;

CREATE OR REPLACE FUNCTION trg_shop_commission_mode_stamp() RETURNS trigger AS $$
BEGIN
  IF NEW.commission_mode IS DISTINCT FROM OLD.commission_mode THEN
    NEW.commission_mode_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shop_commission_mode_stamp_trigger ON shops;
CREATE TRIGGER shop_commission_mode_stamp_trigger BEFORE UPDATE ON shops
  FOR EACH ROW EXECUTE FUNCTION trg_shop_commission_mode_stamp();

-- confirm_shop_order (389) rewritten: identical gross-sale leg; the
-- commission leg is now skipped entirely for a monthly_lumpsum shop — the
-- committee already collected for this shop's selling rights via its flat
-- fee, so nothing more is deducted per order. Same signature, CREATE OR
-- REPLACE is enough.
CREATE OR REPLACE FUNCTION confirm_shop_order(p_order_id uuid) RETURNS jsonb AS $$
DECLARE
  o shop_orders%ROWTYPE; s shops%ROWTYPE;
  v_shop_account uuid; v_cash_account uuid; v_commission_account uuid;
  v_commission_pct decimal; v_commission_amount decimal;
  v_gross_voucher_id uuid; v_gross_voucher_no varchar; v_commission_voucher_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO o FROM shop_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0001'; END IF;
  IF o.status <> 'announced' THEN RAISE EXCEPTION 'This order is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO s FROM shops WHERE id = o.shop_id;
  v_shop_account := ensure_shop_account(o.shop_id);

  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects'
    AND code = (CASE WHEN o.announced_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);
  SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050';

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Order from ' || s.name || ' — paid via portal, confirmed', o.announced_amount_pkr, v_shop_account, v_cash_account, s.name)
  RETURNING id, voucher_no INTO v_gross_voucher_id, v_gross_voucher_no;

  IF s.commission_mode = 'per_order' THEN
    SELECT COALESCE(value::decimal, 0) INTO v_commission_pct FROM site_settings WHERE key = 'marketplace_shop_commission_pct';
    v_commission_amount := round(o.announced_amount_pkr * v_commission_pct / 100, 2);

    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — order from ' || s.name, v_commission_amount, v_commission_account, v_shop_account, s.name)
      RETURNING id INTO v_commission_voucher_id;
    END IF;
  END IF;
  -- monthly_lumpsum: no commission leg — the flat fee already covers it
  -- (see post_shop_lumpsum_charges below).

  UPDATE shop_orders SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
    gross_voucher_id = v_gross_voucher_id, commission_voucher_id = v_commission_voucher_id
  WHERE id = p_order_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (o.portal_user_id, 'shop_order_confirmed', 'Order confirmed', 'Your order from ' || s.name || ' has been confirmed.', '/accounts');

  RETURN jsonb_build_object('voucher_no', v_gross_voucher_no, 'amount', o.announced_amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Monthly flat-fee billing — one charge per shop per calendar month,
--    posted the same two-account way as a commission leg (debits the
--    shop's own clearing account, credits marketplace income) so it nets
--    straight into the same balance a settlement later pays out — a
--    lumpsum shop that hasn't sold enough that month simply owes the
--    committee the difference, same as any subscription.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS shop_lumpsum_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  period varchar NOT NULL, -- 'YYYY-MM', Asia/Karachi
  amount_pkr decimal NOT NULL,
  voucher_id uuid REFERENCES vouchers(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE (shop_id, period)
);

ALTER TABLE shop_lumpsum_charges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shop_lumpsum_charges_admin_read" ON shop_lumpsum_charges FOR SELECT TO authenticated
  USING (can_access_system('donors_projects'));
CREATE POLICY "shop_lumpsum_charges_keeper_read" ON shop_lumpsum_charges FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id()));

CREATE OR REPLACE FUNCTION post_shop_lumpsum_charges() RETURNS void AS $$
DECLARE
  r RECORD;
  v_commission_account uuid;
  v_shop_account uuid;
  v_period varchar := to_char((now() AT TIME ZONE 'Asia/Karachi')::date, 'YYYY-MM');
  v_voucher_id uuid;
BEGIN
  SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050';

  FOR r IN
    SELECT * FROM shops WHERE commission_mode = 'monthly_lumpsum' AND COALESCE(lumpsum_fee_pkr, 0) > 0 AND status = 'active'
  LOOP
    IF EXISTS (SELECT 1 FROM shop_lumpsum_charges WHERE shop_id = r.id AND period = v_period) THEN
      CONTINUE; -- already charged this period (re-run safety)
    END IF;

    v_shop_account := ensure_shop_account(r.id);
    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
    VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
      'Monthly marketplace subscription — ' || r.name || ' (' || v_period || ')', r.lumpsum_fee_pkr, v_commission_account, v_shop_account, r.name)
    RETURNING id INTO v_voucher_id;

    INSERT INTO shop_lumpsum_charges (shop_id, period, amount_pkr, voucher_id) VALUES (r.id, v_period, r.lumpsum_fee_pkr, v_voucher_id);

    IF r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (r.portal_user_id, 'shop_lumpsum_charged', 'Monthly fee charged',
        'This month''s marketplace subscription fee has been charged to your account.', '/portal/my-shop/reports');
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DO $$
BEGIN
  PERFORM cron.schedule('shop-lumpsum-monthly-charges', '0 4 1 * *', 'SELECT post_shop_lumpsum_charges()');
  RAISE NOTICE 'pg_cron: monthly shop subscription charges run 09:00 PKT on the 1st of each month';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable — run post_shop_lumpsum_charges() by hand. %', SQLERRM;
END $$;

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('shop_lumpsum_charged', 'A shop''s monthly marketplace subscription fee was charged', false, true)
ON CONFLICT (event_type) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Demand insights — the actual reason a shop would want the flat-fee
--    tier over per-order. Every marketplace search gets logged (query
--    text + whether it matched anything); a monthly_lumpsum shop's own
--    keeper can see the aggregate, platform-wide — matched searches show
--    what's popular, UNMATCHED ones show real unmet demand nobody nearby
--    is stocking. The log table itself has no SELECT policy at all —
--    every read goes through the report function below.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS marketplace_search_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query text NOT NULL,
  result_count int NOT NULL,
  searched_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketplace_search_log_searched_at_idx ON marketplace_search_log(searched_at);
ALTER TABLE marketplace_search_log ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies — nobody can SELECT/INSERT this table directly,
-- not even a staff account; search_marketplace_products() and the report
-- function below run as their SECURITY DEFINER owner, which bypasses RLS.

-- search_marketplace_products (389, extended for flavor in 392) now also
-- logs each search — same signature and return shape, just no longer a
-- pure read (hence LANGUAGE plpgsql instead of sql, and no longer STABLE).
CREATE OR REPLACE FUNCTION search_marketplace_products(p_query text) RETURNS jsonb AS $$
DECLARE
  v_results jsonb;
  v_count int;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'product_id', p.id, 'product_name', p.name, 'product_name_ur', p.name_ur,
    'flavor', p.flavor, 'flavor_ur', p.flavor_ur, 'unit_price_pkr', p.unit_price_pkr,
    'shop_id', s.id, 'shop_name', s.name, 'shop_name_ur', s.name_ur,
    'shop_location', s.location, 'shop_location_ur', s.location_ur, 'delivery_enabled', s.delivery_enabled
  ) ORDER BY p.unit_price_pkr), '[]'::jsonb), count(*)
  INTO v_results, v_count
  FROM shop_products p
  JOIN shops s ON s.id = p.shop_id
  WHERE p.is_active AND s.status = 'active'
    AND (p.name ILIKE '%' || p_query || '%' OR p.name_ur ILIKE '%' || p_query || '%'
      OR p.flavor ILIKE '%' || p_query || '%' OR p.flavor_ur ILIKE '%' || p_query || '%');

  IF trim(p_query) <> '' THEN
    INSERT INTO marketplace_search_log (query, result_count) VALUES (trim(p_query), v_count);
  END IF;

  RETURN v_results;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION marketplace_search_demand_report(p_days int DEFAULT 30) RETURNS jsonb AS $$
DECLARE
  v_authorized boolean := false;
BEGIN
  IF COALESCE(current_admin_permission('manage_parties'), false) THEN v_authorized := true; END IF;
  IF NOT v_authorized AND EXISTS (
    SELECT 1 FROM shops WHERE portal_user_id = current_portal_user_id() AND commission_mode = 'monthly_lumpsum'
  ) THEN v_authorized := true; END IF;
  IF NOT v_authorized THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;

  RETURN jsonb_build_object(
    'matched', (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
      SELECT query, count(*) AS searches FROM marketplace_search_log
      WHERE searched_at >= now() - (p_days || ' days')::interval AND result_count > 0
      GROUP BY query ORDER BY count(*) DESC LIMIT 20
    ) x),
    'unmatched', (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
      SELECT query, count(*) AS searches FROM marketplace_search_log
      WHERE searched_at >= now() - (p_days || ' days')::interval AND result_count = 0
      GROUP BY query ORDER BY count(*) DESC LIMIT 20
    ) x)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION marketplace_search_demand_report(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION marketplace_search_demand_report(int) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. Order visibility for the shop's own keeper — shop_orders/
--    shop_order_items (389) only had admin-read and the CUSTOMER's own
--    read; a shop's keeper had no way to see orders placed against their
--    own shop at all, so they get the same additive read shop_products
--    already has.
-- ═════════════════════════════════════════════════════════════════════════
CREATE POLICY "shop_orders_keeper_read" ON shop_orders FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id()));
CREATE POLICY "shop_order_items_keeper_read" ON shop_order_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM shop_orders o JOIN shops s ON s.id = o.shop_id WHERE o.id = order_id AND s.portal_user_id = current_portal_user_id()));

-- ═════════════════════════════════════════════════════════════════════════
-- 5. Cash-flow / earnings back-office. accounts/ledger_entries are
--    deliberately closed to portal users (182) — a shop keeper's balance
--    is exposed only through this SECURITY DEFINER summary, never by
--    widening those tables' own RLS. Profit is a best-effort figure using
--    each product's CURRENT cost_price_pkr, not a price frozen at sale
--    time (neither shop_sale_items nor shop_order_items snapshot cost) —
--    an acceptable approximation for a "how am I doing" dashboard, not a
--    formal accounting figure.
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

  SELECT count(*) INTO v_pending_orders FROM shop_orders WHERE shop_id = p_shop_id AND status = 'announced';
  SELECT count(*) INTO v_low_stock FROM shop_products WHERE shop_id = p_shop_id AND is_active AND quantity_on_hand <= 5;
  SELECT count(*) INTO v_expiring FROM shop_products WHERE shop_id = p_shop_id AND is_active AND expiry_date IS NOT NULL AND expiry_date BETWEEN v_today AND v_today + 7;

  SELECT settled_date, amount_pkr INTO v_last_settle FROM collector_settlements WHERE shop_id = p_shop_id ORDER BY settled_date DESC LIMIT 1;

  RETURN jsonb_build_object(
    'balance_pkr', v_balance, 'commission_mode', v_shop.commission_mode, 'lumpsum_fee_pkr', v_shop.lumpsum_fee_pkr,
    'today_earnings_pkr', v_today_walkin + v_today_market, 'month_earnings_pkr', v_month_walkin + v_month_market,
    'month_profit_pkr', (v_month_walkin + v_month_market) - (v_month_cost_walkin + v_month_cost_market),
    'pending_orders_count', v_pending_orders, 'low_stock_count', v_low_stock, 'expiring_count', v_expiring,
    'last_settlement_date', v_last_settle.settled_date, 'last_settlement_amount', v_last_settle.amount_pkr
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION shop_daily_earnings(p_shop_id uuid, p_days int DEFAULT 14) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_result jsonb;
BEGIN
  IF v_portal_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM shops WHERE id = p_shop_id AND portal_user_id = v_portal_user_id) THEN
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

CREATE OR REPLACE FUNCTION shop_best_sellers(p_shop_id uuid, p_days int DEFAULT 30) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_result jsonb;
BEGIN
  IF v_portal_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM shops WHERE id = p_shop_id AND portal_user_id = v_portal_user_id) THEN
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

REVOKE ALL ON FUNCTION shop_dashboard_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION shop_dashboard_summary(uuid) TO authenticated;
REVOKE ALL ON FUNCTION shop_daily_earnings(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION shop_daily_earnings(uuid, int) TO authenticated;
REVOKE ALL ON FUNCTION shop_best_sellers(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION shop_best_sellers(uuid, int) TO authenticated;
