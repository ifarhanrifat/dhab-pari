-- Phase 2, slice 8 (RLS): tenant-scope every policy on the 17 slice-8
-- tables. Standard rule: authenticated-only policies get
-- `tenant_id = my_tenant_id() AND` prepended. Purely anonymous-readable
-- policies get the hardcoded dhab-pari literal UNLESS they are the only
-- policy that would otherwise grant an authenticated same-tenant admin
-- read visibility (no separate ALL/read-all policy exists for that role)
-- -- those three get coalesce(my_tenant_id(), <dhab-pari>) instead:
-- talent_showcase_comment_likes_read, talent_showcase_comments_read
-- (same reasoning as their project_comments_* twins in slice 6), and
-- volunteers_public_read (the only SELECT-granting policy on that table
-- for an admin browsing the volunteers list -- volunteers_staff_moderate
-- only covers UPDATE).

alter policy institutes_read on institutes
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid and is_active = true);

alter policy institutes_write on institutes
  using (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]))
  with check (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]));

alter policy job_listings_public_read on job_listings
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid and is_active = true);

alter policy job_listings_self_all on job_listings
  using (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id())
  with check (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id());

alter policy job_listings_staff_moderate on job_listings
  using (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)))
  with check (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)));

alter policy job_listings_staff_read on job_listings
  using (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)));

alter policy manual_achievements_admin_all on manual_achievements
  using (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]))
  with check (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]));

alter policy mentor_chat_blocks_own_read on mentor_chat_blocks
  using (my_tenant_id() = tenant_id and (blocker_portal_user_id = current_portal_user_id() or (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[])));

alter policy mentor_conversations_participant_read on mentor_conversations
  using (my_tenant_id() = tenant_id and (student_portal_user_id = current_portal_user_id() or mentor_portal_user_id = current_portal_user_id() or (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[])));

alter policy mentor_messages_participant_insert on mentor_messages
  with check (my_tenant_id() = tenant_id and sender_portal_user_id = current_portal_user_id() and (exists (select 1 from mentor_conversations c where c.id = mentor_messages.conversation_id and (c.status)::text = 'open'::text and (c.student_portal_user_id = current_portal_user_id() or c.mentor_portal_user_id = current_portal_user_id()))));

alter policy mentor_messages_participant_read on mentor_messages
  using (my_tenant_id() = tenant_id and ((exists (select 1 from mentor_conversations c where c.id = mentor_messages.conversation_id and (c.student_portal_user_id = current_portal_user_id() or c.mentor_portal_user_id = current_portal_user_id()))) or (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[])));

alter policy school_tiers_admin on school_fee_tiers
  using (my_tenant_id() = tenant_id and can_access_system('donors_projects'::character varying))
  with check (my_tenant_id() = tenant_id and can_access_system('donors_projects'::character varying));

alter policy school_tiers_read on school_fee_tiers
  using (my_tenant_id() = tenant_id);

alter policy schools_admin on schools
  using (my_tenant_id() = tenant_id and can_access_system('donors_projects'::character varying))
  with check (my_tenant_id() = tenant_id and can_access_system('donors_projects'::character varying));

alter policy schools_read on schools
  using (my_tenant_id() = tenant_id and is_active);

alter policy talent_showcase_comment_likes_delete_own on talent_showcase_comment_likes
  using (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id());

alter policy talent_showcase_comment_likes_insert_own on talent_showcase_comment_likes
  with check (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id());

alter policy talent_showcase_comment_likes_read on talent_showcase_comment_likes
  using (tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid));

alter policy talent_showcase_comments_delete_own on talent_showcase_comments
  using (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id());

alter policy talent_showcase_comments_insert_own on talent_showcase_comments
  with check (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id());

alter policy talent_showcase_comments_read on talent_showcase_comments
  using (tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) and (is_hidden = false or portal_user_id = current_portal_user_id() or (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true))));

alter policy talent_showcase_comments_staff_moderate on talent_showcase_comments
  using (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)))
  with check (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)));

alter policy talent_help_offers_admin_manage on talent_showcase_help_offers
  using (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]))
  with check (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]));

alter policy talent_help_offers_own_insert on talent_showcase_help_offers
  with check (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id());

alter policy talent_help_offers_own_read on talent_showcase_help_offers
  using (my_tenant_id() = tenant_id and (portal_user_id = current_portal_user_id() or (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[])));

alter policy talent_showcase_supporters_admin_all on talent_showcase_supporters
  using (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]))
  with check (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]));

alter policy talent_showcases_admin_all on talent_showcases
  using (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]))
  with check (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]));

alter policy talent_showcases_own_read on talent_showcases
  using (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id());

alter policy talent_showcases_portal_delete_own on talent_showcases
  using (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id() and (moderation_status)::text = 'pending'::text);

alter policy talent_showcases_portal_insert on talent_showcases
  with check (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id());

alter policy talent_showcases_public_read on talent_showcases
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid and is_published = true);

alter policy training_batches_admin on training_batches
  using (my_tenant_id() = tenant_id and can_access_system('donors_projects'::character varying))
  with check (my_tenant_id() = tenant_id and can_access_system('donors_projects'::character varying) and current_admin_permission('manage_parties'::character varying));

alter policy training_batches_read on training_batches
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

alter policy training_batches_trainer on training_batches
  using (my_tenant_id() = tenant_id and current_admin_can_collect_for_training_program(project_id));

alter policy training_enrollments_admin on training_enrollments
  using (my_tenant_id() = tenant_id and can_access_system('donors_projects'::character varying))
  with check (my_tenant_id() = tenant_id and can_access_system('donors_projects'::character varying) and current_admin_permission('manage_parties'::character varying));

alter policy training_enrollments_own on training_enrollments
  using (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id());

alter policy training_enrollments_trainer on training_enrollments
  using (my_tenant_id() = tenant_id and current_admin_can_collect_for_training_program(project_id));

alter policy training_fee_charges_admin on training_fee_charges
  using (my_tenant_id() = tenant_id and can_access_system('donors_projects'::character varying))
  with check (my_tenant_id() = tenant_id and can_access_system('donors_projects'::character varying));

alter policy training_fee_charges_own on training_fee_charges
  using (my_tenant_id() = tenant_id and (exists (select 1 from training_enrollments e where e.id = training_fee_charges.enrollment_id and e.portal_user_id = current_portal_user_id())));

alter policy training_fee_charges_trainer on training_fee_charges
  using (my_tenant_id() = tenant_id and (exists (select 1 from training_enrollments e where e.id = training_fee_charges.enrollment_id and current_admin_can_collect_for_training_program(e.project_id))));

alter policy volunteers_public_read on volunteers
  using (tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid));

alter policy volunteers_self_all on volunteers
  using (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id())
  with check (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id());

alter policy volunteers_staff_moderate on volunteers
  using (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)))
  with check (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)));
