-- Migration 430: "who accepts decides the price," not GPS/routing — a
-- driver already checked into the target city (tier1) gets a flat
-- purchasing fee scaled to what's being bought; a village-based driver who
-- has to make the round trip (tier2) gets the existing real fuel formula
-- (goods + outbound + return + wait), which is naturally about double the
-- tier1 case since it's a genuine village↔city round trip. No live GPS,
-- no routing API, no map pin — accept_dispatch_call already knows which
-- tier the accepting vehicle was invited under.
--
-- Also: a "General Purchase" city_shop, one per city, seeded here — lets
-- the merged "Order from City" screen (replacing separate city-shop-order
-- and city-fetch tiles) post a free-text broadcast without requiring the
-- villager to pick a specific pre-listed shop first. The existing
-- create_dispatch_call/invite_dispatch_tier/dispatch_call_detail machinery
-- is untouched — this reuses it exactly as built and tested, just against
-- a generic shop row instead of a real one.

CREATE TABLE IF NOT EXISTS purchase_fee_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  max_goods_pkr decimal NOT NULL,
  fee_pkr decimal NOT NULL,
  display_order int NOT NULL DEFAULT 0
);
INSERT INTO purchase_fee_tiers (max_goods_pkr, fee_pkr, display_order) VALUES
  (1000, 100, 1), (1500, 120, 2), (2000, 150, 3), (2500, 200, 4), (3000, 250, 5), (4000, 300, 6), (999999999, 350, 7)
ON CONFLICT DO NOTHING;
ALTER TABLE purchase_fee_tiers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_purchase_fee_tiers" ON purchase_fee_tiers FOR SELECT USING (true);
CREATE POLICY "purchase_fee_tiers_write" ON purchase_fee_tiers FOR INSERT TO authenticated WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "purchase_fee_tiers_update" ON purchase_fee_tiers FOR UPDATE TO authenticated USING (true) WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "purchase_fee_tiers_delete" ON purchase_fee_tiers FOR DELETE TO authenticated USING (current_admin_permission('delete_transactions'));

CREATE OR REPLACE FUNCTION purchase_fee_for_budget(p_budget_pkr decimal) RETURNS decimal AS $$
  SELECT fee_pkr FROM purchase_fee_tiers WHERE max_goods_pkr >= p_budget_pkr ORDER BY max_goods_pkr ASC LIMIT 1;
$$ LANGUAGE sql STABLE;

ALTER TABLE city_shops ADD COLUMN IF NOT EXISTS is_general boolean NOT NULL DEFAULT false;
INSERT INTO city_shops (name, name_ur, city_id, category, is_general)
SELECT 'General Purchase', 'عمومی خریداری', c.id, 'general', true FROM cities c
WHERE c.is_active AND NOT EXISTS (SELECT 1 FROM city_shops cs WHERE cs.city_id = c.id AND cs.is_general);

ALTER TABLE dispatch_calls ADD COLUMN IF NOT EXISTS purchase_fee_pkr decimal;
ALTER TABLE dispatch_calls ADD COLUMN IF NOT EXISTS accepted_tier int;

