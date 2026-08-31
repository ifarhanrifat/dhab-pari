-- Migration 405: Marketplace order fulfillment — the operational half of an
-- order that was missing entirely. shop_orders/place_shop_order/
-- confirm_shop_order/reject_shop_order (386/389/393/394) only ever tracked
-- the MONEY side (announced → confirmed/rejected, i.e. "was this order
-- paid"). There was no delivery address captured anywhere, no buyer
-- contact stored, and no concept of "the shop is preparing/delivering
-- this" at all — a delivery-enabled shop had no way to actually know
-- where to send an order once it was paid for.
--
-- This adds a second, independent axis — fulfillment_status — so the two
-- concerns stay separate exactly as they are in real life: a lumpsum shop
-- can start preparing an order before staff have gotten around to
-- confirming the payment slip, and a per_order shop already controls its
-- own payment confirmation but still needs a delivery pipeline on top.
-- Existing confirm_shop_order/reject_shop_order are untouched — this is
-- additive.

-- ═════════════════════════════════════════════════════════════════════════
-- 1. New columns
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE shop_orders
  ADD COLUMN IF NOT EXISTS delivery_address text,
  ADD COLUMN IF NOT EXISTS buyer_mobile varchar,
  ADD COLUMN IF NOT EXISTS fulfillment_status varchar NOT NULL DEFAULT 'pending'
    CHECK (fulfillment_status IN ('pending', 'accepted', 'preparing', 'out_for_delivery', 'delivered', 'cancelled')),
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS out_for_delivery_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

-- Backfill existing rows so old, already-settled orders don't suddenly
-- show up as "needs action" in the new fulfillment UI: a rejected order
-- was never going anywhere (cancelled), a confirmed one was placed and
-- paid before this tracking existed so there's no real history to
-- reconstruct — treat it as already delivered rather than inventing a
-- false "pending" queue on go-live.
UPDATE shop_orders SET fulfillment_status = 'cancelled' WHERE status = 'rejected' AND fulfillment_status = 'pending';
UPDATE shop_orders SET fulfillment_status = 'delivered', delivered_at = COALESCE(confirmed_at, created_at)
  WHERE status = 'confirmed' AND fulfillment_status = 'pending';

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('shop_order_received', 'A new marketplace order came in for a staff-managed shop', false, true)
ON CONFLICT (event_type) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. place_shop_order — now requires a delivery address, captures the
--    buyer's contact from their own portal profile (never typed in by
--    hand — one less field for the customer, and always a verified
--    number rather than whatever they might mistype), and tells the shop
--    a new order is waiting: its own keeper if self-service, staff
--    otherwise (same admin-selection shape as
--    shop_product_expiry_reminders, migration 390).
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION place_shop_order(
  p_shop_id uuid, p_items jsonb, p_method varchar, p_proof_url text, p_delivery_address text
) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_buyer_mobile varchar;
  v_shop shops%ROWTYPE;
  v_order_id uuid;
  v_total decimal := 0;
  r jsonb;
  v_product shop_products%ROWTYPE;
  v_qty decimal;
  v_line_total decimal;
  v_admin RECORD;
  v_staff_notify_enabled boolean;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_delivery_address IS NULL OR trim(p_delivery_address) = '' THEN
    RAISE EXCEPTION 'Enter a delivery address.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_shop FROM shops WHERE id = p_shop_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shop not found' USING ERRCODE = 'P0001'; END IF;
  IF v_shop.status <> 'active' THEN RAISE EXCEPTION 'This shop is not currently active.' USING ERRCODE = 'P0001'; END IF;
  IF NOT v_shop.delivery_enabled THEN
    RAISE EXCEPTION 'This shop does not offer delivery — visit the store to buy.' USING ERRCODE = 'P0001';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'Your cart is empty.' USING ERRCODE = 'P0001'; END IF;

  IF v_shop.commission_mode = 'monthly_lumpsum' THEN
    IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  ELSIF NOT shop_bookable(p_shop_id) THEN
    RAISE EXCEPTION 'This shop is temporarily unable to take new orders — try again later or visit in person.' USING ERRCODE = 'P0001';
  END IF;

  SELECT mobile INTO v_buyer_mobile FROM portal_users WHERE id = v_portal_user_id;

  INSERT INTO shop_orders (shop_id, portal_user_id, status, announced_method, announced_proof_url, announced_at, delivery_address, buyer_mobile)
  VALUES (p_shop_id, v_portal_user_id, 'announced', p_method, p_proof_url, now(), trim(p_delivery_address), v_buyer_mobile)
  RETURNING id INTO v_order_id;

  FOR r IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := (r->>'quantity')::decimal;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Invalid quantity in cart.' USING ERRCODE = 'P0001'; END IF;

    SELECT * INTO v_product FROM shop_products WHERE id = (r->>'product_id')::uuid AND shop_id = p_shop_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'One of the items in your cart is no longer available.' USING ERRCODE = 'P0001'; END IF;
    IF NOT v_product.is_active THEN RAISE EXCEPTION '% is no longer available.', v_product.name USING ERRCODE = 'P0001'; END IF;
    IF v_qty > v_product.quantity_on_hand THEN
      RAISE EXCEPTION 'Only % of % left in stock.', v_product.quantity_on_hand, v_product.name USING ERRCODE = 'P0001';
    END IF;

    v_line_total := v_qty * v_product.unit_price_pkr;
    v_total := v_total + v_line_total;

    INSERT INTO shop_order_items (order_id, product_id, quantity, unit_price_pkr)
    VALUES (v_order_id, v_product.id, v_qty, v_product.unit_price_pkr);

    UPDATE shop_products SET quantity_on_hand = quantity_on_hand - v_qty WHERE id = v_product.id;
  END LOOP;

  UPDATE shop_orders SET total_amount_pkr = v_total, announced_amount_pkr = v_total WHERE id = v_order_id;

  IF v_shop.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_shop.portal_user_id, 'shop_order_received', 'New order received',
      'A new order worth Rs ' || round(v_total) || ' just came in.', '/portal/my-shop/reports');
  ELSE
    SELECT popup_enabled INTO v_staff_notify_enabled FROM notification_preferences WHERE event_type = 'shop_order_received';
    IF v_staff_notify_enabled IS DISTINCT FROM false THEN
      FOR v_admin IN SELECT id FROM admin_users WHERE is_active = true AND (role = 'super_admin' OR can_manage_parties) AND access_donors_projects LOOP
        INSERT INTO notifications (recipient_id, event_type, title, body, link)
        VALUES (v_admin.id, 'shop_order_received', 'New marketplace order',
          'New order for ' || v_shop.name || ' worth Rs ' || round(v_total) || '.', '/admin/shops?shop=' || p_shop_id);
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object('order_id', v_order_id, 'total', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS place_shop_order(uuid, jsonb, varchar, text);
REVOKE ALL ON FUNCTION place_shop_order(uuid, jsonb, varchar, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION place_shop_order(uuid, jsonb, varchar, text, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. accept_shop_order — the shop (its own keeper, any commission mode —
--    this is operational, not financial, so per_order's self-confirm
--    restriction doesn't apply here) or staff marks they've seen the
--    order and will fulfill it. Independent of payment status: a
--    lumpsum shop can start preparing immediately, staff can confirm the
--    payment slip whenever they get to it.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION accept_shop_order(p_order_id uuid) RETURNS void AS $$
DECLARE o shop_orders%ROWTYPE; s shops%ROWTYPE; v_is_keeper boolean;
BEGIN
  SELECT * INTO o FROM shop_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO s FROM shops WHERE id = o.shop_id;

  v_is_keeper := s.portal_user_id IS NOT NULL AND s.portal_user_id = current_portal_user_id();
  IF NOT (COALESCE(current_admin_permission('post_transactions'), false) OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF o.status = 'rejected' THEN RAISE EXCEPTION 'This order was rejected.' USING ERRCODE = 'P0001'; END IF;
  IF o.fulfillment_status <> 'pending' THEN RAISE EXCEPTION 'This order has already been accepted.' USING ERRCODE = 'P0001'; END IF;

  UPDATE shop_orders SET fulfillment_status = 'accepted', accepted_at = now() WHERE id = p_order_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (o.portal_user_id, 'shop_order_accepted', 'Order accepted', s.name || ' is preparing your order.', '/portal/marketplace');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION accept_shop_order(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_shop_order(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. advance_shop_order_fulfillment — moves an accepted order through
--    preparing → out_for_delivery → delivered (forward one step at a
--    time — the app always offers the single next button, this just
--    guards it server-side too), or cancels it. Cancelling releases
--    reserved stock exactly like reject_shop_order; cancelling is
--    refused once payment has already been confirmed and posted to the
--    ledger (settle that as a real reversal — see the closed-month
--    reversal convention — not a silent stock/status flip).
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION advance_shop_order_fulfillment(p_order_id uuid, p_status varchar) RETURNS void AS $$
DECLARE
  o shop_orders%ROWTYPE; s shops%ROWTYPE; v_is_keeper boolean; item RECORD;
  v_rank_current int; v_rank_new int;
  v_ranks jsonb := '{"pending":0,"accepted":1,"preparing":2,"out_for_delivery":3,"delivered":4}'::jsonb;
BEGIN
  IF p_status NOT IN ('preparing', 'out_for_delivery', 'delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid status' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO o FROM shop_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO s FROM shops WHERE id = o.shop_id;

  v_is_keeper := s.portal_user_id IS NOT NULL AND s.portal_user_id = current_portal_user_id();
  IF NOT (COALESCE(current_admin_permission('post_transactions'), false) OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF o.fulfillment_status IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'This order is already closed.' USING ERRCODE = 'P0001';
  END IF;

  IF p_status = 'cancelled' THEN
    IF o.status = 'confirmed' THEN
      RAISE EXCEPTION 'Payment for this order was already confirmed — reverse the voucher instead of cancelling here.' USING ERRCODE = 'P0001';
    END IF;
    FOR item IN SELECT product_id, quantity FROM shop_order_items WHERE order_id = p_order_id LOOP
      UPDATE shop_products SET quantity_on_hand = quantity_on_hand + item.quantity WHERE id = item.product_id;
    END LOOP;
    UPDATE shop_orders SET status = 'rejected', fulfillment_status = 'cancelled',
      rejected_reason = COALESCE(rejected_reason, 'Cancelled by shop') WHERE id = p_order_id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (o.portal_user_id, 'shop_order_cancelled', 'Order cancelled', 'Your order from ' || s.name || ' was cancelled.', '/portal/marketplace');
    RETURN;
  END IF;

  v_rank_current := (v_ranks->>o.fulfillment_status)::int;
  v_rank_new := (v_ranks->>p_status)::int;
  IF v_rank_new <> v_rank_current + 1 THEN
    RAISE EXCEPTION 'Orders must move through each delivery step in order.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE shop_orders SET
    fulfillment_status = p_status,
    out_for_delivery_at = CASE WHEN p_status = 'out_for_delivery' THEN now() ELSE out_for_delivery_at END,
    delivered_at = CASE WHEN p_status = 'delivered' THEN now() ELSE delivered_at END
  WHERE id = p_order_id;

  IF p_status = 'out_for_delivery' THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (o.portal_user_id, 'shop_order_out_for_delivery', 'Order out for delivery', 'Your order from ' || s.name || ' is on its way.', '/portal/marketplace');
  ELSIF p_status = 'delivered' THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (o.portal_user_id, 'shop_order_delivered', 'Order delivered', 'Your order from ' || s.name || ' has been delivered. Thanks for shopping!', '/portal/marketplace');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION advance_shop_order_fulfillment(uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION advance_shop_order_fulfillment(uuid, varchar) TO authenticated;
