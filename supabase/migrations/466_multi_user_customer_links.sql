-- Multiple household members sharing one udhar account (2026-09-08 request:
-- husband/wife/aunt all buying against the same "Rizwan Iqbal" account) —
-- generalizes 463's one-portal-user-per-customer link into a proper list,
-- via the exact same one-time-code process, repeated per person.
--
-- The real, explicit requirement driving the shape of this: the shopkeeper
-- must NEVER see which real person is behind a link — only that N portal
-- users are linked, shown as anonymous "User 1"/"User 2"/etc. The account's
-- own name ("Rizwan Iqbal") is unaffected — that was always just text a
-- shopkeeper typed in, not tied to any one portal identity.

CREATE TABLE IF NOT EXISTS shop_customer_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES shop_customers(id) ON DELETE CASCADE,
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  -- Assigned sequentially at redeem time ('User 1', 'User 2', ...) — the
  -- ONLY thing about a link the shopkeeper's own screens ever surface.
  label text NOT NULL,
  linked_at timestamptz DEFAULT now(),
  UNIQUE (customer_id, portal_user_id)
);
CREATE INDEX IF NOT EXISTS shop_customer_links_customer_id_idx ON shop_customer_links(customer_id);
CREATE INDEX IF NOT EXISTS shop_customer_links_portal_user_id_idx ON shop_customer_links(portal_user_id);

-- Carry forward whoever was already linked under 463's single-column
-- design as that account's "User 1" — nobody loses access over this
-- migration.
INSERT INTO shop_customer_links (customer_id, portal_user_id, label, linked_at)
SELECT id, linked_portal_user_id, 'User 1', now() FROM shop_customers WHERE linked_portal_user_id IS NOT NULL
ON CONFLICT (customer_id, portal_user_id) DO NOTHING;

-- The column itself is dropped at the very end of this migration, after
-- every policy that still references it (shop_customers_owner_read etc.,
-- from 463) has been replaced — Postgres refuses to drop a column a live
-- policy expression still reads.
DROP INDEX IF EXISTS shop_customers_linked_user_per_shop_uniq;

-- RLS: a linked portal user can read their OWN link row (needed for the
-- EXISTS checks embedded in shop_customers/shop_sales/etc.'s own policies
-- below — those run as the querying role, not as this function, so the
-- row has to be genuinely visible under normal RLS, not just reachable
-- through a SECURITY DEFINER function); the managing shop can read every
-- link row for its own customers (label + id only ever reach the client
-- through list_customer_links() below, but the raw row itself carries no
-- name — portal_user_id alone is not resolvable to an identity from the
-- client, portal_users' own RLS only ever lets someone read their own row).
-- No write policies anywhere — every insert/delete goes through the
-- SECURITY DEFINER functions below.
ALTER TABLE shop_customer_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shop_customer_links_read" ON shop_customer_links FOR SELECT TO authenticated
  USING (
    portal_user_id = current_portal_user_id()
    OR current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM shop_customers c WHERE c.id = customer_id AND user_manages_shop(c.shop_id))
  );

-- A hard ceiling so this can never grow unbounded by mistake (a shopkeeper
-- repeatedly tapping "Link to Portal") — six comfortably covers any real
-- household.
CREATE OR REPLACE FUNCTION generate_customer_link_code(p_customer_id uuid) RETURNS text AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_shop_id uuid;
  v_linked_count int;
  v_code text;
  v_tries int := 0;
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required.';
  END IF;
  SELECT shop_id INTO v_shop_id FROM shop_customers WHERE id = p_customer_id;
  IF v_shop_id IS NULL OR NOT (current_admin_permission('manage_parties') OR user_manages_shop(v_shop_id)) THEN
    RAISE EXCEPTION 'You do not manage this customer''s shop.';
  END IF;

  SELECT COUNT(*) INTO v_linked_count FROM shop_customer_links WHERE customer_id = p_customer_id;
  IF v_linked_count >= 6 THEN
    RAISE EXCEPTION 'This account already has the maximum of 6 linked portal users.';
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

