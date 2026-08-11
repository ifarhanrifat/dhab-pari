-- Migration 200: schedule an appeal ahead of time, and make its history
-- visible after it stops.
--
-- appeals could already be given an end (expires_at) but not a start, so
-- everything went live the instant it was written. That rules out the ordinary
-- case: writing Friday's announcement on Wednesday, or lining up a reminder for
-- the morning of a meeting. Whoever writes it had to be awake at the moment it
-- should appear.
--
-- starts_at defaults to now(), so every existing appeal and every caller that
-- does not care keeps behaving exactly as before.
ALTER TABLE appeals
  ADD COLUMN IF NOT EXISTS starts_at timestamptz NOT NULL DEFAULT now();

DROP INDEX IF EXISTS appeals_active_idx;
CREATE INDEX IF NOT EXISTS appeals_window_idx
  ON appeals(status, starts_at, expires_at) WHERE status = 'active';

-- ── Reads now respect the window ─────────────────────────────────────────
-- The red belt asks these functions live on every load, so scheduling needs no
-- background job to work on the site itself: an appeal simply starts appearing
-- once starts_at passes.
DROP FUNCTION IF EXISTS public_appeals();
CREATE OR REPLACE FUNCTION public_appeals()
RETURNS TABLE (id uuid, kind text, severity text, title_en text, title_ur text,
               body_en text, body_ur text, contact_number text, created_at timestamptz) AS $$
  SELECT a.id, a.kind::text, a.severity::text, a.title_en::text, a.title_ur::text,
         a.body_en, a.body_ur, a.contact_number::text, a.created_at
    FROM appeals a
   WHERE a.status = 'active'
     AND a.is_public
     AND a.starts_at <= now()
     AND (a.expires_at IS NULL OR a.expires_at > now())
   ORDER BY CASE a.severity WHEN 'emergency' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
            a.created_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public_appeals() TO anon, authenticated;

DROP FUNCTION IF EXISTS my_appeals();
CREATE OR REPLACE FUNCTION my_appeals()
RETURNS TABLE (id uuid, kind text, severity text, title_en text, title_ur text,
               body_en text, body_ur text, contact_number text, created_at timestamptz) AS $$
DECLARE u portal_users%ROWTYPE;
BEGIN
  SELECT * INTO u FROM portal_users WHERE auth_user_id = auth.uid() AND is_active = true;
  IF u.id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT a.id, a.kind::text, a.severity::text, a.title_en::text, a.title_ur::text,
         a.body_en, a.body_ur, a.contact_number::text, a.created_at
    FROM appeals a
   WHERE a.status = 'active'
     AND a.starts_at <= now()
     AND (a.expires_at IS NULL OR a.expires_at > now())
     AND CASE a.audience
       WHEN 'everyone'  THEN true
       WHEN 'consumers' THEN u.consumer_id IS NOT NULL
       WHEN 'donors'    THEN u.donor_account_id IS NOT NULL
       WHEN 'villagers' THEN COALESCE(u.donor_type, 'villager') = 'villager'
       WHEN 'overseas'  THEN u.donor_type = 'overseas'
                             AND (cardinality(a.audience_countries) = 0
                                  OR u.country = ANY (a.audience_countries))
       ELSE false
     END
   ORDER BY CASE a.severity WHEN 'emergency' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
            a.created_at DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_appeals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_appeals() TO authenticated;

-- ── The mirrored news_ticker row needs a nudge ───────────────────────────
-- The red belt is driven by the functions above and needs nothing. The
-- news_ticker copy is a plain row with an is_active flag, so a scheduled appeal
-- must not switch it on until it is due, and an expired one must switch it off.
-- Without this, a Friday announcement written on Wednesday would sit in the
-- green ticker for two days.
CREATE OR REPLACE FUNCTION sync_appeal_tickers() RETURNS void AS $$
  UPDATE news_ticker t SET is_active = true
    FROM appeals a
   WHERE a.ticker_id = t.id AND a.status = 'active' AND a.is_public
     AND a.starts_at <= now() AND (a.expires_at IS NULL OR a.expires_at > now())
     AND t.is_active = false;

  UPDATE news_ticker t SET is_active = false
    FROM appeals a
   WHERE a.ticker_id = t.id AND t.is_active = true
     AND (a.status <> 'active' OR a.starts_at > now()
          OR (a.expires_at IS NOT NULL AND a.expires_at <= now()));
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION sync_appeal_tickers() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION sync_appeal_tickers() TO authenticated;

-- Best effort, same as the recurring scheduler: if pg_cron is unavailable the
-- Alerts screen calls it on load, which covers the realistic case since someone
-- scheduling an appeal is looking at that screen anyway.
DO $$
BEGIN
  PERFORM cron.unschedule('sync-appeal-tickers');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.schedule('sync-appeal-tickers', '*/5 * * * *', 'SELECT sync_appeal_tickers()');
  RAISE NOTICE 'pg_cron: appeal tickers sync every 5 minutes';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable — appeal tickers sync when the Alerts screen is opened. %', SQLERRM;
END $$;

