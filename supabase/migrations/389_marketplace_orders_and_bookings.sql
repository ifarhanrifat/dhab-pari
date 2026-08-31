-- Migration 389: Marketplace phase 3 — the money flow. Checkout is one
-- step here (unlike training enrollment's separate request→confirm): there
-- is no eligibility gate to clear before paying, just "does the customer
-- want to buy this" — so place_shop_order()/place_ride_booking() insert
-- the order/booking AND its announced_* fields in one call. Confirmation
-- (staff side) is where the ledger actually posts, mirroring
-- announce_training_fee_payment()/confirm_training_fee_announcement()/
-- reject_training_fee_announcement() (migration 386) precisely.

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Shop orders
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS shop_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  status varchar NOT NULL DEFAULT 'announced' CHECK (status IN ('announced', 'confirmed', 'rejected')),
  total_amount_pkr decimal NOT NULL DEFAULT 0,
  announced_amount_pkr decimal,
  announced_method varchar,
  announced_proof_url text,
  announced_at timestamptz,
  confirmed_at timestamptz,
  confirmed_by uuid REFERENCES admin_users(id),
  gross_voucher_id uuid REFERENCES vouchers(id),
  commission_voucher_id uuid REFERENCES vouchers(id),
  rejected_reason text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_orders_shop_id_idx ON shop_orders(shop_id);
CREATE INDEX IF NOT EXISTS shop_orders_portal_user_id_idx ON shop_orders(portal_user_id);

CREATE TABLE IF NOT EXISTS shop_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES shop_products(id),
  quantity decimal NOT NULL CHECK (quantity > 0),
  unit_price_pkr decimal NOT NULL,
  line_total_pkr decimal GENERATED ALWAYS AS (quantity * unit_price_pkr) STORED
);
CREATE INDEX IF NOT EXISTS shop_order_items_order_id_idx ON shop_order_items(order_id);

-- Writes only ever happen through the SECURITY DEFINER RPCs below (which
-- run as the migration's owning role and so aren't gated by these
-- policies at all) — these are read-only from the client's own session:
-- an admin sees every order in their system, a portal user sees their own.
ALTER TABLE shop_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shop_orders_admin_read" ON shop_orders FOR SELECT TO authenticated USING (can_access_system('donors_projects'));
CREATE POLICY "shop_orders_portal_read_own" ON shop_orders FOR SELECT TO authenticated USING (portal_user_id = current_portal_user_id());

ALTER TABLE shop_order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shop_order_items_admin_read" ON shop_order_items FOR SELECT TO authenticated
  USING (can_access_system('donors_projects'));
CREATE POLICY "shop_order_items_portal_read_own" ON shop_order_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM shop_orders o WHERE o.id = order_id AND o.portal_user_id = current_portal_user_id()));

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Ride bookings — no seat-reservation column to decrement; availability
--    for a route+date is always computed live (route_seats_available()
--    below), so rejecting a booking frees its seats automatically just by
--    no longer counting toward the sum.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS ride_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES vehicle_routes(id) ON DELETE CASCADE,
  portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  travel_date date NOT NULL,
  seats int NOT NULL CHECK (seats > 0),
  total_amount_pkr decimal NOT NULL,
  status varchar NOT NULL DEFAULT 'announced' CHECK (status IN ('announced', 'confirmed', 'rejected')),
  announced_amount_pkr decimal,
  announced_method varchar,
  announced_proof_url text,
  announced_at timestamptz,
  confirmed_at timestamptz,
  confirmed_by uuid REFERENCES admin_users(id),
  gross_voucher_id uuid REFERENCES vouchers(id),
  commission_voucher_id uuid REFERENCES vouchers(id),
  rejected_reason text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ride_bookings_route_travel_idx ON ride_bookings(route_id, travel_date);
CREATE INDEX IF NOT EXISTS ride_bookings_portal_user_id_idx ON ride_bookings(portal_user_id);

ALTER TABLE ride_bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ride_bookings_admin_read" ON ride_bookings FOR SELECT TO authenticated USING (can_access_system('donors_projects'));
CREATE POLICY "ride_bookings_portal_read_own" ON ride_bookings FOR SELECT TO authenticated USING (portal_user_id = current_portal_user_id());

CREATE OR REPLACE FUNCTION route_seats_available(p_route_id uuid, p_travel_date date) RETURNS int AS $$
  SELECT v.total_seats - COALESCE((
    SELECT SUM(rb.seats)::int FROM ride_bookings rb
    WHERE rb.route_id = p_route_id AND rb.travel_date = p_travel_date AND rb.status IN ('announced', 'confirmed')
  ), 0)
  FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id WHERE vr.id = p_route_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION route_seats_available(uuid, date) TO authenticated, anon;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Cross-store search — the whole "compare prices across every shop"
