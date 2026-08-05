-- Migration 111: Emergency job broadcast + meeting-due reminders (10th/20th/
-- 30th of each month). Both stay on the deep-link/tap-to-send WhatsApp
-- convention already used throughout this app (no WhatsApp Business API).

-- 1. Emergency jobs — a distinct kind of task raised outside the normal
-- per-meeting allocation flow, broadcast to every committee member at once.
-- Reuses agenda_item_assignees/mark_agenda_item_done/the assignment
-- notification trigger completely unchanged: "broadcast to everyone" is just
-- "assign every committee member," which those already handle correctly.
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS is_emergency boolean NOT NULL DEFAULT false;
-- General field (not emergency-only) — no task previously recorded who
-- raised it; needed here to show "called by" on emergency jobs specifically.
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS created_by_admin_user_id uuid REFERENCES admin_users(id);

-- 2. Extend reminder_queue (077) with a 4th tier: meeting-due reminders.
-- Not system-scoped (water_supply/donors_projects) like the other three —
-- Meetings & Agenda is committee-wide — so its RLS branches are open to any
-- authenticated admin_user rather than gated by can_access_system/
-- post_transactions.
DO $$
DECLARE
  v_constraint_name text;
BEGIN
  SELECT conname INTO v_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'reminder_queue'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%reminder_type%';
  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE reminder_queue DROP CONSTRAINT %I', v_constraint_name);
  END IF;
END $$;
ALTER TABLE reminder_queue ADD CONSTRAINT reminder_queue_reminder_type_check
  CHECK (reminder_type IN ('bill_weekly', 'bill_defaulter', 'donor_recurring', 'meeting_due'));

DROP POLICY IF EXISTS "reminder_queue_read" ON reminder_queue;
CREATE POLICY "reminder_queue_read" ON reminder_queue FOR SELECT TO authenticated
  USING (
    (reminder_type IN ('bill_weekly', 'bill_defaulter') AND can_access_system('water_supply'))
    OR (reminder_type = 'donor_recurring' AND can_access_system('donors_projects'))
    OR (reminder_type = 'meeting_due')
  );
DROP POLICY IF EXISTS "reminder_queue_update" ON reminder_queue;
CREATE POLICY "reminder_queue_update" ON reminder_queue FOR UPDATE TO authenticated
  USING (
    (reminder_type IN ('bill_weekly', 'bill_defaulter') AND can_access_system('water_supply') AND current_admin_permission('post_transactions'))
    OR (reminder_type = 'donor_recurring' AND can_access_system('donors_projects') AND current_admin_permission('post_transactions'))
    OR (reminder_type = 'meeting_due')
  )
  WITH CHECK (true);

INSERT INTO message_templates (key, label, body) VALUES
  ('meeting_due_reminder', 'Meeting-due reminder (10th/20th/30th of each month)',
   'میٹنگ کی تاریخ قریب ہے، شرکت لازمی ہے۔ ایجنڈا پڑھیں اور کم از کم 2 تجاویز کے ساتھ آئیں۔ ایجنڈا یہاں دیکھیں: %%link%%')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION run_meeting_due_reminder_sweep() RETURNS void AS $$
DECLARE
  v_body text;
  v_site_url text;
  v_popup_enabled boolean;
  r record;
BEGIN
  SELECT COALESCE(body, 'میٹنگ کی تاریخ قریب ہے، شرکت لازمی ہے۔ ایجنڈا پڑھیں اور کم از کم 2 تجاویز کے ساتھ آئیں۔ ایجنڈا یہاں دیکھیں: %%link%%')
    INTO v_body FROM message_templates WHERE key = 'meeting_due_reminder';
  v_body := COALESCE(v_body, 'میٹنگ کی تاریخ قریب ہے، شرکت لازمی ہے۔ ایجنڈا پڑھیں اور کم از کم 2 تجاویز کے ساتھ آئیں۔ ایجنڈا یہاں دیکھیں: %%link%%');
  SELECT COALESCE(value, 'https://dhabpari.com') INTO v_site_url FROM site_settings WHERE key = 'site_url';
  v_site_url := COALESCE(v_site_url, 'https://dhabpari.com');
  SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'meeting_due_reminder';

  -- Scoped delete — must never touch the other three tiers' pending rows,
  -- which run on a different (weekly) schedule.
  DELETE FROM reminder_queue WHERE status = 'pending' AND reminder_type = 'meeting_due';

  FOR r IN
    SELECT cm.id AS committee_member_id, cm.name,
      CASE WHEN cm.uses_smartphone AND cm.admin_user_id IS NOT NULL THEN cm.phone ELSE proxy.mobile END AS phone,
      COALESCE(cm.admin_user_id, cm.proxy_admin_user_id) AS recipient_admin_user_id
    FROM committee_members cm
    LEFT JOIN admin_users proxy ON proxy.id = cm.proxy_admin_user_id
    WHERE cm.is_active = true
  LOOP
    INSERT INTO reminder_queue (reminder_type, target_name, target_phone, message)
    VALUES ('meeting_due', r.name, r.phone, replace(v_body, '%%link%%', v_site_url || '/admin/tasks/meetings'));

    IF r.recipient_admin_user_id IS NOT NULL AND v_popup_enabled IS DISTINCT FROM false THEN
      INSERT INTO notifications (recipient_id, event_type, title, body, link)
      VALUES (r.recipient_admin_user_id, 'meeting_due_reminder', 'Meeting reminder',
        replace(v_body, '%%link%%', '/admin/tasks/meetings'), '/admin/tasks/meetings');
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('meeting_due_reminder', 'Recurring meeting-due reminder (10th/20th/30th)', true, true)
ON CONFLICT (event_type) DO NOTHING;

SELECT cron.schedule('meeting-due-reminder', '0 8 10,20,30 * *', $$SELECT run_meeting_due_reminder_sweep()$$);
