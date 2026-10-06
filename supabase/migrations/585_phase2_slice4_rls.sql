-- Phase 2, slice 4 (RLS): same uniform transformation as prior slices --
-- prepend `tenant_id = my_tenant_id() AND` to every USING/CHECK. Only
-- sadqa_catalogue and support_pools have a genuinely anonymous-readable
-- policy (`qual = is_active` for the `public` role, no auth.role() =
-- 'authenticated' guard), so those two get the one real tenant's id
-- hardcoded instead.

alter policy "chanda_campaigns_manager_read" on chanda_campaigns
  using ((tenant_id = my_tenant_id()) AND ((manager_portal_user_id = current_portal_user_id())));

alter policy "chanda_campaigns_staff_all" on chanda_campaigns
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))))
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))));

alter policy "chanda_pledges_manager_all" on chanda_pledges
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM chanda_campaigns c
  WHERE ((c.id = chanda_pledges.campaign_id) AND (c.manager_portal_user_id = current_portal_user_id()))))))
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM chanda_campaigns c
  WHERE ((c.id = chanda_pledges.campaign_id) AND (c.manager_portal_user_id = current_portal_user_id()))))));

alter policy "chanda_pledges_self_insert" on chanda_pledges
  with check ((tenant_id = my_tenant_id()) AND (((giver_portal_user_id = current_portal_user_id()) AND ((status)::text = 'pending'::text))));

alter policy "chanda_pledges_self_read" on chanda_pledges
  using ((tenant_id = my_tenant_id()) AND ((giver_portal_user_id = current_portal_user_id())));

alter policy "chanda_pledges_staff_all" on chanda_pledges
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))))
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))));

alter policy "event_salami_accounts_manager_read" on event_salami_accounts
  using ((tenant_id = my_tenant_id()) AND ((manager_portal_user_id = current_portal_user_id())));

alter policy "event_salami_accounts_staff_all" on event_salami_accounts
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))))
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))));

alter policy "event_salami_pledges_manager_all" on event_salami_pledges
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM event_salami_accounts a
  WHERE ((a.event_id = event_salami_pledges.event_id) AND ((a.side)::text = (event_salami_pledges.side)::text) AND (a.manager_portal_user_id = current_portal_user_id()))))))
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM event_salami_accounts a
  WHERE ((a.event_id = event_salami_pledges.event_id) AND ((a.side)::text = (event_salami_pledges.side)::text) AND (a.manager_portal_user_id = current_portal_user_id()))))));

alter policy "event_salami_pledges_self_insert" on event_salami_pledges
  with check ((tenant_id = my_tenant_id()) AND (((giver_portal_user_id = current_portal_user_id()) AND ((status)::text = 'pending'::text))));

alter policy "event_salami_pledges_self_read" on event_salami_pledges
  using ((tenant_id = my_tenant_id()) AND ((giver_portal_user_id = current_portal_user_id())));

alter policy "event_salami_pledges_staff_all" on event_salami_pledges
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))))
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))));

alter policy "kafalat_children_admin" on kafalat_children
  using ((tenant_id = my_tenant_id()) AND ((current_admin_is_needs_verifier() OR current_admin_is_super_admin())))
  with check ((tenant_id = my_tenant_id()) AND ((current_admin_is_needs_verifier() OR current_admin_is_super_admin())));

alter policy "kafalat_disbursements_admin" on kafalat_disbursements
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "kafalat_fee_payments_admin" on kafalat_fee_payments
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "kafalat_nominations_admin" on kafalat_nominations
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "kafalat_nominations_create" on kafalat_nominations
  with check ((tenant_id = my_tenant_id()) AND (((nominated_by_portal_user_id = current_portal_user_id()) AND ((status)::text = 'new'::text))));

alter policy "kafalat_nominations_own" on kafalat_nominations
  using ((tenant_id = my_tenant_id()) AND ((nominated_by_portal_user_id = current_portal_user_id())));

alter policy "kafalat_package_admin" on kafalat_package_lines
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "kafalat_progress_admin" on kafalat_progress
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "kafalat_progress_sponsor" on kafalat_progress
  using ((tenant_id = my_tenant_id()) AND ((published AND (EXISTS ( SELECT 1
   FROM kafalat_shares s
  WHERE ((s.child_id = kafalat_progress.child_id) AND (s.portal_user_id = current_portal_user_id()) AND ((s.status)::text = ANY ((ARRAY['pledged'::character varying, 'active'::character varying])::text[]))))))));

