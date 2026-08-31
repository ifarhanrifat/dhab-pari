-- Migration 391: AI-assisted catalog entry + in-person point-of-sale for
-- shop keepers. A shop keeper (a portal user linked to their shop via
-- shops.portal_user_id, set by staff same as everything else in this
-- listing) can now manage their own catalog directly instead of going
-- through staff every time, using their own free Gemini API key to
-- photograph a product and have its name/company/category autofilled.
-- The same recognition is reused at sale time to build a walk-in bill.
--
-- Walk-in sales (shop_sales) are deliberately kept OUT of the committee's
-- ledger: the customer pays the shopkeeper directly at their own counter,
-- the committee never touches that cash and never facilitated the sale,
-- so there is no commission and nothing to post — this table exists only
-- so a shop keeper gets their own stock/sales bookkeeping. That's the
-- real dividing line from shop_orders (388/389): an order is a delivery
-- the committee's checkout facilitated and takes a cut of; a walk-in sale
-- is the shopkeeper's own counter transaction the platform is just
-- helping them ring up and track stock for.

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Catalog fields the AI extraction (and manual entry) fills in: a fixed
--    default category list, brand/company, and a buying (cost) price
--    alongside the existing selling price — the last one also unlocks a
--    real profit-margin view later, for free.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS category varchar
  CHECK (category IN ('biscuits_snacks', 'beverages', 'grocery_pantry', 'dairy', 'frozen',
    'personal_care', 'household', 'stationery', 'cigarettes_paan', 'other'));
ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS company varchar;
ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS company_ur varchar;
ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS cost_price_pkr decimal NOT NULL DEFAULT 0 CHECK (cost_price_pkr >= 0);
CREATE INDEX IF NOT EXISTS shop_products_category_idx ON shop_products(category) WHERE category IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Link a shop to the portal account of the person who actually runs
--    its counter. Staff still creates the listing itself (unchanged from
--    388) — this just designates who gets self-service catalog/POS access
--    once it exists. Nullable: a shop with no linked keeper simply has no
--    self-service access yet, staff manages it exactly as before.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE shops ADD COLUMN IF NOT EXISTS portal_user_id uuid REFERENCES portal_users(id);
CREATE INDEX IF NOT EXISTS shops_portal_user_id_idx ON shops(portal_user_id) WHERE portal_user_id IS NOT NULL;

-- A shop's own keeper can now maintain their catalog directly (photos,
-- prices, stock, expiry) — additive to the existing manage_parties (staff)
-- policies from 388, not a replacement of them.
DROP POLICY IF EXISTS "shop_products_write" ON shop_products;
CREATE POLICY "shop_products_write" ON shop_products FOR INSERT TO authenticated
  WITH CHECK (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id())
  );
DROP POLICY IF EXISTS "shop_products_update" ON shop_products;
CREATE POLICY "shop_products_update" ON shop_products FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id())
  );
DROP POLICY IF EXISTS "shop_products_delete" ON shop_products;
CREATE POLICY "shop_products_delete" ON shop_products FOR DELETE TO authenticated
  USING (
    current_admin_permission('delete_transactions')
    OR EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id())
  );

-- Same widening for product_media, so a keeper's camera-captured cover
-- photo can actually be attached to the product they just created.
DROP POLICY IF EXISTS "product_media_write" ON product_media;
CREATE POLICY "product_media_write" ON product_media FOR INSERT TO authenticated
  WITH CHECK (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM shop_products p JOIN shops s ON s.id = p.shop_id WHERE p.id = product_id AND s.portal_user_id = current_portal_user_id())
  );
DROP POLICY IF EXISTS "product_media_update" ON product_media;
CREATE POLICY "product_media_update" ON product_media FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM shop_products p JOIN shops s ON s.id = p.shop_id WHERE p.id = product_id AND s.portal_user_id = current_portal_user_id())
  );
