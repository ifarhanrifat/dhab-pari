-- Migration 394: prepaid commission wallets for per_order sellers, the
-- same two commission modes extended to vehicles, and a per-vehicle-type
-- commission override.
--
-- The real shift here: under per_order mode, the customer now pays the
-- shop/driver DIRECTLY (cash in hand) — the committee never holds that
-- money. Its only role is drawing its commission from the seller's own
-- prepaid wallet the moment an order/ride is marked done. That's what
-- makes "top up or stop getting new orders" a real, meaningful gate —
-- under the old always-pay-through-portal design a per_order seller's
-- balance only ever grew (gross credited before commission was drawn),
-- so it could never run dry on its own.
--
-- monthly_lumpsum is completely unaffected: payment still routes through
-- the portal, staff still verifies it, same as migration 393 built it —
-- those sellers already prepaid for the month, no wallet gate needed.
--
-- The wallet IS the seller's existing clearing account (accounts.shop_id/
-- vehicle_id) — a top-up just credits it the same way a settlement
-- doesn't touch (this is the opposite direction: money coming FROM the
-- seller TO the committee, in advance), and a commission draw debits it
-- exactly like it already did. No new account type needed.

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Vehicles get the same commission-mode machinery shops got in 393,
--    plus a portal_user_id so a driver can self-service (top up, mark a
--    booking fulfilled, see their own numbers) — route/vehicle listing
--    itself stays staff-managed, unchanged.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS commission_mode varchar NOT NULL DEFAULT 'per_order'
  CHECK (commission_mode IN ('per_order', 'monthly_lumpsum'));
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS lumpsum_fee_pkr decimal CHECK (lumpsum_fee_pkr IS NULL OR lumpsum_fee_pkr >= 0);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS commission_mode_changed_at timestamptz;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS portal_user_id uuid REFERENCES portal_users(id);
CREATE INDEX IF NOT EXISTS vehicles_portal_user_id_idx ON vehicles(portal_user_id) WHERE portal_user_id IS NOT NULL;

-- Dedupe flags for the low-balance/inactive notifications below — fires
-- once per dip, not once per order, same "stamp so it fires once" idiom
-- as shop_products.expiry_reminded_at. Cleared on a confirmed top-up.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS low_balance_warned_at timestamptz;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS inactive_notified_at timestamptz;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS low_balance_warned_at timestamptz;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS inactive_notified_at timestamptz;

CREATE OR REPLACE FUNCTION trg_vehicle_commission_mode_stamp() RETURNS trigger AS $$
BEGIN
  IF NEW.commission_mode IS DISTINCT FROM OLD.commission_mode THEN
    NEW.commission_mode_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS vehicle_commission_mode_stamp_trigger ON vehicles;
CREATE TRIGGER vehicle_commission_mode_stamp_trigger BEFORE UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION trg_vehicle_commission_mode_stamp();

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Per-vehicle-type commission override — "fix the commission for each
--    vehicle type separately". Matched by exact vehicle_type text
--    (case-insensitive) + the route's intercity/out_of_city classification;
--    falls back to the existing global site_settings rate when a type has
--    no override configured, so nothing breaks for a type nobody's set
--    a rate for yet.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vehicle_type_commission_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_type varchar NOT NULL,
  classification varchar NOT NULL CHECK (classification IN ('intercity', 'out_of_city')),
  commission_pct decimal NOT NULL CHECK (commission_pct >= 0),
  UNIQUE (vehicle_type, classification)
);
ALTER TABLE vehicle_type_commission_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vehicle_type_commission_rates_admin_all" ON vehicle_type_commission_rates FOR ALL TO authenticated
  USING (current_admin_permission('manage_parties')) WITH CHECK (current_admin_permission('manage_parties'));

