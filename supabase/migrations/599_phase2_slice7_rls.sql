-- Phase 2, slice 7 (RLS): tenant-scope every policy on the 7 slice-7
-- tables. All 12 policies are roles={authenticated} with no anonymous-
-- readable policy at all -- every one gets `tenant_id = my_tenant_id() AND`
-- prepended, no coalesce/hardcoded-literal cases this time.

alter policy agenda_item_assignees_read on agenda_item_assignees
  using (my_tenant_id() = tenant_id);

alter policy agenda_item_assignees_write on agenda_item_assignees
  using (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]))
  with check (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]));

alter policy agenda_items_read on agenda_items
  using (my_tenant_id() = tenant_id);

alter policy agenda_items_write on agenda_items
  using (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]) and (exists (select 1 from agenda_meetings m where m.id = agenda_items.meeting_id and (m.status)::text = 'open'::text)))
  with check (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]) and (exists (select 1 from agenda_meetings m where m.id = agenda_items.meeting_id and (m.status)::text = 'open'::text)));

alter policy agenda_meetings_read on agenda_meetings
  using (my_tenant_id() = tenant_id);

alter policy agenda_meetings_write on agenda_meetings
  using (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]))
  with check (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]));

alter policy approval_approvers_read on approval_approvers
  using (my_tenant_id() = tenant_id and can_access_system(system));

alter policy approval_approvers_write on approval_approvers
  using (my_tenant_id() = tenant_id and current_admin_is_admin_tier())
  with check (my_tenant_id() = tenant_id and current_admin_is_admin_tier());

alter policy approval_confirmations_read on approval_confirmations
  using (my_tenant_id() = tenant_id and (approver_id = current_admin_user_id() or (exists (select 1 from approval_requests r where r.id = approval_confirmations.approval_request_id and can_access_system(r.system)))));

alter policy approval_confirmations_update_own on approval_confirmations
  using (my_tenant_id() = tenant_id and approver_id = current_admin_user_id() and confirmed is null)
  with check (my_tenant_id() = tenant_id and approver_id = current_admin_user_id());

alter policy approval_requests_read on approval_requests
  using (my_tenant_id() = tenant_id and can_access_system(system));

alter policy approval_type_settings_read on approval_type_settings
  using (my_tenant_id() = tenant_id and can_access_system(system));

alter policy approval_type_settings_write on approval_type_settings
  using (my_tenant_id() = tenant_id and current_admin_is_admin_tier())
  with check (my_tenant_id() = tenant_id and current_admin_is_admin_tier());
