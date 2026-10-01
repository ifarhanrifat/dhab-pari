-- Migration 553: real ask, 2026-10-01, "alerts are not editable make
-- them editable" — a live appeal could only be closed and re-posted from
-- scratch before. update_appeal() is the same shape as create_appeal()
-- but UPDATEs the existing row (and its linked news_ticker mirror, if
-- any) instead of inserting a new one, so editing in place doesn't
-- duplicate it on the belt.
CREATE OR REPLACE FUNCTION update_appeal(
  p_appeal_id uuid, p_kind varchar, p_body_ur text, p_body_en text,
  p_audience varchar DEFAULT 'everyone', p_audience_countries text[] DEFAULT '{}',
  p_is_public boolean DEFAULT true, p_title_ur varchar DEFAULT NULL,
  p_contact_number varchar DEFAULT NULL, p_expires_at timestamptz DEFAULT NULL,
  p_severity varchar DEFAULT 'appeal'
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
  -- Same "nothing runs forever by accident" rule as create_appeal (549/550)
  -- applies here too -- there's no stored alert_type to recompute a
  -- feature-specific default from on an edit, so this falls back to the
  -- severity tier's own default.
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
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION update_appeal(uuid, varchar, text, text, varchar, text[], boolean, varchar, varchar, timestamptz, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION update_appeal(uuid, varchar, text, text, varchar, text[], boolean, varchar, varchar, timestamptz, varchar) TO authenticated;
