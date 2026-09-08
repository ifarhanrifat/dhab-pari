-- Links a shop_customers (udhar) record to the actual villager's own
-- portal account, so they can see their own statement/bills, without
-- disturbing the existing flow for customers who have no portal account
-- at all (name/phone only — stays the default, linking is opt-in).
--
-- Confirmed design (2026-09-08): linking happens via a one-time code the
-- shopkeeper generates and hands to the customer (WhatsApp or in person),
-- which the customer then redeems from their own portal login — not an
-- automatic match on phone number. A shop_customers.phone field is just
-- text a shopkeeper typed in; trusting it to auto-link would let whoever
-- currently holds that SIM see someone else's balance.

ALTER TABLE shop_customers ADD COLUMN IF NOT EXISTS linked_portal_user_id uuid REFERENCES portal_users(id) ON DELETE SET NULL;

-- One portal account can only be linked to one customer record per shop
-- (linking the same person to two "customers" at the same shop would
-- just be a data-entry duplicate, and would make "which one is really
-- them" ambiguous for the balance view below).
CREATE UNIQUE INDEX IF NOT EXISTS shop_customers_linked_user_per_shop_uniq
  ON shop_customers (shop_id, linked_portal_user_id) WHERE linked_portal_user_id IS NOT NULL;

-- Short-lived one-time codes. RLS is enabled with NO policies at all —
-- on purpose, same reasoning as shop_ai_settings' internal tables: every
-- access to this table goes through the SECURITY DEFINER functions below,
-- never a direct select/insert from the client, so there's nothing for a
-- row policy to usefully allow.
CREATE TABLE IF NOT EXISTS shop_customer_link_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES shop_customers(id) ON DELETE CASCADE,
  code text NOT NULL,
  created_by uuid NOT NULL REFERENCES portal_users(id),
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by uuid REFERENCES portal_users(id)
);
CREATE INDEX IF NOT EXISTS shop_customer_link_codes_customer_id_idx ON shop_customer_link_codes(customer_id);
-- Only one *live* code per customer, so an old unexpired code a
-- shopkeeper already sent can't quietly linger valid alongside a new one.
CREATE UNIQUE INDEX IF NOT EXISTS shop_customer_link_codes_customer_live_uniq
  ON shop_customer_link_codes(customer_id) WHERE used_at IS NULL;

ALTER TABLE shop_customer_link_codes ENABLE ROW LEVEL SECURITY;

