-- Migration 388: Marketplace phase 1 — schema for shops (products, sold for
-- pickup or delivery) and vehicles (routes, booked by the seat). Both are
-- staff-listed, not self-service (a shop/vehicle owner asks the committee to
-- list them, same as a donor being entered by an accountant) — customers
-- (portal users) browse and place their own orders/bookings, phases 3-4.
--
-- Every clearing account here follows ensure_project_account()/
-- trg_project_ensure_account (118/358) exactly: a new account_headers
-- group, a nullable FK + partial unique index on accounts, a find-or-create
-- function, and an AFTER INSERT trigger so the account exists the moment
-- the listing does, regardless of which screen created it.

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Chart of accounts: two new clearing groups + the commission income
--    account itself. DP-4001/4002/4020 already taken; 4050 leaves room.
-- ═════════════════════════════════════════════════════════════════════════
INSERT INTO account_headers (system, code, label, code_prefix, display_order, is_system) VALUES
  ('donors_projects', 'shop', 'Shop Owners', 'DP-SHP', 11, true),
  ('donors_projects', 'vehicle_owner', 'Vehicle Owners', 'DP-VEH', 12, true)
ON CONFLICT (system, code) DO NOTHING;

INSERT INTO accounts (code, name, name_ur, type, system, description, is_protected) VALUES
  ('DP-4050', 'Marketplace Commission Income', 'مارکیٹ پلیس کمیشن آمدنی', 'income', 'donors_projects',
   'The committee''s cut of every confirmed shop order and vehicle ride booking', true)
