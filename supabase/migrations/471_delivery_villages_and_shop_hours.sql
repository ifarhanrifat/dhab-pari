-- Delivery system, part 1: schema. Real requirements from a direct ask:
-- a village-name rate card (Dhab Pari itself as the default, other
-- villages committee-added) instead of the single flat fee every
-- delivery has paid since 432; shop opening/closing hours (shops have
-- never had any at all — addas already do, same shape reused here);
-- and a genuine self-pickup choice at checkout (today delivery_enabled
-- shops have no way to skip delivery/the fee at all).
--
-- Deliberately NOT live map/GPS distance calculation for village fees —
-- this app already made that exact call for cities (420): an admin
-- types in distance_km once, the fare math just multiplies it by a
-- rate. A village's distance from Dhab Pari never changes, so nothing
-- "live" buys anything here that a one-time committee-entered number
-- doesn't, and it avoids pulling in a paid routing API for something
-- this static.

CREATE TABLE IF NOT EXISTS villages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar NOT NULL,
  name_ur varchar,
  delivery_fee_pkr decimal NOT NULL DEFAULT 0 CHECK (delivery_fee_pkr >= 0),
  is_home_village boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  display_order int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
-- At most one home village — the dropdown's default selection.
CREATE UNIQUE INDEX IF NOT EXISTS villages_one_home_uniq ON villages ((true)) WHERE is_home_village;

ALTER TABLE villages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_villages" ON villages FOR SELECT USING (is_active);
CREATE POLICY "villages_write" ON villages FOR INSERT TO authenticated
  WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "villages_update" ON villages FOR UPDATE TO authenticated
  USING (true) WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "villages_delete" ON villages FOR DELETE TO authenticated
  USING (current_admin_permission('delete_transactions'));

-- Carries forward the exact fee every delivery has paid since 432 —
-- nothing changes for a live order the moment this ships, until the
-- committee actually adds more villages.
INSERT INTO villages (name, name_ur, delivery_fee_pkr, is_home_village, display_order)
VALUES ('Dhab Pari', 'ڈھب پری', 80, true, 0)
ON CONFLICT DO NOTHING;

-- Shop hours — same shape as addas.operating_start_time/end_time (415),
-- shopkeeper-editable (their own business hours, not a committee-wide
-- setting) rather than admin-only like an adda's. NULL/NULL (the
-- default for every shop that hasn't set one yet) means "no restriction
-- — always open," so this ships with zero behavior change until a
-- shopkeeper actually sets hours.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS opens_at time;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS closes_at time;

-- shop_orders: which village (delivery) or that the buyer is collecting
-- it themselves (pickup), and which vehicle ultimately took the
-- delivery job (set once a biker accepts the ring — part 2).
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS fulfillment_mode varchar NOT NULL DEFAULT 'delivery'
  CHECK (fulfillment_mode IN ('pickup', 'delivery'));
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS village_id uuid REFERENCES villages(id);
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS delivery_vehicle_id uuid REFERENCES vehicles(id);
-- Tracks the ring separately from fulfillment_status — a delivery can
-- be "out_for_delivery" from the customer's point of view the instant
-- the shop starts looking for a rider, while the ring itself is still
-- being sorted out behind the scenes.
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS delivery_ring_status varchar NOT NULL DEFAULT 'none'
  CHECK (delivery_ring_status IN ('none', 'ringing', 'no_answer', 'assigned'));

-- shop_bookable — the one place both place_shop_order and the shop
-- front's own "can I even order right now" check already go through —
-- now also closed for the day outside a shop's own hours (if it's set
-- any; NULL/NULL never blocks). Deliberately a same-day window only
-- (opens < closes) — no overnight-wraparound shops exist in this
-- village today, and it's a real edge case not worth guessing at
-- silently if one ever does.
CREATE OR REPLACE FUNCTION shop_bookable(p_shop_id uuid) RETURNS boolean AS $$
DECLARE v_shop shops%ROWTYPE; v_min decimal; v_now_time time;
BEGIN
  SELECT * INTO v_shop FROM shops WHERE id = p_shop_id;
  IF NOT FOUND OR v_shop.status <> 'active' OR NOT v_shop.delivery_enabled THEN RETURN false; END IF;

  IF v_shop.opens_at IS NOT NULL AND v_shop.closes_at IS NOT NULL THEN
    v_now_time := (now() AT TIME ZONE 'Asia/Karachi')::time;
    IF v_now_time < v_shop.opens_at OR v_now_time > v_shop.closes_at THEN RETURN false; END IF;
  END IF;

  IF v_shop.commission_mode = 'monthly_lumpsum' THEN RETURN true; END IF;
  SELECT COALESCE(value::decimal, 0) INTO v_min FROM site_settings WHERE key = 'marketplace_min_balance_to_order_pkr';
  RETURN seller_account_balance(ensure_shop_account(p_shop_id)) >= v_min;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION shop_bookable(uuid) TO authenticated, anon;

-- Same closed-for-the-day check, exposed on its own — the shop front
-- needs to explain WHY ordering is blocked (closed vs. genuinely
-- unbookable) rather than one opaque "can't order" boolean covering
-- both.
CREATE OR REPLACE FUNCTION shop_open_now(p_shop_id uuid) RETURNS boolean AS $$
DECLARE v_opens time; v_closes time; v_now_time time;
BEGIN
  SELECT opens_at, closes_at INTO v_opens, v_closes FROM shops WHERE id = p_shop_id;
  IF v_opens IS NULL OR v_closes IS NULL THEN RETURN true; END IF;
  v_now_time := (now() AT TIME ZONE 'Asia/Karachi')::time;
  RETURN v_now_time >= v_opens AND v_now_time <= v_closes;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION shop_open_now(uuid) TO authenticated, anon;
