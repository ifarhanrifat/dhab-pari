-- Phase 2, slice 9 (RLS): tenant-scope every policy on the 4 slice-9
-- tables. All 11 policies are roles={authenticated} with no anonymous-
-- readable policy at all -- every one gets `tenant_id = my_tenant_id() AND`
-- prepended.

alter policy employee_payslips_insert on employee_payslips
  with check (my_tenant_id() = tenant_id and can_access_system('water_supply'::character varying) and current_admin_permission('post_transactions'::character varying));

alter policy employee_payslips_read on employee_payslips
  using (my_tenant_id() = tenant_id and can_access_system('water_supply'::character varying));

alter policy employee_payslips_update on employee_payslips
  using (my_tenant_id() = tenant_id and can_access_system('water_supply'::character varying))
  with check (my_tenant_id() = tenant_id and can_access_system('water_supply'::character varying) and current_admin_permission('post_transactions'::character varying));

alter policy employee_roles_read on employee_roles
  using (my_tenant_id() = tenant_id and can_access_system('water_supply'::character varying));

alter policy employee_roles_update on employee_roles
  using (my_tenant_id() = tenant_id and can_access_system('water_supply'::character varying))
  with check (my_tenant_id() = tenant_id and can_access_system('water_supply'::character varying) and current_admin_permission('manage_parties'::character varying));

alter policy employee_roles_write on employee_roles
  with check (my_tenant_id() = tenant_id and can_access_system('water_supply'::character varying) and current_admin_permission('manage_parties'::character varying));

alter policy employees_delete on employees
  using (my_tenant_id() = tenant_id and can_access_system('water_supply'::character varying) and current_admin_permission('manage_parties'::character varying));

alter policy employees_read on employees
  using (my_tenant_id() = tenant_id and can_access_system('water_supply'::character varying));

alter policy employees_update on employees
  using (my_tenant_id() = tenant_id and can_access_system('water_supply'::character varying))
  with check (my_tenant_id() = tenant_id and can_access_system('water_supply'::character varying) and current_admin_permission('manage_parties'::character varying));

alter policy employees_write on employees
  with check (my_tenant_id() = tenant_id and can_access_system('water_supply'::character varying) and current_admin_permission('manage_parties'::character varying));

alter policy monthly_closing_reports_read on monthly_closing_reports
  using (my_tenant_id() = tenant_id and can_access_system(system));
