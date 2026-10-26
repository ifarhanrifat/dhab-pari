-- Real ask, 2026-10-26: "that fix amount can also be readjusted for
-- the monthly fixed commission for each category vehicle which will
-- use this service" — the Rs 30 route-run stake (734/735, now scoped
-- to start_route_run only, the fixed/recurring school-van-style
-- route) shouldn't be one single flat number for every vehicle — a
-- van and a car running a fixed daily route are different businesses.
-- Reuses the exact real per-category pattern vehicle_categories (707)
-- already has for commission_pct — same shape, same fallback
-- discipline ("falls back to the exact prior behavior whenever
-- category_id is NULL", 709's own words) so nothing changes for a
-- vehicle with no category assigned yet.

ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS route_stake_pkr decimal NOT NULL DEFAULT 30 CHECK (route_stake_pkr >= 0);

CREATE OR REPLACE FUNCTION charge_vehicle_ride_stake(p_vehicle_id uuid, p_context text) RETURNS void AS $$
DECLARE
  v vehicles%ROWTYPE; v_stake decimal; v_vehicle_account uuid; v_commission_account uuid; v_voucher_id uuid; v_balance decimal;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vehicle not found.' USING ERRCODE = 'P0001'; END IF;
  IF v.commission_mode <> 'per_order' THEN RETURN; END IF;

  IF v.category_id IS NOT NULL THEN
    SELECT route_stake_pkr INTO v_stake FROM vehicle_categories WHERE id = v.category_id;
  END IF;
  IF v_stake IS NULL THEN
    SELECT COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'vehicle_ride_posting_stake_pkr'), 30) INTO v_stake;
  END IF;
  IF v_stake <= 0 THEN RETURN; END IF;

  v_vehicle_account := ensure_vehicle_account(p_vehicle_id);
  v_balance := seller_account_balance(v_vehicle_account);
  IF v_balance < v_stake THEN
    RAISE EXCEPTION 'Your wallet balance (Rs %) is too low to cover this Rs % posting fee — top up first.', round(v_balance), v_stake USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050' AND tenant_id = v.tenant_id;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    p_context || ' — posting fee (non-refundable)', v_stake, v_commission_account, v_vehicle_account, v.owner_name)
  RETURNING id INTO v_voucher_id;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'vehicle_ride_stake_charged', 'Posting fee charged',
      'Rs ' || v_stake || ' was charged from your wallet for ' || p_context || ' — this is not refundable.', '/portal/my-vehicle');
  END IF;

  PERFORM check_seller_balance_notify('vehicle', p_vehicle_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION vehicle_ride_stake_info(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v vehicles%ROWTYPE; v_stake decimal;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = current_portal_user_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF v.commission_mode <> 'per_order' THEN
    RETURN jsonb_build_object('applies', false, 'stake_pkr', 0, 'balance_pkr', 0, 'can_afford', true);
  END IF;
  IF v.category_id IS NOT NULL THEN
    SELECT route_stake_pkr INTO v_stake FROM vehicle_categories WHERE id = v.category_id;
  END IF;
  IF v_stake IS NULL THEN
    SELECT COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'vehicle_ride_posting_stake_pkr'), 30) INTO v_stake;
  END IF;
  RETURN jsonb_build_object('applies', true, 'stake_pkr', v_stake, 'balance_pkr', seller_account_balance(ensure_vehicle_account(p_vehicle_id)),
    'can_afford', seller_account_balance(ensure_vehicle_account(p_vehicle_id)) >= v_stake);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_ride_stake_info(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_ride_stake_info(uuid) TO authenticated;
