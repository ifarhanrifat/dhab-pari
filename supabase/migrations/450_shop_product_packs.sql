-- Bulk pack pricing — the real Pakistani-shop pattern the user described:
-- Lays comes in a container of ~80 pieces, Pampers in a packet of a
-- dozen, sugar/rice/vegetables sell per-kg but also at a cheaper bulk
-- "دھاڑی" (e.g. 5kg) rate. One mechanism covers both the packaged-goods
-- case (pack_qty counts pieces) and the loose-goods case (pack_qty
-- counts kg) — a pack is just "this many base units of this product,
-- sold together as one line at a fixed total price."
--
-- Cost basis deliberately reuses the product's own cost_price_pkr ×
-- pack_qty rather than a separate bulk-cost field (confirmed choice,
-- 2026-09-07) — no extra data entry, and accurate enough since the
-- shopkeeper is still free to price the pack below piece-price×qty to
-- reflect whatever bulk discount they actually got or want to offer.
create table if not exists shop_product_packs (
  id uuid primary key default gen_random_uuid(),
  shop_product_id uuid not null references shop_products(id) on delete cascade,
  label text not null,
  label_ur text,
  pack_qty decimal not null check (pack_qty > 0),
  pack_price_pkr decimal not null check (pack_price_pkr >= 0),
  is_active boolean not null default true,
  created_at timestamptz default now()
);
create index if not exists shop_product_packs_product_idx on shop_product_packs(shop_product_id);

alter table shop_product_packs enable row level security;

-- Same ownership shape as shop_products itself (391) — via the product's
-- own shop_id, since this table has no shop_id column of its own.
create policy "shop_product_packs_read" on shop_product_packs for select to authenticated
  using (
    current_admin_permission('manage_parties')
    or exists (select 1 from shop_products p join shops s on s.id = p.shop_id where p.id = shop_product_id and s.portal_user_id = current_portal_user_id())
  );
create policy "shop_product_packs_write" on shop_product_packs for insert to authenticated
  with check (
    current_admin_permission('manage_parties')
    or exists (select 1 from shop_products p join shops s on s.id = p.shop_id where p.id = shop_product_id and s.portal_user_id = current_portal_user_id())
  );
create policy "shop_product_packs_update" on shop_product_packs for update to authenticated
  using (true)
  with check (
    current_admin_permission('manage_parties')
    or exists (select 1 from shop_products p join shops s on s.id = p.shop_id where p.id = shop_product_id and s.portal_user_id = current_portal_user_id())
  );
create policy "shop_product_packs_delete" on shop_product_packs for delete to authenticated
  using (
    current_admin_permission('manage_parties')
    or exists (select 1 from shop_products p join shops s on s.id = p.shop_id where p.id = shop_product_id and s.portal_user_id = current_portal_user_id())
  );

-- shop_sale_items gets an optional record of which pack (if any) was
-- sold — same "snapshot" convention product_name_snapshot already uses,
-- so a pack sale still reads correctly in sales history even after the
-- pack itself is later edited or deleted.
alter table shop_sale_items add column if not exists pack_id uuid references shop_product_packs(id) on delete set null;
alter table shop_sale_items add column if not exists pack_label_snapshot text;

-- record_shop_sale, extended: each item in p_items may now include an
-- optional "pack_id". When present, quantity and line total are taken
-- from the pack row itself (server-resolved, never trusted from the
-- client) rather than the product's own unit_price_pkr — this is the
-- actual mechanism that makes a discounted bulk-pack sale bill correctly
-- instead of silently charging full per-piece price for every unit.
-- Signature is unchanged (still record_shop_sale(uuid, jsonb)), so every
-- existing caller passing plain {product_id, quantity} items keeps
-- working exactly as before.
CREATE OR REPLACE FUNCTION record_shop_sale(p_shop_id uuid, p_items jsonb) RETURNS uuid AS $$
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
