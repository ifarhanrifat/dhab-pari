-- Real business concern raised directly: handing a shopkeeper a linked
-- portal customer's WhatsApp number is an open invitation to take future
-- orders off-platform over chat, where this app's own order fee is never
-- collected. A customer with no portal account is a pure walk-in
-- relationship the shopkeeper already has by other means (their own
-- number, given directly) — nothing changes there. A LINKED customer
-- instead gets notified in-portal the moment a bill is generated, and
-- reads it from their own My Credit page — no phone number ever changes
-- hands for them.
INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('shop_bill_ready', 'A shop generated a new udhar bill for a linked account', false, true)
ON CONFLICT (event_type) DO NOTHING;

CREATE OR REPLACE FUNCTION notify_customer_bill_ready(p_invoice_id uuid) RETURNS void AS $$
DECLARE
  v_customer_id uuid;
  v_shop_id uuid;
  v_shop_name text;
  v_invoice_number int;
  v_total decimal;
BEGIN
  SELECT inv.customer_id, inv.invoice_number, inv.total_amount_pkr, c.shop_id, s.name
    INTO v_customer_id, v_invoice_number, v_total, v_shop_id, v_shop_name
    FROM shop_customer_invoices inv
    JOIN shop_customers c ON c.id = inv.customer_id
    JOIN shops s ON s.id = c.shop_id
    WHERE inv.id = p_invoice_id;
  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Invoice not found.';
  END IF;
  IF NOT (current_admin_permission('manage_parties') OR user_manages_shop(v_shop_id)) THEN
    RAISE EXCEPTION 'You do not manage this account''s shop.';
  END IF;

  -- A no-op for a walk-in customer with no linked portal users at all —
  -- this SELECT just returns zero rows, nothing to notify.
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT l.portal_user_id, 'shop_bill_ready',
    v_shop_name || ' — New Bill',
    'Bill #' || v_invoice_number || ' — Rs ' || trim(to_char(v_total, 'FM999,999,999,990')) || ' is ready. View it in Shop Credit / Udhar.',
    '/portal/my-credit'
  FROM shop_customer_links l WHERE l.customer_id = v_customer_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION notify_customer_bill_ready(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION notify_customer_bill_ready(uuid) TO authenticated;
