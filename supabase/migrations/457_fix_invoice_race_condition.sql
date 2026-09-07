-- Caught on re-review before this ever ran live, not from a bug report:
-- the original version queried "which sales are still unbilled" TWICE —
-- once to total them, once to link them to the new invoice. A sale
-- recorded for the same customer in between those two queries (a
-- concurrent counter-sale, in theory, however narrow the window) would
-- get linked to the invoice without its amount ever being added to
-- v_total — the invoice's own total_amount_pkr would then understate
-- what it actually covers. Captures the unbilled sale ids into an array
-- ONCE and reuses that same snapshot for both the total and the links,
-- so there's nothing left for a concurrent write to slip between.
CREATE OR REPLACE FUNCTION generate_shop_customer_invoice(p_customer_id uuid) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_invoice_id uuid;
  v_number int;
  v_total decimal;
  v_period_start timestamptz;
  v_sale_ids uuid[];
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

  SELECT array_agg(sa.id), COALESCE(SUM(sa.total_amount_pkr), 0), MIN(sa.created_at)
    INTO v_sale_ids, v_total, v_period_start
    FROM shop_sales sa
    WHERE sa.customer_id = p_customer_id
      AND NOT EXISTS (SELECT 1 FROM shop_customer_invoice_sales cis WHERE cis.sale_id = sa.id);

  IF v_sale_ids IS NULL THEN
    RAISE EXCEPTION 'Nothing to bill — every sale for this customer is already on an earlier invoice.';
  END IF;

  SELECT COUNT(*) + 1 INTO v_number FROM shop_customer_invoices WHERE customer_id = p_customer_id;

  INSERT INTO shop_customer_invoices (customer_id, invoice_number, period_start, total_amount_pkr)
  VALUES (p_customer_id, v_number, v_period_start, v_total)
  RETURNING id INTO v_invoice_id;

  INSERT INTO shop_customer_invoice_sales (invoice_id, sale_id)
  SELECT v_invoice_id, sale_id FROM unnest(v_sale_ids) AS sale_id;

  RETURN v_invoice_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
