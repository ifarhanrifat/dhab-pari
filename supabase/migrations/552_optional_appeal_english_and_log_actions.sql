-- Migration 552: real ask, 2026-10-01, "remove this compulsory english
-- option from the appeal tab for admin" -- Urdu is the one language that
-- actually matters here (every appeal already shows Urdu large, English
-- underneath); body_en/title_en stay NOT NULL in the schema (shared with
-- the public ticker's own NOT NULL message column), so a blank English
-- field now just reuses the Urdu text instead of blocking the post.
CREATE OR REPLACE FUNCTION create_appeal(
  p_kind varchar, p_body_ur text, p_body_en text,
  p_audience varchar DEFAULT 'everyone', p_audience_countries text[] DEFAULT '{}',
  p_is_public boolean DEFAULT true, p_title_ur varchar DEFAULT NULL,
  p_title_en varchar DEFAULT NULL, p_contact_name varchar DEFAULT NULL,
  p_contact_number varchar DEFAULT NULL, p_project_id uuid DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL, p_notify boolean DEFAULT true,
  p_severity varchar DEFAULT 'appeal', p_alert_type varchar DEFAULT NULL
) RETURNS uuid AS $$
DECLARE v_id uuid; v_admin uuid; v_ticker uuid; v_expires_at timestamptz; v_body_en text; v_title_en varchar;
BEGIN
  IF (current_admin_permission('manage_parties') IS DISTINCT FROM true)
     AND (current_admin_permission('manage_blood_requests') IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'You do not have permission to post an appeal';
  END IF;
  IF coalesce(trim(p_body_ur), '') = '' THEN
    RAISE EXCEPTION 'An appeal needs wording in Urdu';
  END IF;

  v_admin := current_admin_user_id();
  v_body_en := COALESCE(NULLIF(trim(coalesce(p_body_en, '')), ''), trim(p_body_ur));
  v_title_en := COALESCE(NULLIF(trim(coalesce(p_title_en, '')), ''), p_title_ur);
  v_expires_at := COALESCE(
    p_expires_at,
    now() + (get_alert_expiry_hours(COALESCE(p_alert_type, p_severity || '_default')) || ' hours')::interval
  );

  INSERT INTO appeals (kind, severity, title_en, title_ur, body_en, body_ur, audience,
                       audience_countries, is_public, contact_name, contact_number,
                       project_id, expires_at, created_by_admin_user_id)
  VALUES (p_kind, p_severity, v_title_en, p_title_ur, v_body_en, trim(p_body_ur),
          p_audience, coalesce(p_audience_countries, '{}'), p_is_public, p_contact_name,
          p_contact_number, p_project_id, v_expires_at, v_admin)
  RETURNING id INTO v_id;

  IF p_is_public THEN
    INSERT INTO news_ticker (message, message_ur, is_active, display_order, expires_at, is_appeal_mirror)
    VALUES (v_body_en, trim(p_body_ur), true, -100, v_expires_at, true)
    RETURNING id INTO v_ticker;
    UPDATE appeals SET ticker_id = v_ticker WHERE id = v_id;
  END IF;

  IF p_notify THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT a.portal_user_id, 'appeal',
           COALESCE(nullif(trim(coalesce(p_title_ur, '')), ''),
                    nullif(trim(coalesce(p_title_en, '')), ''), 'ایک اپیل'),
           trim(p_body_ur) || chr(10) || v_body_en,
           '/portal'
      FROM appeal_audience_users(p_audience, p_audience_countries) a
      JOIN portal_users u ON u.id = a.portal_user_id
     WHERE p_severity = 'emergency' OR u.notify_general_appeals = true;
  END IF;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Real report, 2026-10-01: a stuck 'pending' row in the WhatsApp Message
-- History log ("why this section of appeal is showing pending and
-- nothing can resend or remove this") -- that section has always been a
-- placeholder (al.integrationNote already says so: "logged for future
-- integration"), so nothing ever moves a row out of 'pending'. RLS
-- already permits delete/update here (admin_all_notifications, FOR ALL) --
-- the actual gap is just that the admin UI never offered the buttons;
-- fixed client-side, nothing to change here.
