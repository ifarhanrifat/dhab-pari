-- Migration 076: Admin-editable WhatsApp message templates. Body is plain
-- Unicode text — admin writes in Urdu, English, or a mix, whatever they want.
-- Placeholders use the %%key%% convention (matching the reference app the
-- request was modeled on), substituted client-side via renderTemplate() in
-- src/lib/messageTemplates.ts.
CREATE TABLE IF NOT EXISTS message_templates (
  key varchar PRIMARY KEY,
  label varchar NOT NULL,
  body text NOT NULL,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "message_templates_read" ON message_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY "message_templates_write" ON message_templates FOR UPDATE TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin'))
  WITH CHECK (current_admin_role() IN ('super_admin', 'admin'));

INSERT INTO message_templates (key, label, body) VALUES
  ('connection_activated', 'A new connection is activated',
   '*Dhab Pari Water Committee*

Congratulations %%name%%! Your new water connection (%%consumer_id%%) has been installed and activated. Monthly bill: Rs. %%monthly_amount%%.

Thank you for connecting with us.'),
  ('bill_reminder_weekly', 'Weekly reminder for an overdue bill',
   '*Dhab Pari Water Committee*

Dear %%name%%, your water bill of Rs. %%outstanding%% (Consumer No: %%consumer_id%%) was due on %%due_date%%. Please pay at your earliest convenience.'),
  ('bill_defaulter_warning', '2-month defaulter warning',
   '*Dhab Pari Water Committee*

Dear %%name%%, your water bill of Rs. %%outstanding%% is now 2 months overdue. Please pay immediately to avoid disconnection. A reconnection charge of Rs. %%restore_fee%% will apply if your connection is discontinued.'),
  ('donor_recurring_reminder', 'Recurring donor reminder',
   '*Dhab Pari Water Committee*

Dear %%name%%, thank you for your continued support. Your next contribution of Rs. %%amount%% is due around %%due_date%%. We truly appreciate your generosity.'),
  ('consumer_outstanding_notify', 'Manual "Notify" button on Billing page',
   '*Dhab Pari Water Committee*

Dear %%name%%, your outstanding water bill is Rs. %%outstanding%% (%%pending_count%% bill(s) pending). Consumer No: %%consumer_id%%. Please pay at your earliest convenience. Thank you.')
ON CONFLICT (key) DO NOTHING;

-- Configurable reconnection fee, substituted into bill_defaulter_warning as %%restore_fee%%.
INSERT INTO site_settings (key, value, description) VALUES
  ('defaulter_restore_fee', '5000', 'Reconnection charge quoted in the 2-month defaulter warning message')
ON CONFLICT (key) DO NOTHING;