CREATE OR REPLACE FUNCTION accept_dispatch_call(p_call_id uuid, p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE
  c dispatch_calls%ROWTYPE; v vehicles%ROWTYPE; v_city_km decimal; v_leg_fare decimal;
  v_tier int; v_purchase_fee decimal; v_total decimal;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND OR v.portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO c FROM dispatch_calls WHERE id = p_call_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Call not found.' USING ERRCODE = 'P0001'; END IF;
  IF c.status NOT IN ('tier1', 'tier2') THEN RAISE EXCEPTION 'This call is no longer open.' USING ERRCODE = 'P0001'; END IF;

  SELECT tier INTO v_tier FROM dispatch_invitations WHERE call_id = p_call_id AND vehicle_id = p_vehicle_id AND status = 'ringing';
  IF NOT FOUND THEN RAISE EXCEPTION 'You were not invited to this call, or someone else already accepted it.' USING ERRCODE = 'P0001'; END IF;

  -- Only a tier2 (village, real round-trip) accept needs a per-km rate —
  -- a tier1 accept (already in the city) is priced off the flat fee
  -- table instead, no distance math at all.
  IF v_tier = 2 AND v.per_km_pkr IS NULL THEN
    RAISE EXCEPTION 'Your per-km rate has not been set yet — ask the committee to set it before accepting deliveries from outside the city.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE dispatch_invitations SET status = 'accepted', responded_at = now()
    WHERE call_id = p_call_id AND vehicle_id = p_vehicle_id AND status = 'ringing';

  -- First accept wins — every other still-ringing invitation is closed out.
  UPDATE dispatch_invitations SET status = 'expired', responded_at = now()
    WHERE call_id = p_call_id AND vehicle_id <> p_vehicle_id AND status = 'ringing';

  IF v_tier = 1 THEN
    v_purchase_fee := purchase_fee_for_budget(c.goods_budget_pkr);
    v_total := c.goods_budget_pkr + v_purchase_fee;
    UPDATE dispatch_calls SET
      status = 'priced', accepted_vehicle_id = p_vehicle_id, accepted_tier = v_tier,
      purchase_fee_pkr = v_purchase_fee, fare_outbound_pkr = NULL, fare_return_pkr = NULL, wait_fee_pkr = NULL,
      total_pkr = v_total
    WHERE id = p_call_id;
  ELSE
    SELECT ci.distance_km INTO v_city_km FROM city_shops s JOIN cities ci ON ci.id = s.city_id WHERE s.id = c.city_shop_id;
    v_leg_fare := round_to_10(v_city_km * v.per_km_pkr);
    v_total := c.goods_budget_pkr + v_leg_fare + v_leg_fare + 50;
    UPDATE dispatch_calls SET
      status = 'priced', accepted_vehicle_id = p_vehicle_id, accepted_tier = v_tier,
      purchase_fee_pkr = NULL, fare_outbound_pkr = v_leg_fare, fare_return_pkr = v_leg_fare, wait_fee_pkr = 50,
      total_pkr = v_total
    WHERE id = p_call_id;
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (c.initiator_portal_user_id, 'dispatch_accepted', 'Delivery accepted', v.owner_name || ' — Rs ' || v_total::text, '/portal/marketplace/dispatch/' || p_call_id);

  RETURN dispatch_call_detail(p_call_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION accept_dispatch_call(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_dispatch_call(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION dispatch_call_detail(p_call_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'call', jsonb_build_object(
      'id', c.id, 'item', c.item, 'address', c.address, 'goods_budget_pkr', c.goods_budget_pkr, 'status', c.status,
      'fare_outbound_pkr', c.fare_outbound_pkr, 'fare_return_pkr', c.fare_return_pkr, 'wait_fee_pkr', c.wait_fee_pkr,
      'purchase_fee_pkr', c.purchase_fee_pkr, 'accepted_tier', c.accepted_tier, 'total_pkr', c.total_pkr,
      'shop_name', s.name, 'shop_name_ur', s.name_ur, 'shop_is_general', s.is_general, 'city_name', ci.name, 'city_km', ci.distance_km,
      'accepted_vehicle_id', av.id, 'accepted_owner_name', av.owner_name, 'accepted_owner_mobile', av.owner_mobile, 'accepted_vehicle_type', av.vehicle_type
    ),
    'invitations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'vehicle_id', v.id, 'owner_name', v.owner_name, 'tier', i.tier, 'status', i.status, 'invited_at', i.invited_at, 'responded_at', i.responded_at
      ) ORDER BY i.tier, i.invited_at)
      FROM dispatch_invitations i JOIN vehicles v ON v.id = i.vehicle_id WHERE i.call_id = c.id
    ), '[]'::jsonb)
  )
  FROM dispatch_calls c
  JOIN city_shops s ON s.id = c.city_shop_id
  JOIN cities ci ON ci.id = s.city_id
  LEFT JOIN vehicles av ON av.id = c.accepted_vehicle_id
  WHERE c.id = p_call_id AND is_party_to_dispatch(c.id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION dispatch_call_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION dispatch_call_detail(uuid) TO authenticated;

-- The two-section vehicle list for the merged "Order from City" screen —
-- "present" mirrors dispatch tier1's own eligibility rule exactly
-- (vehicle_city_presence + delivers), "village" mirrors tier2's (delivers
-- + allows_out_of_city-or-home, not currently present) — same rules
-- invite_dispatch_tier (423/429) already uses, kept in lockstep by
-- construction rather than duplicated ad hoc in the frontend.
CREATE OR REPLACE FUNCTION vehicles_available_for_city(p_city_id uuid) RETURNS jsonb AS $$
DECLARE v_is_home boolean;
BEGIN
  SELECT is_home_city INTO v_is_home FROM cities WHERE id = p_city_id;
  RETURN jsonb_build_object(
    'present', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'vehicle_id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number
      ) ORDER BY p.checked_in_at)
      FROM vehicle_city_presence p JOIN vehicles v ON v.id = p.vehicle_id
      WHERE p.city_id = p_city_id AND p.is_active AND v.is_active AND v.delivers
    ), '[]'::jsonb),
    'village', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'vehicle_id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number
      ) ORDER BY v.owner_name)
      FROM vehicles v
      WHERE v.is_active AND v.delivers AND (v_is_home OR v.allows_out_of_city)
        AND NOT EXISTS (SELECT 1 FROM vehicle_city_presence p WHERE p.vehicle_id = v.id AND p.city_id = p_city_id AND p.is_active)
    ), '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicles_available_for_city(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicles_available_for_city(uuid) TO authenticated;