alter policy "kafalat_reverifications_admin" on kafalat_reverifications
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "kafalat_shares_admin" on kafalat_shares
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "kafalat_shares_own" on kafalat_shares
  using ((tenant_id = my_tenant_id()) AND (((portal_user_id IS NOT NULL) AND (portal_user_id = current_portal_user_id()))));

alter policy "kafalat_uniform_issues_admin" on kafalat_uniform_issues
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "pool_commitments_admin" on pool_commitments
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "pool_commitments_own" on pool_commitments
  using ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())));

alter policy "pool_months_admin" on pool_months
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "pool_payments_admin" on pool_payments
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "pool_payments_read_own" on pool_payments
  using ((tenant_id = my_tenant_id()) AND (((announced_by_portal_user_id = current_portal_user_id()) OR (EXISTS ( SELECT 1
   FROM pool_commitments c
  WHERE ((c.id = pool_payments.commitment_id) AND (c.portal_user_id = current_portal_user_id())))))));

alter policy "sadqa_bills_admin" on sadqa_bills
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "sadqa_bills_own" on sadqa_bills
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM sadqa_objects o
  WHERE ((o.id = sadqa_bills.object_id) AND (o.portal_user_id = current_portal_user_id()))))));

alter policy "sadqa_catalogue_admin" on sadqa_catalogue
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "sadqa_catalogue_read" on sadqa_catalogue
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (is_active));

alter policy "sadqa_maintenance_admin" on sadqa_maintenance_log
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "sadqa_messages_admin" on sadqa_messages
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "sadqa_messages_mark_read" on sadqa_messages
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM sadqa_objects o
  WHERE ((o.id = sadqa_messages.object_id) AND (o.portal_user_id = current_portal_user_id()))))))
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM sadqa_objects o
  WHERE ((o.id = sadqa_messages.object_id) AND (o.portal_user_id = current_portal_user_id()))))));

alter policy "sadqa_messages_own" on sadqa_messages
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM sadqa_objects o
  WHERE ((o.id = sadqa_messages.object_id) AND (o.portal_user_id = current_portal_user_id()))))));

alter policy "sadqa_objects_admin" on sadqa_objects
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "sadqa_objects_own" on sadqa_objects
  using ((tenant_id = my_tenant_id()) AND (((portal_user_id IS NOT NULL) AND (portal_user_id = current_portal_user_id()))));

alter policy "sadqa_objects_propose" on sadqa_objects
  with check ((tenant_id = my_tenant_id()) AND (((portal_user_id = current_portal_user_id()) AND ((status)::text = 'proposed'::text) AND (amount_received_pkr = (0)::numeric) AND (approved_at IS NULL))));

alter policy "sadqa_receipts_admin" on sadqa_receipts
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "sadqa_receipts_own" on sadqa_receipts
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM sadqa_objects o
  WHERE ((o.id = sadqa_receipts.object_id) AND (o.portal_user_id = current_portal_user_id()))))));

alter policy "sadqa_upkeep_admin" on sadqa_upkeep_charges
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "sadqa_upkeep_own" on sadqa_upkeep_charges
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM sadqa_objects o
  WHERE ((o.id = sadqa_upkeep_charges.object_id) AND (o.portal_user_id = current_portal_user_id()) AND ((o.maintenance_mode)::text = 'donor'::text))))));

alter policy "support_pools_admin" on support_pools
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "support_pools_read" on support_pools
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (is_active));

alter policy "wazifa_academic_add_own" on wazifa_academic_records
  with check ((tenant_id = my_tenant_id()) AND (wazifa_app_is_open(application_id)));

alter policy "wazifa_academic_admin" on wazifa_academic_records
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "wazifa_academic_change_own" on wazifa_academic_records
  using ((tenant_id = my_tenant_id()) AND (wazifa_app_is_open(application_id)))
  with check ((tenant_id = my_tenant_id()) AND (wazifa_app_is_open(application_id)));

alter policy "wazifa_academic_read_own" on wazifa_academic_records
  using ((tenant_id = my_tenant_id()) AND (wazifa_app_is_mine(application_id)));

alter policy "wazifa_academic_remove_own" on wazifa_academic_records
  using ((tenant_id = my_tenant_id()) AND (wazifa_app_is_open(application_id)));

