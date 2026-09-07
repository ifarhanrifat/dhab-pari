-- Customer credit ("khata") — a shopkeeper's own private ledger of who
-- owes them money, separate from the committee's own accounting exactly
-- like every other shop-portal table (391's own note). Scoped design,
-- confirmed 2026-09-07:
--   - A credit sale is the SAME counter-sale screen, just paying with a
--     registered customer's tab instead of cash — not a separate screen.
--   - Balance is a running tab, paid down whenever, not a fixed monthly
--     billing cycle — "monthly" was the shopkeeper's own example
--     cadence, not a hard requirement. A statement can still be pulled
--     for any date range, "this month" included.
--   - Partial payments are supported — a customer can pay any amount
--     against their balance at any time.

CREATE TABLE IF NOT EXISTS shop_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name text NOT NULL,
  name_ur text,
  phone text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_customers_shop_id_idx ON shop_customers(shop_id);

CREATE TABLE IF NOT EXISTS shop_customer_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES shop_customers(id) ON DELETE CASCADE,
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  note text,
  recorded_by_portal_user_id uuid REFERENCES portal_users(id),
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_customer_payments_customer_id_idx ON shop_customer_payments(customer_id);

ALTER TABLE shop_customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shop_customers_owner_read" ON shop_customers FOR SELECT TO authenticated
  USING (current_admin_permission('manage_parties') OR EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id()));
CREATE POLICY "shop_customers_owner_write" ON shop_customers FOR INSERT TO authenticated
  WITH CHECK (current_admin_permission('manage_parties') OR EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id()));
CREATE POLICY "shop_customers_owner_update" ON shop_customers FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (current_admin_permission('manage_parties') OR EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id()));

ALTER TABLE shop_customer_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shop_customer_payments_owner_read" ON shop_customer_payments FOR SELECT TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM shop_customers c JOIN shops s ON s.id = c.shop_id WHERE c.id = customer_id AND s.portal_user_id = current_portal_user_id())
  );
-- No direct INSERT policy on payments — writes only happen through
-- record_shop_credit_payment() below (SECURITY DEFINER), same pattern as
-- shop_sales/shop_sale_items already use for record_shop_sale.

-- shop_sales gets an optional customer_id + how it was paid. Cash sales
-- (the overwhelming majority, and every sale before this migration)
-- are completely unaffected — customer_id stays null, payment_method
-- defaults to 'cash'.
ALTER TABLE shop_sales ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES shop_customers(id);
ALTER TABLE shop_sales ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'credit'));
CREATE INDEX IF NOT EXISTS shop_sales_customer_id_idx ON shop_sales(customer_id) WHERE customer_id IS NOT NULL;

-- record_shop_sale, extended with an optional p_customer_id — same
-- signature otherwise, so every existing 2-argument call (every cash
-- sale, past and future) keeps working unchanged. Passing a customer_id
-- marks the sale as credit and attaches it to that customer's tab;
-- otherwise identical to before.
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
  IF NOT EXISTS (SELECT 1 FROM shops WHERE id = p_shop_id AND portal_user_id = v_portal_user_id) THEN
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

-- Records a payment against a customer's tab. SECURITY DEFINER + no
-- direct INSERT policy on shop_customer_payments (see above) — a
-- payment can only ever be created through here, same reasoning as
-- record_shop_sale for shop_sale_items.
CREATE OR REPLACE FUNCTION record_shop_credit_payment(p_customer_id uuid, p_amount_pkr decimal, p_note text DEFAULT NULL) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_payment_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required.';
  END IF;
  IF p_amount_pkr IS NULL OR p_amount_pkr <= 0 THEN
    RAISE EXCEPTION 'Enter a payment amount greater than zero.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM shop_customers c JOIN shops s ON s.id = c.shop_id
    WHERE c.id = p_customer_id AND s.portal_user_id = v_portal_user_id
  ) THEN
    RAISE EXCEPTION 'You do not manage this customer''s shop.';
  END IF;

  INSERT INTO shop_customer_payments (customer_id, amount_pkr, note, recorded_by_portal_user_id)
  VALUES (p_customer_id, p_amount_pkr, NULLIF(trim(COALESCE(p_note, '')), ''), v_portal_user_id)
  RETURNING id INTO v_payment_id;
  RETURN v_payment_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION record_shop_credit_payment(uuid, decimal, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_shop_credit_payment(uuid, decimal, text) TO authenticated;

-- Merged statement for one customer: every credit sale (a debit — it
-- adds to what they owe) and every payment (a credit — it reduces what
-- they owe), oldest first, with a running balance computed server-side
-- so the client never has to reconstruct that math itself. A positive
-- balance means the customer still owes the shop money.
CREATE OR REPLACE FUNCTION shop_customer_statement(p_customer_id uuid)
RETURNS TABLE (entry_id uuid, entry_type text, entry_at timestamptz, description text, debit decimal, credit decimal, running_balance decimal) AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM shop_customers c JOIN shops s ON s.id = c.shop_id
    WHERE c.id = p_customer_id AND (current_admin_permission('manage_parties') OR s.portal_user_id = current_portal_user_id())
  ) THEN
    RAISE EXCEPTION 'You do not manage this customer''s shop.';
  END IF;

  RETURN QUERY
  WITH entries AS (
    SELECT sa.id AS entry_id, 'sale'::text AS entry_type, sa.created_at AS entry_at,
      'Sale #' || substr(sa.id::text, 1, 8) AS description, sa.total_amount_pkr AS debit, 0::decimal AS credit
    FROM shop_sales sa WHERE sa.customer_id = p_customer_id
    UNION ALL
    SELECT pmt.id, 'payment', pmt.created_at, COALESCE(pmt.note, 'Payment received'), 0::decimal, pmt.amount_pkr
    FROM shop_customer_payments pmt WHERE pmt.customer_id = p_customer_id
  )
  SELECT entry_id, entry_type, entry_at, description, debit, credit,
    SUM(debit - credit) OVER (ORDER BY entry_at, entry_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance
  FROM entries
  ORDER BY entry_at DESC, entry_id DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION shop_customer_statement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION shop_customer_statement(uuid) TO authenticated;