CREATE OR REPLACE FUNCTION vehicle_commission_pct(p_vehicle_type varchar, p_classification varchar) RETURNS decimal AS $$
DECLARE v_pct decimal;
BEGIN
  SELECT commission_pct INTO v_pct FROM vehicle_type_commission_rates
    WHERE lower(vehicle_type) = lower(p_vehicle_type) AND classification = p_classification;
  IF v_pct IS NOT NULL THEN RETURN v_pct; END IF;
  RETURN COALESCE((SELECT value::decimal FROM site_settings WHERE key =
    CASE WHEN p_classification = 'intercity' THEN 'marketplace_intercity_commission_pct' ELSE 'marketplace_outofcity_commission_pct' END), 0);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Wallet mechanics — a reusable balance reader (shop/vehicle_owner
--    accounts are both credit-normal, see the collectors-settlement fix
--    earlier this project), the eligibility gate, and the low-balance/
--    inactive notification (fires once per dip, reused by both shop and
--    ride confirmation below).
-- ═════════════════════════════════════════════════════════════════════════
INSERT INTO site_settings (key, value, description) VALUES
  ('marketplace_min_balance_to_order_pkr', '0', 'A per-order shop/vehicle needs at least this much in their wallet to receive new orders/bookings'),
  ('marketplace_low_balance_warning_pkr', '200', 'Below this wallet balance, a per-order shop/vehicle gets a "top up soon" warning')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION seller_account_balance(p_account_id uuid) RETURNS decimal AS $$
  SELECT a.opening_balance - (
    COALESCE((SELECT SUM(debit) FROM ledger_entries WHERE account_id = a.id), 0) -
    COALESCE((SELECT SUM(credit) FROM ledger_entries WHERE account_id = a.id), 0)
  ) FROM accounts a WHERE a.id = p_account_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION shop_bookable(p_shop_id uuid) RETURNS boolean AS $$
DECLARE v_shop shops%ROWTYPE; v_min decimal;
BEGIN
  SELECT * INTO v_shop FROM shops WHERE id = p_shop_id;
  IF NOT FOUND OR v_shop.status <> 'active' OR NOT v_shop.delivery_enabled THEN RETURN false; END IF;
  IF v_shop.commission_mode = 'monthly_lumpsum' THEN RETURN true; END IF;
  SELECT COALESCE(value::decimal, 0) INTO v_min FROM site_settings WHERE key = 'marketplace_min_balance_to_order_pkr';
  RETURN seller_account_balance(ensure_shop_account(p_shop_id)) >= v_min;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION shop_bookable(uuid) TO authenticated, anon;

CREATE OR REPLACE FUNCTION vehicle_bookable(p_vehicle_id uuid) RETURNS boolean AS $$
DECLARE v_vehicle vehicles%ROWTYPE; v_min decimal;
BEGIN
  SELECT * INTO v_vehicle FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND OR NOT v_vehicle.is_active THEN RETURN false; END IF;
  IF v_vehicle.commission_mode = 'monthly_lumpsum' THEN RETURN true; END IF;
  SELECT COALESCE(value::decimal, 0) INTO v_min FROM site_settings WHERE key = 'marketplace_min_balance_to_order_pkr';
  RETURN seller_account_balance(ensure_vehicle_account(p_vehicle_id)) >= v_min;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION vehicle_bookable(uuid) TO authenticated, anon;

CREATE OR REPLACE FUNCTION check_seller_balance_notify(p_kind varchar, p_id uuid) RETURNS void AS $$
DECLARE
  v_account_id uuid; v_balance decimal; v_min decimal; v_warn decimal;
  v_portal_user_id uuid; v_warned_at timestamptz; v_inactive_at timestamptz; v_link text;
