-- Migration 145: Village Job Board (Part 2, per your direction — build this
-- one first). A public, searchable directory of people offering a trade or
-- labor service (plumber, mason, electrician, laborer, etc.) so anyone can
-- find and contact them directly — the deliberate opposite of the Blood
-- Donor registry's privacy stance (migration 124): here the whole point is
-- public visibility, and the poster is knowingly publishing their own
-- contact info, same as any marketplace listing.
--
-- Contact fields are denormalized onto the listing itself (not joined from
-- portal_users, which stays private) — the poster explicitly enters/confirms
-- the number they want inquiries to go to when they post, and can point it
-- elsewhere later without touching their private profile.

CREATE TABLE IF NOT EXISTS job_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  category varchar NOT NULL CHECK (category IN (
    'plumber', 'electrician', 'mason', 'carpenter', 'painter', 'laborer',
    'driver', 'tailor', 'cook', 'tutor', 'mechanic', 'other'
  )),
  headline varchar NOT NULL,
  description text,
  sector varchar,
  contact_name varchar NOT NULL,
  contact_mobile varchar NOT NULL,
  contact_whatsapp varchar,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_listings_active_idx ON job_listings(category) WHERE is_active = true;

ALTER TABLE job_listings ENABLE ROW LEVEL SECURITY;

-- Public directory — the entire point of this table, unlike everything
-- else portal-identity-linked in this app.
CREATE POLICY "job_listings_public_read" ON job_listings FOR SELECT
  USING (is_active = true);

-- Self-manage (create/edit/pause/reactivate your own listings) + staff can
-- see and deactivate any listing (committee-wide moderation lever, same
-- "any active admin_users row" gate as blood_donors — not system-scoped).
CREATE POLICY "job_listings_self_all" ON job_listings FOR ALL TO authenticated
  USING (portal_user_id = current_portal_user_id())
  WITH CHECK (portal_user_id = current_portal_user_id());
CREATE POLICY "job_listings_staff_read" ON job_listings FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));
CREATE POLICY "job_listings_staff_moderate" ON job_listings FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));
