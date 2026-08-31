-- Migration 390: Marketplace phase 6 — owner settlement (extends the
-- existing collector_settlements mechanism rather than building a new
-- table) and the product-expiry reminder cron.

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Owner settlement — a shop's or vehicle's clearing account holds
--    exactly what's owed the owner (confirm_shop_order()/
--    confirm_ride_booking() already net it to that), same shape as a
--    field collector's holding. Rather than a new table, collector_id
--    becomes optional and two more optional target columns are added,
--    with a check that exactly one of the three is ever set.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE collector_settlements ALTER COLUMN collector_id DROP NOT NULL;
ALTER TABLE collector_settlements ADD COLUMN IF NOT EXISTS shop_id uuid REFERENCES shops(id);
ALTER TABLE collector_settlements ADD COLUMN IF NOT EXISTS vehicle_id uuid REFERENCES vehicles(id);

ALTER TABLE collector_settlements DROP CONSTRAINT IF EXISTS collector_settlements_one_target_check;
ALTER TABLE collector_settlements ADD CONSTRAINT collector_settlements_one_target_check
  CHECK (num_nonnulls(collector_id, shop_id, vehicle_id) = 1);

-- trg_collector_settlement_ledger() generalized: same two-line posting
-- (debit real cash/bank, credit whichever clearing account this row is
-- actually settling), just resolving the clearing account and the
-- human-readable name from whichever of the three ids is set instead of
-- assuming collector_id.
CREATE OR REPLACE FUNCTION trg_collector_settlement_ledger() RETURNS trigger AS $$
DECLARE
  v_clearing_account_id uuid;
  v_owner_name varchar;
  v_particular text;
BEGIN
  IF NEW.collector_id IS NOT NULL THEN
    v_clearing_account_id := ensure_collector_account(NEW.collector_id, NEW.system);
    SELECT full_name INTO v_owner_name FROM admin_users WHERE id = NEW.collector_id;
    v_particular := 'Cash received from collector ' || COALESCE(v_owner_name, 'Unknown');
  ELSIF NEW.shop_id IS NOT NULL THEN
    v_clearing_account_id := ensure_shop_account(NEW.shop_id);
    SELECT name INTO v_owner_name FROM shops WHERE id = NEW.shop_id;
    v_particular := 'Paid out to shop ' || COALESCE(v_owner_name, 'Unknown');
  ELSE
    v_clearing_account_id := ensure_vehicle_account(NEW.vehicle_id);
    SELECT owner_name INTO v_owner_name FROM vehicles WHERE id = NEW.vehicle_id;
    v_particular := 'Paid out to vehicle owner ' || COALESCE(v_owner_name, 'Unknown');
  END IF;
  v_particular := v_particular || CASE WHEN NEW.note IS NOT NULL AND trim(NEW.note) != '' THEN ' — ' || NEW.note ELSE '' END;

  -- A collector settlement is money coming IN (debit real cash/bank,
  -- credit their clearing account down to zero). A shop/vehicle
  -- settlement is money going OUT (the committee paying the owner what's
  -- owed) — the legs are the reverse of that.
  IF NEW.collector_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (NEW.to_account_id, NEW.settled_date, v_particular, NEW.amount_pkr, 0, 'collector_settlement', NEW.id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_clearing_account_id, NEW.settled_date, v_particular, 0, NEW.amount_pkr, 'collector_settlement', NEW.id);
  ELSE
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_clearing_account_id, NEW.settled_date, v_particular, NEW.amount_pkr, 0, 'collector_settlement', NEW.id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (NEW.to_account_id, NEW.settled_date, v_particular, 0, NEW.amount_pkr, 'collector_settlement', NEW.id);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Product expiry reminder — daily pg_cron job, same shape as
--    training_session_reminders(). Flags anything expiring within 7 days
--    that hasn't already been flagged, stamps expiry_reminded_at so it
--    only fires once (trg_shop_product_expiry_reset from migration 388
--    clears that stamp automatically if the expiry date itself changes).
-- ═════════════════════════════════════════════════════════════════════════
INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('shop_product_expiring', 'A shop product is close to its expiry date', false, true)
ON CONFLICT (event_type) DO NOTHING;

CREATE OR REPLACE FUNCTION shop_product_expiry_reminders() RETURNS void AS $$
DECLARE
  r RECORD;
  v_admin RECORD;
BEGIN
  FOR r IN
    SELECT p.id, p.name, p.expiry_date, s.name AS shop_name
    FROM shop_products p JOIN shops s ON s.id = p.shop_id
    WHERE p.is_active AND p.expiry_date IS NOT NULL
      AND p.expiry_date BETWEEN (now() AT TIME ZONE 'Asia/Karachi')::date AND (now() AT TIME ZONE 'Asia/Karachi')::date + 7
      AND p.expiry_reminded_at IS NULL
  LOOP
    FOR v_admin IN
      SELECT id FROM admin_users WHERE is_active = true AND (role = 'super_admin' OR can_manage_parties) AND access_donors_projects
    LOOP
      INSERT INTO notifications (recipient_id, event_type, title, body, link)
      VALUES (v_admin.id, 'shop_product_expiring', 'Product expiring soon',
        r.name || ' (' || r.shop_name || ') expires ' || to_char(r.expiry_date, 'DD Mon YYYY') || '.', '/admin/shops');
    END LOOP;
    UPDATE shop_products SET expiry_reminded_at = now() WHERE id = r.id;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DO $$
BEGIN
  PERFORM cron.schedule('shop-product-expiry-reminders', '30 4 * * *', 'SELECT shop_product_expiry_reminders()');
  RAISE NOTICE 'pg_cron: shop product expiry reminders run daily at 09:30 PKT';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable — run shop_product_expiry_reminders() by hand. %', SQLERRM;
END $$;
