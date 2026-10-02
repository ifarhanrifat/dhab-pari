-- Migration 559: update_appeal() can re-notify, like create_appeal() always
-- could -- 2026-10-02.
--
-- Real report: a live medical-help appeal was re-triggered from the admin
-- panel and the belt refreshed, but nobody's phone got a notification.
-- Root cause: update_appeal() (553) only ever UPDATEs the appeals row and
-- its news_ticker mirror -- unlike create_appeal() (196), it never had a
-- portal_notifications fan-out at all, with no way to ask for one either.
-- The admin panel has exactly one "Update Appeal" button for both "fix a
-- typo" and "re-circulate this emergency" -- there's no second action for
-- the latter, so the update path needs to be able to do both.
--
-- Defaults to true (re-notify), unlike create_appeal's own p_notify
-- (also defaults true, same reasoning from 196: "an appeal nobody is told
-- about is a poster in an empty room") -- silently NOT re-notifying on an
-- edited emergency appeal is a worse failure than occasionally re-pinging
-- people on a minor wording fix, and the admin can still uncheck it.
CREATE OR REPLACE FUNCTION update_appeal(
  p_appeal_id uuid, p_kind varchar, p_body_ur text, p_body_en text,
  p_audience varchar DEFAULT 'everyone', p_audience_countries text[] DEFAULT '{}',
  p_is_public boolean DEFAULT true, p_title_ur varchar DEFAULT NULL,
  p_contact_number varchar DEFAULT NULL, p_expires_at timestamptz DEFAULT NULL,
  p_severity varchar DEFAULT 'appeal', p_notify boolean DEFAULT true
) RETURNS void AS $$
DECLARE v_ticker_id uuid; v_body_en text; v_title_en varchar; v_expires_at timestamptz;
BEGIN
  IF (current_admin_permission('manage_parties') IS DISTINCT FROM true)
     AND (current_admin_permission('manage_blood_requests') IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'You do not have permission to edit an appeal';
  END IF;
  IF coalesce(trim(p_body_ur), '') = '' THEN
    RAISE EXCEPTION 'An appeal needs wording in Urdu';
  END IF;

  SELECT ticker_id, title_en INTO v_ticker_id, v_title_en FROM appeals WHERE id = p_appeal_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Appeal not found'; END IF;

  v_body_en := COALESCE(NULLIF(trim(coalesce(p_body_en, '')), ''), trim(p_body_ur));
  v_expires_at := COALESCE(p_expires_at, now() + (get_alert_expiry_hours(p_severity || '_default') || ' hours')::interval);

  UPDATE appeals SET
    kind = p_kind, severity = p_severity, title_ur = p_title_ur,
    body_en = v_body_en, body_ur = trim(p_body_ur), audience = p_audience,
    audience_countries = coalesce(p_audience_countries, '{}'), is_public = p_is_public,
    contact_number = p_contact_number, expires_at = v_expires_at
  WHERE id = p_appeal_id;

  IF v_ticker_id IS NOT NULL THEN
    UPDATE news_ticker SET message = v_body_en, message_ur = trim(p_body_ur), expires_at = v_expires_at, is_active = p_is_public
    WHERE id = v_ticker_id;
  END IF;

  IF p_notify THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT a.portal_user_id, 'appeal',
           COALESCE(nullif(trim(coalesce(p_title_ur, '')), ''), nullif(trim(v_title_en), ''), 'ایک اپیل'),
           trim(p_body_ur) || chr(10) || v_body_en,
           '/portal'
      FROM appeal_audience_users(p_audience, p_audience_countries) a;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION update_appeal(uuid, varchar, text, text, varchar, text[], boolean, varchar, varchar, timestamptz, varchar, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION update_appeal(uuid, varchar, text, text, varchar, text[], boolean, varchar, varchar, timestamptz, varchar, boolean) TO authenticated;

-- The 11-argument version from 553 would otherwise remain as a second
-- candidate and make every call with defaulted arguments ambiguous.
DROP FUNCTION IF EXISTS update_appeal(uuid, varchar, text, text, varchar, text[], boolean, varchar, varchar, timestamptz, varchar);
