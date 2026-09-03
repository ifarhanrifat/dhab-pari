-- Migration 420: reference data for the "Village Portal Marketplace"
-- expansion (design handoff studied in full — Village Portal v2.dc.html
-- + its CLAUDE_CODE_HANDOFF.md spec). Two new lookup tables everything
-- downstream keys off of:
--
--   cities          — a fixed village→city distance, the single source
--                      of truth for every km-based fare formula in the
--                      spec (adda seat fare already has its own per-adda
--                      fare; this is for the NEW pro-service/loading/
--                      dispatch formulas, which are destination-km based,
--                      not per-adda).
--   service_classes — the "Pro service"/"Loading" catalog: a class of
--                      whole-vehicle charter (Car AC, Rickshaw, Suzuki
--                      Dala, ...), each with a base fare + per-km rate.
--                      Booking one doesn't pick a specific vehicle up
--                      front — it broadcasts to whichever vehicles opted
--                      into that class (vehicle_service_offers below),
--                      same acceptance mechanism migration 423's dispatch
--                      system uses for the city-shop "pizza case".
--
-- Seeded from the design mock's own placeholder numbers (28/42/60/78/92 km
-- for Chakwal/Mandra/Talagang/Pindi/Islamabad; the 8 service-class base
-- fares/per-km rates) — these are NOT claimed real committee-approved
-- distances or rates, exactly the same honesty convention already used
-- for addas.fixed_fare_per_seat_pkr (migration 415) and
-- vehicle_commission_pct: an admin screen must let the committee correct
-- every one of these before they're treated as real.

CREATE TABLE IF NOT EXISTS cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar NOT NULL,
  name_ur varchar,
  distance_km decimal NOT NULL CHECK (distance_km > 0),
  is_active boolean NOT NULL DEFAULT true,
  display_order int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE cities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_cities" ON cities FOR SELECT USING (true);
CREATE POLICY "cities_write" ON cities FOR INSERT TO authenticated
  WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "cities_update" ON cities FOR UPDATE TO authenticated
  USING (true) WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "cities_delete" ON cities FOR DELETE TO authenticated
  USING (current_admin_permission('delete_transactions'));

INSERT INTO cities (name, name_ur, distance_km, display_order) VALUES
  ('Chakwal', 'چکوال', 28, 1),
  ('Mandra', 'منڈرہ', 42, 2),
  ('Talagang', 'تلہ گنگ', 60, 3),
  ('Rawalpindi', 'راولپنڈی', 78, 4),
  ('Islamabad', 'اسلام آباد', 92, 5)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS service_classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar NOT NULL,
  name_ur varchar,
  category varchar NOT NULL CHECK (category IN ('passenger', 'loading')),
  capacity_label varchar,
  capacity_label_ur varchar,
  note varchar,
  note_ur varchar,
  base_fare_pkr decimal NOT NULL CHECK (base_fare_pkr >= 0),
  per_km_pkr decimal NOT NULL CHECK (per_km_pkr >= 0),
  is_active boolean NOT NULL DEFAULT true,
  display_order int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE service_classes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_service_classes" ON service_classes FOR SELECT USING (true);
CREATE POLICY "service_classes_write" ON service_classes FOR INSERT TO authenticated
  WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "service_classes_update" ON service_classes FOR UPDATE TO authenticated
  USING (true) WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "service_classes_delete" ON service_classes FOR DELETE TO authenticated
  USING (current_admin_permission('delete_transactions'));

