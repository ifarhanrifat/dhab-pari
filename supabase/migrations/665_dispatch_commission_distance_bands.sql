-- Migration 665: city-dispatch commission by distance (item 3 of the 6
-- real gaps). Confirmed live before building: dispatch_calls has no
-- distance of its own, but every dispatch targets a city_shops row,
-- which targets a cities row, and cities.distance_km already exists
-- (committee-entered, real values span 28km-92km today — there's no
-- "same village" tier at all, every registered city is a real trip).
-- So the real gap isn't "local vs city", it's that the single flat
-- marketplace_dispatch_commission_pct charges the same % whether the
-- driver went 28km or 92km. Fixed with a distance-banded table, same
-- shape as vehicle_type_commission_rates, falling back to today's flat
-- setting if no band matches -- so nothing changes until the committee
-- actually adds bands.
CREATE TABLE IF NOT EXISTS dispatch_commission_bands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT COALESCE(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid),
  min_distance_km decimal NOT NULL CHECK (min_distance_km >= 0),
  max_distance_km decimal CHECK (max_distance_km IS NULL OR max_distance_km > min_distance_km),
  commission_pct decimal NOT NULL CHECK (commission_pct >= 0),
  created_at timestamptz DEFAULT now()
);
ALTER TABLE dispatch_commission_bands ENABLE ROW LEVEL SECURITY;
CREATE POLICY "dispatch_commission_bands_read" ON dispatch_commission_bands FOR SELECT USING (true);
CREATE POLICY "dispatch_commission_bands_write" ON dispatch_commission_bands FOR ALL TO authenticated
  USING (tenant_id = my_tenant_id() AND current_admin_permission('manage_parties'))
  WITH CHECK (tenant_id = my_tenant_id() AND current_admin_permission('manage_parties'));

CREATE OR REPLACE FUNCTION dispatch_commission_pct(p_tenant_id uuid, p_distance_km decimal) RETURNS decimal AS $$
DECLARE v_pct decimal;
BEGIN
  SELECT commission_pct INTO v_pct FROM dispatch_commission_bands
  WHERE tenant_id = p_tenant_id AND p_distance_km >= min_distance_km AND (max_distance_km IS NULL OR p_distance_km < max_distance_km)
  ORDER BY min_distance_km DESC LIMIT 1;
  IF v_pct IS NOT NULL THEN RETURN v_pct; END IF;
  RETURN COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_dispatch_commission_pct' AND tenant_id = p_tenant_id), 0);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION dispatch_commission_pct(uuid, decimal) TO authenticated;

CREATE OR REPLACE FUNCTION complete_dispatch_call(p_call_id uuid) RETURNS void AS $$
DECLARE
  c dispatch_calls%ROWTYPE; v vehicles%ROWTYPE; v_distance_km decimal;
  v_vehicle_account uuid; v_commission_account uuid; v_commission_pct decimal; v_fee_portion decimal; v_commission_amount decimal := 0;
  v_commission_voucher_id uuid;
BEGIN
  SELECT * INTO c FROM dispatch_calls WHERE id = p_call_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Call not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = c.accepted_vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this delivery.' USING ERRCODE = 'P0001';
  END IF;
  IF c.status <> 'approved' THEN RAISE EXCEPTION 'This call is not awaiting completion.' USING ERRCODE = 'P0001'; END IF;
  UPDATE dispatch_calls SET status = 'completed', completed_at = now() WHERE id = p_call_id;

  IF v.commission_mode = 'per_order' THEN
    v_fee_portion := GREATEST(0, COALESCE(c.total_pkr, 0) - COALESCE(c.goods_budget_pkr, 0));
    IF v_fee_portion > 0 THEN
      v_vehicle_account := ensure_vehicle_account(v.id);
      SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050' AND tenant_id = c.tenant_id;
      SELECT ci.distance_km INTO v_distance_km FROM city_shops cs JOIN cities ci ON ci.id = cs.city_id WHERE cs.id = c.city_shop_id;
      v_commission_pct := dispatch_commission_pct(c.tenant_id, COALESCE(v_distance_km, 0));
      v_commission_amount := round(v_fee_portion * v_commission_pct / 100, 2);
      IF v_commission_amount > 0 THEN
        INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
        VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
          'Marketplace commission — city dispatch: ' || c.item || ' (paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
        RETURNING id INTO v_commission_voucher_id;
        UPDATE dispatch_calls SET commission_voucher_id = v_commission_voucher_id WHERE id = p_call_id;
      END IF;
      PERFORM check_seller_balance_notify('vehicle', v.id);
    END IF;
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
  VALUES (c.initiator_portal_user_id, 'dispatch_completed', 'Delivered', c.item, '/portal/marketplace/dispatch/' || p_call_id, c.tenant_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
