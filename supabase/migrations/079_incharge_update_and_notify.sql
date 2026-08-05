-- Migration 079: Two bugs from real usage of the Task Todo incharge workflow
-- (migration 073):
--
--   1. A viewer-role incharge got "new row violates row-level security
--      policy" trying to update their assigned task's status. Expected:
--      current_admin_permission() hard-blocks plain viewers from
--      'edit_transactions' regardless of any individual can_* flag (migration
--      066) — that's by design for transactions generally, but an incharge
--      needs to move THEIR OWN assigned task through Assigned/In
--      Progress/Done. Fix: a second RLS path keyed on
--      incharge_user_id = current_admin_user_id(), plus a guard trigger that
--      clamps every non-task-workflow column back to its prior value when
--      the row is only reachable via that path — so a viewer incharge can
--      move task_status/notes/etc. but can never touch financial or
--      consumer-identity fields through this door, even via a crafted request.
--   2. No popup notification fired when an admin assigned/reassigned an
--      incharge — same pattern already used for complaint assignment
--      (trg_complaint_assigned_log, migration 063), just for
--      connection_requests.incharge_user_id.

-- 1a. Guard trigger — runs for every update; only actually clamps columns
-- when the acting user doesn't have edit_transactions (i.e. is relying on the
-- incharge path).
CREATE OR REPLACE FUNCTION trg_connection_request_incharge_guard() RETURNS trigger AS $$
BEGIN
  IF current_admin_permission('edit_transactions') THEN
    RETURN NEW;
  END IF;

  IF NEW.incharge_user_id IS DISTINCT FROM current_admin_user_id() AND OLD.incharge_user_id IS DISTINCT FROM current_admin_user_id() THEN
    RAISE EXCEPTION 'Not authorized to update this connection request';
  END IF;

  -- Only task-workflow columns may change through the incharge-only path.
  NEW.status := OLD.status;
  NEW.consumer_name := OLD.consumer_name;
  NEW.consumer_phone := OLD.consumer_phone;
  NEW.consumer_address := OLD.consumer_address;
  NEW.father_husband_name := OLD.father_husband_name;
  NEW.whatsapp_number := OLD.whatsapp_number;
  NEW.whatsapp_same_as_mobile := OLD.whatsapp_same_as_mobile;
  NEW.house_no := OLD.house_no;
  NEW.area := OLD.area;
  NEW.connections := OLD.connections;
  NEW.sector := OLD.sector;
  NEW.requested_date := OLD.requested_date;
  NEW.description := OLD.description;
  NEW.wants_inventory_from_us := OLD.wants_inventory_from_us;
  NEW.plumber_charge := OLD.plumber_charge;
  NEW.digging_charge := OLD.digging_charge;
  NEW.security_deposit_amount := OLD.security_deposit_amount;
  NEW.total_amount := OLD.total_amount;
  NEW.bill_id := OLD.bill_id;
  NEW.payment_id := OLD.payment_id;
  NEW.consumer_id := OLD.consumer_id;
  NEW.recurring_schedule_id := OLD.recurring_schedule_id;
  NEW.incharge_user_id := OLD.incharge_user_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS connection_request_incharge_guard_trigger ON connection_requests;
CREATE TRIGGER connection_request_incharge_guard_trigger BEFORE UPDATE ON connection_requests
  FOR EACH ROW EXECUTE FUNCTION trg_connection_request_incharge_guard();

-- 1b. RLS: allow the update through if either the normal edit_transactions
-- grant applies, or the caller is this row's incharge (the trigger above is
-- what actually limits what an incharge-only caller can change).
DROP POLICY IF EXISTS "connection_requests_update" ON connection_requests;
CREATE POLICY "connection_requests_update" ON connection_requests FOR UPDATE TO authenticated
  USING (can_access_system('water_supply') AND (current_admin_permission('edit_transactions') OR incharge_user_id = current_admin_user_id()))
  WITH CHECK (can_access_system('water_supply') AND (current_admin_permission('edit_transactions') OR incharge_user_id = current_admin_user_id()));

-- 2. Notify on assignment, same pattern as complaints.
INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('task_incharge_assigned', 'A new-connection installation task is assigned to you', false, true)
ON CONFLICT (event_type) DO NOTHING;

CREATE OR REPLACE FUNCTION trg_connection_request_incharge_notify() RETURNS trigger AS $$
DECLARE
  v_popup_enabled boolean;
BEGIN
  IF NEW.incharge_user_id IS DISTINCT FROM OLD.incharge_user_id AND NEW.incharge_user_id IS NOT NULL THEN
    SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'task_incharge_assigned';
    IF v_popup_enabled IS DISTINCT FROM false THEN
      INSERT INTO notifications (recipient_id, event_type, title, body, link)
      VALUES (NEW.incharge_user_id, 'task_incharge_assigned',
        'Installation task assigned to you — ' || COALESCE(NEW.request_number, ''),
        NEW.consumer_name || COALESCE(' · ' || NEW.sector, ''), '/admin/tasks');
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS connection_request_incharge_notify_trigger ON connection_requests;
CREATE TRIGGER connection_request_incharge_notify_trigger AFTER UPDATE OF incharge_user_id ON connection_requests
  FOR EACH ROW EXECUTE FUNCTION trg_connection_request_incharge_notify();