DROP POLICY IF EXISTS "product_media_delete" ON product_media;
CREATE POLICY "product_media_delete" ON product_media FOR DELETE TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM shop_products p JOIN shops s ON s.id = p.shop_id WHERE p.id = product_id AND s.portal_user_id = current_portal_user_id())
  );

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Each shop's own Gemini key. Kept in its own table, never on `shops`
--    itself (which has a public "read everything" policy for the
--    marketplace browse/search page) — RLS here only ever grants SELECT
--    to the shop's own keeper or staff, nobody else, so the key never
--    reaches a page that lists shops publicly. All actual AI calls happen
--    server-side (the API route), the key is never sent to a browser.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS shop_ai_settings (
  shop_id uuid PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
  gemini_api_key text,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE shop_ai_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shop_ai_settings_owner_all" ON shop_ai_settings FOR ALL TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id())
  )
  WITH CHECK (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id())
  );

-- ═════════════════════════════════════════════════════════════════════════
-- 4. Walk-in sales — the shopkeeper's own in-person bill, built the same
--    way the checkout cart is (one row per line item), but recorded by
--    record_shop_sale() below instead of place_shop_order(): no
--    announce/confirm step (nothing to reconcile — the shopkeeper already
--    has the cash in hand), no ledger postings (see the note at the top).
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS shop_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  sold_by_portal_user_id uuid REFERENCES portal_users(id),
  total_amount_pkr decimal NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shop_sale_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES shop_sales(id) ON DELETE CASCADE,
  product_id uuid REFERENCES shop_products(id),
  product_name_snapshot varchar NOT NULL,
  quantity decimal NOT NULL CHECK (quantity > 0),
  unit_price_pkr decimal NOT NULL,
  line_total_pkr decimal NOT NULL
);
CREATE INDEX IF NOT EXISTS shop_sales_shop_id_idx ON shop_sales(shop_id);
CREATE INDEX IF NOT EXISTS shop_sale_items_sale_id_idx ON shop_sale_items(sale_id);

ALTER TABLE shop_sales ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shop_sales_owner_read" ON shop_sales FOR SELECT TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id())
  );
ALTER TABLE shop_sale_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shop_sale_items_owner_read" ON shop_sale_items FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM shop_sales sa JOIN shops s ON s.id = sa.shop_id
      WHERE sa.id = sale_id AND (current_admin_permission('manage_parties') OR s.portal_user_id = current_portal_user_id())
    )
  );
-- No direct INSERT policy on either table — writes only happen through
-- record_shop_sale() below (SECURITY DEFINER), so the stock decrement and
-- the sale row can never drift apart.

CREATE OR REPLACE FUNCTION record_shop_sale(p_shop_id uuid, p_items jsonb) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_sale_id uuid;
  v_total decimal := 0;
  item jsonb;
  v_product shop_products%ROWTYPE;
  v_qty decimal;
  v_line_total decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM shops WHERE id = p_shop_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this shop.';
  END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one item to the bill.';
  END IF;

  INSERT INTO shop_sales (shop_id, sold_by_portal_user_id, total_amount_pkr)
  VALUES (p_shop_id, v_portal_user_id, 0) RETURNING id INTO v_sale_id;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_product FROM shop_products WHERE id = (item->>'product_id')::uuid AND shop_id = p_shop_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found in this shop.';
    END IF;
    v_qty := (item->>'quantity')::decimal;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Quantity must be greater than zero for %.', v_product.name;
    END IF;
    IF v_product.quantity_on_hand < v_qty THEN
      RAISE EXCEPTION 'Not enough stock for % — % left.', v_product.name, v_product.quantity_on_hand;
    END IF;
    v_line_total := v_product.unit_price_pkr * v_qty;
    v_total := v_total + v_line_total;

    UPDATE shop_products SET quantity_on_hand = quantity_on_hand - v_qty WHERE id = v_product.id;
    INSERT INTO shop_sale_items (sale_id, product_id, product_name_snapshot, quantity, unit_price_pkr, line_total_pkr)
    VALUES (v_sale_id, v_product.id, v_product.name, v_qty, v_product.unit_price_pkr, v_line_total);
  END LOOP;

  UPDATE shop_sales SET total_amount_pkr = v_total WHERE id = v_sale_id;
  RETURN v_sale_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION record_shop_sale(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_shop_sale(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION record_shop_sale(uuid, jsonb) TO authenticated;