-- Redeem now ADDS a link rather than replacing a single slot — the one
-- real behavior change from 463/465. Still refuses a second link for the
-- same shop to the same portal user (one real person, one identity per
-- shop, even across different customer accounts) and still refuses
-- redeeming a code you're already linked by (the unique constraint would
-- catch it too, but this gives a clearer message).
CREATE OR REPLACE FUNCTION redeem_customer_link_code(p_code text) RETURNS TABLE (customer_id uuid, shop_id uuid, shop_name text, shop_name_ur text) AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_row shop_customer_link_codes%ROWTYPE;
  v_shop_id uuid;
  v_next_n int;
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

  SELECT c.shop_id INTO v_shop_id FROM shop_customers c WHERE c.id = v_row.customer_id FOR UPDATE;

  -- Every reference below is qualified with an alias, not just the one
  -- that failed under live testing: RETURNS TABLE's own `customer_id`
  -- OUT parameter is a PL/pgSQL variable for the whole function body
  -- (same class of bug as migrations 454/455/464), so a bare
  -- `customer_id` anywhere in here — not only the final SELECT — is
  -- ambiguous against it.
  IF EXISTS (SELECT 1 FROM shop_customer_links sc WHERE sc.customer_id = v_row.customer_id AND sc.portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You are already linked to this account.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM shop_customer_links l JOIN shop_customers c ON c.id = l.customer_id
    WHERE c.shop_id = v_shop_id AND l.portal_user_id = v_portal_user_id
  ) THEN
    RAISE EXCEPTION 'You are already linked to a different account at this shop.';
  END IF;

  SELECT COUNT(*) + 1 INTO v_next_n FROM shop_customer_links sc WHERE sc.customer_id = v_row.customer_id;

  INSERT INTO shop_customer_links (customer_id, portal_user_id, label)
  VALUES (v_row.customer_id, v_portal_user_id, 'User ' || v_next_n);

  UPDATE shop_customer_link_codes SET used_at = now(), used_by = v_portal_user_id WHERE id = v_row.id;

  RETURN QUERY SELECT c.id, c.shop_id, s.name::text, s.name_ur::text FROM shop_customers c JOIN shops s ON s.id = c.shop_id WHERE c.id = v_row.customer_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Self-service unlink — a linked person removing their OWN access.
-- Signature unchanged from 463 (still just p_customer_id), now removes
-- the caller's own row from the list instead of clearing a single column.
CREATE OR REPLACE FUNCTION unlink_customer_portal(p_customer_id uuid) RETURNS void AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required.';
  END IF;
  DELETE FROM shop_customer_links WHERE customer_id = p_customer_id AND portal_user_id = v_portal_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'You are not linked to this account.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Shopkeeper-side removal, keyed on the link's own id — never the portal
-- user's id or name, so a shopkeeper can revoke "User 2" without ever
-- learning who User 2 actually is.
CREATE OR REPLACE FUNCTION shop_remove_customer_link(p_link_id uuid) RETURNS void AS $$
DECLARE
  v_shop_id uuid;
