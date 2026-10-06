-- Phase 2, slice 1 (schema): directory, contacts, civic reports,
-- complaints, lost & found, suggestions, village events/landmarks, blood
-- bank, and the two water-billing-adjacent support tables
-- (consumer_nonpayment_flags, reminder_queue) that were deliberately left
-- out of phase 1 since they reference consumers by the still-globally-
-- unique consumer_id rather than a tenant-scoped FK. Smallest, lowest-
-- financial-complexity slice of "the rest" — proving the phase 1 pattern
-- scales before the much bigger marketplace and welfare-program slices.
--
-- Same approach as migration 566: nullable add -> backfill to the one
-- real tenant -> NOT NULL -> indexed, plus DEFAULT coalesce(my_tenant_id(),
-- <dhab-pari>) so no app code needs to change for existing INSERT paths.

do $$
declare
  v_tenant_id uuid := (select id from tenants where slug = 'dhab-pari');
  v_table text;
  v_tables text[] := array[
    'directory_entries', 'important_contacts', 'civic_reports',
    'complaints', 'complaint_handlers', 'complaint_updates',
    'lost_found_posts', 'suggestions',
    'village_landmarks', 'village_events',
    'blood_donors', 'blood_request_contacts', 'blood_requests',
    'consumer_nonpayment_flags', 'reminder_queue'
  ];
begin
  foreach v_table in array v_tables loop
    execute format('alter table %I add column tenant_id uuid references tenants(id)', v_table);
    execute format('update %I set tenant_id = $1', v_table) using v_tenant_id;
    execute format('alter table %I alter column tenant_id set not null', v_table);
    execute format('alter table %I alter column tenant_id set default coalesce(my_tenant_id(), %L::uuid)', v_table, v_tenant_id);
    execute format('create index %I on %I (tenant_id)', v_table || '_tenant_id_idx', v_table);
  end loop;
end $$;

-- complaint_number_counters has no `id` — same shape as voucher_counters
-- in migration 566.
alter table complaint_number_counters add column tenant_id uuid references tenants(id);
update complaint_number_counters set tenant_id = (select id from tenants where slug = 'dhab-pari');
alter table complaint_number_counters alter column tenant_id set not null;
alter table complaint_number_counters alter column tenant_id set default coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
alter table complaint_number_counters drop constraint complaint_number_counters_pkey;
alter table complaint_number_counters add primary key (tenant_id, system);