alter policy "wazifa_agreements_admin" on wazifa_agreements
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "wazifa_agreements_own" on wazifa_agreements
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM (wazifa_awards a
     JOIN wazifa_students s ON ((s.id = a.student_id)))
  WHERE ((a.id = wazifa_agreements.award_id) AND (s.portal_user_id = current_portal_user_id()))))));

alter policy "wazifa_applications_admin" on wazifa_applications
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "wazifa_applications_edit" on wazifa_applications
  using ((tenant_id = my_tenant_id()) AND (((EXISTS ( SELECT 1
   FROM wazifa_students s
  WHERE ((s.id = wazifa_applications.student_id) AND (s.portal_user_id = current_portal_user_id())))) AND ((status)::text = ANY ((ARRAY['draft'::character varying, 'submitted'::character varying])::text[])))))
  with check ((tenant_id = my_tenant_id()) AND (((EXISTS ( SELECT 1
   FROM wazifa_students s
  WHERE ((s.id = wazifa_applications.student_id) AND (s.portal_user_id = current_portal_user_id())))) AND ((status)::text = ANY ((ARRAY['draft'::character varying, 'submitted'::character varying])::text[])) AND (merit_score IS NULL) AND (need_score IS NULL))));

alter policy "wazifa_applications_own" on wazifa_applications
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM wazifa_students s
  WHERE ((s.id = wazifa_applications.student_id) AND (s.portal_user_id = current_portal_user_id()))))));

alter policy "wazifa_applications_submit" on wazifa_applications
  with check ((tenant_id = my_tenant_id()) AND (((EXISTS ( SELECT 1
   FROM wazifa_students s
  WHERE ((s.id = wazifa_applications.student_id) AND (s.portal_user_id = current_portal_user_id())))) AND ((status)::text = ANY ((ARRAY['draft'::character varying, 'submitted'::character varying])::text[])) AND (merit_score IS NULL) AND (need_score IS NULL))));

alter policy "wazifa_awards_admin" on wazifa_awards
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "wazifa_awards_own" on wazifa_awards
  using ((tenant_id = my_tenant_id()) AND (((EXISTS ( SELECT 1
   FROM wazifa_students s
  WHERE ((s.id = wazifa_awards.student_id) AND (s.portal_user_id = current_portal_user_id())))) OR (sponsor_portal_user_id = current_portal_user_id()))));

alter policy "wazifa_check_ins_admin" on wazifa_check_ins
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "wazifa_check_ins_own" on wazifa_check_ins
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM (wazifa_awards a
     JOIN wazifa_students s ON ((s.id = a.student_id)))
  WHERE ((a.id = wazifa_check_ins.award_id) AND (s.portal_user_id = current_portal_user_id()))))));

alter policy "wazifa_contributions_admin" on wazifa_contributions
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "wazifa_contributions_own" on wazifa_contributions
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM (wazifa_awards a
     JOIN wazifa_students s ON ((s.id = a.student_id)))
  WHERE ((a.id = wazifa_contributions.award_id) AND (s.portal_user_id = current_portal_user_id()))))));

alter policy "wazifa_decisions_admin" on wazifa_decisions
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "wazifa_disbursement_charges_admin" on wazifa_disbursement_charges
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "wazifa_disbursement_charges_own" on wazifa_disbursement_charges
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM (wazifa_awards a
     JOIN wazifa_students s ON ((s.id = a.student_id)))
  WHERE ((a.id = wazifa_disbursement_charges.award_id) AND (s.portal_user_id = current_portal_user_id()))))));

alter policy "wazifa_documents_add_own" on wazifa_documents
  with check ((tenant_id = my_tenant_id()) AND (wazifa_app_is_open(application_id)));

alter policy "wazifa_documents_admin" on wazifa_documents
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "wazifa_documents_change_own" on wazifa_documents
  using ((tenant_id = my_tenant_id()) AND ((wazifa_app_is_open(application_id) AND (seen_by IS NULL))))
  with check ((tenant_id = my_tenant_id()) AND (wazifa_app_is_open(application_id)));

alter policy "wazifa_documents_read_own" on wazifa_documents
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM (wazifa_applications a
     JOIN wazifa_students s ON ((s.id = a.student_id)))
  WHERE ((a.id = wazifa_documents.application_id) AND (s.portal_user_id = current_portal_user_id()))))));

alter policy "wazifa_documents_remove_own" on wazifa_documents
  using ((tenant_id = my_tenant_id()) AND ((wazifa_app_is_open(application_id) AND (seen_by IS NULL))));