BEGIN
  SELECT COALESCE(value::decimal, 0) INTO v_min FROM site_settings WHERE key = 'marketplace_min_balance_to_order_pkr';
  SELECT COALESCE(value::decimal, 200) INTO v_warn FROM site_settings WHERE key = 'marketplace_low_balance_warning_pkr';
  v_link := CASE WHEN p_kind = 'shop' THEN '/portal/my-shop/reports' ELSE '/portal/my-vehicle' END;

  IF p_kind = 'shop' THEN
    SELECT portal_user_id, low_balance_warned_at, inactive_notified_at INTO v_portal_user_id, v_warned_at, v_inactive_at FROM shops WHERE id = p_id;
    v_account_id := ensure_shop_account(p_id);
  ELSE
    SELECT portal_user_id, low_balance_warned_at, inactive_notified_at INTO v_portal_user_id, v_warned_at, v_inactive_at FROM vehicles WHERE id = p_id;
    v_account_id := ensure_vehicle_account(p_id);
  END IF;
  IF v_portal_user_id IS NULL THEN RETURN; END IF;

  v_balance := seller_account_balance(v_account_id);

  IF v_balance <= v_min THEN
    IF v_inactive_at IS NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (v_portal_user_id, 'marketplace_wallet_inactive', 'Your account is now inactive for new orders',
        'Your wallet balance has run out — top up to start receiving new orders/bookings again.', v_link);
      IF p_kind = 'shop' THEN UPDATE shops SET inactive_notified_at = now() WHERE id = p_id;
      ELSE UPDATE vehicles SET inactive_notified_at = now() WHERE id = p_id; END IF;
    END IF;
  ELSIF v_balance <= v_warn AND v_warned_at IS NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_portal_user_id, 'marketplace_wallet_low', 'Your wallet balance is running low',
      'Top up soon to avoid your account going inactive for new orders/bookings.', v_link);
    IF p_kind = 'shop' THEN UPDATE shops SET low_balance_warned_at = now() WHERE id = p_id;
    ELSE UPDATE vehicles SET low_balance_warned_at = now() WHERE id = p_id; END IF;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('marketplace_wallet_low', 'A per-order shop/vehicle wallet is running low', false, true),
  ('marketplace_wallet_inactive', 'A per-order shop/vehicle wallet ran out — inactive for new orders', false, true),
  ('shop_wallet_topup_confirmed', 'A shop wallet top-up was confirmed', false, true),
  ('shop_wallet_topup_rejected', 'A shop wallet top-up was rejected', false, true),
  ('vehicle_wallet_topup_confirmed', 'A vehicle wallet top-up was confirmed', false, true),
  ('vehicle_wallet_topup_rejected', 'A vehicle wallet top-up was rejected', false, true)
ON CONFLICT (event_type) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. Wallet top-ups — same announce/confirm/reject shape as every other
--    payment reconciliation here. A confirmed top-up credits the seller's
--    account exactly like a settlement doesn't touch it (opposite
--    direction: money moving TO the committee, not from it) and clears
--    the low-balance/inactive flags so the notification cycle can fire
--    again next time it dips.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS shop_wallet_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  status varchar NOT NULL DEFAULT 'announced' CHECK (status IN ('announced', 'confirmed', 'rejected')),
  announced_method varchar NOT NULL,
  announced_proof_url text NOT NULL,
  announced_at timestamptz DEFAULT now(),
  confirmed_at timestamptz,
  confirmed_by uuid REFERENCES admin_users(id),
  voucher_id uuid REFERENCES vouchers(id),
  rejected_reason text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE shop_wallet_topups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shop_wallet_topups_admin_read" ON shop_wallet_topups FOR SELECT TO authenticated USING (can_access_system('donors_projects'));
CREATE POLICY "shop_wallet_topups_keeper_read" ON shop_wallet_topups FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id()));

CREATE TABLE IF NOT EXISTS vehicle_wallet_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  status varchar NOT NULL DEFAULT 'announced' CHECK (status IN ('announced', 'confirmed', 'rejected')),
  announced_method varchar NOT NULL,
  announced_proof_url text NOT NULL,
  announced_at timestamptz DEFAULT now(),
  confirmed_at timestamptz,
  confirmed_by uuid REFERENCES admin_users(id),
  voucher_id uuid REFERENCES vouchers(id),
  rejected_reason text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE vehicle_wallet_topups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vehicle_wallet_topups_admin_read" ON vehicle_wallet_topups FOR SELECT TO authenticated USING (can_access_system('donors_projects'));
CREATE POLICY "vehicle_wallet_topups_keeper_read" ON vehicle_wallet_topups FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id()));

