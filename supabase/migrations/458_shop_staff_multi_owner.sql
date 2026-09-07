-- Multiple owners/staff on one shop (e.g. two brothers running it
-- together) — confirmed design (2026-09-08): full equal access, same
-- as the original owner, not a tiered permission system.
--
-- shops.portal_user_id stays exactly what it's always been — the
-- original account, never removable, so a shop can never end up with
-- zero owners. shop_staff is purely ADDITIVE: every extra account gets
-- a row here and, from that point on, can do anything the original
-- owner can.
--
-- user_manages_shop() is now the ONE place "does this portal user
-- manage this shop" is decided — every policy/RPC below that used to
-- inline `EXISTS (SELECT 1 FROM shops s WHERE s.id = ... AND
-- s.portal_user_id = current_portal_user_id())` now calls this instead.
-- SECURITY DEFINER so its own lookup into shop_staff isn't itself
-- gated by shop_staff's RLS (same pattern current_admin_permission
-- already uses) — otherwise checking membership would require a
-- separate way to read shop_staff, which is circular.
--
-- Scope of this pass: every table/RPC this session actually built or
-- touched (products, packs, sales, purchases, customers/credit,
-- invoices, AI settings, dashboard/reports) is now staff-aware. Kits,
-- Deals, catalog-brand-submission review, and marketplace order/wallet-
-- topup fulfillment are NOT yet — still owner-only, a real remaining
-- gap named here on purpose rather than silently left half-done.
CREATE TABLE IF NOT EXISTS shop_staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  added_at timestamptz DEFAULT now(),
  UNIQUE (shop_id, portal_user_id)
);
CREATE INDEX IF NOT EXISTS shop_staff_shop_id_idx ON shop_staff(shop_id);
CREATE INDEX IF NOT EXISTS shop_staff_portal_user_id_idx ON shop_staff(portal_user_id);

ALTER TABLE shop_staff ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shop_staff_owner_read" ON shop_staff FOR SELECT TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id())
    OR portal_user_id = current_portal_user_id()
  );
-- Only the ORIGINAL owner (shops.portal_user_id itself, not another
-- staff member) can add or remove staff — otherwise a shop with three
-- staff could deadlock over who's allowed to remove whom. Simple,
-- matches "one person actually owns the account/number this shop is
-- registered under."
CREATE POLICY "shop_staff_owner_write" ON shop_staff FOR INSERT TO authenticated
  WITH CHECK (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id())
  );
CREATE POLICY "shop_staff_owner_delete" ON shop_staff FOR DELETE TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id())
  );

CREATE OR REPLACE FUNCTION user_manages_shop(p_shop_id uuid) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM shops s WHERE s.id = p_shop_id AND s.portal_user_id = current_portal_user_id())
    OR EXISTS (SELECT 1 FROM shop_staff st WHERE st.shop_id = p_shop_id AND st.portal_user_id = current_portal_user_id());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION user_manages_shop(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION user_manages_shop(uuid) TO authenticated;

-- ═══ shop_products / product_media ══════════════════════════════════
DROP POLICY IF EXISTS "shop_products_write" ON shop_products;
CREATE POLICY "shop_products_write" ON shop_products FOR INSERT TO authenticated
  WITH CHECK (current_admin_permission('manage_parties') OR user_manages_shop(shop_id));
DROP POLICY IF EXISTS "shop_products_update" ON shop_products;
CREATE POLICY "shop_products_update" ON shop_products FOR UPDATE TO authenticated
  USING (true) WITH CHECK (current_admin_permission('manage_parties') OR user_manages_shop(shop_id));
DROP POLICY IF EXISTS "shop_products_delete" ON shop_products;
CREATE POLICY "shop_products_delete" ON shop_products FOR DELETE TO authenticated
  USING (current_admin_permission('delete_transactions') OR user_manages_shop(shop_id));

DROP POLICY IF EXISTS "product_media_write" ON product_media;
CREATE POLICY "product_media_write" ON product_media FOR INSERT TO authenticated
  WITH CHECK (current_admin_permission('manage_parties') OR EXISTS (SELECT 1 FROM shop_products p WHERE p.id = product_id AND user_manages_shop(p.shop_id)));
DROP POLICY IF EXISTS "product_media_update" ON product_media;
CREATE POLICY "product_media_update" ON product_media FOR UPDATE TO authenticated
  USING (true) WITH CHECK (current_admin_permission('manage_parties') OR EXISTS (SELECT 1 FROM shop_products p WHERE p.id = product_id AND user_manages_shop(p.shop_id)));
DROP POLICY IF EXISTS "product_media_delete" ON product_media;
CREATE POLICY "product_media_delete" ON product_media FOR DELETE TO authenticated
  USING (current_admin_permission('manage_parties') OR EXISTS (SELECT 1 FROM shop_products p WHERE p.id = product_id AND user_manages_shop(p.shop_id)));

-- ═══ shop_product_packs ══════════════════════════════════════════════
DROP POLICY IF EXISTS "shop_product_packs_read" ON shop_product_packs;
CREATE POLICY "shop_product_packs_read" ON shop_product_packs FOR SELECT TO authenticated
  USING (current_admin_permission('manage_parties') OR EXISTS (SELECT 1 FROM shop_products p WHERE p.id = shop_product_id AND user_manages_shop(p.shop_id)));
DROP POLICY IF EXISTS "shop_product_packs_write" ON shop_product_packs;
CREATE POLICY "shop_product_packs_write" ON shop_product_packs FOR INSERT TO authenticated
  WITH CHECK (current_admin_permission('manage_parties') OR EXISTS (SELECT 1 FROM shop_products p WHERE p.id = shop_product_id AND user_manages_shop(p.shop_id)));
DROP POLICY IF EXISTS "shop_product_packs_update" ON shop_product_packs;
CREATE POLICY "shop_product_packs_update" ON shop_product_packs FOR UPDATE TO authenticated
  USING (true) WITH CHECK (current_admin_permission('manage_parties') OR EXISTS (SELECT 1 FROM shop_products p WHERE p.id = shop_product_id AND user_manages_shop(p.shop_id)));
DROP POLICY IF EXISTS "shop_product_packs_delete" ON shop_product_packs;
CREATE POLICY "shop_product_packs_delete" ON shop_product_packs FOR DELETE TO authenticated
  USING (current_admin_permission('manage_parties') OR EXISTS (SELECT 1 FROM shop_products p WHERE p.id = shop_product_id AND user_manages_shop(p.shop_id)));

-- ═══ shop_sales / shop_sale_items / shop_purchases / shop_purchase_items (read) ═══
DROP POLICY IF EXISTS "shop_sales_owner_read" ON shop_sales;
CREATE POLICY "shop_sales_owner_read" ON shop_sales FOR SELECT TO authenticated
  USING (current_admin_permission('manage_parties') OR user_manages_shop(shop_id));
DROP POLICY IF EXISTS "shop_sale_items_owner_read" ON shop_sale_items;
CREATE POLICY "shop_sale_items_owner_read" ON shop_sale_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM shop_sales sa WHERE sa.id = sale_id AND (current_admin_permission('manage_parties') OR user_manages_shop(sa.shop_id))));
DROP POLICY IF EXISTS "shop_purchases_owner_read" ON shop_purchases;
CREATE POLICY "shop_purchases_owner_read" ON shop_purchases FOR SELECT TO authenticated
  USING (current_admin_permission('manage_parties') OR user_manages_shop(shop_id));