alter policy "wazifa_family_add_own" on wazifa_family_members
  with check ((tenant_id = my_tenant_id()) AND (wazifa_app_is_open(application_id)));

alter policy "wazifa_family_admin" on wazifa_family_members
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "wazifa_family_change_own" on wazifa_family_members
  using ((tenant_id = my_tenant_id()) AND (wazifa_app_is_open(application_id)))
  with check ((tenant_id = my_tenant_id()) AND (wazifa_app_is_open(application_id)));

alter policy "wazifa_family_read_own" on wazifa_family_members
  using ((tenant_id = my_tenant_id()) AND (wazifa_app_is_mine(application_id)));

alter policy "wazifa_family_remove_own" on wazifa_family_members
  using ((tenant_id = my_tenant_id()) AND (wazifa_app_is_open(application_id)));

alter policy "wazifa_installment_charges_admin" on wazifa_installment_charges
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "wazifa_installment_charges_own" on wazifa_installment_charges
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM (wazifa_awards a
     JOIN wazifa_students s ON ((s.id = a.student_id)))
  WHERE ((a.id = wazifa_installment_charges.award_id) AND (s.portal_user_id = current_portal_user_id()))))));

alter policy "wazifa_instalments_admin" on wazifa_instalments
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "wazifa_interim_grant_admin" on wazifa_interim_grant
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "wazifa_interim_grant_own" on wazifa_interim_grant
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM (wazifa_awards a
     JOIN wazifa_students s ON ((s.id = a.student_id)))
  WHERE ((a.id = wazifa_interim_grant.award_id) AND (s.portal_user_id = current_portal_user_id()))))));

alter policy "wazifa_schedule_admin" on wazifa_repayment_schedule
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "wazifa_schedule_own" on wazifa_repayment_schedule
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM (wazifa_awards a
     JOIN wazifa_students s ON ((s.id = a.student_id)))
  WHERE ((a.id = wazifa_repayment_schedule.award_id) AND (s.portal_user_id = current_portal_user_id()))))));

alter policy "wazifa_repayments_admin" on wazifa_repayments
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "wazifa_results_add_own" on wazifa_results
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM wazifa_students s
  WHERE ((s.id = wazifa_results.student_id) AND (s.portal_user_id = current_portal_user_id()))))));

alter policy "wazifa_results_admin" on wazifa_results
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "wazifa_results_change_own" on wazifa_results
  using ((tenant_id = my_tenant_id()) AND (((EXISTS ( SELECT 1
   FROM wazifa_students s
  WHERE ((s.id = wazifa_results.student_id) AND (s.portal_user_id = current_portal_user_id())))) AND (award_id IS NULL))))
  with check ((tenant_id = my_tenant_id()) AND (((EXISTS ( SELECT 1
   FROM wazifa_students s
  WHERE ((s.id = wazifa_results.student_id) AND (s.portal_user_id = current_portal_user_id())))) AND (award_id IS NULL))));

alter policy "wazifa_results_read_own" on wazifa_results
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM wazifa_students s
  WHERE ((s.id = wazifa_results.student_id) AND (s.portal_user_id = current_portal_user_id()))))));

alter policy "wazifa_students_admin" on wazifa_students
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "wazifa_students_apply" on wazifa_students
  with check ((tenant_id = my_tenant_id()) AND (((portal_user_id = current_portal_user_id()) AND ((status)::text = 'applicant'::text))));

alter policy "wazifa_students_edit" on wazifa_students
  using ((tenant_id = my_tenant_id()) AND (((portal_user_id = current_portal_user_id()) AND (EXISTS ( SELECT 1
   FROM wazifa_applications a
  WHERE ((a.student_id = wazifa_students.id) AND ((a.status)::text = ANY ((ARRAY['draft'::character varying, 'submitted'::character varying])::text[]))))))))
  with check ((tenant_id = my_tenant_id()) AND (((portal_user_id = current_portal_user_id()) AND ((status)::text = 'applicant'::text))));

alter policy "wazifa_students_own" on wazifa_students
  using ((tenant_id = my_tenant_id()) AND (((portal_user_id IS NOT NULL) AND (portal_user_id = current_portal_user_id()))));

alter policy "wazifa_verifications_admin" on wazifa_verifications
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "zakat_beneficiaries_admin" on zakat_round_beneficiaries
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "zakat_rounds_admin" on zakat_rounds
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

-- 96 policies total
