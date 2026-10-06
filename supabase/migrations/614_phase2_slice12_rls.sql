-- Phase 2, slice 12 (RLS): tenant-scope every policy on account_headers,
-- term_labels, ui_overrides.
--
-- public_read_account_headers can use the plain hardcoded dhab-pari
-- literal, since account_headers_read is a separate authenticated-only
-- policy that already covers an admin's own-tenant visibility.
--
-- term_labels_read and ui_overrides_read are each the ONE read policy
-- covering BOTH anon and authenticated roles (roles={anon,authenticated})
-- with no separate authenticated-only fallback -- each needs
-- coalesce(my_tenant_id(), <dhab-pari>) so an authenticated user of any
-- tenant still sees their own tenant's labels/overrides, not just
-- dhab-pari's.

alter policy account_headers_delete on account_headers
  using (my_tenant_id() = tenant_id and can_access_system(system) and current_admin_permission('manage_accounts'::character varying));

alter policy account_headers_read on account_headers
  using (my_tenant_id() = tenant_id and can_access_system(system));

alter policy account_headers_update on account_headers
  using (my_tenant_id() = tenant_id and can_access_system(system))
  with check (my_tenant_id() = tenant_id and can_access_system(system) and current_admin_permission('manage_accounts'::character varying));

alter policy account_headers_write on account_headers
  with check (my_tenant_id() = tenant_id and can_access_system(system) and current_admin_permission('manage_accounts'::character varying));

alter policy public_read_account_headers on account_headers
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

alter policy term_labels_read on term_labels
  using (tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid));

alter policy term_labels_write on term_labels
  using (my_tenant_id() = tenant_id and current_admin_permission('manage_accounts'::character varying) IS DISTINCT FROM false)
  with check (my_tenant_id() = tenant_id and current_admin_permission('manage_accounts'::character varying) IS DISTINCT FROM false);

alter policy ui_overrides_read on ui_overrides
  using (tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid));

alter policy ui_overrides_write on ui_overrides
  using (my_tenant_id() = tenant_id and current_admin_permission('manage_accounts'::character varying) IS DISTINCT FROM false)
  with check (my_tenant_id() = tenant_id and current_admin_permission('manage_accounts'::character varying) IS DISTINCT FROM false);
