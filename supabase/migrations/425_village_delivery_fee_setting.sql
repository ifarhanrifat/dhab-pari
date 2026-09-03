-- Migration 425: the spec's flat in-village delivery charge (villageDelivery
-- = ₨80, no negotiation, distinct from the out-of-city dispatch formula in
-- 423). Recorded as an admin-tunable site_settings row — the same
-- key/value table marketplace_shop_commission_pct etc. already use (406)
-- — so the committee can correct the number like every other placeholder
-- rate seeded tonight.
--
-- NOT wired into place_shop_order (389)/confirm_shop_order yet: that RPC
-- is already live with real orders and real posted vouchers, and adding
-- ₨80 to v_total would silently also grow the commission take (computed
-- as a % of total) on money that isn't goods revenue — a real business-
-- logic call for the committee, not something to guess silently on a live
-- money path. The constant is here, ready, the moment that's decided.
INSERT INTO site_settings (key, value, description) VALUES
  ('village_delivery_flat_fee_pkr', '80', 'Flat delivery charge (Rs) for an in-village delivery — placeholder from the design mock, not yet charged anywhere; confirm before wiring into checkout.')
ON CONFLICT (key) DO NOTHING;
