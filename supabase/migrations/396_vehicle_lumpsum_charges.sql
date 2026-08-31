-- Migration 396: the vehicle-side counterpart to shop_lumpsum_charges/
-- post_shop_lumpsum_charges() (393) — missed when 394 gave vehicles the
-- same commission_mode machinery. Identical shape, vehicle_id instead of
-- shop_id.
CREATE TABLE IF NOT EXISTS vehicle_lumpsum_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  period varchar NOT NULL,
  amount_pkr decimal NOT NULL,
  voucher_id uuid REFERENCES vouchers(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE (vehicle_id, period)
);
ALTER TABLE vehicle_lumpsum_charges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vehicle_lumpsum_charges_admin_read" ON vehicle_lumpsum_charges FOR SELECT TO authenticated
  USING (can_access_system('donors_projects'));
CREATE POLICY "vehicle_lumpsum_charges_keeper_read" ON vehicle_lumpsum_charges FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id()));

CREATE OR REPLACE FUNCTION post_vehicle_lumpsum_charges() RETURNS void AS $$
DECLARE
  r RECORD;
  v_commission_account uuid;
  v_vehicle_account uuid;
  v_period varchar := to_char((now() AT TIME ZONE 'Asia/Karachi')::date, 'YYYY-MM');
  v_voucher_id uuid;
BEGIN
  SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050';

  FOR r IN
    SELECT * FROM vehicles WHERE commission_mode = 'monthly_lumpsum' AND COALESCE(lumpsum_fee_pkr, 0) > 0 AND is_active = true
  LOOP
    IF EXISTS (SELECT 1 FROM vehicle_lumpsum_charges WHERE vehicle_id = r.id AND period = v_period) THEN CONTINUE; END IF;

    v_vehicle_account := ensure_vehicle_account(r.id);
    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
    VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
      'Monthly marketplace subscription — ' || r.owner_name || ' (' || v_period || ')', r.lumpsum_fee_pkr, v_commission_account, v_vehicle_account, r.owner_name)
    RETURNING id INTO v_voucher_id;

    INSERT INTO vehicle_lumpsum_charges (vehicle_id, period, amount_pkr, voucher_id) VALUES (r.id, v_period, r.lumpsum_fee_pkr, v_voucher_id);

    IF r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (r.portal_user_id, 'shop_lumpsum_charged', 'Monthly fee charged',
        'This month''s marketplace subscription fee has been charged to your account.', '/portal/my-vehicle');
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DO $$
BEGIN
  PERFORM cron.schedule('vehicle-lumpsum-monthly-charges', '5 4 1 * *', 'SELECT post_vehicle_lumpsum_charges()');
  RAISE NOTICE 'pg_cron: monthly vehicle subscription charges run 09:05 PKT on the 1st of each month';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable — run post_vehicle_lumpsum_charges() by hand. %', SQLERRM;
END $$;