ON CONFLICT (code, system) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Shops
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS shops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar NOT NULL,
  name_ur varchar,
  description text,
  description_ur text,
  owner_name varchar,
  owner_mobile varchar,
  owner_whatsapp varchar,
  location varchar,
  location_ur varchar,
  -- Only a delivery-enabled shop can receive an online order at all — a
  -- shop that isn't still shows up in search (price comparison still
  -- works), just with no buy button, per place_shop_order()'s own guard
  -- in the next migration.
  delivery_enabled boolean NOT NULL DEFAULT false,
  status varchar NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS shop_id uuid REFERENCES shops(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_shop_id_key ON accounts(shop_id) WHERE shop_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ensure_shop_account(p_shop_id uuid) RETURNS uuid AS $$
DECLARE
  v_account_id uuid;
  v_name varchar;
BEGIN
  SELECT id INTO v_account_id FROM accounts WHERE shop_id = p_shop_id;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;
  SELECT name INTO v_name FROM shops WHERE id = p_shop_id;
  INSERT INTO accounts (code, name, type, system, shop_id, opening_balance)
  VALUES ('SHP-' || substr(replace(p_shop_id::text, '-', ''), 1, 8), v_name, 'shop', 'donors_projects', p_shop_id, 0)
  RETURNING id INTO v_account_id;
  RETURN v_account_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION trg_shop_ensure_account() RETURNS trigger AS $$
BEGIN
  PERFORM ensure_shop_account(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS shop_ensure_account_trigger ON shops;
CREATE TRIGGER shop_ensure_account_trigger AFTER INSERT ON shops
  FOR EACH ROW EXECUTE FUNCTION trg_shop_ensure_account();

ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_shops" ON shops FOR SELECT USING (true);
CREATE POLICY "shops_write" ON shops FOR INSERT TO authenticated
  WITH CHECK (can_access_system('donors_projects') AND current_admin_permission('manage_parties'));
CREATE POLICY "shops_update" ON shops FOR UPDATE TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects') AND current_admin_permission('manage_parties'));
CREATE POLICY "shops_delete" ON shops FOR DELETE TO authenticated
  USING (can_access_system('donors_projects') AND current_admin_permission('delete_transactions'));

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Shop products — a plain stock count (no purchase-bill/COGS tracking;
--    this isn't the water-billing inventory model, just "how many left"),
--    plus an optional expiry date for the phase-6 reminder cron.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS shop_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name varchar NOT NULL,
  name_ur varchar,
  description text,
  description_ur text,
  unit_price_pkr decimal NOT NULL CHECK (unit_price_pkr >= 0),
  quantity_on_hand decimal NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  expiry_date date,
  -- Stamped by the reminder cron (phase 6) so it fires once per product,
  -- not once a day for every day it's within the warning window. Cleared
  -- if the expiry date itself changes, so an admin correcting/extending it
  -- gets a fresh warning cycle rather than permanent silence.
  expiry_reminded_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shop_products_shop_id_idx ON shop_products(shop_id);
CREATE INDEX IF NOT EXISTS shop_products_expiry_idx ON shop_products(expiry_date) WHERE expiry_date IS NOT NULL;

ALTER TABLE shop_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_shop_products" ON shop_products FOR SELECT USING (true);
CREATE POLICY "shop_products_write" ON shop_products FOR INSERT TO authenticated
  WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "shop_products_update" ON shop_products FOR UPDATE TO authenticated
  USING (true) WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "shop_products_delete" ON shop_products FOR DELETE TO authenticated
  USING (current_admin_permission('delete_transactions'));

CREATE OR REPLACE FUNCTION trg_shop_product_expiry_reset() RETURNS trigger AS $$
BEGIN
  IF NEW.expiry_date IS DISTINCT FROM OLD.expiry_date THEN
    NEW.expiry_reminded_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shop_product_expiry_reset_trigger ON shop_products;
CREATE TRIGGER shop_product_expiry_reset_trigger BEFORE UPDATE ON shop_products
  FOR EACH ROW EXECUTE FUNCTION trg_shop_product_expiry_reset();

-- ═════════════════════════════════════════════════════════════════════════
-- 4. Product photos — identical shape to project_media (383's is_cover
--    addition included from the start, not bolted on later).
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS product_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  url text NOT NULL,
  caption text,
  is_cover boolean NOT NULL DEFAULT false,
  display_order int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS product_media_one_cover_per_product
  ON product_media (product_id) WHERE is_cover;

ALTER TABLE product_media ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_product_media" ON product_media FOR SELECT USING (true);
CREATE POLICY "product_media_write" ON product_media FOR INSERT TO authenticated
  WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "product_media_update" ON product_media FOR UPDATE TO authenticated
  USING (true) WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "product_media_delete" ON product_media FOR DELETE TO authenticated
  USING (current_admin_permission('manage_parties'));

-- ═════════════════════════════════════════════════════════════════════════
-- 5. Vehicles — the physical vehicle + its owner/driver. A vehicle's own
--    clearing account (not per-route) since one driver/vehicle can run
--    several routes but gets paid out as one person.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_name varchar NOT NULL,
  owner_mobile varchar,
  owner_whatsapp varchar,
  vehicle_type varchar NOT NULL,
  vehicle_number varchar,
  total_seats int NOT NULL CHECK (total_seats > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS vehicle_id uuid REFERENCES vehicles(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_vehicle_id_key ON accounts(vehicle_id) WHERE vehicle_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ensure_vehicle_account(p_vehicle_id uuid) RETURNS uuid AS $$
DECLARE
  v_account_id uuid;
  v_name varchar;
BEGIN
  SELECT id INTO v_account_id FROM accounts WHERE vehicle_id = p_vehicle_id;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;
  SELECT owner_name INTO v_name FROM vehicles WHERE id = p_vehicle_id;
  INSERT INTO accounts (code, name, type, system, vehicle_id, opening_balance)
  VALUES ('VEH-' || substr(replace(p_vehicle_id::text, '-', ''), 1, 8), v_name, 'vehicle_owner', 'donors_projects', p_vehicle_id, 0)
  RETURNING id INTO v_account_id;
  RETURN v_account_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION trg_vehicle_ensure_account() RETURNS trigger AS $$
BEGIN
  PERFORM ensure_vehicle_account(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS vehicle_ensure_account_trigger ON vehicles;
CREATE TRIGGER vehicle_ensure_account_trigger AFTER INSERT ON vehicles
  FOR EACH ROW EXECUTE FUNCTION trg_vehicle_ensure_account();

ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_vehicles" ON vehicles FOR SELECT USING (true);
CREATE POLICY "vehicles_write" ON vehicles FOR INSERT TO authenticated
  WITH CHECK (can_access_system('donors_projects') AND current_admin_permission('manage_parties'));
CREATE POLICY "vehicles_update" ON vehicles FOR UPDATE TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects') AND current_admin_permission('manage_parties'));
CREATE POLICY "vehicles_delete" ON vehicles FOR DELETE TO authenticated
  USING (can_access_system('donors_projects') AND current_admin_permission('delete_transactions'));

-- ═════════════════════════════════════════════════════════════════════════
-- 6. Vehicle routes — a recurring schedule (which days it runs), not a
--    calendar of individual trips. Seat availability for any given travel
--    date is computed live off ride_bookings in the next migration, the
--    same way training_batches_for_join() computes spots_left — no trip
--    rows to pre-generate, no cron needed just to keep a calendar filled.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vehicle_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  origin varchar NOT NULL,
  origin_ur varchar,
  destination varchar NOT NULL,
  destination_ur varchar,
  classification varchar NOT NULL CHECK (classification IN ('intercity', 'out_of_city')),
  fare_per_seat_pkr decimal NOT NULL CHECK (fare_per_seat_pkr >= 0),
  departure_time time,
  -- 0=Sun..6=Sat, same convention as training_batches.session_days.
  days_of_week int[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vehicle_routes_vehicle_id_idx ON vehicle_routes(vehicle_id);

ALTER TABLE vehicle_routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_vehicle_routes" ON vehicle_routes FOR SELECT USING (true);
CREATE POLICY "vehicle_routes_write" ON vehicle_routes FOR INSERT TO authenticated
  WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "vehicle_routes_update" ON vehicle_routes FOR UPDATE TO authenticated
  USING (true) WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "vehicle_routes_delete" ON vehicle_routes FOR DELETE TO authenticated
  USING (current_admin_permission('delete_transactions'));

-- ═════════════════════════════════════════════════════════════════════════
-- 7. Route photos — same shape as product_media.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vehicle_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  url text NOT NULL,
  caption text,
  is_cover boolean NOT NULL DEFAULT false,
  display_order int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_media_one_cover_per_vehicle
  ON vehicle_media (vehicle_id) WHERE is_cover;

ALTER TABLE vehicle_media ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_vehicle_media" ON vehicle_media FOR SELECT USING (true);
CREATE POLICY "vehicle_media_write" ON vehicle_media FOR INSERT TO authenticated
  WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "vehicle_media_update" ON vehicle_media FOR UPDATE TO authenticated
  USING (true) WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "vehicle_media_delete" ON vehicle_media FOR DELETE TO authenticated
  USING (current_admin_permission('manage_parties'));

-- ═════════════════════════════════════════════════════════════════════════
-- 8. Commission settings — shops get one rate, vehicles get two (phase 3
--    reads these; nothing consumes them yet in this migration).
-- ═════════════════════════════════════════════════════════════════════════
INSERT INTO site_settings (key, value, description) VALUES
  ('marketplace_shop_commission_pct', '5', 'Committee''s commission on a confirmed shop order, as a percentage'),
  ('marketplace_intercity_commission_pct', '10', 'Committee''s commission on a confirmed intercity ride booking, as a percentage'),
  ('marketplace_outofcity_commission_pct', '15', 'Committee''s commission on a confirmed out-of-city ride booking, as a percentage')
ON CONFLICT (key) DO NOTHING;
