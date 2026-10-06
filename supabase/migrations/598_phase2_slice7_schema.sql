-- Phase 2, slice 7 (schema): tenant-scope the meetings/agenda + approval
-- workflow domain -- 7 tables. All tightly linked to admin_users/
-- committee_members/projects/suggestions (all already tenant-scoped);
-- confirmed via FK dump before starting.
--
-- approval_type_settings has a pure business-key PK with no id column at
-- all: (system, transaction_type). Re-keyed to
-- (tenant_id, system, transaction_type), same pattern as every other
-- business-key PK this phase. Every other UNIQUE constraint on these
-- tables (agenda_item_assignees(agenda_item_id, committee_member_id),
-- approval_approvers(system, admin_user_id), approval_confirmations
-- (approval_request_id, approver_id), approval_requests(kind,
-- reference_id)) is already transitively tenant-safe: every column is
-- either a UUID FK into an already-tenant-scoped row, or a globally-unique
-- UUID (reference_id) that cannot collide across tenants.

do $$
declare
  t text;
  tables text[] := array[
    'agenda_meetings','agenda_items','agenda_item_assignees',
    'approval_requests','approval_approvers','approval_confirmations',
    'approval_type_settings'
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

-- approval_type_settings: PK re-keyed from (system, transaction_type) to
-- (tenant_id, system, transaction_type).
alter table approval_type_settings drop constraint approval_type_settings_pkey;
alter table approval_type_settings add primary key (tenant_id, system, transaction_type);
