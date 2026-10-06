-- Phase 2, slice 1 (RLS): same uniform transformation as migration 568 —
-- prepend `tenant_id = my_tenant_id() AND` to every USING/CHECK, with the
-- handful of genuinely anonymous-readable "is_active = true" policies
-- (civic reports, directory, contacts, lost & found, events, landmarks)
-- getting the one real tenant's id hardcoded instead, since there's no
-- auth.uid() for my_tenant_id() to resolve for a logged-out visitor — see
-- migration 568's header for the full reasoning, identical here.

alter policy "blood_donors_self_all" on blood_donors
  using ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())))
  with check ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())));

alter policy "blood_donors_staff_read" on blood_donors
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))));

alter policy "blood_contacts_donor_read_own" on blood_request_contacts
  using ((tenant_id = my_tenant_id()) AND ((blood_donor_id IN ( SELECT blood_donors.id
   FROM blood_donors
  WHERE (blood_donors.portal_user_id = current_portal_user_id())))));

alter policy "blood_contacts_donor_respond" on blood_request_contacts
  using ((tenant_id = my_tenant_id()) AND ((blood_donor_id IN ( SELECT blood_donors.id
   FROM blood_donors
  WHERE (blood_donors.portal_user_id = current_portal_user_id())))))
  with check ((tenant_id = my_tenant_id()) AND ((blood_donor_id IN ( SELECT blood_donors.id
   FROM blood_donors
  WHERE (blood_donors.portal_user_id = current_portal_user_id())))));

alter policy "blood_contacts_manage" on blood_request_contacts
  using ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_blood_requests'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_blood_requests'::character varying)));

alter policy "blood_contacts_staff_read" on blood_request_contacts
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))));

alter policy "blood_requests_manage" on blood_requests
  using ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_blood_requests'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_blood_requests'::character varying)));

alter policy "blood_requests_staff_read" on blood_requests
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))));

alter policy "civic_reports_public_read" on civic_reports
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND ((is_active = true)));

alter policy "civic_reports_self_insert" on civic_reports
  with check ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())));

alter policy "civic_reports_self_read" on civic_reports
  using ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())));

alter policy "civic_reports_self_update" on civic_reports
  using ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())))
  with check ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())));

alter policy "civic_reports_staff_all" on civic_reports
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))))
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))));

alter policy "complaint_handlers_read" on complaint_handlers
  using ((tenant_id = my_tenant_id()) AND (can_access_system(system)));

alter policy "complaint_handlers_write" on complaint_handlers
  using ((tenant_id = my_tenant_id()) AND (current_admin_is_admin_tier()))
  with check ((tenant_id = my_tenant_id()) AND (current_admin_is_admin_tier()));

alter policy "complaint_updates_read" on complaint_updates
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM complaints c
  WHERE ((c.id = complaint_updates.complaint_id) AND can_access_system(c.system))))));

alter policy "complaint_updates_write" on complaint_updates
  with check ((tenant_id = my_tenant_id()) AND ((((kind)::text = 'comment'::text) AND (EXISTS ( SELECT 1
   FROM complaints c
  WHERE ((c.id = complaint_updates.complaint_id) AND can_access_system(c.system)))))));

alter policy "complaints_portal_insert" on complaints
  with check ((tenant_id = my_tenant_id()) AND (((portal_user_id = current_portal_user_id()) AND ((source)::text = 'website'::text) AND ((status)::text = 'open'::text) AND (assigned_to IS NULL))));

alter policy "complaints_public_insert" on complaints
  with check ((tenant_id = my_tenant_id()) AND ((((source)::text = 'website'::text) AND ((status)::text = 'open'::text) AND (assigned_to IS NULL) AND ((portal_user_id IS NULL) OR (portal_user_id = current_portal_user_id())))));

alter policy "complaints_read" on complaints
  using ((tenant_id = my_tenant_id()) AND (can_access_system(system)));

alter policy "complaints_read_own" on complaints
  using ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())));

alter policy "complaints_staff_insert" on complaints
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system(system) AND ((source)::text = 'manual'::text))));

alter policy "complaints_update" on complaints
  using ((tenant_id = my_tenant_id()) AND (can_access_system(system)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system(system)));

alter policy "consumer_nonpayment_flags_read" on consumer_nonpayment_flags
  using ((tenant_id = my_tenant_id()) AND (can_access_system('water_supply'::character varying)));

alter policy "admin_all_directory_entries" on directory_entries
  using ((tenant_id = my_tenant_id()) AND ((auth.role() = 'authenticated'::text)));

alter policy "public_read_active_directory_entries" on directory_entries
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND ((is_active = true)));

alter policy "admin_all_important_contacts" on important_contacts
  using ((tenant_id = my_tenant_id()) AND ((auth.role() = 'authenticated'::text)));

alter policy "public_read_active_contacts" on important_contacts
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND ((is_active = true)));

alter policy "lost_found_public_read" on lost_found_posts
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND ((is_active = true)));

alter policy "lost_found_self_all" on lost_found_posts
  using ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())))
  with check ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())));

alter policy "lost_found_staff_moderate" on lost_found_posts
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))))
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))));

alter policy "lost_found_staff_read" on lost_found_posts
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))));

alter policy "reminder_queue_read" on reminder_queue
  using ((tenant_id = my_tenant_id()) AND (((((reminder_type)::text = ANY ((ARRAY['bill_weekly'::character varying, 'bill_defaulter'::character varying])::text[])) AND can_access_system('water_supply'::character varying)) OR (((reminder_type)::text = ANY ((ARRAY['donor_recurring'::character varying, 'donor_pledge_unpaid'::character varying, 'wazifa_repayment_due'::character varying])::text[])) AND can_access_system('donors_projects'::character varying)) OR ((reminder_type)::text = 'meeting_due'::text))));

alter policy "reminder_queue_update" on reminder_queue
  using ((tenant_id = my_tenant_id()) AND (((((reminder_type)::text = ANY ((ARRAY['bill_weekly'::character varying, 'bill_defaulter'::character varying])::text[])) AND can_access_system('water_supply'::character varying) AND current_admin_permission('post_transactions'::character varying)) OR (((reminder_type)::text = ANY ((ARRAY['donor_recurring'::character varying, 'donor_pledge_unpaid'::character varying, 'wazifa_repayment_due'::character varying])::text[])) AND can_access_system('donors_projects'::character varying) AND current_admin_permission('post_transactions'::character varying)) OR ((reminder_type)::text = 'meeting_due'::text))))
  with check ((tenant_id = my_tenant_id()) AND (true));

alter policy "admin_all_suggestions" on suggestions
  using ((tenant_id = my_tenant_id()) AND ((auth.role() = 'authenticated'::text)));

alter policy "public_insert_suggestions" on suggestions
  with check ((tenant_id = my_tenant_id()) AND (((portal_user_id IS NULL) OR (portal_user_id = current_portal_user_id()))));

alter policy "suggestions_read_own" on suggestions
  using ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())));

alter policy "village_events_public_read" on village_events
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND ((is_active = true)));

alter policy "village_events_staff_all" on village_events
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))))
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))));

alter policy "village_landmarks_public_read" on village_landmarks
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND ((is_active = true)));

alter policy "village_landmarks_staff_all" on village_landmarks
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))))
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))));