DROP POLICY IF EXISTS "shop_purchase_items_owner_read" ON shop_purchase_items;
CREATE POLICY "shop_purchase_items_owner_read" ON shop_purchase_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM shop_purchases pu WHERE pu.id = purchase_id AND (current_admin_permission('manage_parties') OR user_manages_shop(pu.shop_id))));

-- ═══ shop_ai_settings ════════════════════════════════════════════════
DROP POLICY IF EXISTS "shop_ai_settings_owner_all" ON shop_ai_settings;
CREATE POLICY "shop_ai_settings_owner_all" ON shop_ai_settings FOR ALL TO authenticated
  USING (current_admin_permission('manage_parties') OR user_manages_shop(shop_id))
  WITH CHECK (current_admin_permission('manage_parties') OR user_manages_shop(shop_id));

-- ═══ shop_customers / payments / invoices / invoice_sales (the credit system) ═══
DROP POLICY IF EXISTS "shop_customers_owner_read" ON shop_customers;
CREATE POLICY "shop_customers_owner_read" ON shop_customers FOR SELECT TO authenticated
  USING (current_admin_permission('manage_parties') OR user_manages_shop(shop_id));
DROP POLICY IF EXISTS "shop_customers_owner_write" ON shop_customers;
CREATE POLICY "shop_customers_owner_write" ON shop_customers FOR INSERT TO authenticated
  WITH CHECK (current_admin_permission('manage_parties') OR user_manages_shop(shop_id));
DROP POLICY IF EXISTS "shop_customers_owner_update" ON shop_customers;
CREATE POLICY "shop_customers_owner_update" ON shop_customers FOR UPDATE TO authenticated
  USING (true) WITH CHECK (current_admin_permission('manage_parties') OR user_manages_shop(shop_id));

DROP POLICY IF EXISTS "shop_customer_payments_owner_read" ON shop_customer_payments;
CREATE POLICY "shop_customer_payments_owner_read" ON shop_customer_payments FOR SELECT TO authenticated
  USING (current_admin_permission('manage_parties') OR EXISTS (SELECT 1 FROM shop_customers c WHERE c.id = customer_id AND user_manages_shop(c.shop_id)));

DROP POLICY IF EXISTS "shop_customer_invoices_owner_read" ON shop_customer_invoices;
CREATE POLICY "shop_customer_invoices_owner_read" ON shop_customer_invoices FOR SELECT TO authenticated
  USING (current_admin_permission('manage_parties') OR EXISTS (SELECT 1 FROM shop_customers c WHERE c.id = customer_id AND user_manages_shop(c.shop_id)));

DROP POLICY IF EXISTS "shop_customer_invoice_sales_owner_read" ON shop_customer_invoice_sales;
CREATE POLICY "shop_customer_invoice_sales_owner_read" ON shop_customer_invoice_sales FOR SELECT TO authenticated
  USING (current_admin_permission('manage_parties') OR EXISTS (SELECT 1 FROM shop_customer_invoices inv JOIN shop_customers c ON c.id = inv.customer_id WHERE inv.id = invoice_id AND user_manages_shop(c.shop_id)));

-- ═══ catalog_brand_submissions (read) ════════════════════════════════
DROP POLICY IF EXISTS "catalog_brand_submissions_owner_read" ON catalog_brand_submissions;
CREATE POLICY "catalog_brand_submissions_owner_read" ON catalog_brand_submissions FOR SELECT TO authenticated
  USING (current_admin_permission('manage_parties') OR user_manages_shop(shop_id));
