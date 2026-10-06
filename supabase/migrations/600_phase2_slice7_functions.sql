-- Phase 2, slice 7 (functions): every function touching only slice-7
-- tables (meetings/agenda + approval workflow), reproduced from the real,
-- current body (pulled live via pg_get_functiondef) with only the minimal
-- tenant-scoping fix applied.
--
-- The most serious finding this slice: get_transactions_workspace_documents
-- was classified "mixed"/deferred in every earlier slice purely because it
-- also touched approval_requests (not yet scoped) -- but once pulled and
-- read in full, it turns out NONE of its other six tables (bills,
-- payments, vouchers, purchases, donors, voucher_line_items/
-- purchase_line_items/inventory_transactions), despite ALL being already
-- tenant-scoped since earlier slices, were ever filtered by tenant in this
-- function. This is the admin "recent transactions" workspace screen --
-- an admin from any tenant could see every OTHER tenant's recent bills,
-- payments, vouchers, donations and purchases. This is the risk flagged
-- in this phase's own methodology (a function deferred for one blocking
-- table can hide unrelated, already-exploitable gaps in its other table
-- references) -- now fully fixed.
--
-- Cron job: run_agenda_reminder_sweep read notification_preferences as a
-- bare singleton (correctness bug once a second tenant sets the same key)
-- while sweeping every tenant's due tasks in one run -- fixed by moving
-- the check inside the loop, keyed by each task's own tenant_id (the
-- per-row resolve/insert were already transitively tenant-safe via FK
-- chains, so no full per-tenant restructuring was needed here).
--
-- Cross-tenant approver leaks: create_approval_request, get_approver_stats,
-- submit_purchase_for_approval, voucher_requires_approval all checked
-- approval_approvers by bare `system` name with no tenant filter --
-- 'donors_projects'/'water_supply' are shared system labels across every
-- tenant, so this would have pulled or counted another tenant's approvers
-- into the caller's own approval flow.
--
-- get_meetings_core_data (admin meetings dashboard) had no tenant filter
-- on any of its six subqueries -- would have shown every tenant's
-- meetings, committee members, admin users, agenda items/assignees and
-- complaints to any authenticated admin.
--
-- carry_forward_meeting's "find the previous meeting" lookup had no
-- tenant filter -- could have carried another tenant's unfinished tasks
-- into this tenant's new meeting.
--
-- Admin-gated ID-lookup mutators with no tenant filter: cancel_meeting,
-- finalize_meeting, mark_agenda_item_done, override_approve_confirmation,
-- resend_approval_notifications -- each fixed the same way as every other
-- instance of this bug class this phase.

