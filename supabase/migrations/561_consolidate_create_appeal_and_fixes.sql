-- Migration 561: consolidate create_appeal(), Urdu-only push body, admin
-- fan-out everywhere -- 2026-10-02.
--
-- Real, serious find while chasing a "two notifications, English and Urdu
-- separately" report: THREE overloaded versions of create_appeal() were
-- simultaneously live (196's base shape, 550's alert_type-aware shape, and
-- 200's scheduling shape) -- each migration added one new trailing
-- parameter without dropping the version it was replacing, and Postgres
-- treats a different parameter list as a wholly separate function.
-- postAppeal() in the admin UI always sends p_starts_at as a named arg,
-- which only exists on the OLDEST (200) overload -- so PostgREST has been
-- silently routing every real appeal through that one ever since
-- scheduling shipped. Concretely, in production, every appeal created
-- from the admin panel has been:
--   - requiring BOTH Urdu and English (the "remove compulsory English" fix,
--     552, was applied to the wrong, dead overload),
--   - ignoring the Alert Expiry Settings admin page entirely (hardcoded
--     24h/3d/7d intervals instead of get_alert_expiry_hours()),
--   - ignoring each portal user's notify_general_appeals preference.
-- This migration folds every feature into the ONE signature the client
-- actually calls (same 15 names as the scheduling overload) and drops the
-- other two dead ones so there is exactly one create_appeal again.
--
-- Separately: the push body across every one of these functions
-- (create/update/reopen_appeal) was the Urdu AND English text joined by a
-- newline in one notification -- correct behavior, but a direct ask
-- ("only one push notification... in Urdu only") wants just the Urdu line.
-- And none of them ever notified admin_users at all, only portal_users --
-- another direct ask. Both fixed here, plus post_blood_appeal (which had
-- no notification fan-out of any kind before this).

CREATE OR REPLACE FUNCTION create_appeal(
  p_kind varchar, p_body_ur text, p_body_en text,
  p_audience varchar DEFAULT 'everyone', p_audience_countries text[] DEFAULT '{}',
  p_is_public boolean DEFAULT true, p_title_ur varchar DEFAULT NULL, p_title_en varchar DEFAULT NULL,
  p_contact_name varchar DEFAULT NULL, p_contact_number varchar DEFAULT NULL,
  p_project_id uuid DEFAULT NULL, p_expires_at timestamptz DEFAULT NULL,
  p_notify boolean DEFAULT true, p_severity varchar DEFAULT 'appeal',
  p_starts_at timestamptz DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_id uuid; v_admin uuid; v_ticker uuid; v_body_en text; v_title_en varchar; v_title_ur varchar; v_expires_at timestamptz;
  v_starts timestamptz := COALESCE(p_starts_at, now());
BEGIN
  IF (current_admin_permission('manage_parties') IS DISTINCT FROM true)
     AND (current_admin_permission('manage_blood_requests') IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'You do not have permission to post an appeal';
  END IF;
  IF coalesce(trim(p_body_ur), '') = '' THEN
    RAISE EXCEPTION 'An appeal needs wording in Urdu';
  END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= v_starts THEN
    RAISE EXCEPTION 'The end time must be after the start time';
  END IF;

  v_admin := current_admin_user_id();
  v_body_en := COALESCE(NULLIF(trim(coalesce(p_body_en, '')), ''), trim(p_body_ur));
  v_title_ur := COALESCE(nullif(trim(coalesce(p_title_ur, '')), ''), 'ایک اپیل');
  v_title_en := COALESCE(NULLIF(trim(coalesce(p_title_en, '')), ''), p_title_ur, v_title_ur);
  v_expires_at := COALESCE(p_expires_at, v_starts + (get_alert_expiry_hours(p_severity || '_default') || ' hours')::interval);

  INSERT INTO appeals (kind, severity, title_en, title_ur, body_en, body_ur, audience,
                       audience_countries, is_public, contact_name, contact_number,
                       project_id, starts_at, expires_at, created_by_admin_user_id)
  VALUES (p_kind, p_severity, v_title_en, p_title_ur, v_body_en, trim(p_body_ur),
          p_audience, coalesce(p_audience_countries, '{}'), p_is_public, p_contact_name,
          p_contact_number, p_project_id, v_starts, v_expires_at, v_admin)
  RETURNING id INTO v_id;

  IF p_is_public THEN
    INSERT INTO news_ticker (message, message_ur, is_active, display_order, expires_at, is_appeal_mirror)
    VALUES (v_body_en, trim(p_body_ur), v_starts <= now(), -100, v_expires_at, true)
    RETURNING id INTO v_ticker;
    UPDATE appeals SET ticker_id = v_ticker WHERE id = v_id;
  END IF;

  -- A notification for something that hasn't started yet is just confusing
  -- -- a scheduled appeal notifies once sync_appeal_tickers brings it live.
  IF p_notify AND v_starts <= now() THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT a.portal_user_id, 'appeal', v_title_ur, trim(p_body_ur), '/portal'
      FROM appeal_audience_users(p_audience, p_audience_countries) a
      JOIN portal_users u ON u.id = a.portal_user_id
     WHERE p_severity = 'emergency' OR u.notify_general_appeals = true;

    PERFORM notify_admins_pending_item('appeal', v_title_ur, trim(p_body_ur), '/admin/notifications');
  END IF;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION create_appeal(varchar, text, text, varchar, text[], boolean, varchar, varchar, varchar, varchar, uuid, timestamptz, boolean, varchar, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_appeal(varchar, text, text, varchar, text[], boolean, varchar, varchar, varchar, varchar, uuid, timestamptz, boolean, varchar, timestamptz) TO authenticated;

-- The two dead overloads this consolidates -- without dropping these,
-- there would be three create_appeal functions again.
DROP FUNCTION IF EXISTS create_appeal(varchar, text, text, varchar, text[], boolean, varchar, varchar, varchar, varchar, uuid, timestamptz, boolean, varchar);
DROP FUNCTION IF EXISTS create_appeal(varchar, text, text, varchar, text[], boolean, varchar, varchar, varchar, varchar, uuid, timestamptz, boolean, varchar, varchar);

-- update_appeal (559): Urdu-only push body, plus admin fan-out.
CREATE OR REPLACE FUNCTION update_appeal(
  p_appeal_id uuid, p_kind varchar, p_body_ur text, p_body_en text,
  p_audience varchar DEFAULT 'everyone', p_audience_countries text[] DEFAULT '{}',
  p_is_public boolean DEFAULT true, p_title_ur varchar DEFAULT NULL,
  p_contact_number varchar DEFAULT NULL, p_expires_at timestamptz DEFAULT NULL,
  p_severity varchar DEFAULT 'appeal', p_notify boolean DEFAULT true
) RETURNS void AS $$
DECLARE v_ticker_id uuid; v_body_en text; v_title_ur varchar; v_expires_at timestamptz;
BEGIN
  IF (current_admin_permission('manage_parties') IS DISTINCT FROM true)
     AND (current_admin_permission('manage_blood_requests') IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'You do not have permission to edit an appeal';
  END IF;
  IF coalesce(trim(p_body_ur), '') = '' THEN
    RAISE EXCEPTION 'An appeal needs wording in Urdu';
  END IF;

  SELECT ticker_id INTO v_ticker_id FROM appeals WHERE id = p_appeal_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Appeal not found'; END IF;

  v_body_en := COALESCE(NULLIF(trim(coalesce(p_body_en, '')), ''), trim(p_body_ur));
  v_title_ur := COALESCE(nullif(trim(coalesce(p_title_ur, '')), ''), 'ایک اپیل');
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
    SELECT a.portal_user_id, 'appeal', v_title_ur, trim(p_body_ur), '/portal'
      FROM appeal_audience_users(p_audience, p_audience_countries) a;

    PERFORM notify_admins_pending_item('appeal', v_title_ur, trim(p_body_ur), '/admin/notifications');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- reopen_appeal (560): Urdu-only push body, plus admin fan-out.
CREATE OR REPLACE FUNCTION reopen_appeal(p_appeal_id uuid, p_expires_at timestamptz DEFAULT NULL)
RETURNS void AS $$
DECLARE a appeals%ROWTYPE; v_title_ur varchar;
BEGIN
  IF (current_admin_permission('manage_parties') IS DISTINCT FROM true)
     AND (current_admin_permission('manage_blood_requests') IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'You do not have permission to reopen an appeal';
  END IF;

  SELECT * INTO a FROM appeals WHERE id = p_appeal_id FOR UPDATE;
  IF a.id IS NULL THEN RAISE EXCEPTION 'Appeal not found'; END IF;
  IF a.status = 'active' THEN RAISE EXCEPTION 'That appeal is already showing'; END IF;

  UPDATE appeals
     SET status = 'active', closed_at = NULL, closed_by_admin_user_id = NULL,
         close_reason = NULL, starts_at = now(),
         expires_at = COALESCE(p_expires_at, expires_at)
   WHERE id = p_appeal_id;

  PERFORM sync_appeal_tickers();

  v_title_ur := COALESCE(nullif(trim(coalesce(a.title_ur, '')), ''), 'ایک اپیل');

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT u.portal_user_id, 'appeal', v_title_ur, trim(a.body_ur), '/portal'
    FROM appeal_audience_users(a.audience, a.audience_countries) u;

  PERFORM notify_admins_pending_item('appeal', v_title_ur, trim(a.body_ur), '/admin/notifications');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- post_blood_appeal (549): had NO notification fan-out at all before this.
CREATE OR REPLACE FUNCTION post_blood_appeal(
  p_request_id uuid, p_contact_number varchar DEFAULT NULL,
  p_audience varchar DEFAULT 'everyone', p_audience_countries text[] DEFAULT '{}',
  p_is_public boolean DEFAULT true
) RETURNS uuid AS $$
DECLARE r blood_requests%ROWTYPE; v_id uuid; v_admin uuid; v_ticker uuid; v_expires_at timestamptz; v_title_ur varchar; v_body_ur text;
BEGIN
  IF current_admin_permission('manage_blood_requests') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'You do not have permission to post a blood appeal';
  END IF;

  SELECT * INTO r FROM blood_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'open' THEN RAISE EXCEPTION 'Only an open request can be posted publicly'; END IF;

  v_admin := current_admin_user_id();
  v_expires_at := (r.needed_on + 1)::timestamp AT TIME ZONE 'Asia/Karachi';
  v_title_ur := r.blood_group || ' خون کی ضرورت';
  v_body_ur := blood_appeal_text_ur(p_request_id, p_contact_number);

  INSERT INTO appeals (kind, severity, title_en, title_ur, body_en, body_ur, audience,
                       audience_countries, is_public, contact_name, contact_number,
                       blood_request_id, expires_at, created_by_admin_user_id)
  VALUES ('blood', 'emergency',
          r.blood_group || ' blood needed', v_title_ur,
          blood_appeal_text_en(p_request_id, p_contact_number), v_body_ur,
          p_audience, coalesce(p_audience_countries, '{}'), p_is_public,
          r.requester_name,
          coalesce(nullif(trim(coalesce(p_contact_number, '')), ''), r.requester_whatsapp),
          p_request_id, v_expires_at, v_admin)
  RETURNING id INTO v_id;

  IF p_is_public THEN
    INSERT INTO news_ticker (message, message_ur, is_active, display_order, expires_at, is_appeal_mirror)
    VALUES (blood_appeal_text_en(p_request_id, p_contact_number), v_body_ur, true, -100, v_expires_at, true)
    RETURNING id INTO v_ticker;
    UPDATE appeals SET ticker_id = v_ticker WHERE id = v_id;
    UPDATE blood_requests SET ticker_id = v_ticker WHERE id = p_request_id;
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT a.portal_user_id, 'appeal', v_title_ur, v_body_ur, '/portal'
    FROM appeal_audience_users(p_audience, p_audience_countries) a;

  PERFORM notify_admins_pending_item('appeal', v_title_ur, v_body_ur, '/admin/notifications');

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
