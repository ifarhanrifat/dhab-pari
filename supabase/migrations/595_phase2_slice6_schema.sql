-- Phase 2, slice 6 (schema): tenant-scope the donors & projects "core
-- content" domain -- 16 tables. `projects` itself is the single most
-- central, donor-facing table still unscoped in the whole system (it's the
-- table behind the donation-display bug fixed earlier this session) --
-- everything else here is a table that hangs directly off it or off the
-- same portal_users/admin_users identity layer: project_comments,
-- project_comment_likes, project_media, project_tasks, project_votes,
-- appeals, committee_members, committee_notes, death_announcements,
-- help_requests, needs_register, needs_surveys, needs_verifications,
-- party_complaints, and the shared polymorphic ratings table (used by
-- vehicles/shops too, confirmed via its rater_party_type/target_party_type
-- values, but with no FK dependency that would make it awkward to include
-- here).
--
-- needs_register.code (UNIQUE) is re-keyed to (tenant_id, code), same
-- pattern as every other business-key PK/UNIQUE this phase. Every other
-- UNIQUE constraint on these tables (project_comment_likes(comment_id,
-- portal_user_id), project_votes(project_id, portal_user_id),
-- needs_verifications(register_id, admin_user_id), ratings(ref_type,
-- ref_id, rater_party_type, rater_party_id)) is already transitively
-- tenant-safe: every column in each is either itself a UUID FK into an
-- already-tenant-scoped row (comment_id/project_id/register_id), or a
-- globally-unique UUID (ref_id) that cannot collide across tenants.

do $$
declare
  t text;
  tables text[] := array[
    'projects','project_comments','project_comment_likes','project_media',
    'project_tasks','project_votes','appeals','committee_members',
    'committee_notes','death_announcements','help_requests','needs_register',
    'needs_surveys','needs_verifications','party_complaints','ratings'
  ];
begin
  foreach t in array tables loop
    execute format('alter table %I add column tenant_id uuid references tenants(id)', t);
    -- trg_needs_verification_guard rejects any UPDATE not made by a
    -- needs-verifier admin, including this migration's own tenant_id
    -- backfill -- not a data-integrity guard, just an app-flow safeguard,
    -- so it's safe to disable for this one statement.
    if t = 'needs_verifications' then
      execute 'alter table needs_verifications disable trigger needs_verification_guard';
    end if;
    execute format('update %I set tenant_id = ''bf9e4815-4104-472a-ab32-114171b7e34d''::uuid where tenant_id is null', t);
    if t = 'needs_verifications' then
      execute 'alter table needs_verifications enable trigger needs_verification_guard';
    end if;
    execute format('alter table %I alter column tenant_id set not null', t);
    execute format('create index %I on %I (tenant_id)', t || '_tenant_id_idx', t);
    execute format('alter table %I alter column tenant_id set default coalesce(my_tenant_id(), ''bf9e4815-4104-472a-ab32-114171b7e34d''::uuid)', t);
  end loop;
end $$;

-- needs_register: UNIQUE re-keyed from (code) to (tenant_id, code).
alter table needs_register drop constraint needs_register_code_key;
alter table needs_register add constraint needs_register_code_key unique (tenant_id, code);