BEGIN
  SELECT c.shop_id INTO v_shop_id FROM shop_customer_links l JOIN shop_customers c ON c.id = l.customer_id WHERE l.id = p_link_id;
  IF v_shop_id IS NULL OR NOT (current_admin_permission('manage_parties') OR user_manages_shop(v_shop_id)) THEN
    RAISE EXCEPTION 'You do not manage this account.';
  END IF;
  DELETE FROM shop_customer_links WHERE id = p_link_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION shop_remove_customer_link(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION shop_remove_customer_link(uuid) TO authenticated;

-- The shopkeeper's own view of who's linked — label + id + when, nothing
-- else. This is the only shape the client ever fetches for the shop side;
-- it never selects shop_customer_links directly.
CREATE OR REPLACE FUNCTION list_customer_links(p_customer_id uuid) RETURNS TABLE (link_id uuid, label text, linked_at timestamptz) AS $$
DECLARE
  v_shop_id uuid;
BEGIN
  SELECT shop_id INTO v_shop_id FROM shop_customers WHERE id = p_customer_id;
  IF v_shop_id IS NULL OR NOT (current_admin_permission('manage_parties') OR user_manages_shop(v_shop_id)) THEN
    RAISE EXCEPTION 'You do not manage this customer''s shop.';
  END IF;
  RETURN QUERY SELECT l.id, l.label, l.linked_at FROM shop_customer_links l WHERE l.customer_id = p_customer_id ORDER BY l.label;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION list_customer_links(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION list_customer_links(uuid) TO authenticated;

-- my_credit_accounts — one row per shared account (not per link), keyed
-- off membership in shop_customer_links instead of the old single column.
-- linked_count lets the buyer-side page say "shared with N others" for
-- basic transparency to the OTHER household members, without naming them
-- either.
DROP FUNCTION IF EXISTS my_credit_accounts();
CREATE OR REPLACE FUNCTION my_credit_accounts() RETURNS TABLE (customer_id uuid, shop_id uuid, shop_name text, shop_name_ur text, balance decimal, linked_count int) AS $$
  -- No DISTINCT needed: (customer_id, portal_user_id) is unique on
  -- shop_customer_links, so joining on a fixed portal_user_id can never
  -- produce more than one row per customer. (DISTINCT + ORDER BY s.name
  -- against a select list that casts s.name::text also isn't legal SQL —
  -- ORDER BY has to match a select-list expression exactly under DISTINCT.)
  SELECT c.id, s.id, s.name::text, s.name_ur::text,
    COALESCE((SELECT SUM(sa.total_amount_pkr) FROM shop_sales sa WHERE sa.customer_id = c.id), 0)
    - COALESCE((SELECT SUM(pmt.amount_pkr) FROM shop_customer_payments pmt WHERE pmt.customer_id = c.id), 0) AS balance,
    (SELECT COUNT(*)::int FROM shop_customer_links l2 WHERE l2.customer_id = c.id) AS linked_count
  FROM shop_customers c JOIN shops s ON s.id = c.shop_id
  JOIN shop_customer_links l ON l.customer_id = c.id
  WHERE l.portal_user_id = current_portal_user_id()
  ORDER BY s.name;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- shop_customers_with_balance — the shopkeeper's customer list. Replaces
-- linked_portal_user_id/linked_full_name (a real name, migration 463's
-- own mistake given today's ask) with a bare count. Return shape changed,
-- so the old function must be dropped first.
DROP FUNCTION IF EXISTS shop_customers_with_balance(uuid);
CREATE OR REPLACE FUNCTION shop_customers_with_balance(p_shop_id uuid)
RETURNS TABLE (id uuid, name text, name_ur text, phone text, is_active boolean, balance decimal, linked_count int) AS $$
BEGIN
  IF NOT (current_admin_permission('manage_parties') OR user_manages_shop(p_shop_id)) THEN
    RAISE EXCEPTION 'You do not manage this shop.';
  END IF;

  RETURN QUERY
  SELECT c.id, c.name, c.name_ur, c.phone, c.is_active,
    COALESCE((SELECT SUM(sa.total_amount_pkr) FROM shop_sales sa WHERE sa.customer_id = c.id), 0)
    - COALESCE((SELECT SUM(pmt.amount_pkr) FROM shop_customer_payments pmt WHERE pmt.customer_id = c.id), 0) AS balance,
    (SELECT COUNT(*)::int FROM shop_customer_links l WHERE l.customer_id = c.id) AS linked_count
  FROM shop_customers c
  WHERE c.shop_id = p_shop_id
  ORDER BY c.name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION shop_customers_with_balance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION shop_customers_with_balance(uuid) TO authenticated;

-- shop_customer_statement — guard swapped from the old single column to
-- membership in shop_customer_links; body otherwise identical to 456.
CREATE OR REPLACE FUNCTION shop_customer_statement(p_customer_id uuid)
RETURNS TABLE (entry_id uuid, entry_type text, entry_at timestamptz, description text, debit decimal, credit decimal, running_balance decimal) AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM shop_customers c
    WHERE c.id = p_customer_id AND (
      current_admin_permission('manage_parties') OR user_manages_shop(c.shop_id)
      OR EXISTS (SELECT 1 FROM shop_customer_links l WHERE l.customer_id = c.id AND l.portal_user_id = current_portal_user_id())
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

-- ═══ RLS: the same OR clause across the credit tables, now checking
-- shop_customer_links membership instead of the dropped column.
DROP POLICY IF EXISTS "shop_customers_owner_read" ON shop_customers;
CREATE POLICY "shop_customers_owner_read" ON shop_customers FOR SELECT TO authenticated
  USING (
    current_admin_permission('manage_parties') OR user_manages_shop(shop_id)
    OR EXISTS (SELECT 1 FROM shop_customer_links l WHERE l.customer_id = id AND l.portal_user_id = current_portal_user_id())
  );

DROP POLICY IF EXISTS "shop_customer_payments_owner_read" ON shop_customer_payments;
CREATE POLICY "shop_customer_payments_owner_read" ON shop_customer_payments FOR SELECT TO authenticated
  USING (current_admin_permission('manage_parties') OR EXISTS (
    SELECT 1 FROM shop_customers c WHERE c.id = customer_id AND (
      user_manages_shop(c.shop_id) OR EXISTS (SELECT 1 FROM shop_customer_links l WHERE l.customer_id = c.id AND l.portal_user_id = current_portal_user_id())
    )
  ));

DROP POLICY IF EXISTS "shop_customer_invoices_owner_read" ON shop_customer_invoices;
CREATE POLICY "shop_customer_invoices_owner_read" ON shop_customer_invoices FOR SELECT TO authenticated
  USING (current_admin_permission('manage_parties') OR EXISTS (
    SELECT 1 FROM shop_customers c WHERE c.id = customer_id AND (
      user_manages_shop(c.shop_id) OR EXISTS (SELECT 1 FROM shop_customer_links l WHERE l.customer_id = c.id AND l.portal_user_id = current_portal_user_id())
    )
  ));

DROP POLICY IF EXISTS "shop_customer_invoice_sales_owner_read" ON shop_customer_invoice_sales;
CREATE POLICY "shop_customer_invoice_sales_owner_read" ON shop_customer_invoice_sales FOR SELECT TO authenticated
  USING (current_admin_permission('manage_parties') OR EXISTS (
    SELECT 1 FROM shop_customer_invoices inv JOIN shop_customers c ON c.id = inv.customer_id
    WHERE inv.id = invoice_id AND (
      user_manages_shop(c.shop_id) OR EXISTS (SELECT 1 FROM shop_customer_links l WHERE l.customer_id = c.id AND l.portal_user_id = current_portal_user_id())
    )
  ));

DROP POLICY IF EXISTS "shop_sales_owner_read" ON shop_sales;
CREATE POLICY "shop_sales_owner_read" ON shop_sales FOR SELECT TO authenticated
  USING (current_admin_permission('manage_parties') OR user_manages_shop(shop_id) OR EXISTS (
    SELECT 1 FROM shop_customer_links l WHERE l.customer_id = shop_sales.customer_id AND l.portal_user_id = current_portal_user_id()
  ));

DROP POLICY IF EXISTS "shop_sale_items_owner_read" ON shop_sale_items;
CREATE POLICY "shop_sale_items_owner_read" ON shop_sale_items FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM shop_sales sa WHERE sa.id = sale_id AND (
      current_admin_permission('manage_parties') OR user_manages_shop(sa.shop_id) OR EXISTS (
        SELECT 1 FROM shop_customer_links l WHERE l.customer_id = sa.customer_id AND l.portal_user_id = current_portal_user_id()
      )
    )
  ));

-- Now safe: every policy that read this column has just been replaced.
ALTER TABLE shop_customers DROP COLUMN IF EXISTS linked_portal_user_id;
