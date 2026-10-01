-- Migration 546: portal-user notification preferences -- the last open
-- item from the "Village OS" feature set, 2026-10-01.
--
-- Scoped deliberately narrow: the only broadcast categories a villager
-- can mute are weather alerts and non-emergency appeals (project asks,
-- maintenance notices, routine appeals). A true emergency broadcast
-- (blood needed, a Help Request, a Death Announcement -- all posted at
-- severity='emergency') is never muteable here -- this is a safety
-- system, not a newsletter, and a villager who happens to have turned
-- off "appeals" should still be told someone needs blood.
--
-- Direct columns on portal_users rather than a separate preferences
-- table -- there are exactly two toggles, and portal_users already has
-- a working self-update RLS policy (portal_users_update_own) a client
-- can write straight through with no new RPC needed, the same way
-- push_subscriptions already works.
ALTER TABLE portal_users
  ADD COLUMN notify_weather_alerts boolean NOT NULL DEFAULT true,
  ADD COLUMN notify_general_appeals boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION broadcast_weather_alert(p_body_en text, p_body_ur text, p_rain_chance int, p_wind_kph int)
RETURNS uuid AS $$
DECLARE v_id uuid; v_ticker uuid;
BEGIN
  INSERT INTO weather_alerts_log (alert_date, rain_chance, wind_kph) VALUES (current_date, p_rain_chance, p_wind_kph)
  ON CONFLICT (alert_date) DO NOTHING;
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO appeals (kind, severity, title_en, title_ur, body_en, body_ur, audience, audience_countries, is_public)
  VALUES ('weather', 'important', 'Weather Alert', 'موسم کی وارننگ', p_body_en, p_body_ur, 'everyone', '{}', true)
  RETURNING id INTO v_id;

  INSERT INTO news_ticker (message, message_ur, is_active, display_order)
  VALUES (p_body_en, p_body_ur, true, -100)
  RETURNING id INTO v_ticker;
  UPDATE appeals SET ticker_id = v_ticker WHERE id = v_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT id, 'weather_alert', 'Weather Alert', p_body_ur || chr(10) || p_body_en, '/weather'
  FROM portal_users WHERE is_active = true AND notify_weather_alerts = true;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION create_appeal(
  p_kind varchar, p_body_ur text, p_body_en text,
  p_audience varchar DEFAULT 'everyone', p_audience_countries text[] DEFAULT '{}',
  p_is_public boolean DEFAULT true, p_title_ur varchar DEFAULT NULL,
  p_title_en varchar DEFAULT NULL, p_contact_name varchar DEFAULT NULL,
  p_contact_number varchar DEFAULT NULL, p_project_id uuid DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL, p_notify boolean DEFAULT true,
  p_severity varchar DEFAULT 'appeal'
) RETURNS uuid AS $$
DECLARE v_id uuid; v_admin uuid; v_ticker uuid;
BEGIN
  IF (current_admin_permission('manage_parties') IS DISTINCT FROM true)
     AND (current_admin_permission('manage_blood_requests') IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'You do not have permission to post an appeal';
  END IF;
  IF coalesce(trim(p_body_ur), '') = '' OR coalesce(trim(p_body_en), '') = '' THEN
    RAISE EXCEPTION 'An appeal needs wording in both Urdu and English';
  END IF;

  v_admin := current_admin_user_id();

  INSERT INTO appeals (kind, severity, title_en, title_ur, body_en, body_ur, audience,
                       audience_countries, is_public, contact_name, contact_number,
                       project_id, expires_at, created_by_admin_user_id)
  VALUES (p_kind, p_severity, p_title_en, p_title_ur, trim(p_body_en), trim(p_body_ur),
          p_audience, coalesce(p_audience_countries, '{}'), p_is_public, p_contact_name,
          p_contact_number, p_project_id, p_expires_at, v_admin)
  RETURNING id INTO v_id;

  IF p_is_public THEN
    INSERT INTO news_ticker (message, message_ur, is_active, display_order)
    VALUES (trim(p_body_en), trim(p_body_ur), true, -100)
    RETURNING id INTO v_ticker;
    UPDATE appeals SET ticker_id = v_ticker WHERE id = v_id;
  END IF;

  IF p_notify THEN
    -- Emergency severity always reaches everyone in the audience,
    -- regardless of their notify_general_appeals toggle -- see migration
    -- comment above for why.
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
