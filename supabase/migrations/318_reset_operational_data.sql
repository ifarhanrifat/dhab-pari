-- Migration 318: Reset Operational & Engagement Data — the third and
-- final companion to reset_accounting_system() (067) and
-- reset_welfare_and_projects_data() (313), covering everything neither of
-- those touches: Meetings & Agenda (and the achievements the public site
-- shows are just finalized agenda items — clearing agenda_items/meetings
-- clears those too, no separate table), reminders, employees, suggestions,
-- complaints, the news ticker, appeals, notifications, the blood donor
-- registry, job listings, monthly closing reports, and the audit log.
--
-- Every sequence verified in a rollback-safe transaction before this
-- migration was written, same discipline as 313-317.
--
-- Deliberately NOT touched, and why:
--   - complaint_handlers, notification_preferences, employee_roles — these
--     are configuration (who handles what, which channel is on, what
--     roles exist), not records of a specific test event.
--   - service_items — only 2 rows exist and one (Water Supply Monthly
--     Bill) is actively referenced by the live New Connection template
--     (connection_template_items); deleting it would break new-connection
--     requests, not clear test data. Left as-is rather than silently
--     breaking a real workflow.
--   - inventory_items IS trimmed to a single default row (per explicit
--     request) since none of the 4 rows had any real historical reference
--     left (bill_line_items is already empty) — the kept row's own stock
--     quantity is zeroed too, so it reads as a fresh example, not
--     leftover test stock.
CREATE OR REPLACE FUNCTION reset_operational_data() RETURNS void AS $$
DECLARE
  v_keep_inventory_item_id uuid;
BEGIN
  IF NOT current_admin_is_super_admin() THEN
    RAISE EXCEPTION 'Only a Super Admin can reset operational data';
  END IF;

  ALTER TABLE agenda_meetings DISABLE TRIGGER USER;
  ALTER TABLE agenda_items DISABLE TRIGGER USER;
  ALTER TABLE agenda_item_assignees DISABLE TRIGGER USER;
  ALTER TABLE reminder_queue DISABLE TRIGGER USER;
  ALTER TABLE employees DISABLE TRIGGER USER;
  ALTER TABLE employee_payslips DISABLE TRIGGER USER;
  ALTER TABLE suggestions DISABLE TRIGGER USER;
  ALTER TABLE complaints DISABLE TRIGGER USER;
  ALTER TABLE complaint_updates DISABLE TRIGGER USER;
  ALTER TABLE news_ticker DISABLE TRIGGER USER;
  ALTER TABLE appeals DISABLE TRIGGER USER;
  ALTER TABLE notifications DISABLE TRIGGER USER;
  ALTER TABLE notifications_log DISABLE TRIGGER USER;
  ALTER TABLE portal_notifications DISABLE TRIGGER USER;
  ALTER TABLE blood_donors DISABLE TRIGGER USER;
  ALTER TABLE blood_requests DISABLE TRIGGER USER;
  ALTER TABLE blood_request_contacts DISABLE TRIGGER USER;
  ALTER TABLE job_listings DISABLE TRIGGER USER;
  ALTER TABLE monthly_closing_reports DISABLE TRIGGER USER;
  ALTER TABLE audit_log DISABLE TRIGGER USER;
  ALTER TABLE inventory_items DISABLE TRIGGER USER;

  DELETE FROM agenda_item_assignees WHERE true;
  DELETE FROM agenda_items WHERE true;
  DELETE FROM agenda_meetings WHERE true;

  DELETE FROM reminder_queue WHERE true;

  DELETE FROM employees WHERE true;  -- cascades employee_payslips

  DELETE FROM suggestions WHERE true;

  DELETE FROM complaints WHERE true;  -- cascades complaint_updates

  DELETE FROM news_ticker WHERE true;

  DELETE FROM appeals WHERE true;

  DELETE FROM notifications WHERE true;
  DELETE FROM notifications_log WHERE true;
  DELETE FROM portal_notifications WHERE true;

  DELETE FROM blood_request_contacts WHERE true;
  DELETE FROM blood_requests WHERE true;
  DELETE FROM blood_donors WHERE true;

  DELETE FROM job_listings WHERE true;

  DELETE FROM monthly_closing_reports WHERE true;

  DELETE FROM audit_log WHERE true;

  -- Keep exactly one inventory item as a working example — whichever one
  -- happens to sort first is as good as any, since all 4 were equally
  -- generic test rows.
  SELECT id INTO v_keep_inventory_item_id FROM inventory_items ORDER BY created_at LIMIT 1;
  IF v_keep_inventory_item_id IS NOT NULL THEN
    DELETE FROM inventory_items WHERE id <> v_keep_inventory_item_id;
    UPDATE inventory_items SET quantity_on_hand = 0 WHERE id = v_keep_inventory_item_id;
  END IF;

  ALTER TABLE agenda_meetings ENABLE TRIGGER USER;
  ALTER TABLE agenda_items ENABLE TRIGGER USER;
  ALTER TABLE agenda_item_assignees ENABLE TRIGGER USER;
  ALTER TABLE reminder_queue ENABLE TRIGGER USER;
  ALTER TABLE employees ENABLE TRIGGER USER;
  ALTER TABLE employee_payslips ENABLE TRIGGER USER;
  ALTER TABLE suggestions ENABLE TRIGGER USER;
  ALTER TABLE complaints ENABLE TRIGGER USER;
  ALTER TABLE complaint_updates ENABLE TRIGGER USER;
  ALTER TABLE news_ticker ENABLE TRIGGER USER;
  ALTER TABLE appeals ENABLE TRIGGER USER;
  ALTER TABLE notifications ENABLE TRIGGER USER;
  ALTER TABLE notifications_log ENABLE TRIGGER USER;
  ALTER TABLE portal_notifications ENABLE TRIGGER USER;
  ALTER TABLE blood_donors ENABLE TRIGGER USER;
  ALTER TABLE blood_requests ENABLE TRIGGER USER;
  ALTER TABLE blood_request_contacts ENABLE TRIGGER USER;
  ALTER TABLE job_listings ENABLE TRIGGER USER;
  ALTER TABLE monthly_closing_reports ENABLE TRIGGER USER;
  ALTER TABLE audit_log ENABLE TRIGGER USER;
  ALTER TABLE inventory_items ENABLE TRIGGER USER;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION reset_operational_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reset_operational_data() TO authenticated;
