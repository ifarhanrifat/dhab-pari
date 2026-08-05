-- Migration 077: Automated reminder queue. No WhatsApp Business API is
-- connected, so "automated" means the system computes who needs a message and
-- prepares it every Sunday — a staff member still taps Send on the Reminders
-- page to actually open WhatsApp and send it (same wa.me deep-link approach
-- used everywhere else in the app).
--
-- Reuses two things that already exist rather than re-deriving them:
--   - consumer_nonpayment_flags (migration 064) already detects exactly
--     "2 consecutive unpaid months" — the defaulter tier reads it directly.
--   - recurring_schedules with schedule_type='donation' already has donor
--     name/phone/amount/next_run_date — the donor tier reads it directly.

CREATE TABLE IF NOT EXISTS reminder_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_type varchar NOT NULL CHECK (reminder_type IN ('bill_weekly', 'bill_defaulter', 'donor_recurring')),
  target_name varchar NOT NULL,
  target_phone varchar,
  message text NOT NULL,
  amount decimal,
  status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped')),
  consumer_id varchar REFERENCES consumers(consumer_id),
  recurring_schedule_id uuid REFERENCES recurring_schedules(id),
  created_at timestamptz DEFAULT now(),
  sent_at timestamptz
);

ALTER TABLE reminder_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "reminder_queue_read" ON reminder_queue FOR SELECT TO authenticated
  USING (
    (reminder_type IN ('bill_weekly', 'bill_defaulter') AND can_access_system('water_supply'))
    OR (reminder_type = 'donor_recurring' AND can_access_system('donors_projects'))
  );
CREATE POLICY "reminder_queue_update" ON reminder_queue FOR UPDATE TO authenticated
  USING (
    (reminder_type IN ('bill_weekly', 'bill_defaulter') AND can_access_system('water_supply') AND current_admin_permission('post_transactions'))
    OR (reminder_type = 'donor_recurring' AND can_access_system('donors_projects') AND current_admin_permission('post_transactions'))
  )
  WITH CHECK (true);
-- No client INSERT/DELETE policy — only the sweep function below writes rows,
-- same pattern as consumer_nonpayment_flags.

CREATE OR REPLACE FUNCTION run_reminder_sweep() RETURNS void AS $$
DECLARE
  v_weekly_body text;
  v_defaulter_body text;
  v_donor_body text;
  v_restore_fee text;
  r record;
BEGIN
  SELECT COALESCE(body, 'Dear %%name%%, your water bill of Rs. %%outstanding%% (Consumer No: %%consumer_id%%) was due on %%due_date%%. Please pay at your earliest convenience.')
    INTO v_weekly_body FROM message_templates WHERE key = 'bill_reminder_weekly';
  SELECT COALESCE(body, 'Dear %%name%%, your water bill of Rs. %%outstanding%% is now 2 months overdue. Please pay immediately to avoid disconnection. A reconnection charge of Rs. %%restore_fee%% will apply if your connection is discontinued.')
    INTO v_defaulter_body FROM message_templates WHERE key = 'bill_defaulter_warning';
  SELECT COALESCE(body, 'Dear %%name%%, thank you for your continued support. Your next contribution of Rs. %%amount%% is due around %%due_date%%. We truly appreciate your generosity.')
    INTO v_donor_body FROM message_templates WHERE key = 'donor_recurring_reminder';
  SELECT COALESCE(value, '5000') INTO v_restore_fee FROM site_settings WHERE key = 'defaulter_restore_fee';
  v_weekly_body := COALESCE(v_weekly_body, 'Dear %%name%%, your water bill of Rs. %%outstanding%% (Consumer No: %%consumer_id%%) was due on %%due_date%%. Please pay at your earliest convenience.');
  v_defaulter_body := COALESCE(v_defaulter_body, 'Dear %%name%%, your water bill of Rs. %%outstanding%% is now 2 months overdue. Please pay immediately to avoid disconnection. A reconnection charge of Rs. %%restore_fee%% will apply if your connection is discontinued.');
  v_donor_body := COALESCE(v_donor_body, 'Dear %%name%%, thank you for your continued support. Your next contribution of Rs. %%amount%% is due around %%due_date%%. We truly appreciate your generosity.');
  v_restore_fee := COALESCE(v_restore_fee, '5000');

  -- Last week's un-sent items don't pile up — still-overdue consumers get a
  -- fresh row below anyway.
  DELETE FROM reminder_queue WHERE status = 'pending';

  -- Tier 1: active consumers with an outstanding balance, not yet flagged as
  -- a 2-month defaulter.
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

  -- Tier 2: already flagged by the existing 2-month non-payment sweep.
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

  -- Tier 3: recurring donors due within the next 7 days.
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
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

SELECT cron.schedule('weekly-reminder-sweep', '0 9 * * 0', $$SELECT run_reminder_sweep()$$);
