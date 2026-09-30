-- Migration 533: nothing a portal user posts goes public without staff
-- approval first -- real direction, 2026-09-30, after shipping Phase 1/2
-- of the "Village OS" feature set with the opposite (no-pre-approval)
-- convention borrowed from job_listings (migration 145). That was fine
-- for a trade-worker directory; it is not fine for Lost & Found, Buy &
-- Sell, Village Problems, or (especially) "Need Help" requests, where an
-- unmoderated post reaches the whole village immediately.
--
-- Matches the exact approval-gate shape this codebase already uses for
-- donor blog submissions (news_posts, migration 312) and Talent Showcase
-- (talent_showcases, migration 333): a moderation_status column
-- (pending/approved/rejected) plus an is_active/is_published boolean,
-- both force-set by a BEFORE INSERT trigger so "the trigger, not the
-- client, decides the row's real status" (talent_showcases' own words) --
-- a client can't insert a row and simply claim it's already approved.
--
-- job_listings itself is untouched -- that's a prior, separate committee
-- decision (its own migration's comment: "no pre-approval queue, low
-- friction by design"), not something this session introduced.

CREATE OR REPLACE FUNCTION force_pending_moderation() RETURNS trigger AS $$
BEGIN
  NEW.moderation_status := 'pending';
  NEW.is_active := false;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- lost_found_posts and classified_listings already have is_active
-- (defaulted true) -- just add the moderation columns and flip the
-- default, the trigger enforces the rest regardless of default.
ALTER TABLE lost_found_posts
  ADD COLUMN moderation_status varchar NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN reviewed_by uuid REFERENCES admin_users(id),
  ADD COLUMN reviewed_at timestamptz;
ALTER TABLE lost_found_posts ALTER COLUMN is_active SET DEFAULT false;
CREATE TRIGGER lost_found_force_pending BEFORE INSERT ON lost_found_posts
  FOR EACH ROW EXECUTE FUNCTION force_pending_moderation();

ALTER TABLE classified_listings
  ADD COLUMN moderation_status varchar NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN reviewed_by uuid REFERENCES admin_users(id),
  ADD COLUMN reviewed_at timestamptz;
ALTER TABLE classified_listings ALTER COLUMN is_active SET DEFAULT false;
CREATE TRIGGER classified_listings_force_pending BEFORE INSERT ON classified_listings
  FOR EACH ROW EXECUTE FUNCTION force_pending_moderation();

-- civic_reports and help_requests never had an is_active column at all --
-- their public-read policy was unconditionally `USING (true)`, live the
-- instant a row existed. Add the same gate, and a self-read policy so a
-- submitter can still see their own pending/rejected row (previously
-- "public read with no filter" was silently doing that job too).
ALTER TABLE civic_reports
  ADD COLUMN is_active boolean NOT NULL DEFAULT false,
  ADD COLUMN moderation_status varchar NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN reviewed_by uuid REFERENCES admin_users(id),
  ADD COLUMN reviewed_at timestamptz;
DROP POLICY "civic_reports_public_read" ON civic_reports;
CREATE POLICY "civic_reports_public_read" ON civic_reports FOR SELECT USING (is_active = true);
CREATE POLICY "civic_reports_self_read" ON civic_reports FOR SELECT TO authenticated
  USING (portal_user_id = current_portal_user_id());
CREATE TRIGGER civic_reports_force_pending BEFORE INSERT ON civic_reports
  FOR EACH ROW EXECUTE FUNCTION force_pending_moderation();

ALTER TABLE help_requests
  ADD COLUMN is_active boolean NOT NULL DEFAULT false,
  ADD COLUMN moderation_status varchar NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN reviewed_by uuid REFERENCES admin_users(id),
  ADD COLUMN reviewed_at timestamptz;
DROP POLICY "help_requests_public_read" ON help_requests;
CREATE POLICY "help_requests_public_read" ON help_requests FOR SELECT USING (is_active = true);
CREATE POLICY "help_requests_self_read" ON help_requests FOR SELECT TO authenticated
  USING (portal_user_id = current_portal_user_id());
CREATE TRIGGER help_requests_force_pending BEFORE INSERT ON help_requests
  FOR EACH ROW EXECUTE FUNCTION force_pending_moderation();

-- Staff need to actually notice a pending item to approve it -- same
-- "loop active admins, insert one notifications row each" pattern
-- already used for new shop orders (472_shop_delivery_ring.sql). A help
-- request gets its own event_type so the admin panel can play a distinct,
-- more urgent sound for it specifically (wired client-side) instead of
-- the generic chime every other notification uses.
CREATE OR REPLACE FUNCTION notify_admins_pending_item(p_event_type varchar, p_title text, p_body text, p_link varchar)
RETURNS void AS $$
DECLARE
  v_admin RECORD;
BEGIN
  FOR v_admin IN SELECT id FROM admin_users WHERE is_active = true LOOP
    INSERT INTO notifications (recipient_id, event_type, title, body, link)
    VALUES (v_admin.id, p_event_type, p_title, p_body, p_link);
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION notify_admins_help_request() RETURNS trigger AS $$
BEGIN
  PERFORM notify_admins_pending_item('help_request_pending', 'New "Need Help" request awaiting approval',
    NEW.category || ': ' || left(NEW.description, 100), '/admin/help-requests');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER help_requests_notify_admins AFTER INSERT ON help_requests
  FOR EACH ROW EXECUTE FUNCTION notify_admins_help_request();

CREATE OR REPLACE FUNCTION notify_admins_civic_report() RETURNS trigger AS $$
BEGIN
  PERFORM notify_admins_pending_item('civic_report_pending', 'New village problem report awaiting approval',
    NEW.title, '/admin/civic-reports');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER civic_reports_notify_admins AFTER INSERT ON civic_reports
  FOR EACH ROW EXECUTE FUNCTION notify_admins_civic_report();

CREATE OR REPLACE FUNCTION notify_admins_lost_found() RETURNS trigger AS $$
BEGIN
  PERFORM notify_admins_pending_item('lost_found_pending', 'New Lost & Found post awaiting approval',
    NEW.item_name, '/admin/lost-found');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER lost_found_notify_admins AFTER INSERT ON lost_found_posts
  FOR EACH ROW EXECUTE FUNCTION notify_admins_lost_found();

CREATE OR REPLACE FUNCTION notify_admins_classified() RETURNS trigger AS $$
BEGIN
  PERFORM notify_admins_pending_item('classified_pending', 'New Buy & Sell listing awaiting approval',
    NEW.title, '/admin/classifieds');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER classified_listings_notify_admins AFTER INSERT ON classified_listings
  FOR EACH ROW EXECUTE FUNCTION notify_admins_classified();

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('help_request_pending', 'A new "Need Help" request is awaiting approval', false, true),
  ('civic_report_pending', 'A new village problem report is awaiting approval', false, true),
  ('lost_found_pending', 'A new Lost & Found post is awaiting approval', false, true),
  ('classified_pending', 'A new Buy & Sell listing is awaiting approval', false, true)
ON CONFLICT (event_type) DO NOTHING;
