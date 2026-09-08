-- Delivery system, part 2: how a biker actually gets the call. Reuses
-- the exact mechanism already proven for out-of-village dispatch (423)
-- — every eligible vehicle gets a real in-app notification + an
-- accept/decline screen, first accept wins, everyone else's invite is
-- cancelled automatically — rather than a phone call or anything
-- outside the app. Simpler than dispatch's tier1/tier2 city-presence
-- split: there's no "which city are they in" question for in-village
-- delivery, so this is one ring per order, filtered by who's even
-- eligible for where it's going —
--   in-village (the home village): every delivers=true vehicle.
--   any other village: only delivers=true vehicles that also opted
--   into allows_out_of_city — a purely local biker is never rung for a
--   job that takes them out of Dhab Pari.
--
-- The ring starts only once the shop itself marks the order ready
-- (preparing → out_for_delivery) — see advance_shop_order_fulfillment
-- below — never the instant it's placed, so nobody's called in for an
-- order that isn't even packed yet.
--
-- Deliberately NOT wired to move any money yet. The delivery fee itself
-- is already collected as part of the order total (432) — whether that
-- fee then needs to be posted as a voucher from the shop's own account
-- to the accepted vehicle's, and from which account it should actually
-- come (a per_order shop never posts anything for revenue it collects
-- directly today — the same is true of its delivery fee — so crediting
-- a vehicle from a shop account that itself never received a matching
-- entry would just push the shop's own balance incorrectly negative)
-- is a real accounting decision for the committee, same as 425 left the
-- flat fee itself unwired pending exactly this kind of call. The ring/
-- assignment mechanism below is complete and correct on its own; the
-- payout is intentionally left for a separate, explicit decision.

CREATE TABLE IF NOT EXISTS shop_delivery_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  status varchar NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing', 'declined', 'accepted', 'expired')),
  invited_at timestamptz DEFAULT now(),
  responded_at timestamptz,
  UNIQUE (order_id, vehicle_id)
);
CREATE INDEX IF NOT EXISTS shop_delivery_invitations_order_idx ON shop_delivery_invitations(order_id);
CREATE INDEX IF NOT EXISTS shop_delivery_invitations_vehicle_idx ON shop_delivery_invitations(vehicle_id) WHERE status = 'ringing';

