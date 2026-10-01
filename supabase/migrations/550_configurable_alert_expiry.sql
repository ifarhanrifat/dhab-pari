-- Migration 550: admin-configurable default expiry per alert type,
-- 2026-10-01. The hardcoded hours from 549 (emergency 24h, important 3
-- days, appeal 7 days, weather 2 days) move into a real settings table
-- staff can edit, plus finer-grained control for Help Requests and Death
-- Announcements specifically rather than lumping them into the generic
-- "emergency" bucket.
--
-- Plain news_ticker items (the calm belt's own admin page, /admin/ticker)
-- are deliberately NOT included here -- that page's own existing comment
-- is explicit that turning a message on is "a publisher/admin decision —
-- it should stay on until a human turns it off again," which is a real,
-- separate design choice already made, not an oversight to fix here.
CREATE TABLE alert_expiry_settings (
  alert_type varchar PRIMARY KEY,
  label varchar NOT NULL,
  label_ur varchar,
  default_hours int NOT NULL CHECK (default_hours > 0),
  updated_at timestamptz DEFAULT now(),
  updated_by uuid REFERENCES admin_users(id)
);

ALTER TABLE alert_expiry_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "alert_expiry_settings_staff_all" ON alert_expiry_settings FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true))
  WITH CHECK (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));

INSERT INTO alert_expiry_settings (alert_type, label, label_ur, default_hours) VALUES
  ('help_request', 'Help Request (Need Help board)', 'مدد کی درخواست', 24),
  ('death_announcement', 'Death Announcement', 'وفات کی اطلاع', 24),
  ('weather_alert', 'Severe Weather Alert', 'موسم کی وارننگ', 48),
  ('chanda_announcement', 'New Chanda launch (calm belt)', 'نیا چندہ اعلان', 168),
  ('emergency_default', 'Other emergency appeals (e.g. blood)', 'دیگر ہنگامی اپیلیں', 24),
  ('important_default', 'Other important announcements', 'دیگر اہم اعلانات', 72),
  ('appeal_default', 'Routine appeals (project/maintenance)', 'معمول کی اپیلیں', 168)
ON CONFLICT (alert_type) DO NOTHING;

CREATE OR REPLACE FUNCTION get_alert_expiry_hours(p_alert_type varchar) RETURNS int AS $$
  SELECT COALESCE((SELECT default_hours FROM alert_expiry_settings WHERE alert_type = p_alert_type), 168);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- create_appeal gains p_alert_type so Help Requests/Death Announcements
-- (and anything else that wants its own configurable timer) can identify
-- themselves specifically; a plain admin-composed appeal leaves it NULL
-- and falls back to its severity's own default row.
CREATE OR REPLACE FUNCTION create_appeal(
  p_kind varchar, p_body_ur text, p_body_en text,
  p_audience varchar DEFAULT 'everyone', p_audience_countries text[] DEFAULT '{}',
  p_is_public boolean DEFAULT true, p_title_ur varchar DEFAULT NULL,
  p_title_en varchar DEFAULT NULL, p_contact_name varchar DEFAULT NULL,
  p_contact_number varchar DEFAULT NULL, p_project_id uuid DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL, p_notify boolean DEFAULT true,
  p_severity varchar DEFAULT 'appeal', p_alert_type varchar DEFAULT NULL
) RETURNS uuid AS $$
DECLARE v_id uuid; v_admin uuid; v_ticker uuid; v_expires_at timestamptz;
BEGIN
  IF (current_admin_permission('manage_parties') IS DISTINCT FROM true)
     AND (current_admin_permission('manage_blood_requests') IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'You do not have permission to post an appeal';
  END IF;
  IF coalesce(trim(p_body_ur), '') = '' OR coalesce(trim(p_body_en), '') = '' THEN
    RAISE EXCEPTION 'An appeal needs wording in both Urdu and English';
  END IF;

  v_admin := current_admin_user_id();
  v_expires_at := COALESCE(
    p_expires_at,
    now() + (get_alert_expiry_hours(COALESCE(p_alert_type, p_severity || '_default')) || ' hours')::interval
  );

  INSERT INTO appeals (kind, severity, title_en, title_ur, body_en, body_ur, audience,
                       audience_countries, is_public, contact_name, contact_number,
                       project_id, expires_at, created_by_admin_user_id)
  VALUES (p_kind, p_severity, p_title_en, p_title_ur, trim(p_body_en), trim(p_body_ur),
          p_audience, coalesce(p_audience_countries, '{}'), p_is_public, p_contact_name,
          p_contact_number, p_project_id, v_expires_at, v_admin)
  RETURNING id INTO v_id;

  IF p_is_public THEN
    INSERT INTO news_ticker (message, message_ur, is_active, display_order, expires_at, is_appeal_mirror)
    VALUES (trim(p_body_en), trim(p_body_ur), true, -100, v_expires_at, true)
    RETURNING id INTO v_ticker;
    UPDATE appeals SET ticker_id = v_ticker WHERE id = v_id;
  END IF;

  IF p_notify THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT a.portal_user_id, 'appeal',
           COALESCE(nullif(trim(coalesce(p_title_ur, '')), ''),
                    nullif(trim(coalesce(p_title_en, '')), ''), 'ایک اپیل'),
           trim(p_body_ur) || chr(10) || trim(p_body_en),
           '/portal'
      FROM appeal_audience_users(p_audience, p_audience_countries) a
      JOIN portal_users u ON u.id = a.portal_user_id
     WHERE p_severity = 'emergency' OR u.notify_general_appeals = true;
  END IF;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION broadcast_weather_alert(p_body_en text, p_body_ur text, p_rain_chance int, p_wind_kph int)
RETURNS uuid AS $$
DECLARE v_id uuid; v_ticker uuid; v_expires_at timestamptz := now() + (get_alert_expiry_hours('weather_alert') || ' hours')::interval;
BEGIN
  INSERT INTO weather_alerts_log (alert_date, rain_chance, wind_kph) VALUES (current_date, p_rain_chance, p_wind_kph)
  ON CONFLICT (alert_date) DO NOTHING;
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO appeals (kind, severity, title_en, title_ur, body_en, body_ur, audience, audience_countries, is_public, expires_at)
  VALUES ('weather', 'important', 'Weather Alert', 'موسم کی وارننگ', p_body_en, p_body_ur, 'everyone', '{}', true, v_expires_at)
  RETURNING id INTO v_id;

  INSERT INTO news_ticker (message, message_ur, is_active, display_order, expires_at, is_appeal_mirror)
  VALUES (p_body_en, p_body_ur, true, -100, v_expires_at, true)
  RETURNING id INTO v_ticker;
  UPDATE appeals SET ticker_id = v_ticker WHERE id = v_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT id, 'weather_alert', 'Weather Alert', p_body_ur || chr(10) || p_body_en, '/weather'
  FROM portal_users WHERE is_active = true AND notify_weather_alerts = true;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION notify_ticker_new_chanda() RETURNS trigger AS $$
BEGIN
  IF NEW.is_active THEN
    INSERT INTO news_ticker (message, message_ur, is_active, display_order, expires_at)
    VALUES (
      'New Chanda started: ' || NEW.title || ' — see dhabpari.com/chanda',
      'نیا چندہ شروع ہوا: ' || COALESCE(NEW.title_ur, NEW.title) || ' — دیکھیں dhabpari.com/chanda',
      true, -50, now() + (get_alert_expiry_hours('chanda_announcement') || ' hours')::interval
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
