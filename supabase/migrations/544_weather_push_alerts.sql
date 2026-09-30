-- Migration 544: automated severe-weather push alerts -- the last
-- unbuilt piece of the "Village OS" weather feature, 2026-10-01. The
-- /weather page already shows an on-page banner when the forecast trips
-- rain >=70% or wind >=40 km/h (checked against the next 3 days) -- this
-- is that same check, run twice a day by pg_cron, broadcasting through
-- the exact same appeals/news-ticker/portal_notifications pipeline every
-- other broadcast in this app already uses (create_appeal, 195/196/199).
--
-- Not calling create_appeal() itself: it requires an authenticated admin
-- session (current_admin_permission()), which a scheduled system job has
-- none of. broadcast_weather_alert() is the same insert shape with that
-- gate removed, reachable only via the service-role client from the
-- trusted /api/weather-check route (never granted to anon/authenticated).
ALTER TABLE appeals DROP CONSTRAINT appeals_kind_check;
ALTER TABLE appeals ADD CONSTRAINT appeals_kind_check
  CHECK (kind IN ('blood', 'medical', 'project', 'maintenance', 'weather', 'other'));

-- One row per calendar day -- the actual dedupe gate, so the twice-daily
-- cron run doesn't re-broadcast the same day's forecast every time it
-- fires while the threshold stays tripped.
CREATE TABLE weather_alerts_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_date date NOT NULL UNIQUE,
  rain_chance int,
  wind_kph int,
  created_at timestamptz DEFAULT now()
);

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
  FROM portal_users WHERE is_active = true;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION broadcast_weather_alert(text, text, int, int) FROM PUBLIC, anon, authenticated;

-- Same fire-and-forget pg_net pattern as dispatch_push_notification()
-- (348) -- Postgres only pings the route; the actual Open-Meteo fetch,
-- threshold check, and wording happen in Node (much easier to get right
-- than parsing an HTTP JSON response back inside a pg_net callback).
CREATE OR REPLACE FUNCTION trigger_weather_check() RETURNS void AS $$
DECLARE v_url text; v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'weather_check_api_url';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'push_trigger_secret';
  IF v_url IS NULL OR v_secret IS NULL THEN RETURN; END IF;
  PERFORM net.http_post(url := v_url, headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret));
EXCEPTION WHEN OTHERS THEN
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault, net;

-- 01:00 and 13:00 UTC = 6am and 6pm Pakistan time (185_recurring_pakistan_time.sql:
-- this database runs in UTC, so every schedule here is hand-offset).
SELECT cron.schedule('weather-severe-check', '0 1,13 * * *', 'SELECT trigger_weather_check()');

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('weather_alert', 'A severe weather alert was broadcast', false, true)
ON CONFLICT (event_type) DO NOTHING;