CREATE OR REPLACE FUNCTION is_party_to_shop_delivery(p_order_id uuid) RETURNS boolean AS $$
  SELECT COALESCE(current_admin_permission('manage_parties'), false)
    OR EXISTS (SELECT 1 FROM shop_orders o WHERE o.id = p_order_id AND o.portal_user_id = current_portal_user_id())
    OR EXISTS (SELECT 1 FROM shop_orders o WHERE o.id = p_order_id AND user_manages_shop(o.shop_id))
    OR EXISTS (
      SELECT 1 FROM shop_delivery_invitations i JOIN vehicles v ON v.id = i.vehicle_id
      WHERE i.order_id = p_order_id AND v.portal_user_id = current_portal_user_id()
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

ALTER TABLE shop_delivery_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shop_delivery_invitations_parties_read" ON shop_delivery_invitations FOR SELECT TO authenticated
  USING (is_party_to_shop_delivery(order_id));

CREATE OR REPLACE FUNCTION start_shop_delivery_ring(p_order_id uuid) RETURNS void AS $$
DECLARE
  o shop_orders%ROWTYPE;
  v_is_home boolean;
  v_count int;
BEGIN
  SELECT * INTO o FROM shop_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR user_manages_shop(o.shop_id)) THEN
    RAISE EXCEPTION 'You do not manage this shop.' USING ERRCODE = 'P0001';
  END IF;
  IF o.fulfillment_mode <> 'delivery' THEN RETURN; END IF;

  SELECT v.is_home_village INTO v_is_home FROM villages v WHERE v.id = o.village_id;

  INSERT INTO shop_delivery_invitations (order_id, vehicle_id)
  SELECT p_order_id, veh.id FROM vehicles veh
  WHERE veh.is_active AND veh.delivers
    AND NOT EXISTS (SELECT 1 FROM shop_delivery_invitations i WHERE i.order_id = p_order_id AND i.vehicle_id = veh.id)
    AND (COALESCE(v_is_home, true) OR veh.allows_out_of_city);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count = 0 THEN
    UPDATE shop_orders SET delivery_ring_status = 'no_answer' WHERE id = p_order_id;
    RETURN;
  END IF;

  UPDATE shop_orders SET delivery_ring_status = 'ringing' WHERE id = p_order_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT veh.portal_user_id, 'shop_delivery_invited', 'Delivery request',
    'A delivery job is available' || CASE WHEN v_is_home THEN '' ELSE ' (out of village)' END || '.',
    '/portal/my-vehicle/deliveries/' || p_order_id
  FROM shop_delivery_invitations i JOIN vehicles veh ON veh.id = i.vehicle_id
  WHERE i.order_id = p_order_id AND i.status = 'ringing' AND veh.portal_user_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION start_shop_delivery_ring(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION start_shop_delivery_ring(uuid) TO authenticated;

-- Client-polled sweep, same shape as advance_dispatch_call — expires a
-- ring that's been open 60s with nobody accepting.
CREATE OR REPLACE FUNCTION advance_shop_delivery_ring(p_order_id uuid) RETURNS void AS $$
DECLARE v_ringing_left int; v_oldest timestamptz;
BEGIN
  SELECT count(*), min(invited_at) INTO v_ringing_left, v_oldest
    FROM shop_delivery_invitations WHERE order_id = p_order_id AND status = 'ringing';
  IF v_ringing_left = 0 THEN RETURN; END IF;
  IF now() - v_oldest > interval '60 seconds' THEN
    UPDATE shop_delivery_invitations SET status = 'expired', responded_at = now()
      WHERE order_id = p_order_id AND status = 'ringing';
    UPDATE shop_orders SET delivery_ring_status = 'no_answer' WHERE id = p_order_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION advance_shop_delivery_ring(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION advance_shop_delivery_ring(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION decline_shop_delivery(p_order_id uuid, p_vehicle_id uuid) RETURNS void AS $$
DECLARE v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND OR v.portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE shop_delivery_invitations SET status = 'declined', responded_at = now()
    WHERE order_id = p_order_id AND vehicle_id = p_vehicle_id AND status = 'ringing';
  PERFORM advance_shop_delivery_ring(p_order_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION decline_shop_delivery(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION decline_shop_delivery(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION accept_shop_delivery(p_order_id uuid, p_vehicle_id uuid) RETURNS void AS $$
DECLARE v vehicles%ROWTYPE; o shop_orders%ROWTYPE;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND OR v.portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO o FROM shop_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found.' USING ERRCODE = 'P0001'; END IF;

  UPDATE shop_delivery_invitations SET status = 'accepted', responded_at = now()
    WHERE order_id = p_order_id AND vehicle_id = p_vehicle_id AND status = 'ringing';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'You were not invited to this delivery, or someone else already accepted it.' USING ERRCODE = 'P0001';
  END IF;

  -- First accept wins — every other still-ringing invitation is closed out.
  UPDATE shop_delivery_invitations SET status = 'expired', responded_at = now()
    WHERE order_id = p_order_id AND vehicle_id <> p_vehicle_id AND status = 'ringing';

  UPDATE shop_orders SET delivery_vehicle_id = p_vehicle_id, delivery_ring_status = 'assigned' WHERE id = p_order_id;

  IF o.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (o.portal_user_id, 'shop_delivery_assigned', 'Rider assigned',
      v.owner_name || ' will deliver your order.', '/portal/marketplace');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION accept_shop_delivery(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_shop_delivery(uuid, uuid) TO authenticated;

-- A vehicle owner's own ringing invitations, across every shop —
-- mirrors my_dispatch_invitations (423). Order/shop/village context
-- included so the accept screen can show what it's actually for
-- without a second round trip.
CREATE OR REPLACE FUNCTION my_shop_delivery_invitations(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND OR v.portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'order_id', o.id, 'shop_name', s.name, 'shop_name_ur', s.name_ur,
      'delivery_address', o.delivery_address, 'village_name', vl.name, 'village_name_ur', vl.name_ur,
      'delivery_fee_pkr', o.delivery_fee_pkr, 'invited_at', i.invited_at
    ) ORDER BY i.invited_at)
    FROM shop_delivery_invitations i
    JOIN shop_orders o ON o.id = i.order_id
    JOIN shops s ON s.id = o.shop_id
    LEFT JOIN villages vl ON vl.id = o.village_id
    WHERE i.vehicle_id = p_vehicle_id AND i.status = 'ringing'
  ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_shop_delivery_invitations(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_shop_delivery_invitations(uuid) TO authenticated;

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('shop_delivery_invited', 'A delivery job was offered to a vehicle', false, true),
  ('shop_delivery_assigned', 'A rider was assigned to a customer''s order', false, true)
ON CONFLICT (event_type) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════
-- place_shop_order — adds fulfillment_mode + village_id. Pickup skips
-- the address requirement and the fee entirely; delivery now prices off
-- the chosen village's own rate instead of one flat site_settings
-- number.
-- ═════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS place_shop_order(uuid, jsonb, varchar, text, text);
CREATE OR REPLACE FUNCTION place_shop_order(
  p_shop_id uuid, p_items jsonb, p_method varchar, p_proof_url text,
  p_fulfillment_mode varchar, p_delivery_address text DEFAULT NULL, p_village_id uuid DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_buyer_mobile varchar;
  v_shop shops%ROWTYPE;
  v_order_id uuid;
  v_total decimal := 0;
  v_delivery_fee decimal := 0;
  v_grand_total decimal;
  r jsonb;
  v_product shop_products%ROWTYPE;
  v_qty decimal;
  v_line_total decimal;
  v_admin RECORD;
  v_staff_notify_enabled boolean;
  v_commission_pct decimal;
  v_expected_commission decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_fulfillment_mode NOT IN ('pickup', 'delivery') THEN
    RAISE EXCEPTION 'Choose pickup or delivery.' USING ERRCODE = 'P0001';
  END IF;
  IF p_fulfillment_mode = 'delivery' THEN
    IF p_delivery_address IS NULL OR trim(p_delivery_address) = '' THEN
      RAISE EXCEPTION 'Enter a delivery address.' USING ERRCODE = 'P0001';
    END IF;
    SELECT delivery_fee_pkr INTO v_delivery_fee FROM villages WHERE id = p_village_id AND is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'Choose where this should be delivered.' USING ERRCODE = 'P0001'; END IF;
  END IF;

  SELECT * INTO v_shop FROM shops WHERE id = p_shop_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shop not found' USING ERRCODE = 'P0001'; END IF;
  IF v_shop.status <> 'active' THEN RAISE EXCEPTION 'This shop is not currently active.' USING ERRCODE = 'P0001'; END IF;
  IF NOT v_shop.delivery_enabled THEN
    RAISE EXCEPTION 'This shop does not offer online ordering — visit the store to buy.' USING ERRCODE = 'P0001';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'Your cart is empty.' USING ERRCODE = 'P0001'; END IF;

  IF v_shop.commission_mode = 'monthly_lumpsum' THEN
    IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  ELSIF NOT shop_bookable(p_shop_id) THEN
    RAISE EXCEPTION 'This shop is closed or temporarily unable to take new orders — try again later or visit in person.' USING ERRCODE = 'P0001';
  END IF;

  SELECT mobile INTO v_buyer_mobile FROM portal_users WHERE id = v_portal_user_id;

  INSERT INTO shop_orders (shop_id, portal_user_id, status, announced_method, announced_proof_url, announced_at,
    delivery_address, buyer_mobile, fulfillment_mode, village_id)
  VALUES (p_shop_id, v_portal_user_id, 'announced', p_method, p_proof_url, now(),
    NULLIF(trim(COALESCE(p_delivery_address, '')), ''), v_buyer_mobile, p_fulfillment_mode,
    CASE WHEN p_fulfillment_mode = 'delivery' THEN p_village_id ELSE NULL END)
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

  IF v_shop.commission_mode = 'per_order' THEN
    v_commission_pct := COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_shop_commission_pct'), 0);
    v_expected_commission := round(v_total * v_commission_pct / 100, 2);
    IF seller_account_balance(ensure_shop_account(p_shop_id)) < v_expected_commission THEN
      RAISE EXCEPTION 'This shop''s wallet balance is too low to cover this order''s commission — the shop needs to top up first.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_grand_total := v_total + v_delivery_fee;
  UPDATE shop_orders SET total_amount_pkr = v_grand_total, announced_amount_pkr = v_grand_total, delivery_fee_pkr = v_delivery_fee
    WHERE id = v_order_id;

  IF v_shop.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_shop.portal_user_id, 'shop_order_received', 'New order received',
      'A new order worth Rs ' || round(v_grand_total) || ' just came in.', '/portal/my-shop/reports');
  ELSE
    SELECT popup_enabled INTO v_staff_notify_enabled FROM notification_preferences WHERE event_type = 'shop_order_received';
    IF v_staff_notify_enabled IS DISTINCT FROM false THEN
      FOR v_admin IN SELECT id FROM admin_users WHERE is_active = true AND (role = 'super_admin' OR can_manage_parties) AND access_donors_projects LOOP
        INSERT INTO notifications (recipient_id, event_type, title, body, link)
        VALUES (v_admin.id, 'shop_order_received', 'New marketplace order',
          'New order for ' || v_shop.name || ' worth Rs ' || round(v_grand_total) || '.', '/admin/shops?shop=' || p_shop_id);
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object('order_id', v_order_id, 'total', v_grand_total, 'goods_total', v_total, 'delivery_fee', v_delivery_fee);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION place_shop_order(uuid, jsonb, varchar, text, varchar, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION place_shop_order(uuid, jsonb, varchar, text, varchar, text, uuid) TO authenticated;

-- advance_shop_order_fulfillment — starts the delivery ring the moment
-- an order actually moves to out_for_delivery (never earlier), and
-- skips the ring entirely for a pickup order (relabelled in the UI as
-- "Ready for Pickup" / "Picked Up" — same underlying status names, no
-- second state machine needed for a genuinely simpler case).
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

  v_is_keeper := s.portal_user_id IS NOT NULL AND s.portal_user_id = current_portal_user_id() AND s.commission_mode = 'per_order';
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
    UPDATE shop_delivery_invitations SET status = 'expired', responded_at = now() WHERE order_id = p_order_id AND status = 'ringing';
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (o.portal_user_id, 'shop_order_cancelled', 'Order cancelled', 'Your order from ' || s.name || ' was cancelled.', '/portal/marketplace');
    RETURN;
  END IF;

  v_rank_current := (v_ranks->>o.fulfillment_status)::int;
  v_rank_new := (v_ranks->>p_status)::int;
  IF v_rank_new <> v_rank_current + 1 THEN
    RAISE EXCEPTION 'Orders must move through each step in order.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE shop_orders SET
    fulfillment_status = p_status,
    out_for_delivery_at = CASE WHEN p_status = 'out_for_delivery' THEN now() ELSE out_for_delivery_at END,
    delivered_at = CASE WHEN p_status = 'delivered' THEN now() ELSE delivered_at END
  WHERE id = p_order_id;

  IF p_status = 'out_for_delivery' THEN
    IF o.fulfillment_mode = 'delivery' THEN
      PERFORM start_shop_delivery_ring(p_order_id);
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (o.portal_user_id, 'shop_order_out_for_delivery', 'Order out for delivery', 'Your order from ' || s.name || ' is on its way — looking for a rider now.', '/portal/marketplace');
    ELSE
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (o.portal_user_id, 'shop_order_out_for_delivery', 'Ready for pickup', 'Your order from ' || s.name || ' is ready — come collect it.', '/portal/marketplace');
    END IF;
  ELSIF p_status = 'delivered' THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (o.portal_user_id, 'shop_order_delivered', 'Order delivered',
      CASE WHEN o.fulfillment_mode = 'pickup' THEN 'Thanks for shopping at ' || s.name || '!'
        ELSE 'Your order from ' || s.name || ' has been delivered. Thanks for shopping!' END,
      '/portal/marketplace');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