--    feature. Read-only, no new table.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION search_marketplace_products(p_query text) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'product_id', p.id, 'product_name', p.name, 'product_name_ur', p.name_ur, 'unit_price_pkr', p.unit_price_pkr,
    'shop_id', s.id, 'shop_name', s.name, 'shop_name_ur', s.name_ur,
    'shop_location', s.location, 'shop_location_ur', s.location_ur, 'delivery_enabled', s.delivery_enabled
  ) ORDER BY p.unit_price_pkr), '[]'::jsonb)
  FROM shop_products p
  JOIN shops s ON s.id = p.shop_id
  WHERE p.is_active AND s.status = 'active'
    AND (p.name ILIKE '%' || p_query || '%' OR p.name_ur ILIKE '%' || p_query || '%');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION search_marketplace_products(text) TO authenticated, anon;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. Portal: place a shop order — reserves stock immediately (so two
--    customers can't both "have" the last item while payment sits awaiting
--    confirmation), computes the total from the shop's own current prices
--    (never trusts a client-supplied total), and announces payment against
--    it in the same call.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION place_shop_order(
  p_shop_id uuid, p_items jsonb, p_method varchar, p_proof_url text
) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_shop shops%ROWTYPE;
  v_order_id uuid;
  v_total decimal := 0;
  r jsonb;
  v_product shop_products%ROWTYPE;
  v_qty decimal;
  v_line_total decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_shop FROM shops WHERE id = p_shop_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shop not found' USING ERRCODE = 'P0001'; END IF;
  IF v_shop.status <> 'active' THEN RAISE EXCEPTION 'This shop is not currently active.' USING ERRCODE = 'P0001'; END IF;
  IF NOT v_shop.delivery_enabled THEN
    RAISE EXCEPTION 'This shop does not offer delivery — visit the store to buy.' USING ERRCODE = 'P0001';
  END IF;
  IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'Your cart is empty.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO shop_orders (shop_id, portal_user_id, status, announced_method, announced_proof_url, announced_at)
  VALUES (p_shop_id, v_portal_user_id, 'announced', p_method, p_proof_url, now())
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

  RETURN jsonb_build_object('order_id', v_order_id, 'total', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION place_shop_order(uuid, jsonb, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION place_shop_order(uuid, jsonb, varchar, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- 5. Staff: confirm a shop order — the only place a shop order's ledger
--    legs get posted. Two vouchers: the gross sale (shop's clearing
--    account credited, real cash/bank debited), then the commission cut
--    (the same clearing account debited back down, the committee's
--    marketplace income credited) — so the clearing account always nets
--    to exactly what's owed the shop owner, ready for a later settlement.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION confirm_shop_order(p_order_id uuid) RETURNS jsonb AS $$
DECLARE
  o shop_orders%ROWTYPE; s shops%ROWTYPE;
  v_shop_account uuid; v_cash_account uuid; v_commission_account uuid;
  v_commission_pct decimal; v_commission_amount decimal;
  v_gross_voucher_id uuid; v_gross_voucher_no varchar; v_commission_voucher_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO o FROM shop_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0001'; END IF;
  IF o.status <> 'announced' THEN RAISE EXCEPTION 'This order is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO s FROM shops WHERE id = o.shop_id;
  v_shop_account := ensure_shop_account(o.shop_id);

  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects'
    AND code = (CASE WHEN o.announced_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);
  SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050';
  SELECT COALESCE(value::decimal, 0) INTO v_commission_pct FROM site_settings WHERE key = 'marketplace_shop_commission_pct';
  v_commission_amount := round(o.announced_amount_pkr * v_commission_pct / 100, 2);

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Order from ' || s.name || ' — paid via portal, confirmed', o.announced_amount_pkr, v_shop_account, v_cash_account, s.name)
  RETURNING id, voucher_no INTO v_gross_voucher_id, v_gross_voucher_no;

  IF v_commission_amount > 0 THEN
    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
    VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
      'Marketplace commission — order from ' || s.name, v_commission_amount, v_commission_account, v_shop_account, s.name)
    RETURNING id INTO v_commission_voucher_id;
  END IF;

  UPDATE shop_orders SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
    gross_voucher_id = v_gross_voucher_id, commission_voucher_id = v_commission_voucher_id
  WHERE id = p_order_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (o.portal_user_id, 'shop_order_confirmed', 'Order confirmed', 'Your order from ' || s.name || ' has been confirmed.', '/accounts');

  RETURN jsonb_build_object('voucher_no', v_gross_voucher_no, 'amount', o.announced_amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION confirm_shop_order(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION confirm_shop_order(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- 6. Staff: reject a shop order — releases the reserved stock back.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION reject_shop_order(p_order_id uuid, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE o shop_orders%ROWTYPE; s shops%ROWTYPE; item RECORD;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO o FROM shop_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0001'; END IF;
  IF o.status <> 'announced' THEN RAISE EXCEPTION 'This order is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO s FROM shops WHERE id = o.shop_id;

  FOR item IN SELECT product_id, quantity FROM shop_order_items WHERE order_id = p_order_id LOOP
    UPDATE shop_products SET quantity_on_hand = quantity_on_hand + item.quantity WHERE id = item.product_id;
  END LOOP;

  UPDATE shop_orders SET status = 'rejected', rejected_reason = p_reason WHERE id = p_order_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (o.portal_user_id, 'shop_order_rejected', 'Order could not be confirmed',
    'Your order from ' || s.name || ' could not be confirmed.' || COALESCE(' ' || p_reason, ''), '/accounts');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION reject_shop_order(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reject_shop_order(uuid, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- 7. Portal: book seats on a route — validates the travel date actually
--    falls on a day this route runs, checks live availability
--    (route_seats_available()), computes the fare from the route's own
--    current rate, announces payment in the same call.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION place_ride_booking(
  p_route_id uuid, p_travel_date date, p_seats int, p_method varchar, p_proof_url text
) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE;
  v_available int;
  v_total decimal;
  v_booking_id uuid;
  v_weekday int;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND OR NOT v_route.is_active THEN RAISE EXCEPTION 'Route not found' USING ERRCODE = 'P0001'; END IF;
  IF p_seats IS NULL OR p_seats <= 0 THEN RAISE EXCEPTION 'Pick at least one seat.' USING ERRCODE = 'P0001'; END IF;
  IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;

  v_weekday := extract(dow FROM p_travel_date)::int;
  IF NOT (v_weekday = ANY(v_route.days_of_week)) THEN
    RAISE EXCEPTION 'This route does not run on that day.' USING ERRCODE = 'P0001';
  END IF;

  v_available := route_seats_available(p_route_id, p_travel_date);
  IF p_seats > v_available THEN
    RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001';
  END IF;

  v_total := p_seats * v_route.fare_per_seat_pkr;

  INSERT INTO ride_bookings (route_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at)
  VALUES (p_route_id, v_portal_user_id, p_travel_date, p_seats, v_total, 'announced', v_total, p_method, p_proof_url, now())
  RETURNING id INTO v_booking_id;

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION place_ride_booking(uuid, date, int, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION place_ride_booking(uuid, date, int, varchar, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- 8. Staff: confirm a ride booking — same two-voucher shape as a shop
--    order, but the commission rate is picked by the route's own
--    intercity/out_of_city classification.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION confirm_ride_booking(p_booking_id uuid) RETURNS jsonb AS $$
DECLARE
  b ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v vehicles%ROWTYPE;
  v_vehicle_account uuid; v_cash_account uuid; v_commission_account uuid;
  v_commission_pct decimal; v_commission_amount decimal; v_pct_key varchar;
  v_gross_voucher_id uuid; v_gross_voucher_no varchar; v_commission_voucher_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'announced' THEN RAISE EXCEPTION 'This booking is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO r FROM vehicle_routes WHERE id = b.route_id;
  SELECT * INTO v FROM vehicles WHERE id = r.vehicle_id;
  v_vehicle_account := ensure_vehicle_account(v.id);

  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects'
    AND code = (CASE WHEN b.announced_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);
  SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050';

  v_pct_key := CASE WHEN r.classification = 'intercity' THEN 'marketplace_intercity_commission_pct' ELSE 'marketplace_outofcity_commission_pct' END;
  SELECT COALESCE(value::decimal, 0) INTO v_commission_pct FROM site_settings WHERE key = v_pct_key;
  v_commission_amount := round(b.announced_amount_pkr * v_commission_pct / 100, 2);

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    r.origin || ' → ' || r.destination || ' — ' || b.seats || ' seat(s), ' || to_char(b.travel_date, 'DD Mon YYYY') || ' · paid via portal, confirmed',
    b.announced_amount_pkr, v_vehicle_account, v_cash_account, v.owner_name)
  RETURNING id, voucher_no INTO v_gross_voucher_id, v_gross_voucher_no;

  IF v_commission_amount > 0 THEN
    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
    VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
      'Marketplace commission — ' || r.origin || ' → ' || r.destination || ' ride', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
    RETURNING id INTO v_commission_voucher_id;
  END IF;

  UPDATE ride_bookings SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
    gross_voucher_id = v_gross_voucher_id, commission_voucher_id = v_commission_voucher_id
  WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'ride_booking_confirmed', 'Booking confirmed',
    'Your seat booking for ' || r.origin || ' → ' || r.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || ' has been confirmed.', '/accounts');

  RETURN jsonb_build_object('voucher_no', v_gross_voucher_no, 'amount', b.announced_amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION confirm_ride_booking(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION confirm_ride_booking(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- 9. Staff: reject a ride booking — no seats to release; the live
--    availability count already excludes anything not announced/confirmed.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION reject_ride_booking(p_booking_id uuid, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE b ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'announced' THEN RAISE EXCEPTION 'This booking is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_routes WHERE id = b.route_id;

  UPDATE ride_bookings SET status = 'rejected', rejected_reason = p_reason WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'ride_booking_rejected', 'Booking could not be confirmed',
    'Your seat booking for ' || r.origin || ' → ' || r.destination || ' could not be confirmed.' || COALESCE(' ' || p_reason, ''), '/accounts');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION reject_ride_booking(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reject_ride_booking(uuid, text) TO authenticated;
