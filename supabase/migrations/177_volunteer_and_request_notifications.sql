-- Migration 177: close the notification gap on both sides of Get Involved.
--
-- Until now a volunteer offer or publisher-role request landed in `suggestions`
-- and nothing rang: no staff notification on arrival, and no portal
-- notification when staff replied. The admin reply wrote to notifications_log
-- (the WhatsApp outbox, which nothing sends from), so the person only saw the
-- answer if they happened to revisit the page.
--
-- Both notification tables already exist and both bells already work — nothing
-- was writing to them. Done as triggers, not app code, so a reply sent from any
-- screen (or a status change made directly) still notifies.

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('volunteer_offer', 'Someone offers to volunteer', false, true),
  ('role_request', 'Someone requests the Publisher role', false, true),
  ('volunteer_signup', 'Someone signs up for a project', false, true)
ON CONFLICT (event_type) DO NOTHING;

-- ── Staff bell: a new volunteer offer or role request ────────────────────
-- Goes to admins and super_admins: they are the only roles that can grant a
-- role or accept a volunteer, so notifying anyone else is noise.
CREATE OR REPLACE FUNCTION trg_suggestion_notify_staff() RETURNS trigger AS $$
DECLARE
  v_enabled boolean;
  v_title varchar;
  r record;
BEGIN
  IF NEW.type NOT IN ('volunteer', 'role_request') THEN RETURN NEW; END IF;

  SELECT popup_enabled INTO v_enabled FROM notification_preferences
   WHERE event_type = CASE NEW.type WHEN 'volunteer' THEN 'volunteer_offer' ELSE 'role_request' END;
  IF v_enabled IS DISTINCT FROM false THEN
    v_title := CASE NEW.type
      WHEN 'volunteer' THEN 'Volunteer offer from ' || COALESCE(NEW.name, 'a resident')
      ELSE 'Publisher role request from ' || COALESCE(NEW.name, 'a resident') END;
    FOR r IN SELECT id FROM admin_users WHERE is_active = true AND role IN ('super_admin', 'admin') LOOP
      INSERT INTO notifications (recipient_id, event_type, title, body, link)
      VALUES (r.id, CASE NEW.type WHEN 'volunteer' THEN 'volunteer_offer' ELSE 'role_request' END,
              v_title, left(COALESCE(NEW.message, ''), 140), '/admin/suggestions');
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS suggestion_notify_staff_trigger ON suggestions;
CREATE TRIGGER suggestion_notify_staff_trigger AFTER INSERT ON suggestions
  FOR EACH ROW EXECUTE FUNCTION trg_suggestion_notify_staff();

-- ── Portal bell: staff replied ───────────────────────────────────────────
-- Fires only when admin_notes actually gained content, so flipping a status
-- without writing anything doesn't claim "we replied".
CREATE OR REPLACE FUNCTION trg_suggestion_notify_portal() RETURNS trigger AS $$
BEGIN
  IF NEW.portal_user_id IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(NEW.admin_notes, '') = COALESCE(OLD.admin_notes, '') THEN RETURN NEW; END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (
    NEW.portal_user_id, 'suggestion_reply',
    CASE NEW.type
      WHEN 'volunteer' THEN 'Reply to your volunteer offer'
      WHEN 'role_request' THEN 'Reply to your Publisher role request'
      ELSE 'The committee replied to you' END,
    left(NEW.admin_notes, 300),
    CASE WHEN NEW.type IN ('volunteer', 'role_request') THEN '/portal/get-involved' ELSE '/portal/suggestions' END
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS suggestion_notify_portal_trigger ON suggestions;
CREATE TRIGGER suggestion_notify_portal_trigger AFTER UPDATE ON suggestions
  FOR EACH ROW EXECUTE FUNCTION trg_suggestion_notify_portal();

-- ── Project signups, both directions ─────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_volunteer_notify_staff() RETURNS trigger AS $$
DECLARE
  v_enabled boolean;
  v_name varchar;
  v_project varchar;
  r record;
BEGIN
  SELECT popup_enabled INTO v_enabled FROM notification_preferences WHERE event_type = 'volunteer_signup';
  IF v_enabled IS DISTINCT FROM false THEN
    SELECT full_name INTO v_name FROM portal_users WHERE id = NEW.portal_user_id;
    SELECT title INTO v_project FROM projects WHERE id = NEW.project_id;
    FOR r IN SELECT id FROM admin_users WHERE is_active = true AND role IN ('super_admin', 'admin') LOOP
      INSERT INTO notifications (recipient_id, event_type, title, body, link)
      VALUES (r.id, 'volunteer_signup',
              COALESCE(v_name, 'A resident') || ' signed up to volunteer',
              COALESCE('For: ' || v_project, 'No specific project'), '/admin/volunteers');
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS volunteer_notify_staff_trigger ON volunteers;
CREATE TRIGGER volunteer_notify_staff_trigger AFTER INSERT ON volunteers
  FOR EACH ROW EXECUTE FUNCTION trg_volunteer_notify_staff();

-- Being accepted onto a project is the moment a volunteer most needs telling.
CREATE OR REPLACE FUNCTION trg_volunteer_notify_portal() RETURNS trigger AS $$
DECLARE
  v_project varchar;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  SELECT title INTO v_project FROM projects WHERE id = NEW.project_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (
    NEW.portal_user_id, 'volunteer_status',
    CASE NEW.status
      WHEN 'assigned' THEN 'You have been accepted as a volunteer'
      WHEN 'completed' THEN 'Thank you for volunteering'
      ELSE 'Your volunteering status changed' END,
    CASE NEW.status
      WHEN 'assigned' THEN COALESCE('You are now part of: ' || v_project, 'The committee has accepted your offer to help.')
      WHEN 'completed' THEN COALESCE('The work on ' || v_project || ' is complete. The committee thanks you for your help.',
                                     'The committee thanks you for your help.')
      ELSE NULL END,
    '/portal/my-volunteering'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS volunteer_notify_portal_trigger ON volunteers;
CREATE TRIGGER volunteer_notify_portal_trigger AFTER UPDATE ON volunteers
  FOR EACH ROW EXECUTE FUNCTION trg_volunteer_notify_portal();
