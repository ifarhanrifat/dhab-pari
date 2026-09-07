-- One query for the whole customer list with each one's running balance
-- pre-computed, rather than N calls to shop_customer_statement (452) —
-- that function returns a full transaction-by-transaction statement,
-- which the list screen doesn't need, just the final number.
CREATE OR REPLACE FUNCTION shop_customers_with_balance(p_shop_id uuid)
RETURNS TABLE (id uuid, name text, name_ur text, phone text, is_active boolean, balance decimal) AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM shops WHERE id = p_shop_id AND (current_admin_permission('manage_parties') OR portal_user_id = current_portal_user_id())
  ) THEN
    RAISE EXCEPTION 'You do not manage this shop.';
  END IF;

  RETURN QUERY
  SELECT c.id, c.name, c.name_ur, c.phone, c.is_active,
    COALESCE((SELECT SUM(sa.total_amount_pkr) FROM shop_sales sa WHERE sa.customer_id = c.id), 0)
    - COALESCE((SELECT SUM(pmt.amount_pkr) FROM shop_customer_payments pmt WHERE pmt.customer_id = c.id), 0) AS balance
  FROM shop_customers c
  WHERE c.shop_id = p_shop_id
  ORDER BY c.name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION shop_customers_with_balance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION shop_customers_with_balance(uuid) TO authenticated;
