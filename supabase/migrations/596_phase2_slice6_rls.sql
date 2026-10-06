-- Phase 2, slice 6 (RLS): tenant-scope every policy on the 16 slice-6
-- tables. Standard rule: authenticated-only policies get
-- `tenant_id = my_tenant_id() AND` prepended. Purely anonymous-readable
-- policies (no auth-dependent branch, and a separate ALL/staff policy
-- already covers the authenticated same-tenant case via OR) get
-- `tenant_id = '<dhab-pari-uuid>'::uuid AND` instead.
--
-- Four policies are the single ONLY read-granting policy on their table,
-- with roles={public} AND a mixed USING clause that must serve both true
-- anonymous visitors and authenticated same-tenant privileged readers
-- (own portal_user_id, or admin role) with no other policy to fall back
-- on: project_comment_likes_read, project_comments_read, project_votes_read,
-- public_read_projects. Using the hardcoded literal on these would have
-- silently hidden every OTHER tenant's own data from its own authenticated
-- users (an under-scoping bug, not just a leak) -- fixed with
-- `tenant_id = coalesce(my_tenant_id(), '<dhab-pari-uuid>'::uuid)` instead,
-- same pattern as the public pre-login "browse" functions fixed earlier
-- this phase.

alter policy appeals_manage on appeals
  using (my_tenant_id() = tenant_id and (current_admin_permission('manage_parties'::character varying) or current_admin_permission('manage_blood_requests'::character varying)))
  with check (my_tenant_id() = tenant_id and (current_admin_permission('manage_parties'::character varying) or current_admin_permission('manage_blood_requests'::character varying)));

alter policy appeals_staff_read on appeals
  using (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)));

alter policy admin_all_members on committee_members
  using (my_tenant_id() = tenant_id and auth.role() = 'authenticated'::text);

alter policy public_read_active_members on committee_members
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid and is_active = true);

alter policy committee_notes_public_read on committee_notes
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid and is_published = true);

alter policy committee_notes_write on committee_notes
  using (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]))
  with check (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]));

alter policy death_announcements_public_read on death_announcements
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid and is_active = true);

alter policy death_announcements_self_insert on death_announcements
  with check (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id());

alter policy death_announcements_self_read on death_announcements
  using (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id());

alter policy death_announcements_staff_all on death_announcements
  using (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)))
  with check (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)));

alter policy help_requests_public_read on help_requests
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid and is_active = true);

alter policy help_requests_self_insert on help_requests
  with check (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id());

alter policy help_requests_self_read on help_requests
  using (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id());

alter policy help_requests_self_update on help_requests
  using (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id())
  with check (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id());

alter policy help_requests_staff_all on help_requests
  using (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)))
  with check (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)));

alter policy needs_register_own_read on needs_register
  using (my_tenant_id() = tenant_id and portal_user_id is not null and portal_user_id = current_portal_user_id());

alter policy needs_register_self_insert on needs_register
  with check (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id() and (status)::text = 'pending'::text and (source)::text = 'self'::text and verified_at is null and verified_until is null);

alter policy needs_register_verifier_all on needs_register
  using (my_tenant_id() = tenant_id and current_admin_is_needs_verifier())
  with check (my_tenant_id() = tenant_id and current_admin_is_needs_verifier());

alter policy needs_surveys_verifier_all on needs_surveys
  using (my_tenant_id() = tenant_id and current_admin_is_needs_verifier())
  with check (my_tenant_id() = tenant_id and current_admin_is_needs_verifier());

alter policy needs_verifications_verifier_all on needs_verifications
  using (my_tenant_id() = tenant_id and current_admin_is_needs_verifier())
  with check (my_tenant_id() = tenant_id and current_admin_is_needs_verifier());

alter policy party_complaints_filer_or_admin_read on party_complaints
  using (my_tenant_id() = tenant_id and (filed_by_portal_user_id = current_portal_user_id() or coalesce(current_admin_permission('manage_parties'::character varying), false)));

alter policy project_comment_likes_delete_own on project_comment_likes
  using (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id());