create or replace function public.cancel_meeting(p_meeting_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF COALESCE(current_admin_role(), '') NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Only an admin can cancel a meeting.';
  END IF;
  UPDATE agenda_meetings SET status = 'cancelled' WHERE id = p_meeting_id AND status = 'open' AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Meeting not found or no longer open.'; END IF;
END;
$function$;

create or replace function public.carry_forward_meeting(p_new_meeting_id uuid)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_new_meeting agenda_meetings%ROWTYPE;
  v_prev_meeting_id uuid;
  v_count int := 0;
  r record;
  v_new_item_id uuid;
BEGIN
  SELECT * INTO v_new_meeting FROM agenda_meetings WHERE id = p_new_meeting_id AND tenant_id = my_tenant_id();
  IF v_new_meeting.id IS NULL THEN
    RAISE EXCEPTION 'Meeting not found.';
  END IF;

  SELECT id INTO v_prev_meeting_id FROM agenda_meetings
  WHERE meeting_date < v_new_meeting.meeting_date AND id != p_new_meeting_id AND status != 'cancelled' AND tenant_id = v_new_meeting.tenant_id
  ORDER BY meeting_date DESC LIMIT 1;

  IF v_prev_meeting_id IS NULL THEN
    RETURN 0;
  END IF;

  FOR r IN
    SELECT * FROM agenda_items
    WHERE meeting_id = v_prev_meeting_id AND kind = 'task' AND status != 'done'
  LOOP
    INSERT INTO agenda_items (meeting_id, kind, text_ur, display_order, due_date, category, carried_from_item_id, carry_count)
    VALUES (p_new_meeting_id, 'task', r.text_ur, r.display_order, r.due_date, r.category,
      COALESCE(r.carried_from_item_id, r.id), r.carry_count + 1)
    RETURNING id INTO v_new_item_id;

    INSERT INTO agenda_item_assignees (agenda_item_id, committee_member_id)
    SELECT v_new_item_id, committee_member_id FROM agenda_item_assignees WHERE agenda_item_id = r.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

create or replace function public.create_approval_request(p_system character varying, p_kind character varying, p_reference_id uuid, p_particular text, p_amount numeric, p_created_by uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_request_id uuid;
  v_popup_enabled boolean;
  r record;
BEGIN
  INSERT INTO approval_requests (system, kind, reference_id, particular, amount_pkr, created_by)
  VALUES (p_system, p_kind, p_reference_id, p_particular, p_amount, p_created_by)
  RETURNING id INTO v_request_id;

  INSERT INTO approval_confirmations (approval_request_id, approver_id)
  SELECT v_request_id, admin_user_id FROM approval_approvers WHERE system = p_system AND is_active = true AND tenant_id = my_tenant_id();

  SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'approval_requested' AND tenant_id = my_tenant_id();
  IF v_popup_enabled IS DISTINCT FROM false THEN
    FOR r IN SELECT admin_user_id FROM approval_approvers WHERE system = p_system AND is_active = true AND tenant_id = my_tenant_id() LOOP
      INSERT INTO notifications (recipient_id, event_type, title, body, link)
      VALUES (r.admin_user_id, 'approval_requested', 'Approval needed — Rs. ' || to_char(p_amount, 'FM999999990.00'), p_particular, '/admin/approvals');
    END LOOP;
  END IF;

  RETURN v_request_id;
END;
$function$;

create or replace function public.finalize_meeting(p_meeting_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF COALESCE(current_admin_role(), '') NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Only an admin can finalize a meeting.';
  END IF;
  UPDATE agenda_meetings SET status = 'finalized', finalized_at = now(), finalized_by = current_admin_user_id()
  WHERE id = p_meeting_id AND status = 'open' AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Meeting not found or already finalized.'; END IF;
END;
$function$;

create or replace function public.get_approver_stats(p_system character varying)
 returns TABLE(admin_user_id uuid, full_name character varying, pending_count bigint, approved_count bigint, rejected_count bigint, overridden_count bigint)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT
    au.id, au.full_name,
    COUNT(*) FILTER (WHERE sub.confirmed IS NULL AND sub.request_status = 'pending') AS pending_count,
    COUNT(*) FILTER (WHERE sub.confirmed = true AND sub.overridden_by IS NULL) AS approved_count,
    COUNT(*) FILTER (WHERE sub.confirmed = false) AS rejected_count,
    COUNT(*) FILTER (WHERE sub.overridden_by IS NOT NULL) AS overridden_count
  FROM admin_users au
  JOIN approval_approvers aa ON aa.admin_user_id = au.id AND aa.system = p_system AND aa.is_active = true AND aa.tenant_id = my_tenant_id()
  LEFT JOIN (
    SELECT ac.approver_id, ac.confirmed, ac.overridden_by, r.status AS request_status
    FROM approval_confirmations ac
    JOIN approval_requests r ON r.id = ac.approval_request_id
    WHERE r.system = p_system AND r.tenant_id = my_tenant_id()
  ) sub ON sub.approver_id = au.id
  WHERE can_access_system(p_system) AND au.tenant_id = my_tenant_id()
  GROUP BY au.id, au.full_name;
$function$;

create or replace function public.get_meetings_core_data()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN jsonb_build_object(
    'meetings', (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.meeting_date DESC), '[]'::jsonb) FROM agenda_meetings m WHERE m.tenant_id = my_tenant_id()),
    'members', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'name_ur', c.name_ur, 'position', c.position, 'position_ur', c.position_ur,
        'phone', c.phone, 'admin_user_id', c.admin_user_id, 'proxy_admin_user_id', c.proxy_admin_user_id,
        'uses_smartphone', c.uses_smartphone, 'handles_non_whatsapp_notice', c.handles_non_whatsapp_notice
      ) ORDER BY c.display_order), '[]'::jsonb) FROM committee_members c WHERE c.tenant_id = my_tenant_id()),
    'admin_users', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', a.id, 'full_name', a.full_name) ORDER BY a.full_name), '[]'::jsonb) FROM admin_users a WHERE a.is_active = true AND a.tenant_id = my_tenant_id()),
    'items', (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.display_order), '[]'::jsonb) FROM agenda_items i WHERE i.tenant_id = my_tenant_id()),
    'assignees', (SELECT COALESCE(jsonb_agg(to_jsonb(ai)), '[]'::jsonb) FROM agenda_item_assignees ai WHERE ai.tenant_id = my_tenant_id()),
    'complaints', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', co.id, 'complaint_number', co.complaint_number, 'complainant_name', co.complainant_name, 'sector', co.sector,
        'complaint_text', co.complaint_text, 'status', co.status, 'assigned_to', co.assigned_to, 'resolved_by', co.resolved_by,
        'resolved_at', co.resolved_at, 'created_at', co.created_at,
        'incharge_name', au1.full_name, 'resolved_by_name', au2.full_name
      ) ORDER BY co.created_at DESC), '[]'::jsonb)
      FROM complaints co
      LEFT JOIN admin_users au1 ON au1.id = co.assigned_to
      LEFT JOIN admin_users au2 ON au2.id = co.resolved_by
      WHERE can_access_system(co.system) AND co.tenant_id = my_tenant_id()
    ),
    'current_admin_id', (SELECT id FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1)
  );
