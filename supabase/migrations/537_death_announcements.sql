-- Migration 537: Death/Funeral Announcements -- next Phase 3 item,
-- 2026-09-30. Modeled directly on help_requests (531) + the approval gate
-- (533): a portal user (typically family) submits, a committee member
-- approves, and approving broadcasts it the same way approving a help
-- request does -- via create_appeal() (migrations 195/196/199/200) so it
-- reaches the news ticker and every portal user's notifications. A death
-- announcement is at least as time-critical as a help request, so it
-- gets the same p_severity = 'emergency' tier and the same distinct
-- urgent notification sound for admins (event_type below is picked up by
-- the existing NotificationBell branch once added client-side).
CREATE TABLE death_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  deceased_name varchar NOT NULL,
  deceased_name_ur varchar,
  age int,
  gender varchar CHECK (gender IN ('male', 'female')),
  location_text varchar,
  death_datetime timestamptz,
  funeral_datetime timestamptz,
  burial_location varchar,
  family_contact_name varchar NOT NULL,
  family_contact_mobile varchar NOT NULL,
  message text,
  is_active boolean NOT NULL DEFAULT false,
  moderation_status varchar NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
  reviewed_by uuid REFERENCES admin_users(id),
  reviewed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX death_announcements_created_idx ON death_announcements(created_at DESC);

ALTER TABLE death_announcements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "death_announcements_public_read" ON death_announcements FOR SELECT
  USING (is_active = true);
CREATE POLICY "death_announcements_self_read" ON death_announcements FOR SELECT TO authenticated
  USING (portal_user_id = current_portal_user_id());
CREATE POLICY "death_announcements_self_insert" ON death_announcements FOR INSERT TO authenticated
  WITH CHECK (portal_user_id = current_portal_user_id());
CREATE POLICY "death_announcements_staff_all" ON death_announcements FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));

CREATE TRIGGER death_announcements_force_pending BEFORE INSERT ON death_announcements
  FOR EACH ROW EXECUTE FUNCTION force_pending_moderation();

CREATE OR REPLACE FUNCTION notify_admins_death_announcement() RETURNS trigger AS $$
BEGIN
  PERFORM notify_admins_pending_item('death_announcement_pending', 'New death announcement awaiting approval',
    NEW.deceased_name, '/admin/death-announcements');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER death_announcements_notify_admins AFTER INSERT ON death_announcements
  FOR EACH ROW EXECUTE FUNCTION notify_admins_death_announcement();

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('death_announcement_pending', 'A new death announcement is awaiting approval', false, true)
ON CONFLICT (event_type) DO NOTHING;
