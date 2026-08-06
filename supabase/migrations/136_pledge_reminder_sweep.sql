-- Migration 136: 4th reminder tier — unpaid pledges ("Announce a Pledge" on
-- a project, migration 133). Same weekly sweep, same staff tap-to-send
-- WhatsApp queue as the other 3 tiers, PLUS an automatic in-app
-- portal_notifications reminder (no human tap needed for that half, since
-- it's free/instant unlike WhatsApp).

ALTER TABLE reminder_queue DROP CONSTRAINT IF EXISTS reminder_queue_reminder_type_check;
ALTER TABLE reminder_queue ADD CONSTRAINT reminder_queue_reminder_type_check
  CHECK (reminder_type IN ('bill_weekly', 'bill_defaulter', 'donor_recurring', 'meeting_due', 'donor_pledge_unpaid'));
ALTER TABLE reminder_queue ADD COLUMN IF NOT EXISTS donor_id uuid REFERENCES donors(id) ON DELETE CASCADE;

DROP POLICY IF EXISTS "reminder_queue_read" ON reminder_queue;
CREATE POLICY "reminder_queue_read" ON reminder_queue FOR SELECT TO authenticated
  USING (
    (reminder_type IN ('bill_weekly', 'bill_defaulter') AND can_access_system('water_supply'))
    OR (reminder_type IN ('donor_recurring', 'donor_pledge_unpaid') AND can_access_system('donors_projects'))
    OR (reminder_type = 'meeting_due')
  );
DROP POLICY IF EXISTS "reminder_queue_update" ON reminder_queue;
CREATE POLICY "reminder_queue_update" ON reminder_queue FOR UPDATE TO authenticated
  USING (
    (reminder_type IN ('bill_weekly', 'bill_defaulter') AND can_access_system('water_supply') AND current_admin_permission('post_transactions'))
    OR (reminder_type IN ('donor_recurring', 'donor_pledge_unpaid') AND can_access_system('donors_projects') AND current_admin_permission('post_transactions'))
    OR (reminder_type = 'meeting_due')
  )
  WITH CHECK (true);

INSERT INTO message_templates (key, label, body) VALUES (
  'donor_pledge_reminder', 'Unpaid Pledge Reminder',
  'Dear %%name%%, you announced a pledge of Rs. %%amount%% on %%date%%. We haven''t received your payment yet — please pay at your earliest convenience and submit it from your portal so we can confirm it.'
) ON CONFLICT (key) DO NOTHING;

-- Full body carried forward from migration 077 (still the only prior
-- definition), with Tier 4 appended.
CREATE OR REPLACE FUNCTION run_reminder_sweep() RETURNS void AS $$
DECLARE
  v_weekly_body text;
  v_defaulter_body text;
  v_donor_body text;
  v_pledge_body text;
  v_restore_fee text;
  r record;
BEGIN
  SELECT COALESCE(body, 'Dear %%name%%, your water bill of Rs. %%outstanding%% (Consumer No: %%consumer_id%%) was due on %%due_date%%. Please pay at your earliest convenience.')
    INTO v_weekly_body FROM message_templates WHERE key = 'bill_reminder_weekly';
  SELECT COALESCE(body, 'Dear %%name%%, your water bill of Rs. %%outstanding%% is now 2 months overdue. Please pay immediately to avoid disconnection. A reconnection charge of Rs. %%restore_fee%% will apply if your connection is discontinued.')
    INTO v_defaulter_body FROM message_templates WHERE key = 'bill_defaulter_warning';
  SELECT COALESCE(body, 'Dear %%name%%, thank you for your continued support. Your next contribution of Rs. %%amount%% is due around %%due_date%%. We truly appreciate your generosity.')
    INTO v_donor_body FROM message_templates WHERE key = 'donor_recurring_reminder';
  SELECT COALESCE(body, 'Dear %%name%%, you announced a pledge of Rs. %%amount%% on %%date%%. We haven''t received your payment yet — please pay at your earliest convenience and submit it from your portal so we can confirm it.')
    INTO v_pledge_body FROM message_templates WHERE key = 'donor_pledge_reminder';
  SELECT COALESCE(value, '5000') INTO v_restore_fee FROM site_settings WHERE key = 'defaulter_restore_fee';
  v_weekly_body := COALESCE(v_weekly_body, 'Dear %%name%%, your water bill of Rs. %%outstanding%% (Consumer No: %%consumer_id%%) was due on %%due_date%%. Please pay at your earliest convenience.');
  v_defaulter_body := COALESCE(v_defaulter_body, 'Dear %%name%%, your water bill of Rs. %%outstanding%% is now 2 months overdue. Please pay immediately to avoid disconnection. A reconnection charge of Rs. %%restore_fee%% will apply if your connection is discontinued.');
  v_donor_body := COALESCE(v_donor_body, 'Dear %%name%%, thank you for your continued support. Your next contribution of Rs. %%amount%% is due around %%due_date%%. We truly appreciate your generosity.');
  v_pledge_body := COALESCE(v_pledge_body, 'Dear %%name%%, you announced a pledge of Rs. %%amount%% on %%date%%. We haven''t received your payment yet — please pay at your earliest convenience.');
  v_restore_fee := COALESCE(v_restore_fee, '5000');

  -- Scoped to exclude meeting_due — the original migration 077 body deleted
  -- ALL pending rows here regardless of type, which would silently wipe out
  -- run_meeting_due_reminder_sweep()'s (migration 111) pending rows every
  -- Sunday even though this function never repopulates that tier. Fixed
  -- while touching this function for Tier 4 below.
  DELETE FROM reminder_queue WHERE status = 'pending' AND reminder_type != 'meeting_due';

  FOR r IN
    WITH outstanding_calc AS (
      SELECT b.consumer_id,
        SUM(GREATEST(b.amount_pkr - COALESCE(b.discount_amount, 0) - COALESCE(b.paid_amount, 0), 0)) AS outstanding,
        MAX(b.due_date) AS latest_due_date
      FROM bills b
      JOIN consumers c ON c.consumer_id = b.consumer_id
      WHERE c.status = 'active'
      GROUP BY b.consumer_id
      HAVING SUM(GREATEST(b.amount_pkr - COALESCE(b.discount_amount, 0) - COALESCE(b.paid_amount, 0), 0)) > 0
    )
    SELECT c.consumer_id, c.name, COALESCE(NULLIF(c.whatsapp_number, ''), c.mobile) AS phone, oc.outstanding, oc.latest_due_date
    FROM outstanding_calc oc JOIN consumers c ON c.consumer_id = oc.consumer_id
    WHERE oc.consumer_id NOT IN (SELECT consumer_id FROM consumer_nonpayment_flags)
  LOOP
    INSERT INTO reminder_queue (reminder_type, target_name, target_phone, message, amount, consumer_id)
    VALUES ('bill_weekly', r.name, r.phone,
      replace(replace(replace(replace(v_weekly_body,
        '%%name%%', r.name), '%%consumer_id%%', r.consumer_id),
        '%%outstanding%%', to_char(r.outstanding, 'FM999999990.00')),
        '%%due_date%%', COALESCE(to_char(r.latest_due_date, 'DD Mon YYYY'), 'N/A')),
      r.outstanding, r.consumer_id);
  END LOOP;

  FOR r IN
    SELECT f.consumer_id, c.name, COALESCE(NULLIF(c.whatsapp_number, ''), c.mobile) AS phone, f.total_outstanding
    FROM consumer_nonpayment_flags f JOIN consumers c ON c.consumer_id = f.consumer_id
  LOOP
    INSERT INTO reminder_queue (reminder_type, target_name, target_phone, message, amount, consumer_id)
    VALUES ('bill_defaulter', r.name, r.phone,
      replace(replace(replace(replace(v_defaulter_body,
        '%%name%%', r.name), '%%consumer_id%%', r.consumer_id),
        '%%outstanding%%', to_char(r.total_outstanding, 'FM999999990.00')),
        '%%restore_fee%%', v_restore_fee),
      r.total_outstanding, r.consumer_id);
  END LOOP;

  FOR r IN
    SELECT id, COALESCE(donor_name, 'Donor') AS donor_name, donor_phone, amount_pkr, next_run_date
    FROM recurring_schedules
    WHERE is_active = true AND schedule_type = 'donation' AND next_run_date <= now() + interval '7 days'
  LOOP
    INSERT INTO reminder_queue (reminder_type, target_name, target_phone, message, amount, recurring_schedule_id)
    VALUES ('donor_recurring', r.donor_name, r.donor_phone,
      replace(replace(replace(v_donor_body,
        '%%name%%', r.donor_name),
        '%%amount%%', to_char(r.amount_pkr, 'FM999999990.00')),
        '%%due_date%%', to_char(r.next_run_date, 'DD Mon YYYY')),
      r.amount_pkr, r.id);
  END LOOP;

  -- Tier 4: unpaid pledges — staff WhatsApp queue + an automatic in-app
  -- reminder for the donor themselves (no tap needed for the in-app half).
  FOR r IN
    SELECT id, name, COALESCE(NULLIF(whatsapp_number, ''), phone) AS phone, amount_pkr, date, portal_user_id
    FROM donors
    WHERE payment_status = 'pledged' AND is_verified = false
  LOOP
    INSERT INTO reminder_queue (reminder_type, target_name, target_phone, message, amount, donor_id)
    VALUES ('donor_pledge_unpaid', r.name, r.phone,
      replace(replace(replace(v_pledge_body,
        '%%name%%', r.name),
        '%%amount%%', to_char(r.amount_pkr, 'FM999999990.00')),
        '%%date%%', to_char(r.date, 'DD Mon YYYY')),
      r.amount_pkr, r.id);

    IF r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (r.portal_user_id, 'pledge_reminder', 'Unpaid Pledge Reminder',
        'You pledged Rs. ' || to_char(r.amount_pkr, 'FM999999990.00') || ' — pay it anytime from your portal.',
        '/portal/statement');
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
