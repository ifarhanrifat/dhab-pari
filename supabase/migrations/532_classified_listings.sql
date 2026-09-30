-- Migration 532: Buy & Sell Marketplace (classifieds) -- Phase 2 of the
-- "Village OS" feature set, 2026-09-30. Named `classified_listings`, and
-- routed at /classifieds, deliberately distinct from the existing
-- `/marketplace` (vehicles/shops/dispatch -- a whole separate booking
-- system) -- this is the OLX-style "villager sells a used phone/animal/
-- land to another villager" listing the vision doc asked for, which
-- nothing in the existing marketplace covers.
--
-- Same public/self-manage/staff-moderate shape as job_listings (145) and
-- lost_found_posts (529): no pre-approval queue (low friction by design),
-- staff can take a listing down after the fact via is_active.
CREATE TABLE classified_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  category varchar NOT NULL CHECK (category IN
    ('electronics', 'vehicles', 'animals', 'furniture', 'land', 'agriculture', 'household', 'other')),
  title varchar NOT NULL,
  description text,
  price_pkr numeric,
  photo_url text,
  location_text varchar,
  contact_name varchar NOT NULL,
  contact_mobile varchar NOT NULL,
  contact_whatsapp varchar,
  status varchar NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX classified_listings_browse_idx ON classified_listings(category, status) WHERE is_active = true;

ALTER TABLE classified_listings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "classified_listings_public_read" ON classified_listings FOR SELECT
  USING (is_active = true);

CREATE POLICY "classified_listings_self_all" ON classified_listings FOR ALL TO authenticated
  USING (portal_user_id = current_portal_user_id())
  WITH CHECK (portal_user_id = current_portal_user_id());
CREATE POLICY "classified_listings_staff_read" ON classified_listings FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));
CREATE POLICY "classified_listings_staff_moderate" ON classified_listings FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));