END;
$function$;

-- get_transactions_workspace_documents: previously deferred solely because
-- of approval_requests -- every other table here (bills, payments,
-- vouchers, purchases, donors, voucher_line_items, purchase_line_items,
-- inventory_transactions/inventory_items) has had tenant_id since an
-- earlier slice but was never actually filtered by it in this function.
create or replace function public.get_transactions_workspace_documents(p_system character varying)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT can_access_system(p_system) THEN
    RAISE EXCEPTION 'Not authorized for this system';
  END IF;

  RETURN jsonb_build_object(
    'bills', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', b.id, 'bill_number', b.bill_number, 'consumer_id', b.consumer_id, 'month', b.month, 'year', b.year,
          'amount_pkr', b.amount_pkr, 'discount_amount', b.discount_amount, 'paid_amount', b.paid_amount,
          'due_date', b.due_date, 'description', b.description, 'created_at', b.created_at,
          'security_deposit_amount', b.security_deposit_amount, 'security_deposit_voucher_id', b.security_deposit_voucher_id,
          'recurring_schedule_id', b.recurring_schedule_id
        ) ORDER BY b.created_at DESC), '[]'::jsonb)
       FROM (SELECT * FROM bills WHERE tenant_id = my_tenant_id() ORDER BY created_at DESC LIMIT 50) b)
      ELSE '[]'::jsonb END,
    'payments', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', p.id, 'bill_id', p.bill_id, 'consumer_id', p.consumer_id, 'amount_pkr', p.amount_pkr, 'method', p.method,
          'paid_date', p.paid_date, 'receipt_no', p.receipt_no, 'note', p.note, 'created_at', p.created_at
        ) ORDER BY p.created_at DESC), '[]'::jsonb)
       FROM (SELECT * FROM payments WHERE tenant_id = my_tenant_id() ORDER BY created_at DESC LIMIT 50) p)
      ELSE '[]'::jsonb END,
    'vouchers', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', v.id, 'voucher_type', v.voucher_type, 'voucher_no', v.voucher_no, 'receipt_no', v.receipt_no,
        'voucher_date', v.voucher_date, 'particular', v.particular, 'amount_pkr', v.amount_pkr,
        'party_name', v.party_name, 'from_account_id', v.from_account_id, 'to_account_id', v.to_account_id,
        'bill_id', v.bill_id, 'created_at', v.created_at, 'recurring_schedule_id', v.recurring_schedule_id,
        'project_id', v.project_id, 'project_name', pr.title, 'project_name_ur', pr.title_ur
      ) ORDER BY v.created_at DESC), '[]'::jsonb)
     FROM (SELECT * FROM vouchers WHERE system = p_system AND status IN ('posted', 'approved') AND tenant_id = my_tenant_id() ORDER BY created_at DESC LIMIT 50) v
     LEFT JOIN projects pr ON pr.id = v.project_id),
    'voucher_line_items', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'voucher_id', li.voucher_id, 'account_id', li.account_id, 'description', li.description, 'category', li.category, 'amount', li.amount
      ) ORDER BY li.category), '[]'::jsonb)
     FROM voucher_line_items li
     WHERE li.tenant_id = my_tenant_id()
       AND li.voucher_id IN (SELECT id FROM vouchers WHERE system = p_system AND status IN ('posted', 'approved') AND tenant_id = my_tenant_id() ORDER BY created_at DESC LIMIT 50)),
    'donations', CASE WHEN p_system = 'donors_projects' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', d.id, 'name', d.name, 'name_ur', d.name_ur, 'amount_pkr', d.amount_pkr, 'date', d.date,
          'payment_method', d.payment_method, 'notes', d.notes, 'is_anonymous', d.is_anonymous,
          'is_verified', d.is_verified, 'voucher_no', d.voucher_no, 'created_at', d.created_at,
          'recurring_schedule_id', d.recurring_schedule_id, 'payment_status', d.payment_status,
          'phone', d.phone, 'whatsapp_number', d.whatsapp_number
        ) ORDER BY d.created_at DESC), '[]'::jsonb)
       FROM (SELECT * FROM donors WHERE tenant_id = my_tenant_id() ORDER BY created_at DESC LIMIT 50) d)
      ELSE '[]'::jsonb END,
    'purchases', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', pu.id, 'vendor', pu.vendor, 'purchase_date', pu.purchase_date, 'method', pu.method, 'note', pu.note,
          'attachment_url', pu.attachment_url, 'purchase_number', pu.purchase_number, 'created_at', pu.created_at
        ) ORDER BY pu.created_at DESC), '[]'::jsonb)
       FROM (SELECT * FROM purchases WHERE system = p_system AND status = 'posted' AND tenant_id = my_tenant_id() ORDER BY created_at DESC LIMIT 50) pu)
      ELSE '[]'::jsonb END,
    'purchase_line_items', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'purchase_id', it.purchase_id, 'quantity', it.quantity, 'unit_cost_at_time', it.unit_cost_at_time, 'item_name', ii.name
        )), '[]'::jsonb)
       FROM inventory_transactions it
       LEFT JOIN inventory_items ii ON ii.id = it.item_id
       WHERE it.tenant_id = my_tenant_id()
         AND it.purchase_id IN (SELECT id FROM purchases WHERE system = p_system AND status = 'posted' AND tenant_id = my_tenant_id() ORDER BY created_at DESC LIMIT 50))
      ELSE '[]'::jsonb END,
    'approval_statuses', (SELECT COALESCE(jsonb_agg(jsonb_build_object('reference_id', ar.reference_id, 'auto_posted', ar.auto_posted)), '[]'::jsonb)
      FROM approval_requests ar WHERE ar.system = p_system AND ar.status = 'posted' AND ar.tenant_id = my_tenant_id())
  );
