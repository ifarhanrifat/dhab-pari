-- Phase 1 of multi-tenancy, part 1/3 (schema foundation): a tenants table
-- plus tenant_id on the financial/admin core — admin_users, portal_users,
-- donors, the double-entry ledger, and water billing. Phase 2 extends
-- tenant_id to the rest of the app (marketplace, welfare programs,
-- directory, complaints, notices); phase 3 adds a platform-admin role and
-- per-tenant billing. See the migration 565-era session notes for the
-- real research behind this scope: 390 of 689 SECURITY DEFINER functions
-- touch at least one of these tables, because this app's whole feature
-- set shares one ledger/donor/voucher backbone — but only 113 of those
-- touch *exclusively* phase-1 tables. Everything else stays untouched
-- until its own feature area is scoped in a later phase; a second tenant
-- is therefore water-billing/donors/core-ledger only until phase 2 ships
-- — a deliberate scope boundary, not an oversight.
--
-- Nullable-then-backfill-then-NOT-NULL throughout, on a live database
-- with real admins using it right now: every ADD COLUMN here is nullable
-- first so it never blocks on existing rows, backfilled to the one real
-- tenant (Dhab Pari) in the same migration, then locked to NOT NULL only
-- once every row has a value.

create table tenants (
  id uuid primary key default gen_random_uuid(),
  -- Subdomain/path identifier for a future per-tenant routing layer
  -- (phase 2+) — not used by the app yet, reserved now so it exists
  -- before anything depends on it.
  slug varchar(63) not null unique,
  name varchar(200) not null,
  name_ur varchar(200),
  is_active boolean not null default true,
  -- Direct DB-backed replacement for the NEXT_PUBLIC_MODULE_WATER /
  -- NEXT_PUBLIC_MODULE_DONORS env flags in src/lib/constants.ts — those
  -- only ever hid navigation per *deployment*, with their own comment
  -- explicitly noting they are not a security boundary. These two are:
  -- RLS checks them directly (see the policy migration that follows).
  water_supply_enabled boolean not null default true,
  donors_enabled boolean not null default true,
  created_at timestamptz not null default now()
);

insert into tenants (slug, name, name_ur) values ('dhab-pari', 'Dhab Pari', 'ڈھاب پڑی');

-- tenant_id has to exist on admin_users/portal_users before my_tenant_id()
-- can be created below — a plain SQL function is validated against the
-- catalog at CREATE time, unlike plpgsql's more deferred checking.
do $$
declare
  v_tenant_id uuid := (select id from tenants where slug = 'dhab-pari');
  v_table text;
  v_tables text[] := array[
    'admin_users', 'portal_users', 'donors',
    'accounts', 'ledger_entries', 'vouchers', 'voucher_line_items', 'voucher_approvals', 'payments', 'transactions',
    'consumers', 'bills', 'bill_line_items', 'bill_payment_claims', 'connection_requests', 'connection_request_items',
    'recurring_schedules', 'sectors', 'collector_settlements',
    'inventory_items', 'inventory_transactions', 'service_items',
    'site_settings', 'audit_log'
  ];
begin
  foreach v_table in array v_tables loop
    execute format('alter table %I add column tenant_id uuid references tenants(id)', v_table);
    execute format('update %I set tenant_id = $1', v_table) using v_tenant_id;
    execute format('alter table %I alter column tenant_id set not null', v_table);
    execute format('create index %I on %I (tenant_id)', v_table || '_tenant_id_idx', v_table);
  end loop;
end $$;

-- Same house style as current_admin_user_id()/current_portal_user_id()/
-- my_language() — STABLE SECURITY DEFINER SQL function, admin_users
-- checked before portal_users since the same auth_user_id is never both.
create function my_tenant_id()
returns uuid
language sql
stable security definer
set search_path to 'public'
as $function$
  select coalesce(
    (select tenant_id from admin_users where auth_user_id = auth.uid() and is_active = true limit 1),
    (select tenant_id from portal_users where auth_user_id = auth.uid() and is_active = true limit 1)
  );
$function$;

-- voucher_counters and message_templates have no `id` column at all —
-- their primary key IS their business key, which is exactly what needs
-- to grow a tenant_id component.
alter table voucher_counters add column tenant_id uuid references tenants(id);
update voucher_counters set tenant_id = (select id from tenants where slug = 'dhab-pari');
alter table voucher_counters alter column tenant_id set not null;
alter table voucher_counters drop constraint voucher_counters_pkey;
alter table voucher_counters add primary key (tenant_id, system, voucher_type);

alter table message_templates add column tenant_id uuid references tenants(id);
update message_templates set tenant_id = (select id from tenants where slug = 'dhab-pari');
alter table message_templates alter column tenant_id set not null;
alter table message_templates drop constraint message_templates_pkey;
alter table message_templates add primary key (tenant_id, key);

-- Business-key uniqueness that was only ever meant to hold within one
-- committee's own books — a second tenant must be able to have its own
-- "WB-0001" voucher, its own chart-of-accounts code 4050, without
-- colliding with Dhab Pari's. Random opaque tokens (consumers.lookup_token,
-- vouchers.approval_token) and identity columns Supabase Auth itself
-- already enforces globally (auth_user_id, email) are deliberately left
-- as-is — see this migration's own header comment.
--
-- consumers.consumer_id is the one exception, deliberately NOT re-keyed
-- here: 11 tables carry a plain FK straight to consumers(consumer_id)
-- rather than consumers(id) — including complaints and reminder_queue,
-- neither scoped yet (complaints is phase 2; reminder_queue wasn't even
-- in this migration's table list). Re-keying it to (tenant_id,
-- consumer_id) means turning all 11 into composite FKs, which means
-- giving complaints a tenant_id ahead of the rest of phase 2 — real work,
-- correctly phase 2's, not a thing to rush into this migration. Tracked
-- debt: consumer_id stays a single globally-unique sequence across every
-- tenant until that happens, which costs nothing functionally (it's a
-- display code, not a security boundary — consumers themselves are
-- already tenant_id-scoped and RLS-protected above) beyond a village
-- not getting to start its own consumer numbering back at 1.
alter table bills drop constraint bills_bill_number_key;
alter table bills add constraint bills_bill_number_key unique (tenant_id, bill_number);

alter table site_settings drop constraint site_settings_key_key;
alter table site_settings add constraint site_settings_key_key unique (tenant_id, key);

alter table accounts drop constraint accounts_code_system_key;
alter table accounts add constraint accounts_code_system_key unique (tenant_id, code, system);

alter table accounts drop constraint accounts_donor_account_no_key;
alter table accounts add constraint accounts_donor_account_no_key unique (tenant_id, donor_account_no);

alter table vouchers drop constraint vouchers_voucher_no_key;
alter table vouchers add constraint vouchers_voucher_no_key unique (tenant_id, voucher_no);

alter table inventory_items drop constraint inventory_items_item_code_key;
alter table inventory_items add constraint inventory_items_item_code_key unique (tenant_id, item_code);

alter table service_items drop constraint service_items_service_code_key;
alter table service_items add constraint service_items_service_code_key unique (tenant_id, service_code);

alter table sectors drop constraint sectors_name_key;
alter table sectors add constraint sectors_name_key unique (tenant_id, name);

alter table connection_requests drop constraint connection_requests_request_number_key;
alter table connection_requests add constraint connection_requests_request_number_key unique (tenant_id, request_number);
