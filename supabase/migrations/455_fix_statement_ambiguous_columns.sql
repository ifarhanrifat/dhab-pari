-- Same class of bug as 454, missed there because it only showed up the
-- moment a real customer with actual transactions was opened: RETURNS
-- TABLE(entry_id, entry_type, entry_at, debit, credit, ...) makes every
-- one of those names a PL/pgSQL variable for the whole function body,
-- not just entry_id — the final SELECT/OVER/ORDER BY referenced ALL of
-- them unqualified from the `entries` CTE, every one of which was
-- equally ambiguous against its own OUT-parameter twin. Postgres just
-- happened to name entry_id first in the error. Qualifying every one
-- with the CTE alias this time, not just the one that got reported.
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
  )
  SELECT entries.e_id, entries.e_type, entries.e_at, entries.e_description, entries.e_debit, entries.e_credit,
    SUM(entries.e_debit - entries.e_credit) OVER (ORDER BY entries.e_at, entries.e_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance
  FROM entries
  ORDER BY entries.e_at DESC, entries.e_id DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