CREATE OR REPLACE FUNCTION place_shop_wallet_topup(p_shop_id uuid, p_amount decimal, p_method varchar, p_proof_url text) RETURNS uuid AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM shops WHERE id = p_shop_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this shop.' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Enter an amount to top up.' USING ERRCODE = 'P0001'; END IF;
  IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO shop_wallet_topups (shop_id, amount_pkr, announced_method, announced_proof_url)
  VALUES (p_shop_id, p_amount, p_method, p_proof_url) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION place_shop_wallet_topup(uuid, decimal, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION place_shop_wallet_topup(uuid, decimal, varchar, text) TO authenticated;

CREATE OR REPLACE FUNCTION confirm_shop_wallet_topup(p_topup_id uuid) RETURNS jsonb AS $$
DECLARE t shop_wallet_topups%ROWTYPE; s shops%ROWTYPE; v_shop_account uuid; v_cash_account uuid; v_voucher_id uuid; v_voucher_no varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO t FROM shop_wallet_topups WHERE id = p_topup_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Top-up not found' USING ERRCODE = 'P0001'; END IF;
  IF t.status <> 'announced' THEN RAISE EXCEPTION 'This top-up is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO s FROM shops WHERE id = t.shop_id;
  v_shop_account := ensure_shop_account(t.shop_id);
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects' AND code = (CASE WHEN t.announced_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date, 'Wallet top-up — ' || s.name, t.amount_pkr, v_shop_account, v_cash_account, s.name)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE shop_wallet_topups SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(), voucher_id = v_voucher_id WHERE id = p_topup_id;
  UPDATE shops SET low_balance_warned_at = NULL, inactive_notified_at = NULL WHERE id = t.shop_id;

  IF s.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (s.portal_user_id, 'shop_wallet_topup_confirmed', 'Top-up confirmed', 'Your wallet top-up has been confirmed.', '/portal/my-shop/reports');
  END IF;
  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', t.amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION confirm_shop_wallet_topup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION confirm_shop_wallet_topup(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION reject_shop_wallet_topup(p_topup_id uuid, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE t shop_wallet_topups%ROWTYPE; s shops%ROWTYPE;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO t FROM shop_wallet_topups WHERE id = p_topup_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Top-up not found' USING ERRCODE = 'P0001'; END IF;
  IF t.status <> 'announced' THEN RAISE EXCEPTION 'This top-up is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO s FROM shops WHERE id = t.shop_id;
  UPDATE shop_wallet_topups SET status = 'rejected', rejected_reason = p_reason WHERE id = p_topup_id;
  IF s.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (s.portal_user_id, 'shop_wallet_topup_rejected', 'Top-up could not be confirmed', 'Your wallet top-up could not be confirmed.' || COALESCE(' ' || p_reason, ''), '/portal/my-shop/reports');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION reject_shop_wallet_topup(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reject_shop_wallet_topup(uuid, text) TO authenticated;

-- Vehicles: identical three functions, vehicle_id instead of shop_id.
CREATE OR REPLACE FUNCTION place_vehicle_wallet_topup(p_vehicle_id uuid, p_amount decimal, p_method varchar, p_proof_url text) RETURNS uuid AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Enter an amount to top up.' USING ERRCODE = 'P0001'; END IF;
  IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO vehicle_wallet_topups (vehicle_id, amount_pkr, announced_method, announced_proof_url)
  VALUES (p_vehicle_id, p_amount, p_method, p_proof_url) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION place_vehicle_wallet_topup(uuid, decimal, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION place_vehicle_wallet_topup(uuid, decimal, varchar, text) TO authenticated;

CREATE OR REPLACE FUNCTION confirm_vehicle_wallet_topup(p_topup_id uuid) RETURNS jsonb AS $$
DECLARE t vehicle_wallet_topups%ROWTYPE; v vehicles%ROWTYPE; v_vehicle_account uuid; v_cash_account uuid; v_voucher_id uuid; v_voucher_no varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO t FROM vehicle_wallet_topups WHERE id = p_topup_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Top-up not found' USING ERRCODE = 'P0001'; END IF;
  IF t.status <> 'announced' THEN RAISE EXCEPTION 'This top-up is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = t.vehicle_id;
  v_vehicle_account := ensure_vehicle_account(t.vehicle_id);
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects' AND code = (CASE WHEN t.announced_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date, 'Wallet top-up — ' || v.owner_name, t.amount_pkr, v_vehicle_account, v_cash_account, v.owner_name)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE vehicle_wallet_topups SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(), voucher_id = v_voucher_id WHERE id = p_topup_id;
  UPDATE vehicles SET low_balance_warned_at = NULL, inactive_notified_at = NULL WHERE id = t.vehicle_id;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'vehicle_wallet_topup_confirmed', 'Top-up confirmed', 'Your wallet top-up has been confirmed.', '/portal/my-vehicle');
  END IF;
  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', t.amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION confirm_vehicle_wallet_topup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION confirm_vehicle_wallet_topup(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION reject_vehicle_wallet_topup(p_topup_id uuid, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE t vehicle_wallet_topups%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO t FROM vehicle_wallet_topups WHERE id = p_topup_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Top-up not found' USING ERRCODE = 'P0001'; END IF;
  IF t.status <> 'announced' THEN RAISE EXCEPTION 'This top-up is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = t.vehicle_id;
  UPDATE vehicle_wallet_topups SET status = 'rejected', rejected_reason = p_reason WHERE id = p_topup_id;
  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'vehicle_wallet_topup_rejected', 'Top-up could not be confirmed', 'Your wallet top-up could not be confirmed.' || COALESCE(' ' || p_reason, ''), '/portal/my-vehicle');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION reject_vehicle_wallet_topup(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reject_vehicle_wallet_topup(uuid, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- 5. place_shop_order rewritten: lumpsum keeps the exact 389/393 behaviour
--    (payment proof required). per_order drops the proof requirement
--    entirely (the customer's paying the shop directly) and instead gates
--    on shop_bookable()'s wallet check.
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
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'Your cart is empty.' USING ERRCODE = 'P0001'; END IF;

  IF v_shop.commission_mode = 'monthly_lumpsum' THEN
    IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  ELSIF NOT shop_bookable(p_shop_id) THEN
    RAISE EXCEPTION 'This shop is temporarily unable to take new orders — try again later or visit in person.' USING ERRCODE = 'P0001';
  END IF;

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

-- ═════════════════════════════════════════════════════════════════════════
-- 6. confirm_shop_order / reject_shop_order rewritten: permission now
--    resolved AFTER looking up the shop (need to know its mode first).
--    monthly_lumpsum path is byte-for-byte the same logic 393 had — staff
--    only, payment verified, gross voucher, no commission. per_order path
--    is new: the shop's own keeper can act on it too (no payment to
--    verify — the customer already paid them), no gross voucher posted,
--    just the commission drawn from the wallet.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION confirm_shop_order(p_order_id uuid) RETURNS jsonb AS $$
DECLARE
  o shop_orders%ROWTYPE; s shops%ROWTYPE;
  v_shop_account uuid; v_cash_account uuid; v_commission_account uuid;
  v_commission_pct decimal; v_commission_amount decimal;
  v_gross_voucher_id uuid; v_gross_voucher_no varchar; v_commission_voucher_id uuid;
  v_is_keeper boolean;
BEGIN
  SELECT * INTO o FROM shop_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0001'; END IF;
  IF o.status <> 'announced' THEN RAISE EXCEPTION 'This order is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO s FROM shops WHERE id = o.shop_id;

  v_is_keeper := s.portal_user_id IS NOT NULL AND s.portal_user_id = current_portal_user_id() AND s.commission_mode = 'per_order';
  IF NOT (COALESCE(current_admin_permission('post_transactions'), false) OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  v_shop_account := ensure_shop_account(o.shop_id);
  SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050';

  IF s.commission_mode = 'per_order' THEN
    v_commission_pct := COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_shop_commission_pct'), 0);
    v_commission_amount := round(o.total_amount_pkr * v_commission_pct / 100, 2);

    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — order from ' || s.name || ' (paid directly to shop)', v_commission_amount, v_commission_account, v_shop_account, s.name)
      RETURNING id INTO v_commission_voucher_id;
    END IF;

    UPDATE shop_orders SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
      commission_voucher_id = v_commission_voucher_id WHERE id = p_order_id;

    PERFORM check_seller_balance_notify('shop', o.shop_id);

    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (o.portal_user_id, 'shop_order_confirmed', 'Order confirmed', 'Your order from ' || s.name || ' has been confirmed.', '/accounts');

    RETURN jsonb_build_object('amount', o.total_amount_pkr, 'commission', v_commission_amount);
  END IF;

  -- monthly_lumpsum: unchanged from 393.
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects'
    AND code = (CASE WHEN o.announced_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Order from ' || s.name || ' — paid via portal, confirmed', o.announced_amount_pkr, v_shop_account, v_cash_account, s.name)
  RETURNING id, voucher_no INTO v_gross_voucher_id, v_gross_voucher_no;

  UPDATE shop_orders SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
    gross_voucher_id = v_gross_voucher_id WHERE id = p_order_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (o.portal_user_id, 'shop_order_confirmed', 'Order confirmed', 'Your order from ' || s.name || ' has been confirmed.', '/accounts');

  RETURN jsonb_build_object('voucher_no', v_gross_voucher_no, 'amount', o.announced_amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION reject_shop_order(p_order_id uuid, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE o shop_orders%ROWTYPE; s shops%ROWTYPE; item RECORD; v_is_keeper boolean;
BEGIN
  SELECT * INTO o FROM shop_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0001'; END IF;
  IF o.status <> 'announced' THEN RAISE EXCEPTION 'This order is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO s FROM shops WHERE id = o.shop_id;

  v_is_keeper := s.portal_user_id IS NOT NULL AND s.portal_user_id = current_portal_user_id() AND s.commission_mode = 'per_order';
  IF NOT (COALESCE(current_admin_permission('post_transactions'), false) OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  FOR item IN SELECT product_id, quantity FROM shop_order_items WHERE order_id = p_order_id LOOP
    UPDATE shop_products SET quantity_on_hand = quantity_on_hand + item.quantity WHERE id = item.product_id;
  END LOOP;

  UPDATE shop_orders SET status = 'rejected', rejected_reason = p_reason WHERE id = p_order_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (o.portal_user_id, 'shop_order_rejected', 'Order could not be confirmed',
    'Your order from ' || s.name || ' could not be confirmed.' || COALESCE(' ' || p_reason, ''), '/accounts');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- 7. Same treatment for ride bookings, plus the per-vehicle-type
--    commission lookup.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION place_ride_booking(
  p_route_id uuid, p_travel_date date, p_seats int, p_method varchar, p_proof_url text
) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE;
  v_vehicle vehicles%ROWTYPE;
  v_available int;
  v_total decimal;
  v_booking_id uuid;
  v_weekday int;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND OR NOT v_route.is_active THEN RAISE EXCEPTION 'Route not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;
  IF p_seats IS NULL OR p_seats <= 0 THEN RAISE EXCEPTION 'Pick at least one seat.' USING ERRCODE = 'P0001'; END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;

  v_weekday := extract(dow FROM p_travel_date)::int;
  IF NOT (v_weekday = ANY(v_route.days_of_week)) THEN
    RAISE EXCEPTION 'This route does not run on that day.' USING ERRCODE = 'P0001';
  END IF;

  IF v_vehicle.commission_mode = 'monthly_lumpsum' THEN
    IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  ELSIF NOT vehicle_bookable(v_vehicle.id) THEN
    RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings — try another one.' USING ERRCODE = 'P0001';
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

CREATE OR REPLACE FUNCTION confirm_ride_booking(p_booking_id uuid) RETURNS jsonb AS $$
DECLARE
  b ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v vehicles%ROWTYPE;
  v_vehicle_account uuid; v_cash_account uuid; v_commission_account uuid;
  v_commission_pct decimal; v_commission_amount decimal;
  v_gross_voucher_id uuid; v_gross_voucher_no varchar; v_commission_voucher_id uuid;
  v_is_keeper boolean;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'announced' THEN RAISE EXCEPTION 'This booking is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_routes WHERE id = b.route_id;
  SELECT * INTO v FROM vehicles WHERE id = r.vehicle_id;

  v_is_keeper := v.portal_user_id IS NOT NULL AND v.portal_user_id = current_portal_user_id() AND v.commission_mode = 'per_order';
  IF NOT (COALESCE(current_admin_permission('post_transactions'), false) OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  v_vehicle_account := ensure_vehicle_account(v.id);
  SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050';

  IF v.commission_mode = 'per_order' THEN
    v_commission_pct := vehicle_commission_pct(v.vehicle_type, r.classification);
    v_commission_amount := round(b.total_amount_pkr * v_commission_pct / 100, 2);

    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — ' || r.origin || ' → ' || r.destination || ' ride (paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
      RETURNING id INTO v_commission_voucher_id;
    END IF;

    UPDATE ride_bookings SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
      commission_voucher_id = v_commission_voucher_id WHERE id = p_booking_id;

    PERFORM check_seller_balance_notify('vehicle', v.id);

    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (b.portal_user_id, 'ride_booking_confirmed', 'Booking confirmed',
      'Your seat booking for ' || r.origin || ' → ' || r.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || ' has been confirmed.', '/accounts');

    RETURN jsonb_build_object('amount', b.total_amount_pkr, 'commission', v_commission_amount);
  END IF;

  -- monthly_lumpsum: unchanged from 389/393.
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects'
    AND code = (CASE WHEN b.announced_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    r.origin || ' → ' || r.destination || ' — ' || b.seats || ' seat(s), ' || to_char(b.travel_date, 'DD Mon YYYY') || ' · paid via portal, confirmed',
    b.announced_amount_pkr, v_vehicle_account, v_cash_account, v.owner_name)
  RETURNING id, voucher_no INTO v_gross_voucher_id, v_gross_voucher_no;

  UPDATE ride_bookings SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
    gross_voucher_id = v_gross_voucher_id WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'ride_booking_confirmed', 'Booking confirmed',
    'Your seat booking for ' || r.origin || ' → ' || r.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || ' has been confirmed.', '/accounts');

  RETURN jsonb_build_object('voucher_no', v_gross_voucher_no, 'amount', b.announced_amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION reject_ride_booking(p_booking_id uuid, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE b ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v vehicles%ROWTYPE; v_is_keeper boolean;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'announced' THEN RAISE EXCEPTION 'This booking is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_routes WHERE id = b.route_id;
  SELECT * INTO v FROM vehicles WHERE id = r.vehicle_id;

  v_is_keeper := v.portal_user_id IS NOT NULL AND v.portal_user_id = current_portal_user_id() AND v.commission_mode = 'per_order';
  IF NOT (COALESCE(current_admin_permission('post_transactions'), false) OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  UPDATE ride_bookings SET status = 'rejected', rejected_reason = p_reason WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'ride_booking_rejected', 'Booking could not be confirmed',
    'Your seat booking for ' || r.origin || ' → ' || r.destination || ' could not be confirmed.' || COALESCE(' ' || p_reason, ''), '/accounts');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- 8. Search results now carry a bookable flag (per_order seller whose
--    wallet has run dry still shows up for price comparison, same
--    "visible but not buyable" treatment a non-delivery shop already
--    gets — just doesn't offer the buy flow).
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION search_marketplace_products(p_query text) RETURNS jsonb AS $$
DECLARE
  v_results jsonb;
  v_count int;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'product_id', p.id, 'product_name', p.name, 'product_name_ur', p.name_ur,
    'flavor', p.flavor, 'flavor_ur', p.flavor_ur, 'unit_price_pkr', p.unit_price_pkr,
    'shop_id', s.id, 'shop_name', s.name, 'shop_name_ur', s.name_ur,
    'shop_location', s.location, 'shop_location_ur', s.location_ur,
    'delivery_enabled', s.delivery_enabled, 'bookable', shop_bookable(s.id)
  ) ORDER BY p.unit_price_pkr), '[]'::jsonb), count(*)
  INTO v_results, v_count
  FROM shop_products p
  JOIN shops s ON s.id = p.shop_id
  WHERE p.is_active AND s.status = 'active'
    AND (p.name ILIKE '%' || p_query || '%' OR p.name_ur ILIKE '%' || p_query || '%'
      OR p.flavor ILIKE '%' || p_query || '%' OR p.flavor_ur ILIKE '%' || p_query || '%');

  IF trim(p_query) <> '' THEN
    INSERT INTO marketplace_search_log (query, result_count) VALUES (trim(p_query), v_count);
  END IF;

  RETURN v_results;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
