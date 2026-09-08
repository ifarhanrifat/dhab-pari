-- 466's own redeem_customer_link_code shipped with exactly the bug its own
-- header comment warned about: RETURNS TABLE(customer_id, ...) makes
-- customer_id a PL/pgSQL variable for the whole function body, and two
-- WHERE clauses inside still referenced shop_customer_links.customer_id
-- unqualified. CREATE FUNCTION accepted it (Postgres only plans embedded
-- queries at first execution, not at function-creation time — the same
-- lazy-validation story as migrations 454/455/464), so it only surfaced
-- once actually called, caught immediately by live disposable-account
-- testing before a real household ever hit it. Both now qualified.
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