END;
$function$;

create or replace function public.mark_agenda_item_done(p_item_id uuid, p_is_private boolean DEFAULT false)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_item agenda_items%ROWTYPE;
  v_caller uuid := current_admin_user_id();
  v_is_admin boolean := COALESCE(current_admin_role(), '') IN ('super_admin', 'admin');
  v_allowed boolean := false;
  v_meeting_status varchar;
BEGIN
  SELECT * INTO v_item FROM agenda_items WHERE id = p_item_id AND tenant_id = my_tenant_id();
  IF v_item.id IS NULL THEN
    RAISE EXCEPTION 'Agenda item not found.';
  END IF;

  SELECT status INTO v_meeting_status FROM agenda_meetings WHERE id = v_item.meeting_id;
  IF v_meeting_status = 'finalized' THEN
    RAISE EXCEPTION 'This meeting is finalized — it can no longer be changed.';
  END IF;

  IF v_is_admin THEN
    v_allowed := true;
  ELSIF v_caller IS NOT NULL THEN
    SELECT true INTO v_allowed
    FROM agenda_item_assignees aia
    WHERE aia.agenda_item_id = p_item_id
      AND resolve_agenda_assignee(aia.committee_member_id, v_item.meeting_id) IS NOT DISTINCT FROM v_caller
    LIMIT 1;
  END IF;

  IF v_allowed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Only this task''s assignee, their proxy, or an admin can mark it done.';
  END IF;

  UPDATE agenda_items
  SET status = 'done', done_at = now(), done_by_admin_user_id = v_caller, is_private = p_is_private
  WHERE id = p_item_id;
