-- Migration 563: Agriculture Hub -- 2026-10-02.
--
-- Real ask: expand the Agriculture page (currently just a crop-price
-- board, see 2026-10-01) into a real awareness/directory hub, deliberately
-- scoped down from a much bigger proposal to: crop disease/spray-timing
-- awareness, government scheme info, local help-center contacts, and a
-- village tractors/machinery directory (the last of which reuses the
-- existing Directory feature instead of a new table -- see the admin/
-- public directory.tsx changes in this same commit). All three tables
-- below are plain admin-curated reference content, same shape as
-- crop_prices: public read, staff write, no farmer-submitted data, no
-- forms, no personal records -- explicitly out of scope per the real ask
-- ("we should not add my form etc").

CREATE TABLE ag_disease_guides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crop varchar NOT NULL, crop_ur varchar NOT NULL,
  disease_name varchar NOT NULL, disease_name_ur varchar NOT NULL,
  symptoms text, symptoms_ur text,
  spray_timing text, spray_timing_ur text,
  prevention text, prevention_ur text,
  display_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ag_disease_guides_crop_idx ON ag_disease_guides(crop);

ALTER TABLE ag_disease_guides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ag_disease_guides_public_read" ON ag_disease_guides FOR SELECT USING (is_active = true);
CREATE POLICY "ag_disease_guides_staff_all" ON ag_disease_guides FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));

-- Deliberately free-text eligibility/amount/districts, not normalized --
-- government scheme wording varies too much ("Rs 750,000/tractor", "5
-- acres or more") to force into numeric columns, and this is read-only
-- reference content, never computed against.
CREATE TABLE ag_schemes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title varchar NOT NULL, title_ur varchar NOT NULL,
  description text, description_ur text,
  department varchar,
  eligibility text, eligibility_ur text,
  amount varchar,
  districts varchar,
  status varchar NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'upcoming', 'closed')),
  deadline date,
  official_url text,
  -- The whole point, per the real ask: never let a villager act on
  -- information that might be stale. Admin updates this every time they
  -- re-check the source, regardless of whether anything else changed.
  last_verified_at date NOT NULL DEFAULT current_date,
  display_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_by_admin_user_id uuid REFERENCES admin_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ag_schemes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ag_schemes_public_read" ON ag_schemes FOR SELECT USING (is_active = true);
CREATE POLICY "ag_schemes_staff_all" ON ag_schemes FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));

CREATE TABLE ag_help_centers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar NOT NULL, name_ur varchar NOT NULL,
  what_they_offer text, what_they_offer_ur text,
  phone varchar, address text, address_ur text,
  display_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ag_help_centers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ag_help_centers_public_read" ON ag_help_centers FOR SELECT USING (is_active = true);
CREATE POLICY "ag_help_centers_staff_all" ON ag_help_centers FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));
