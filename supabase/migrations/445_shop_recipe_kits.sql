-- Migration 445: Recipe kits (پکوان کے مکمل سیٹ) — Shop Portal v3 §E,
-- made shopkeeper-managed in v3.2 §J. A kit is a named list of the
-- shopkeeper's OWN products at a fixed quantity each — tapping it on the
-- buyer front pre-fills the cart with every line the shop actually
-- stocks (lines it doesn't carry render dimmed client-side, never block
-- the kit — see the buyer-facing component). Price is computed live from
-- current shop_products prices, never stored, so a kit never goes stale
-- when the shopkeeper repriced an ingredient.
CREATE TABLE IF NOT EXISTS shop_kits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name varchar NOT NULL,
  name_ur varchar,
  sub varchar,           -- one-line description, e.g. "چائے پکوڑے کے لیے سب کچھ"
  sub_ur varchar,
  tint varchar NOT NULL DEFAULT 'ink' CHECK (tint IN ('accent', 'ink', 'photo')),
  photo_url text,        -- only meaningful when tint = 'photo'
  display_order int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shop_kit_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kit_id uuid NOT NULL REFERENCES shop_kits(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  quantity decimal NOT NULL DEFAULT 1 CHECK (quantity > 0)
);
CREATE INDEX IF NOT EXISTS shop_kits_shop_id_idx ON shop_kits(shop_id);
CREATE INDEX IF NOT EXISTS shop_kit_items_kit_id_idx ON shop_kit_items(kit_id);

ALTER TABLE shop_kits ENABLE ROW LEVEL SECURITY;
-- Public read (buyers on any shop's front need to see its kits — same
-- openness as shop_products' own buyer-facing read policy), write
-- restricted to the shop's own keeper or staff.
CREATE POLICY "shop_kits_public_read" ON shop_kits FOR SELECT TO authenticated USING (true);
CREATE POLICY "shop_kits_owner_write" ON shop_kits FOR ALL TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id())
  )
  WITH CHECK (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id())
  );

ALTER TABLE shop_kit_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shop_kit_items_public_read" ON shop_kit_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "shop_kit_items_owner_write" ON shop_kit_items FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM shop_kits k JOIN shops s ON s.id = k.shop_id
      WHERE k.id = kit_id AND (current_admin_permission('manage_parties') OR s.portal_user_id = current_portal_user_id())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM shop_kits k JOIN shops s ON s.id = k.shop_id
      WHERE k.id = kit_id AND (current_admin_permission('manage_parties') OR s.portal_user_id = current_portal_user_id())
    )
  );

-- ── Save (create or replace) a kit's full item list in one call ─────────
-- Simpler for the builder UI than separate add/remove-line endpoints —
-- the shopkeeper's kit builder always submits its whole picked list at
-- once (same "submit the whole selection" shape as BrandItemPicker's own
-- commit), so this just replaces shop_kit_items wholesale rather than
-- diffing.
CREATE OR REPLACE FUNCTION save_shop_kit(
  p_kit_id uuid, p_shop_id uuid, p_name varchar, p_name_ur varchar, p_sub varchar, p_sub_ur varchar,
  p_tint varchar, p_photo_url text, p_items jsonb
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_kit_id uuid;
  item jsonb;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in required.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM shops WHERE id = p_shop_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this shop.';
  END IF;
  IF trim(COALESCE(p_name, '')) = '' THEN RAISE EXCEPTION 'Give the kit a name.'; END IF;
  IF jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'Add at least one item to the kit.'; END IF;

  IF p_kit_id IS NOT NULL THEN
    UPDATE shop_kits SET name = p_name, name_ur = p_name_ur, sub = p_sub, sub_ur = p_sub_ur,
      tint = p_tint, photo_url = p_photo_url
    WHERE id = p_kit_id AND shop_id = p_shop_id
    RETURNING id INTO v_kit_id;
    IF v_kit_id IS NULL THEN RAISE EXCEPTION 'Kit not found.'; END IF;
    DELETE FROM shop_kit_items WHERE kit_id = v_kit_id;
  ELSE
    INSERT INTO shop_kits (shop_id, name, name_ur, sub, sub_ur, tint, photo_url)
    VALUES (p_shop_id, p_name, p_name_ur, p_sub, p_sub_ur, p_tint, p_photo_url)
    RETURNING id INTO v_kit_id;
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO shop_kit_items (kit_id, product_id, quantity)
    VALUES (v_kit_id, (item->>'product_id')::uuid, COALESCE((item->>'quantity')::decimal, 1))
    ON CONFLICT DO NOTHING;
  END LOOP;

  RETURN v_kit_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION save_shop_kit(uuid, uuid, varchar, varchar, varchar, varchar, varchar, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_shop_kit(uuid, uuid, varchar, varchar, varchar, varchar, varchar, text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION delete_shop_kit(p_kit_id uuid) RETURNS void AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in required.'; END IF;
  DELETE FROM shop_kits k WHERE k.id = p_kit_id
    AND EXISTS (SELECT 1 FROM shops s WHERE s.id = k.shop_id AND s.portal_user_id = v_portal_user_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION delete_shop_kit(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION delete_shop_kit(uuid) TO authenticated;