-- ── Creating: accept a start, and hold the notification until then ───────
CREATE OR REPLACE FUNCTION create_appeal(
  p_kind varchar, p_body_ur text, p_body_en text,
  p_audience varchar DEFAULT 'everyone', p_audience_countries text[] DEFAULT '{}',
  p_is_public boolean DEFAULT true, p_title_ur varchar DEFAULT NULL,
  p_title_en varchar DEFAULT NULL, p_contact_name varchar DEFAULT NULL,
  p_contact_number varchar DEFAULT NULL, p_project_id uuid DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL, p_notify boolean DEFAULT true,
  p_severity varchar DEFAULT 'appeal', p_starts_at timestamptz DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_id uuid; v_admin uuid; v_ticker uuid;
  v_starts timestamptz := COALESCE(p_starts_at, now());
BEGIN
  IF (current_admin_permission('manage_parties') IS DISTINCT FROM true)
     AND (current_admin_permission('manage_blood_requests') IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'You do not have permission to post an appeal';
  END IF;
  IF coalesce(trim(p_body_ur), '') = '' OR coalesce(trim(p_body_en), '') = '' THEN
    RAISE EXCEPTION 'An appeal needs wording in both Urdu and English';
  END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= v_starts THEN
    RAISE EXCEPTION 'The end time must be after the start time';
  END IF;

  v_admin := current_admin_user_id();

  INSERT INTO appeals (kind, severity, title_en, title_ur, body_en, body_ur, audience,
                       audience_countries, is_public, contact_name, contact_number,
                       project_id, starts_at, expires_at, created_by_admin_user_id)
  VALUES (p_kind, p_severity, p_title_en, p_title_ur, trim(p_body_en), trim(p_body_ur),
          p_audience, coalesce(p_audience_countries, '{}'), p_is_public, p_contact_name,
          p_contact_number, p_project_id, v_starts, p_expires_at, v_admin)
  RETURNING id INTO v_id;

  IF p_is_public THEN
    INSERT INTO news_ticker (message, message_ur, is_active, display_order)
    VALUES (trim(p_body_en), trim(p_body_ur), v_starts <= now(), -100)
    RETURNING id INTO v_ticker;
    UPDATE appeals SET ticker_id = v_ticker WHERE id = v_id;
  END IF;

  -- A notification for something that has not started yet is just confusing,
  -- so a scheduled appeal notifies when sync_appeal_tickers brings it live.
  IF p_notify AND v_starts <= now() THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT a.portal_user_id, 'appeal',
           COALESCE(nullif(trim(coalesce(p_title_ur, '')), ''),
                    nullif(trim(coalesce(p_title_en, '')), ''), 'ایک اپیل'),
           trim(p_body_ur) || chr(10) || trim(p_body_en),
           '/portal'
      FROM appeal_audience_users(p_audience, p_audience_countries) a;
  END IF;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS create_appeal(varchar, text, text, varchar, text[], boolean, varchar, varchar, varchar, varchar, uuid, timestamptz, boolean, varchar);
REVOKE ALL ON FUNCTION create_appeal(varchar, text, text, varchar, text[], boolean, varchar, varchar, varchar, varchar, uuid, timestamptz, boolean, varchar, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_appeal(varchar, text, text, varchar, text[], boolean, varchar, varchar, varchar, varchar, uuid, timestamptz, boolean, varchar, timestamptz) TO authenticated;

-- ── History ──────────────────────────────────────────────────────────────
-- Closing has always kept the row, with who closed it, when and why. Nothing
-- ever showed it back, so "is it saved?" had no answer anyone could check.
CREATE OR REPLACE FUNCTION appeals_history(p_limit int DEFAULT 50)
RETURNS TABLE (
  id uuid, kind text, severity text, body_ur text, body_en text,
  audience text, is_public boolean, status text,
  starts_at timestamptz, expires_at timestamptz, created_at timestamptz,
  closed_at timestamptz, close_reason text,
  created_by text, closed_by text
) AS $$
  SELECT a.id, a.kind::text, a.severity::text, a.body_ur, a.body_en,
         a.audience::text, a.is_public, a.status::text,
         a.starts_at, a.expires_at, a.created_at, a.closed_at, a.close_reason,
         cb.full_name::text, xb.full_name::text
    FROM appeals a
    LEFT JOIN admin_users cb ON cb.id = a.created_by_admin_user_id
    LEFT JOIN admin_users xb ON xb.id = a.closed_by_admin_user_id
   WHERE EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)
   ORDER BY a.created_at DESC
   LIMIT greatest(1, least(coalesce(p_limit, 50), 500));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION appeals_history(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION appeals_history(int) TO authenticated;

-- ── Reopen ───────────────────────────────────────────────────────────────
-- Closing something by accident during an emergency is easy, and rewriting it
-- from scratch under pressure is how the wording goes wrong.
CREATE OR REPLACE FUNCTION reopen_appeal(p_appeal_id uuid, p_expires_at timestamptz DEFAULT NULL)
RETURNS void AS $$
DECLARE a appeals%ROWTYPE;
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
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION reopen_appeal(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reopen_appeal(uuid, timestamptz) TO authenticated;
