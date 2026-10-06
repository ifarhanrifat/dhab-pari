-- Phase 2, slice 9 (schema): tenant-scope the employee/payroll + monthly
-- closing domain -- 4 tables. Confirmed via FK dump: all tie to
-- admin_users/vouchers/recurring_schedules, already tenant-scoped.
--
-- Two business-key re-keys needed:
--   employee_roles: PK re-keyed from (key) alone to (tenant_id, key) --
--   this also requires employees.primary_role/secondary_role (single-
--   column FKs into employee_roles(key)) to become composite FKs into
--   (tenant_id, key), or the re-key would break them outright.
--   monthly_closing_reports: UNIQUE re-keyed from (system, report_month,
--   report_year) to (tenant_id, ...) -- `system` is a shared label
--   ('donors_projects', 'water_supply') across every tenant, not
--   transitively tenant-safe on its own.
--
-- employee_payslips' UNIQUE (employee_id, month, year) is already
-- transitively tenant-safe (employee_id is a UUID FK into an
-- already-tenant-scoped row) -- left as-is.

do $$
declare
  t text;
  tables text[] := array[
    'employees','employee_roles','employee_payslips','monthly_closing_reports'
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

-- employee_roles: PK re-keyed from (key) to (tenant_id, key); the two FKs
-- from employees become composite to match.
alter table employees drop constraint employees_primary_role_fkey;
alter table employees drop constraint employees_secondary_role_fkey;
alter table employee_roles drop constraint employee_roles_pkey;
alter table employee_roles add primary key (tenant_id, key);
alter table employees add constraint employees_primary_role_fkey
  foreign key (tenant_id, primary_role) references employee_roles (tenant_id, key);
alter table employees add constraint employees_secondary_role_fkey
  foreign key (tenant_id, secondary_role) references employee_roles (tenant_id, key);

-- monthly_closing_reports: UNIQUE re-keyed from (system, report_month,
-- report_year) to (tenant_id, system, report_month, report_year).
alter table monthly_closing_reports drop constraint monthly_closing_reports_system_report_month_report_year_key;
alter table monthly_closing_reports add constraint monthly_closing_reports_system_report_month_report_year_key
  unique (tenant_id, system, report_month, report_year);
