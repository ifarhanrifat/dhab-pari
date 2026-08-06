-- Migration 123: Portal notifications (Part D). notifications.recipient_id
-- is a hard FK to admin_users(id) — not reusable for a different identity
-- class without a schema change, so this mirrors its shape as a parallel
-- table rather than overloading one shared table with a dual-FK. Unlike the
-- staff version, portal users get a DELETE-own policy (staff notifications
-- deliberately have none — this was an explicit ask for the portal).

CREATE TABLE IF NOT EXISTS portal_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  event_type varchar NOT NULL,
  title varchar NOT NULL,
  body text,
  link varchar,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS portal_notifications_recipient_idx ON portal_notifications(portal_user_id, is_read);

ALTER TABLE portal_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "portal_notifications_read_own" ON portal_notifications FOR SELECT TO authenticated
  USING (portal_user_id = current_portal_user_id());
CREATE POLICY "portal_notifications_update_own" ON portal_notifications FOR UPDATE TO authenticated
  USING (portal_user_id = current_portal_user_id()) WITH CHECK (portal_user_id = current_portal_user_id());
CREATE POLICY "portal_notifications_delete_own" ON portal_notifications FOR DELETE TO authenticated
  USING (portal_user_id = current_portal_user_id());
-- No client INSERT policy — only broadcast_portal_notification() (below) and
-- future SECURITY DEFINER triggers may create rows, same convention as
-- staff `notifications`.

-- Emergency-appeal broadcast — one row per active portal user. Staff-only
-- (super_admin/admin), same gate as notification_preferences_write.
CREATE OR REPLACE FUNCTION broadcast_portal_notification(p_event_type varchar, p_title varchar, p_body text, p_link varchar) RETURNS int AS $$
DECLARE
  v_count int;
BEGIN
  IF current_admin_role() NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Not authorized to send a broadcast';
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT id, p_event_type, p_title, p_body, p_link FROM portal_users WHERE is_active = true;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION broadcast_portal_notification(varchar, varchar, text, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION broadcast_portal_notification(varchar, varchar, text, varchar) TO authenticated;