alter policy project_comment_likes_insert_own on project_comment_likes
  with check (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id());

alter policy project_comment_likes_read on project_comment_likes
  using (tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid));

alter policy project_comments_delete_own on project_comments
  using (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id());

alter policy project_comments_delete_own_staff on project_comments
  using (my_tenant_id() = tenant_id and admin_user_id = current_admin_user_id());

alter policy project_comments_insert_own on project_comments
  with check (my_tenant_id() = tenant_id and (comment_type)::text = 'user'::text and portal_user_id = current_portal_user_id());

alter policy project_comments_insert_staff on project_comments
  with check (my_tenant_id() = tenant_id and (comment_type)::text = 'staff'::text and admin_user_id = current_admin_user_id());

alter policy project_comments_read on project_comments
  using (tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) and (is_hidden = false or portal_user_id = current_portal_user_id() or (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true))));

alter policy project_comments_staff_moderate on project_comments
  using (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)))
  with check (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)));

alter policy admin_all_project_media on project_media
  using (my_tenant_id() = tenant_id and auth.role() = 'authenticated'::text);

alter policy public_read_project_media on project_media
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

alter policy project_tasks_read_own on project_tasks
  using (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id() and (exists (select 1 from volunteers v where v.portal_user_id = current_portal_user_id() and v.project_id = project_tasks.project_id and (v.status)::text = 'assigned'::text)));

alter policy project_tasks_staff_read on project_tasks
  using (my_tenant_id() = tenant_id and can_access_system('donors_projects'::character varying));

alter policy project_tasks_staff_write on project_tasks
  using (my_tenant_id() = tenant_id and can_access_system('donors_projects'::character varying) and current_admin_permission('manage_parties'::character varying))
  with check (my_tenant_id() = tenant_id and can_access_system('donors_projects'::character varying) and current_admin_permission('manage_parties'::character varying));

alter policy project_tasks_update_own_status on project_tasks
  using (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id())
  with check (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id());

alter policy project_votes_insert_own on project_votes
  with check (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id() and (exists (select 1 from projects where projects.id = project_votes.project_id and (projects.status)::text = 'upcoming'::text)));

alter policy project_votes_read on project_votes
  using (tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid));

alter policy projects_delete on projects
  using (my_tenant_id() = tenant_id and can_access_system('donors_projects'::character varying) and current_admin_permission('delete_transactions'::character varying));

alter policy projects_portal_propose on projects
  with check (my_tenant_id() = tenant_id and proposed_by_portal_user_id = current_portal_user_id() and (status)::text = 'announced'::text);

alter policy projects_update on projects
  using (my_tenant_id() = tenant_id and can_access_system('donors_projects'::character varying))
  with check (my_tenant_id() = tenant_id and can_access_system('donors_projects'::character varying) and current_admin_permission('manage_parties'::character varying));

alter policy projects_write on projects
  with check (my_tenant_id() = tenant_id and can_access_system('donors_projects'::character varying) and current_admin_permission('manage_parties'::character varying));

alter policy public_read_projects on projects
  using (tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) and ((admin_hidden = false and is_private = false) or proposed_by_portal_user_id = current_portal_user_id() or current_admin_role() is not null));

alter policy ratings_party_or_admin_read on ratings
  using (my_tenant_id() = tenant_id and (coalesce(current_admin_permission('manage_parties'::character varying), false) or ((rater_party_type)::text = 'portal_user'::text and rater_party_id = current_portal_user_id()) or ((target_party_type)::text = 'portal_user'::text and target_party_id = current_portal_user_id()) or ((rater_party_type)::text = 'vehicle'::text and (exists (select 1 from vehicles where vehicles.id = ratings.rater_party_id and vehicles.portal_user_id = current_portal_user_id()))) or ((target_party_type)::text = 'vehicle'::text and (exists (select 1 from vehicles where vehicles.id = ratings.target_party_id and vehicles.portal_user_id = current_portal_user_id()))) or ((rater_party_type)::text = 'shop'::text and user_manages_shop(rater_party_id)) or ((target_party_type)::text = 'shop'::text and user_manages_shop(target_party_id))));
