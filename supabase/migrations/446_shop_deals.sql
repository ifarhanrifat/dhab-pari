-- Migration 446: Deals & Offers (ڈیلز اور رعایتیں) — Shop Portal v3 §S
-- deals / §B deal. Same object shape as shop_kits (445) on purpose — the
-- design handoff's own note is "kit and deal cards are deliberately the
-- same object shape on the buyer side" — a named bundle of the
-- shopkeeper's own products at a fixed quantity each, discounted three
-- possible ways (percent off, flat amount off, or a fixed package
-- price), running for a fixed number of days from creation. Price is
-- still computed live from current shop_products prices before the
-- discount is applied, same reasoning as kits: a deal never goes stale
-- when an ingredient's own price changes.
CREATE TABLE IF NOT EXISTS shop_deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name varchar NOT NULL,
  name_ur varchar,
  sub varchar,           -- one-line description, e.g. "عید پیکج — سب کچھ ایک ساتھ"
  sub_ur varchar,
  tint varchar NOT NULL DEFAULT 'accent' CHECK (tint IN ('accent', 'ink', 'photo')),
  photo_url text,        -- only meaningful when tint = 'photo'
  discount_kind varchar NOT NULL CHECK (discount_kind IN ('percent', 'amount', 'fixed_price')),
  discount_value decimal NOT NULL CHECK (discount_value >= 0),
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz NOT NULL,
  display_order int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shop_deal_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES shop_deals(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  quantity decimal NOT NULL DEFAULT 1 CHECK (quantity > 0)
);
CREATE INDEX IF NOT EXISTS shop_deals_shop_id_idx ON shop_deals(shop_id);
CREATE INDEX IF NOT EXISTS shop_deal_items_deal_id_idx ON shop_deal_items(deal_id);

ALTER TABLE shop_deals ENABLE ROW LEVEL SECURITY;
-- Public read (buyers on any shop's front need to see its running deals,
-- same openness as shop_kits/shop_products' own buyer-facing read
-- policies) — a shop's own keeper/staff still gate the write side.
CREATE POLICY "shop_deals_public_read" ON shop_deals FOR SELECT TO authenticated USING (true);
CREATE POLICY "shop_deals_owner_write" ON shop_deals FOR ALL TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id())
  )
  WITH CHECK (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id())
  );

ALTER TABLE shop_deal_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shop_deal_items_public_read" ON shop_deal_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "shop_deal_items_owner_write" ON shop_deal_items FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM shop_deals d JOIN shops s ON s.id = d.shop_id
      WHERE d.id = deal_id AND (current_admin_permission('manage_parties') OR s.portal_user_id = current_portal_user_id())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM shop_deals d JOIN shops s ON s.id = d.shop_id
      WHERE d.id = deal_id AND (current_admin_permission('manage_parties') OR s.portal_user_id = current_portal_user_id())
    )
  );

-- ── Save (create or replace) a deal's full item list in one call ────────
-- Mirrors save_shop_kit exactly — the builder always submits its whole
-- picked list at once, so this replaces shop_deal_items wholesale rather
-- than diffing. p_valid_days computes expires_at server-side from "now"
-- at save time (the design's own "VALID FOR / کتنے دن" chips), so
-- editing a running deal to extend it just means saving again.
CREATE OR REPLACE FUNCTION save_shop_deal(
  p_deal_id uuid, p_shop_id uuid, p_name varchar, p_name_ur varchar, p_sub varchar, p_sub_ur varchar,
  p_tint varchar, p_photo_url text, p_discount_kind varchar, p_discount_value decimal, p_valid_days int, p_items jsonb
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_deal_id uuid;
  item jsonb;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in required.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM shops WHERE id = p_shop_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this shop.';
  END IF;
  IF trim(COALESCE(p_name, '')) = '' THEN RAISE EXCEPTION 'Give the deal a name.'; END IF;
  IF jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'Add at least one item to the deal.'; END IF;
  IF p_discount_kind NOT IN ('percent', 'amount', 'fixed_price') THEN RAISE EXCEPTION 'Invalid discount type.'; END IF;

  IF p_deal_id IS NOT NULL THEN
    UPDATE shop_deals SET name = p_name, name_ur = p_name_ur, sub = p_sub, sub_ur = p_sub_ur,
      tint = p_tint, photo_url = p_photo_url, discount_kind = p_discount_kind, discount_value = p_discount_value,
      expires_at = now() + (GREATEST(p_valid_days, 1) || ' days')::interval
    WHERE id = p_deal_id AND shop_id = p_shop_id
    RETURNING id INTO v_deal_id;
    IF v_deal_id IS NULL THEN RAISE EXCEPTION 'Deal not found.'; END IF;
    DELETE FROM shop_deal_items WHERE deal_id = v_deal_id;
  ELSE
    INSERT INTO shop_deals (shop_id, name, name_ur, sub, sub_ur, tint, photo_url, discount_kind, discount_value, expires_at)
    VALUES (p_shop_id, p_name, p_name_ur, p_sub, p_sub_ur, p_tint, p_photo_url, p_discount_kind, p_discount_value,
      now() + (GREATEST(p_valid_days, 1) || ' days')::interval)
    RETURNING id INTO v_deal_id;
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO shop_deal_items (deal_id, product_id, quantity)
    VALUES (v_deal_id, (item->>'product_id')::uuid, COALESCE((item->>'quantity')::decimal, 1))
    ON CONFLICT DO NOTHING;
  END LOOP;

  RETURN v_deal_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION save_shop_deal(uuid, uuid, varchar, varchar, varchar, varchar, varchar, text, varchar, decimal, int, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_shop_deal(uuid, uuid, varchar, varchar, varchar, varchar, varchar, text, varchar, decimal, int, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION delete_shop_deal(p_deal_id uuid) RETURNS void AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in required.'; END IF;
  DELETE FROM shop_deals d WHERE d.id = p_deal_id
    AND EXISTS (SELECT 1 FROM shops s WHERE s.id = d.shop_id AND s.portal_user_id = v_portal_user_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION delete_shop_deal(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION delete_shop_deal(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION toggle_shop_deal(p_deal_id uuid, p_is_active boolean) RETURNS void AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in required.'; END IF;
  UPDATE shop_deals d SET is_active = p_is_active WHERE d.id = p_deal_id
    AND EXISTS (SELECT 1 FROM shops s WHERE s.id = d.shop_id AND s.portal_user_id = v_portal_user_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION toggle_shop_deal(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION toggle_shop_deal(uuid, boolean) TO authenticated;
