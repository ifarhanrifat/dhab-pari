-- Same ambiguous-column class as 454/455: RETURNS TABLE (customer_id,
-- shop_id, shop_name, shop_name_ur) makes shop_id a PL/pgSQL variable for
-- the whole function body, and one EXISTS check inside
-- redeem_customer_link_code referenced shop_id bare — caught immediately
-- by live disposable-account testing before this ever reached a real
-- customer. Qualifying with the table alias.
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
  IF EXISTS (SELECT 1 FROM shop_customers sc WHERE sc.shop_id = v_shop_id AND sc.linked_portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You are already linked to an account at this shop.';
  END IF;

  UPDATE shop_customers SET linked_portal_user_id = v_portal_user_id WHERE id = v_row.customer_id;
  UPDATE shop_customer_link_codes SET used_at = now(), used_by = v_portal_user_id WHERE id = v_row.id;

  RETURN QUERY SELECT c.id, c.shop_id, s.name, s.name_ur FROM shop_customers c JOIN shops s ON s.id = c.shop_id WHERE c.id = v_row.customer_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
