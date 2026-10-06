-- Phase 2, slice 11 (RLS): tenant-scope every policy on the slice-11
-- tables (weather_alerts_log has RLS enabled with no policies at all --
-- nothing to fix there). Authenticated-only policies get
-- `tenant_id = my_tenant_id() AND` prepended. Every anonymous-readable
-- policy has a separate authenticated ALL policy ("_staff_all") that
-- already covers an admin's own-tenant visibility regardless of
-- is_active, so each gets the plain hardcoded dhab-pari literal.

alter policy ag_disease_guides_public_read on ag_disease_guides
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid and is_active = true);

alter policy ag_disease_guides_staff_all on ag_disease_guides
  using (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)))
  with check (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)));

alter policy ag_help_centers_public_read on ag_help_centers
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid and is_active = true);

alter policy ag_help_centers_staff_all on ag_help_centers
  using (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)))
  with check (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)));

alter policy ag_livestock_guides_public_read on ag_livestock_guides
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid and is_active = true);

alter policy ag_livestock_guides_staff_all on ag_livestock_guides
  using (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)))
  with check (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)));

alter policy ag_schemes_public_read on ag_schemes
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid and is_active = true);

alter policy ag_schemes_staff_all on ag_schemes
  using (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)))
  with check (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)));

alter policy alert_expiry_settings_staff_all on alert_expiry_settings
  using (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)))
  with check (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)));

alter policy connection_template_items_read on connection_template_items
  using (my_tenant_id() = tenant_id and (exists (select 1 from connection_templates t where t.id = connection_template_items.template_id and can_access_system(t.system))));

alter policy connection_template_items_write on connection_template_items
  using (my_tenant_id() = tenant_id and (exists (select 1 from connection_templates t where t.id = connection_template_items.template_id and can_access_system(t.system) and current_admin_permission('manage_accounts'::character varying))))
  with check (my_tenant_id() = tenant_id and (exists (select 1 from connection_templates t where t.id = connection_template_items.template_id and can_access_system(t.system) and current_admin_permission('manage_accounts'::character varying))));

alter policy connection_templates_delete on connection_templates
  using (my_tenant_id() = tenant_id and can_access_system(system) and current_admin_permission('delete_accounts'::character varying));

alter policy connection_templates_read on connection_templates
  using (my_tenant_id() = tenant_id and can_access_system(system));

alter policy connection_templates_update on connection_templates
  using (my_tenant_id() = tenant_id and can_access_system(system))
  with check (my_tenant_id() = tenant_id and can_access_system(system) and current_admin_permission('edit_accounts'::character varying));

alter policy connection_templates_write on connection_templates
  with check (my_tenant_id() = tenant_id and can_access_system(system) and current_admin_permission('manage_accounts'::character varying));

alter policy crop_prices_public_read on crop_prices
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

alter policy crop_prices_staff_all on crop_prices
  using (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)))
  with check (my_tenant_id() = tenant_id and (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true)));
