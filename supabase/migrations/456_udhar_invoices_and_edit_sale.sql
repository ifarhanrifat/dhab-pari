-- Real "how udhar actually works in Pakistan" gaps, all from one detailed
-- report (2026-09-08): a credit sale had no itemization visible anywhere,
-- no way to correct a mistaken entry, and no way to bundle a customer's
-- unbilled sales into one formal invoice to send them (with a WhatsApp
-- message listing every item, matching how a real khata bill reads).
--
-- shop_sale_items (391) already stores the real line items for every
-- sale, cash or credit — record_shop_sale already supports multiple
-- items per sale — so "no product name" and "no multi-item bill" were
-- both a display gap on the statement, not a missing capability. Fixed
-- by extending shop_customer_statement below to expose each sale's own
-- items, and by adding the two genuinely new pieces: invoices (grouping
-- a customer's already-recorded sales into a formal, numbered bill) and
-- the ability to correct a sale that was entered wrong.

-- One invoice = a snapshot bundling every not-yet-invoiced credit sale
-- for a customer at the moment it's generated. Deliberately references
-- the underlying shop_sales rather than duplicating their line items —
-- the sales themselves stay the one source of truth for what was sold;
-- an invoice is just a formal "these N sales, billed together, as of
-- this date" marker a shopkeeper can hand a customer and re-print later.
CREATE TABLE IF NOT EXISTS shop_customer_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES shop_customers(id) ON DELETE CASCADE,
  invoice_number int NOT NULL,
  period_start timestamptz,
  period_end timestamptz NOT NULL DEFAULT now(),
  total_amount_pkr decimal NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_customer_invoices_customer_id_idx ON shop_customer_invoices(customer_id);

CREATE TABLE IF NOT EXISTS shop_customer_invoice_sales (
  invoice_id uuid NOT NULL REFERENCES shop_customer_invoices(id) ON DELETE CASCADE,
  sale_id uuid NOT NULL REFERENCES shop_sales(id) ON DELETE CASCADE,
  PRIMARY KEY (invoice_id, sale_id)
);
CREATE INDEX IF NOT EXISTS shop_customer_invoice_sales_sale_id_idx ON shop_customer_invoice_sales(sale_id);

ALTER TABLE shop_customer_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shop_customer_invoices_owner_read" ON shop_customer_invoices FOR SELECT TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM shop_customers c JOIN shops s ON s.id = c.shop_id WHERE c.id = customer_id AND s.portal_user_id = current_portal_user_id())
  );
-- No direct INSERT policy — only generate_shop_customer_invoice() below
-- (SECURITY DEFINER) can create one, so an invoice's total always
-- matches the sales actually linked to it.

ALTER TABLE shop_customer_invoice_sales ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shop_customer_invoice_sales_owner_read" ON shop_customer_invoice_sales FOR SELECT TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR EXISTS (
      SELECT 1 FROM shop_customer_invoices inv JOIN shop_customers c ON c.id = inv.customer_id JOIN shops s ON s.id = c.shop_id
      WHERE inv.id = invoice_id AND s.portal_user_id = current_portal_user_id()
    )
  );

-- Bundles every credit sale for this customer that isn't already on some
-- earlier invoice. Raises if there's nothing new to bill — a shopkeeper
-- tapping "Generate Bill" twice in a row on an unchanged account should
-- get a clear "nothing to bill" instead of a Rs 0 invoice cluttering
-- the statement.
CREATE OR REPLACE FUNCTION generate_shop_customer_invoice(p_customer_id uuid) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_invoice_id uuid;
  v_number int;
  v_total decimal;
  v_period_start timestamptz;
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM shop_customers c JOIN shops s ON s.id = c.shop_id
    WHERE c.id = p_customer_id AND s.portal_user_id = v_portal_user_id
  ) THEN
    RAISE EXCEPTION 'You do not manage this customer''s shop.';
  END IF;

  SELECT COALESCE(SUM(sa.total_amount_pkr), 0), MIN(sa.created_at)
    INTO v_total, v_period_start
    FROM shop_sales sa
    WHERE sa.customer_id = p_customer_id
      AND NOT EXISTS (SELECT 1 FROM shop_customer_invoice_sales cis WHERE cis.sale_id = sa.id);

  IF v_period_start IS NULL THEN
    RAISE EXCEPTION 'Nothing to bill — every sale for this customer is already on an earlier invoice.';
  END IF;

  SELECT COUNT(*) + 1 INTO v_number FROM shop_customer_invoices WHERE customer_id = p_customer_id;

  INSERT INTO shop_customer_invoices (customer_id, invoice_number, period_start, total_amount_pkr)
  VALUES (p_customer_id, v_number, v_period_start, v_total)
  RETURNING id INTO v_invoice_id;

  INSERT INTO shop_customer_invoice_sales (invoice_id, sale_id)
  SELECT v_invoice_id, sa.id FROM shop_sales sa
    WHERE sa.customer_id = p_customer_id
      AND NOT EXISTS (SELECT 1 FROM shop_customer_invoice_sales cis WHERE cis.sale_id = sa.id);

  RETURN v_invoice_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION generate_shop_customer_invoice(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION generate_shop_customer_invoice(uuid) TO authenticated;

-- Corrects a sale that was entered wrong — a real, specific complaint
-- ("no way to edit or correct this amount"). Reverses the OLD items'
-- stock impact, replaces them with the new item list, exactly like
-- record_shop_sale's own item loop (pack-aware, same validation), then
-- updates the sale's total. Works for cash or credit sales alike; the
-- shop portal only ever exposes it from the credit statement for now
-- since that's where a wrong entry actually gets disputed and caught.
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
  IF NOT EXISTS (SELECT 1 FROM shops WHERE id = v_sale.shop_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this shop.';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'A bill needs at least one item.';
  END IF;

  -- Give every old line's stock back before touching anything else, so
  -- the new item loop below checks availability against the corrected
  -- baseline rather than double-counting stock the old (wrong) items
  -- had already taken.
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

REVOKE ALL ON FUNCTION edit_shop_sale(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION edit_shop_sale(uuid, jsonb) TO authenticated;

-- shop_customer_statement, extended with a third leg: invoices show up
-- in the timeline as a zero-debit/credit marker ("Invoice #3 generated")
-- so a shopkeeper can see what's already been formally billed without
-- it double-counting the balance the underlying sales already added.
-- Every column renamed/aliased distinctly from the RETURNS TABLE names
-- again (455's own header explains why: a bare column matching an OUT
-- parameter name is ambiguous everywhere in the function body, not just
-- in the final SELECT).
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