END;
$function$;

create or replace function public.notify_agenda_task_assigned()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_popup_enabled boolean;
  v_recipient uuid;
  v_item agenda_items%ROWTYPE;
BEGIN
  SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'agenda_task_assigned' AND tenant_id = NEW.tenant_id;
  IF v_popup_enabled IS DISTINCT FROM false THEN
    SELECT * INTO v_item FROM agenda_items WHERE id = NEW.agenda_item_id;
    v_recipient := resolve_agenda_assignee(NEW.committee_member_id, v_item.meeting_id);
    IF v_recipient IS NOT NULL THEN
      INSERT INTO notifications (recipient_id, event_type, title, body, link, tenant_id)
      VALUES (v_recipient, 'agenda_task_assigned', 'New meeting task assigned',
        v_item.text_ur, '/admin/tasks/meetings', NEW.tenant_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

create or replace function public.override_approve_confirmation(p_confirmation_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_confirmation approval_confirmations%ROWTYPE;
BEGIN
  IF NOT current_admin_is_super_admin() THEN
    RAISE EXCEPTION 'Only a super admin can approve on behalf of another approver.';
  END IF;
  SELECT * INTO v_confirmation FROM approval_confirmations WHERE id = p_confirmation_id AND tenant_id = my_tenant_id();
  IF v_confirmation.id IS NULL THEN
    RAISE EXCEPTION 'Confirmation not found.';
  END IF;
  IF v_confirmation.confirmed IS NOT NULL THEN
    RAISE EXCEPTION 'This approver has already decided — nothing to override.';
  END IF;
  UPDATE approval_confirmations
  SET confirmed = true, decided_at = now(), overridden_by = current_admin_user_id()
  WHERE id = p_confirmation_id;
END;
$function$;

create or replace function public.resend_approval_notifications(p_request_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_req approval_requests%ROWTYPE;
  v_popup_enabled boolean;
  r record;
BEGIN
  SELECT * INTO v_req FROM approval_requests WHERE id = p_request_id AND tenant_id = my_tenant_id();
  IF v_req.id IS NULL OR v_req.status != 'pending' OR NOT can_access_system(v_req.system) THEN RETURN; END IF;

  SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'approval_requested' AND tenant_id = v_req.tenant_id;
  IF v_popup_enabled IS DISTINCT FROM false THEN
    FOR r IN SELECT approver_id FROM approval_confirmations WHERE approval_request_id = p_request_id AND confirmed IS NULL LOOP
      INSERT INTO notifications (recipient_id, event_type, title, body, link)
      VALUES (r.approver_id, 'approval_requested', 'Reminder — approval needed: Rs. ' || to_char(v_req.amount_pkr, 'FM999999990.00'), v_req.particular, '/admin/approvals');
    END LOOP;
  END IF;
END;
$function$;

-- run_agenda_reminder_sweep: the per-row resolve/insert were already
-- transitively tenant-safe (every id involved ties back to one tenant via
-- FK chains) -- only the notification_preferences gate was a shared
-- singleton read, now a correctness bug since it's keyed
-- (tenant_id, event_type). Moved inside the loop, keyed by each task's
-- own tenant_id, rather than restructuring the whole sweep per-tenant.
create or replace function public.run_agenda_reminder_sweep()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_popup_enabled boolean;
  r record;
  v_recipient uuid;
BEGIN
  FOR r IN
    SELECT ai.id, ai.text_ur, ai.due_date, ai.meeting_id, ai.tenant_id, aia.committee_member_id
    FROM agenda_items ai
    JOIN agenda_item_assignees aia ON aia.agenda_item_id = ai.id
    WHERE ai.kind = 'task' AND ai.status != 'done'
      AND ai.due_date IS NOT NULL AND ai.due_date <= current_date + interval '2 days'
  LOOP
    SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'agenda_task_due_soon' AND tenant_id = r.tenant_id;
    IF v_popup_enabled IS DISTINCT FROM false THEN
      v_recipient := resolve_agenda_assignee(r.committee_member_id, r.meeting_id);
      IF v_recipient IS NOT NULL THEN
        INSERT INTO notifications (recipient_id, event_type, title, body, link, tenant_id)
        VALUES (v_recipient, 'agenda_task_due_soon',
          CASE WHEN r.due_date < current_date THEN 'Overdue meeting task' ELSE 'Meeting task due soon' END,
          r.text_ur, '/admin/tasks/meetings', r.tenant_id);
      END IF;
    END IF;
  END LOOP;
END;
$function$;

create or replace function public.submit_purchase_for_approval(p_purchase_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_purchase purchases%ROWTYPE;
  v_total decimal;
  v_has_approvers boolean;
  v_particular text;
BEGIN
  SELECT * INTO v_purchase FROM purchases WHERE id = p_purchase_id;

  IF NOT approval_type_enabled(v_purchase.system, 'purchase') THEN
    PERFORM post_purchase(p_purchase_id);
    RETURN;
  END IF;

  SELECT EXISTS(SELECT 1 FROM approval_approvers WHERE system = v_purchase.system AND is_active = true AND tenant_id = v_purchase.tenant_id) INTO v_has_approvers;
  IF NOT v_has_approvers THEN
    PERFORM post_purchase(p_purchase_id);
    RETURN;
  END IF;

  SELECT COALESCE(SUM(quantity * unit_cost), 0) INTO v_total FROM purchase_line_items WHERE purchase_id = p_purchase_id;
  v_particular := 'Purchase' || CASE WHEN v_purchase.vendor IS NOT NULL THEN ' from ' || v_purchase.vendor ELSE '' END;
  PERFORM create_approval_request(v_purchase.system, 'purchase', p_purchase_id, v_particular, v_total, current_admin_user_id());
END;
$function$;

create or replace function public.voucher_requires_approval(p_system character varying, p_voucher_type character varying)
 returns boolean
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE v_requires boolean; v_has_approvers boolean;
BEGIN
  v_requires := p_voucher_type IN ('withdrawal', 'expense', 'advance', 'advance_settlement',
                                   'complaint_waiver', 'project_transfer', 'kafalat_payment')
    AND approval_type_enabled(p_system, CASE WHEN p_voucher_type = 'withdrawal' THEN 'withdrawal' ELSE 'expense' END);
  IF v_requires THEN
    SELECT EXISTS(SELECT 1 FROM approval_approvers WHERE system = p_system AND is_active = true AND tenant_id = my_tenant_id()) INTO v_has_approvers;
    v_requires := v_has_approvers;
  END IF;
  RETURN COALESCE(v_requires, false);
END;
$function$;
