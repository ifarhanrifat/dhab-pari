-- Migration 545: Agriculture page -- crop/commodity price reference board,
-- 2026-10-01. Scoped down from the original brainstorm on purpose: an
-- actual farming marketplace (buy/sell produce, livestock) already exists
-- via classified_listings' 'animal'/'land' fields (534) -- this doesn't
-- duplicate that. What's genuinely new here is a simple, admin-maintained
-- reference table of local crop/input prices, since that's information a
-- farmer can't get from Buy & Sell or anywhere else in this app.
CREATE TABLE crop_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commodity varchar NOT NULL,
  commodity_ur varchar,
  price numeric(10,2) NOT NULL,
  unit varchar NOT NULL DEFAULT 'per_maund' CHECK (unit IN ('per_maund', 'per_kg', 'per_40kg', 'per_bag', 'other')),
  category varchar NOT NULL DEFAULT 'crop' CHECK (category IN ('crop', 'input', 'livestock_feed')),
  display_order int DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  updated_by uuid REFERENCES admin_users(id)
);

ALTER TABLE crop_prices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "crop_prices_public_read" ON crop_prices FOR SELECT USING (true);
CREATE POLICY "crop_prices_staff_all" ON crop_prices FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));
