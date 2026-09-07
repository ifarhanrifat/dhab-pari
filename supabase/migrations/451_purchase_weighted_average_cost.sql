-- record_shop_purchase (434) rolled cost_price_pkr straight forward to
-- whatever was just paid, discarding the cost basis of any stock already
-- on hand — correct only when the shelf was empty before restocking.
-- Buying 3 more dozen bananas at a different price than the 2 dozen
-- already sitting there should blend into a weighted average, not
-- silently overwrite the old batch's cost — the standard, requested
-- (2026-09-07) fix: new_cost = (old_qty*old_cost + bought_qty*bought_cost)
-- / (old_qty + bought_qty). Same signature, same tables, same stock
-- increment — only the cost-price line changes.
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

    -- Weighted average, not a straight replace — see this migration's
    -- own header. GREATEST(...,0) guards a corrupted-negative
    -- quantity_on_hand from ever producing a nonsensical average; the
    -- ordinary case is old_qty >= 0, bought_qty > 0, so the denominator
    -- is always positive.
    v_new_avg_cost := (GREATEST(v_product.quantity_on_hand, 0) * v_product.cost_price_pkr + v_qty * v_unit_cost)
      / (GREATEST(v_product.quantity_on_hand, 0) + v_qty);
    UPDATE shop_products SET quantity_on_hand = quantity_on_hand + v_qty, cost_price_pkr = ROUND(v_new_avg_cost, 2) WHERE id = v_product.id;
  END LOOP;

  UPDATE shop_purchases SET total_cost_pkr = v_total WHERE id = v_purchase_id;
  RETURN v_purchase_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