INSERT INTO service_classes (name, name_ur, category, capacity_label, capacity_label_ur, note, note_ur, base_fare_pkr, per_km_pkr, display_order) VALUES
  ('Car — AC', 'کار — اے سی', 'passenger', '4 passengers', '4 مسافر', 'Closed vehicle, room for luggage', 'بند گاڑی، سامان کی جگہ', 500, 33, 1),
  ('Car — Non-AC', 'کار — نان اے سی', 'passenger', '4 passengers', '4 مسافر', 'Cheaper option', 'سستا آپشن', 400, 26, 2),
  ('Suzuki Ravi', 'سوزوکی راوی', 'passenger', '6 passengers', '6 مسافر', 'Family or shared trip', 'فیملی یا مشترکہ سفر', 300, 22, 3),
  ('Carry Dabba', 'کیری ڈبہ', 'passenger', '10 passengers', '10 مسافر', 'Wedding party, group trip', 'بارات، دعوت، گروپ', 400, 25, 4),
  ('Rickshaw', 'رکشہ', 'passenger', '3 passengers', '3 مسافر', 'Short trips', 'قریب کے سفر کے لیے', 150, 16, 5),
  ('Bike', 'بائیک', 'passenger', '1 passenger', '1 مسافر', 'Fastest, solo travel', 'سب سے تیز، اکیلے سفر', 100, 12, 6),
  ('Suzuki Dala', 'سوزوکی ڈالہ', 'loading', 'up to 1 ton', '1 ٹن تک', 'Fodder, cement, furniture', 'بھوسہ، سیمنٹ، فرنیچر', 600, 38, 1),
  ('Loading Rickshaw', 'لوڈنگ رکشہ', 'loading', 'up to 400 kg', '400 کلو تک', 'Small goods, groceries', 'چھوٹا سامان، راشن', 250, 22, 2)
ON CONFLICT DO NOTHING;

-- A vehicle opts into offering one or more service classes for whole-
-- vehicle charter — separate from the adda queue (fixed seat fares,
-- untouched) and separate from vehicle_routes (scheduled seat trips,
-- untouched). Booking a service class broadcasts to every vehicle that's
-- opted in and currently active, same acceptance race the dispatch
-- system (423) uses.
CREATE TABLE IF NOT EXISTS vehicle_service_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  service_class_id uuid NOT NULL REFERENCES service_classes(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE (vehicle_id, service_class_id)
);
CREATE INDEX IF NOT EXISTS vehicle_service_offers_vehicle_id_idx ON vehicle_service_offers(vehicle_id);
CREATE INDEX IF NOT EXISTS vehicle_service_offers_service_class_id_idx ON vehicle_service_offers(service_class_id) WHERE is_active;

ALTER TABLE vehicle_service_offers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_vehicle_service_offers" ON vehicle_service_offers FOR SELECT USING (true);
CREATE POLICY "vehicle_service_offers_write" ON vehicle_service_offers FOR INSERT TO authenticated
  WITH CHECK (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id())
  );
CREATE POLICY "vehicle_service_offers_update" ON vehicle_service_offers FOR UPDATE TO authenticated
  USING (true) WITH CHECK (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id())
  );
CREATE POLICY "vehicle_service_offers_delete" ON vehicle_service_offers FOR DELETE TO authenticated
  USING (
    current_admin_permission('delete_transactions')
    OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id())
  );

-- The "does this vehicle do out-of-village fetch/delivery at all" switch
-- — independent of adda participation and independent of a specific
-- service-class offer (a bike with no pro-service listing can still
-- toggle this on and be eligible for city-fetch/dispatch tier 1/2).
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS delivers boolean NOT NULL DEFAULT false;

-- roundTo10 — the spec's single source of truth for every fare formula
-- in this feature set (addaSeatFare/proFare/dispatchTotal all wrap it).
-- A plain SQL function, not duplicated inline in every RPC that needs it.
CREATE OR REPLACE FUNCTION round_to_10(n decimal) RETURNS decimal AS $$
  SELECT round(n / 10.0) * 10;
$$ LANGUAGE sql IMMUTABLE;

-- proFare(city_km, base, per_km, is_return) = roundTo10((base + km*perKm) * (is_return ? 1.85 : 1))
CREATE OR REPLACE FUNCTION pro_service_fare(p_city_km decimal, p_base_fare_pkr decimal, p_per_km_pkr decimal, p_is_return boolean)
RETURNS decimal AS $$
  SELECT round_to_10((p_base_fare_pkr + p_city_km * p_per_km_pkr) * (CASE WHEN p_is_return THEN 1.85 ELSE 1 END));
$$ LANGUAGE sql IMMUTABLE;
