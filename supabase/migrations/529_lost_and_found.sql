-- Migration 529: Lost & Found -- Phase 1 of the "Village OS" feature set,
-- 2026-09-30. Same shape as job_listings (145_village_job_board.sql):
-- requires a real portal account (not anonymous), contact fields entered
-- on the post itself so a poster can point inquiries anywhere without
-- touching their private profile, self-manage + staff moderation.
CREATE TABLE lost_found_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  type varchar NOT NULL CHECK (type IN ('lost', 'found')),
  item_name varchar NOT NULL,
  description text,
  photo_url text,
  location_text varchar,
  contact_name varchar NOT NULL,
  contact_mobile varchar NOT NULL,
  contact_whatsapp varchar,
  status varchar NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX lost_found_posts_active_idx ON lost_found_posts(type, status) WHERE is_active = true;

ALTER TABLE lost_found_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lost_found_public_read" ON lost_found_posts FOR SELECT
  USING (is_active = true);

CREATE POLICY "lost_found_self_all" ON lost_found_posts FOR ALL TO authenticated
  USING (portal_user_id = current_portal_user_id())
  WITH CHECK (portal_user_id = current_portal_user_id());
CREATE POLICY "lost_found_staff_read" ON lost_found_posts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));
CREATE POLICY "lost_found_staff_moderate" ON lost_found_posts FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));