-- Shopkeeper side: generate a fresh code for a customer, invalidating any
-- earlier unused one for the same customer (the unique index above would
-- reject a second live row anyway — this just makes "generate again"
-- behave as "replace" instead of erroring).
CREATE OR REPLACE FUNCTION generate_customer_link_code(p_customer_id uuid) RETURNS text AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_shop_id uuid;
  v_already_linked uuid;
  v_code text;
  v_tries int := 0;
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required.';
  END IF;
  SELECT shop_id, linked_portal_user_id INTO v_shop_id, v_already_linked
    FROM shop_customers WHERE id = p_customer_id;
  IF v_shop_id IS NULL OR NOT (current_admin_permission('manage_parties') OR user_manages_shop(v_shop_id)) THEN
    RAISE EXCEPTION 'You do not manage this customer''s shop.';
  END IF;
  IF v_already_linked IS NOT NULL THEN
    RAISE EXCEPTION 'This customer is already linked to a portal account.';
  END IF;

  DELETE FROM shop_customer_link_codes WHERE customer_id = p_customer_id AND used_at IS NULL;

  LOOP
    v_code := lpad(floor(random() * 1000000)::int::text, 6, '0');
    BEGIN
      INSERT INTO shop_customer_link_codes (customer_id, code, created_by, expires_at)
      VALUES (p_customer_id, v_code, v_portal_user_id, now() + interval '30 minutes');
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_tries := v_tries + 1;
      IF v_tries > 5 THEN RAISE EXCEPTION 'Could not generate a code, please try again.'; END IF;
    END;
  END LOOP;

  RETURN v_code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION generate_customer_link_code(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION generate_customer_link_code(uuid) TO authenticated;

-- Customer side: redeem the code they were given, from their OWN portal
-- login — this is the step that actually proves it's them, not just
-- someone who happens to know the phone number on file.
CREATE OR REPLACE FUNCTION redeem_customer_link_code(p_code text) RETURNS TABLE (customer_id uuid, shop_id uuid, shop_name text, shop_name_ur text) AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_row shop_customer_link_codes%ROWTYPE;
  v_shop_id uuid;
  v_already_linked uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required.';
  END IF;

  SELECT * INTO v_row FROM shop_customer_link_codes
    WHERE code = trim(p_code) AND used_at IS NULL AND expires_at > now()
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This code is invalid or has expired — ask the shopkeeper for a new one.';
  END IF;

  SELECT c.shop_id, c.linked_portal_user_id INTO v_shop_id, v_already_linked
    FROM shop_customers c WHERE c.id = v_row.customer_id FOR UPDATE;
  IF v_already_linked IS NOT NULL THEN
    RAISE EXCEPTION 'This account is already linked to a portal account.';
  END IF;
  IF EXISTS (SELECT 1 FROM shop_customers WHERE shop_id = v_shop_id AND linked_portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You are already linked to an account at this shop.';
  END IF;

  UPDATE shop_customers SET linked_portal_user_id = v_portal_user_id WHERE id = v_row.customer_id;
  UPDATE shop_customer_link_codes SET used_at = now(), used_by = v_portal_user_id WHERE id = v_row.id;

  RETURN QUERY SELECT c.id, c.shop_id, s.name, s.name_ur FROM shop_customers c JOIN shops s ON s.id = c.shop_id WHERE c.id = v_row.customer_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION redeem_customer_link_code(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION redeem_customer_link_code(text) TO authenticated;

-- Undo — either side can walk it back (a wrong code shared with the
-- wrong person, or a customer who no longer wants their portal account
-- tied to a shop). Existing name/phone credit record is untouched, it
-- just stops being viewable from that portal account.
CREATE OR REPLACE FUNCTION unlink_customer_portal(p_customer_id uuid) RETURNS void AS $$
DECLARE
  v_shop_id uuid;
  v_linked uuid;
BEGIN
  SELECT shop_id, linked_portal_user_id INTO v_shop_id, v_linked FROM shop_customers WHERE id = p_customer_id;
  IF v_shop_id IS NULL THEN
    RAISE EXCEPTION 'Customer not found.';
  END IF;
  IF NOT (current_admin_permission('manage_parties') OR user_manages_shop(v_shop_id) OR v_linked = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You cannot unlink this account.';
  END IF;
  UPDATE shop_customers SET linked_portal_user_id = NULL WHERE id = p_customer_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION unlink_customer_portal(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION unlink_customer_portal(uuid) TO authenticated;

-- Buyer's own list of shops they have a linked udhar account at — the
-- entry point for /portal/my-credit. Explicit function rather than
-- relying purely on the RLS opened up below, so the list screen doesn't
-- also depend on shops' own read policy shape.
CREATE OR REPLACE FUNCTION my_credit_accounts() RETURNS TABLE (customer_id uuid, shop_id uuid, shop_name text, shop_name_ur text, balance decimal) AS $$
  SELECT c.id, s.id, s.name, s.name_ur,
    COALESCE((SELECT SUM(sa.total_amount_pkr) FROM shop_sales sa WHERE sa.customer_id = c.id), 0)
    - COALESCE((SELECT SUM(pmt.amount_pkr) FROM shop_customer_payments pmt WHERE pmt.customer_id = c.id), 0) AS balance
  FROM shop_customers c JOIN shops s ON s.id = c.shop_id
  WHERE c.linked_portal_user_id = current_portal_user_id()
  ORDER BY s.name;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_credit_accounts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_credit_accounts() TO authenticated;

-- shop_customers_with_balance (453/454) — shopkeeper's customer list —
-- now also surfaces whether each customer is linked, and to whom, so the
-- "Link to Portal" button can show a name instead of a bare yes/no.
-- Return shape changed (two new columns), so the old function must be
-- dropped first — CREATE OR REPLACE cannot change a RETURNS TABLE list.
DROP FUNCTION IF EXISTS shop_customers_with_balance(uuid);
CREATE OR REPLACE FUNCTION shop_customers_with_balance(p_shop_id uuid)
RETURNS TABLE (id uuid, name text, name_ur text, phone text, is_active boolean, balance decimal, linked_portal_user_id uuid, linked_full_name text) AS $$
BEGIN
  IF NOT (current_admin_permission('manage_parties') OR user_manages_shop(p_shop_id)) THEN
    RAISE EXCEPTION 'You do not manage this shop.';
  END IF;

  RETURN QUERY
  SELECT c.id, c.name, c.name_ur, c.phone, c.is_active,
    COALESCE((SELECT SUM(sa.total_amount_pkr) FROM shop_sales sa WHERE sa.customer_id = c.id), 0)
    - COALESCE((SELECT SUM(pmt.amount_pkr) FROM shop_customer_payments pmt WHERE pmt.customer_id = c.id), 0) AS balance,
    c.linked_portal_user_id, pu.full_name::text
  FROM shop_customers c
  LEFT JOIN portal_users pu ON pu.id = c.linked_portal_user_id
  WHERE c.shop_id = p_shop_id
  ORDER BY c.name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION shop_customers_with_balance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION shop_customers_with_balance(uuid) TO authenticated;

-- shop_customer_statement (455/456) — same statement RPC used by the
-- shopkeeper, now also usable by the linked customer viewing their own
-- account. Body is unchanged from 456 apart from the guard's extra OR.
CREATE OR REPLACE FUNCTION shop_customer_statement(p_customer_id uuid)
RETURNS TABLE (entry_id uuid, entry_type text, entry_at timestamptz, description text, debit decimal, credit decimal, running_balance decimal) AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM shop_customers c
    WHERE c.id = p_customer_id AND (
      current_admin_permission('manage_parties') OR user_manages_shop(c.shop_id) OR c.linked_portal_user_id = current_portal_user_id()
    )
  ) THEN
    RAISE EXCEPTION 'You cannot view this customer''s statement.';
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

-- ═══ RLS: open the same read policies to a linked customer, in addition
-- to whoever already manages the shop — direct-select paths the buyer
-- screen reuses (sale line items, invoice + its line items, payments).
DROP POLICY IF EXISTS "shop_customers_owner_read" ON shop_customers;
CREATE POLICY "shop_customers_owner_read" ON shop_customers FOR SELECT TO authenticated
  USING (current_admin_permission('manage_parties') OR user_manages_shop(shop_id) OR linked_portal_user_id = current_portal_user_id());

DROP POLICY IF EXISTS "shop_customer_payments_owner_read" ON shop_customer_payments;
CREATE POLICY "shop_customer_payments_owner_read" ON shop_customer_payments FOR SELECT TO authenticated
  USING (current_admin_permission('manage_parties') OR EXISTS (
    SELECT 1 FROM shop_customers c WHERE c.id = customer_id AND (user_manages_shop(c.shop_id) OR c.linked_portal_user_id = current_portal_user_id())
  ));

DROP POLICY IF EXISTS "shop_customer_invoices_owner_read" ON shop_customer_invoices;
CREATE POLICY "shop_customer_invoices_owner_read" ON shop_customer_invoices FOR SELECT TO authenticated
  USING (current_admin_permission('manage_parties') OR EXISTS (
    SELECT 1 FROM shop_customers c WHERE c.id = customer_id AND (user_manages_shop(c.shop_id) OR c.linked_portal_user_id = current_portal_user_id())
  ));

DROP POLICY IF EXISTS "shop_customer_invoice_sales_owner_read" ON shop_customer_invoice_sales;
CREATE POLICY "shop_customer_invoice_sales_owner_read" ON shop_customer_invoice_sales FOR SELECT TO authenticated
  USING (current_admin_permission('manage_parties') OR EXISTS (
    SELECT 1 FROM shop_customer_invoices inv JOIN shop_customers c ON c.id = inv.customer_id
    WHERE inv.id = invoice_id AND (user_manages_shop(c.shop_id) OR c.linked_portal_user_id = current_portal_user_id())
  ));

DROP POLICY IF EXISTS "shop_sales_owner_read" ON shop_sales;
CREATE POLICY "shop_sales_owner_read" ON shop_sales FOR SELECT TO authenticated
  USING (current_admin_permission('manage_parties') OR user_manages_shop(shop_id) OR EXISTS (
    SELECT 1 FROM shop_customers c WHERE c.id = shop_sales.customer_id AND c.linked_portal_user_id = current_portal_user_id()
  ));

DROP POLICY IF EXISTS "shop_sale_items_owner_read" ON shop_sale_items;
CREATE POLICY "shop_sale_items_owner_read" ON shop_sale_items FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM shop_sales sa WHERE sa.id = sale_id AND (
      current_admin_permission('manage_parties') OR user_manages_shop(sa.shop_id) OR EXISTS (
        SELECT 1 FROM shop_customers c WHERE c.id = sa.customer_id AND c.linked_portal_user_id = current_portal_user_id()
      )
    )
  ));
