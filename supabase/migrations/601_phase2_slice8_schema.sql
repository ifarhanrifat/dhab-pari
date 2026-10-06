-- Phase 2, slice 8 (schema): tenant-scope the mentor/talent/training/
-- schools domain -- 17 tables. Confirmed via FK dump: all tie to
-- portal_users/admin_users/projects/donors/vouchers/schools, already
-- tenant-scoped. This is the biggest remaining domain and unblocks the
-- largest backlog of functions already deferred as "mixed" across slices
-- 5-7 (admin_sidebar_badges, complete_project_volunteers,
-- academy_summary_report, confirm_training_enrollment,
-- my_training_academy_roster, my_training_fees, pay_training_fee_charge,
-- reject_training_enrollment, reject_training_fee_announcement,
-- training_session_reminders, trg_volunteer_notify_staff,
-- trg_volunteer_notify_portal, recent_activity_since).
--
-- No business-key PK/UNIQUE re-keys needed this slice -- every UNIQUE
-- constraint checked (mentor_chat_blocks(blocker,blocked),
-- mentor_conversations(student,mentor), talent_showcase_comment_likes
-- (comment_id, portal_user_id), training_fee_charges(enrollment_id,
-- charge_no)) is already transitively tenant-safe: every column is a UUID
-- FK into an already-tenant-scoped row.

do $$
declare
  t text;
  tables text[] := array[
    'mentor_chat_blocks','mentor_conversations','mentor_messages',
    'talent_showcases','talent_showcase_comments','talent_showcase_comment_likes',
    'talent_showcase_help_offers','talent_showcase_supporters',
    'job_listings','manual_achievements','institutes','schools',
    'school_fee_tiers','training_batches','training_enrollments',
    'training_fee_charges','volunteers'
  ];
begin
  foreach t in array tables loop
    execute format('alter table %I add column tenant_id uuid references tenants(id)', t);
    execute format('update %I set tenant_id = ''bf9e4815-4104-472a-ab32-114171b7e34d''::uuid where tenant_id is null', t);
    execute format('alter table %I alter column tenant_id set not null', t);
    execute format('create index %I on %I (tenant_id)', t || '_tenant_id_idx', t);
    execute format('alter table %I alter column tenant_id set default coalesce(my_tenant_id(), ''bf9e4815-4104-472a-ab32-114171b7e34d''::uuid)', t);
  end loop;
end $$;
