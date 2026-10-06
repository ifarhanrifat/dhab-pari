-- Phase 2, slice 12 (schema): the final 3 tables genuinely needing
-- tenant scoping, out of the 6 platform-level tables left after slice 11.
--
-- account_headers, term_labels, ui_overrides were all reviewed and
-- judged real per-tenant customization gaps, not platform-wide tables:
--   account_headers groups a tenant's own chart-of-accounts by section,
--   with its own code-generation serial counter (next_serial) -- exactly
--   the kind of per-tenant sequence this whole phase has scoped
--   everywhere else (voucher_counters, complaint_number_counters, etc).
--   term_labels / ui_overrides are terminology and UI-string overrides a
--   different village/tenant would plausibly want to customize
--   independently (different local terms, different branding).
--
-- The other 3 tables found alongside them are deliberately left
-- unscoped: admin_user_credentials and dismissed_hints are pure 1:1/
-- per-user child tables (already transitively tenant-safe via
-- admin_user_id/portal_user_id, never queried independently of one), and
-- legacy_import_records is dhab-pari's own one-time pre-multi-tenancy
-- data-import audit trail -- inherently historical, not something a
-- future tenant would ever have rows in.
--
-- All three business-key UNIQUE constraints are re-keyed to include
-- tenant_id: account_headers (system, code), term_labels (category,
-- code), ui_overrides (locale, key) -- none of these are FK-derived, so
-- none were transitively tenant-safe on their own.

do $$
declare
  t text;
  tables text[] := array['account_headers','term_labels','ui_overrides'];
begin
  foreach t in array tables loop
    execute format('alter table %I add column tenant_id uuid references tenants(id)', t);
    execute format('update %I set tenant_id = ''bf9e4815-4104-472a-ab32-114171b7e34d''::uuid where tenant_id is null', t);
    execute format('alter table %I alter column tenant_id set not null', t);
    execute format('create index %I on %I (tenant_id)', t || '_tenant_id_idx', t);
    execute format('alter table %I alter column tenant_id set default coalesce(my_tenant_id(), ''bf9e4815-4104-472a-ab32-114171b7e34d''::uuid)', t);
  end loop;
end $$;

-- accounts.type has a composite FK into account_headers(system, code) --
-- drop it first, re-key account_headers, then recreate it as composite
-- with tenant_id (accounts already has tenant_id from an earlier slice).
alter table accounts drop constraint accounts_type_fkey;
alter table account_headers drop constraint account_headers_system_code_key;
alter table account_headers add constraint account_headers_system_code_key unique (tenant_id, system, code);
alter table accounts add constraint accounts_type_fkey
  foreign key (tenant_id, system, type) references account_headers (tenant_id, system, code);

alter table term_labels drop constraint term_labels_category_code_key;
alter table term_labels add constraint term_labels_category_code_key unique (tenant_id, category, code);

alter table ui_overrides drop constraint ui_overrides_locale_key_key;
alter table ui_overrides add constraint ui_overrides_locale_key_key unique (tenant_id, locale, key);
