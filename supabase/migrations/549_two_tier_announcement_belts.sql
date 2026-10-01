-- Migration 549: two-tier announcement belt, 2026-10-01.
--
-- Real ask: the calm "news" belt should run everywhere (public, portal,
-- AND admin — previously public-only) and should also carry Chanda/
-- donation announcements, not just hand-written news; alerts (appeals)
-- get their OWN belt underneath it instead of replacing it, red for
-- severity='emergency' and yellow-with-black-text for everything else
-- (death announcements, help requests, routine appeals); every alert
-- gets a sane default end-time so nothing runs forever by accident.
--
-- Appeals already mirror into news_ticker (195/196/199/200) so the old
-- single-belt design could show them at all. Now that alerts get their
-- own belt, that mirror would just duplicate the same text in both
-- places -- is_appeal_mirror marks those rows so the calm belt's own
-- query can exclude them, WITHOUT touching ticker_id itself: the admin
-- Blood Requests screen reads `ticker_id IS NOT NULL` as "already posted
-- publicly", and sync_appeal_tickers() (200) still needs a real row to
-- flip active/inactive as a scheduled or expiring appeal's window
-- opens/closes. Pulling that thread out would mean auditing and
-- rewriting those too -- this is the smaller, additive, lower-risk fix
-- for the same outcome.
ALTER TABLE news_ticker ADD COLUMN is_appeal_mirror boolean NOT NULL DEFAULT false;
UPDATE news_ticker SET is_appeal_mirror = true
WHERE id IN (SELECT ticker_id FROM appeals WHERE ticker_id IS NOT NULL)
   OR id IN (SELECT ticker_id FROM blood_requests WHERE ticker_id IS NOT NULL);

CREATE OR REPLACE FUNCTION create_appeal(
  p_kind varchar, p_body_ur text, p_body_en text,
  p_audience varchar DEFAULT 'everyone', p_audience_countries text[] DEFAULT '{}',
  p_is_public boolean DEFAULT true, p_title_ur varchar DEFAULT NULL,
  p_title_en varchar DEFAULT NULL, p_contact_name varchar DEFAULT NULL,
  p_contact_number varchar DEFAULT NULL, p_project_id uuid DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL, p_notify boolean DEFAULT true,
  p_severity varchar DEFAULT 'appeal'
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
  -- Real ask, 2026-10-01: "set their timing to end by default once
  -- triggered" -- an explicit p_expires_at always wins; otherwise every
  -- severity now gets a real default instead of running forever.
  v_expires_at := COALESCE(p_expires_at, now() + CASE p_severity
    WHEN 'emergency' THEN interval '24 hours'
    WHEN 'important' THEN interval '3 days'
    ELSE interval '7 days'
  END);

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

CREATE OR REPLACE FUNCTION post_blood_appeal(
  p_request_id uuid, p_contact_number varchar DEFAULT NULL,
  p_audience varchar DEFAULT 'everyone', p_audience_countries text[] DEFAULT '{}',
  p_is_public boolean DEFAULT true
) RETURNS uuid AS $$
DECLARE r blood_requests%ROWTYPE; v_id uuid; v_admin uuid; v_ticker uuid; v_expires_at timestamptz;
BEGIN
  IF current_admin_permission('manage_blood_requests') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'You do not have permission to post a blood appeal';
  END IF;

  SELECT * INTO r FROM blood_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'open' THEN RAISE EXCEPTION 'Only an open request can be posted publicly'; END IF;

  v_admin := current_admin_user_id();
  v_expires_at := (r.needed_on + 1)::timestamp AT TIME ZONE 'Asia/Karachi';

  INSERT INTO appeals (kind, severity, title_en, title_ur, body_en, body_ur, audience,
                       audience_countries, is_public, contact_name, contact_number,
                       blood_request_id, expires_at, created_by_admin_user_id)
  VALUES ('blood', 'emergency',
          r.blood_group || ' blood needed', r.blood_group || ' خون کی ضرورت',
          blood_appeal_text_en(p_request_id, p_contact_number),
          blood_appeal_text_ur(p_request_id, p_contact_number),
          p_audience, coalesce(p_audience_countries, '{}'), p_is_public,
          r.requester_name,
          coalesce(nullif(trim(coalesce(p_contact_number, '')), ''), r.requester_whatsapp),
          p_request_id, v_expires_at, v_admin)
  RETURNING id INTO v_id;

  IF p_is_public THEN
    INSERT INTO news_ticker (message, message_ur, is_active, display_order, expires_at, is_appeal_mirror)
    VALUES (blood_appeal_text_en(p_request_id, p_contact_number),
            blood_appeal_text_ur(p_request_id, p_contact_number), true, -100, v_expires_at, true)
    RETURNING id INTO v_ticker;
    UPDATE appeals SET ticker_id = v_ticker WHERE id = v_id;
    UPDATE blood_requests SET ticker_id = v_ticker WHERE id = p_request_id;
  END IF;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Weather alerts: same mirror-marking, plus a real expiry (a forecast is
-- stale well before a week is up) -- the original version of this
-- function left expires_at unset entirely, meaning it would have run
-- forever.
CREATE OR REPLACE FUNCTION broadcast_weather_alert(p_body_en text, p_body_ur text, p_rain_chance int, p_wind_kph int)
RETURNS uuid AS $$
DECLARE v_id uuid; v_ticker uuid; v_expires_at timestamptz := now() + interval '2 days';
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

-- Chanda campaigns: a calm, non-appeal announcement when a new one
-- launches -- "the default belt will be always running as like it's for
-- the news and for the new chanda, and donations". Short-lived (7 days)
-- since it's meant to draw initial attention, not run the campaign's
-- whole 1-6 month life in the ticker (the Chanda page itself is where
-- it lives for that long).
CREATE OR REPLACE FUNCTION notify_ticker_new_chanda() RETURNS trigger AS $$
BEGIN
  IF NEW.is_active THEN
    INSERT INTO news_ticker (message, message_ur, is_active, display_order, expires_at)
    VALUES (
      'New Chanda started: ' || NEW.title || ' — see dhabpari.com/chanda',
      'نیا چندہ شروع ہوا: ' || COALESCE(NEW.title_ur, NEW.title) || ' — دیکھیں dhabpari.com/chanda',
      true, -50, now() + interval '7 days'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
CREATE TRIGGER chanda_campaigns_notify_ticker AFTER INSERT ON chanda_campaigns
  FOR EACH ROW EXECUTE FUNCTION notify_ticker_new_chanda();
