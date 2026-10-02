-- Migration 560: reopen_appeal() ("Show Again") can notify too -- 2026-10-02.
--
-- Same class of bug as 559, third occurrence: create_appeal (196) was the
-- only one of the three appeal-posting actions that ever fanned out to
-- portal_notifications. update_appeal (553) got fixed in 559; reopen_appeal
-- (200, the "Show Again" button for a previously-closed appeal) has the
-- identical gap -- it flips status back to active and re-syncs the ticker,
-- but never notifies anyone. Real report: re-triggering a closed medical
-- appeal via "Show Again" refreshed the belt with no push reaching any
-- device.
--
-- No p_notify toggle here, unlike update_appeal -- "Show Again" is a single
-- button with no compose form around it, and its entire point is "make
-- people aware of this again," so it always notifies.
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

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT u.portal_user_id, 'appeal',
         COALESCE(nullif(trim(coalesce(a.title_ur, '')), ''), nullif(trim(coalesce(a.title_en, '')), ''), 'ایک اپیل'),
         trim(a.body_ur) || chr(10) || trim(a.body_en),
         '/portal'
    FROM appeal_audience_users(a.audience, a.audience_countries) u;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION reopen_appeal(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reopen_appeal(uuid, timestamptz) TO authenticated;
