-- Migration 433: buyer-facing "popular" row for a shop's front screen
-- (design spec §4) — shop_best_sellers (393) already computes exactly
-- this shape but is hard-restricted to the shop's OWN keeper (a genuine
-- privacy boundary: that RPC also returns revenue_pkr, real money the
-- shop doesn't want a browsing customer to see). This is the public
-- twin: same "top products by recent sold quantity" idea, but scoped to
-- ANY active/delivery-enabled shop, and deliberately returns quantity
-- only — no revenue_pkr, no cost, nothing a buyer shouldn't see.
CREATE OR REPLACE FUNCTION shop_popular_products(p_shop_id uuid, p_days int DEFAULT 30, p_limit int DEFAULT 8) RETURNS jsonb AS $$
DECLARE
  v_shop shops%ROWTYPE;
BEGIN
  SELECT * INTO v_shop FROM shops WHERE id = p_shop_id;
  IF NOT FOUND OR v_shop.status <> 'active' THEN RETURN '[]'::jsonb; END IF;

  RETURN (
    WITH combined AS (
      SELECT si.product_id, SUM(si.quantity) AS qty
      FROM shop_sale_items si JOIN shop_sales sa ON sa.id = si.sale_id
      WHERE sa.shop_id = p_shop_id AND sa.created_at >= now() - (p_days || ' days')::interval
      GROUP BY si.product_id
      UNION ALL
      SELECT oi.product_id, SUM(oi.quantity)
      FROM shop_order_items oi JOIN shop_orders o ON o.id = oi.order_id
      WHERE o.shop_id = p_shop_id AND o.status = 'confirmed' AND o.confirmed_at >= now() - (p_days || ' days')::interval
      GROUP BY oi.product_id
    ), totals AS (
      SELECT product_id, SUM(qty) AS total_qty FROM combined WHERE product_id IS NOT NULL GROUP BY product_id
    )
    SELECT COALESCE(jsonb_agg(t.product_id ORDER BY t.total_qty DESC), '[]'::jsonb)
    FROM (SELECT product_id, total_qty FROM totals ORDER BY total_qty DESC LIMIT p_limit) t
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION shop_popular_products(uuid, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION shop_popular_products(uuid, int, int) TO authenticated;
