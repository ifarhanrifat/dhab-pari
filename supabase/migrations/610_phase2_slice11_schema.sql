-- Phase 2, slice 11 (schema): tenant-scope agriculture reference data +
-- water-supply connection templates -- 9 tables. Confirmed via FK dump:
-- all standalone (no cross-domain FKs) except connection_template_items
-- (ties to connection_templates/inventory_items/service_items, already
-- tenant-scoped).
--
-- Two business-key re-keys needed:
--   alert_expiry_settings: PK re-keyed from (alert_type) alone to
--   (tenant_id, alert_type).
--   weather_alerts_log: UNIQUE re-keyed from (alert_date) alone to
--   (tenant_id, alert_date) -- otherwise only one tenant system-wide could
--   ever log a weather alert for a given calendar date, even though each
--   tenant's alert broadcast to its own portal_users is independent.

do $$
declare
  t text;
  tables text[] := array[
    'ag_disease_guides','ag_help_centers','ag_livestock_guides','ag_schemes',
    'crop_prices','weather_alerts_log','alert_expiry_settings',
    'connection_templates','connection_template_items'
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

-- alert_expiry_settings: PK re-keyed from (alert_type) to (tenant_id, alert_type).
alter table alert_expiry_settings drop constraint alert_expiry_settings_pkey;
alter table alert_expiry_settings add primary key (tenant_id, alert_type);

-- weather_alerts_log: UNIQUE re-keyed from (alert_date) to (tenant_id, alert_date).
alter table weather_alerts_log drop constraint weather_alerts_log_alert_date_key;
alter table weather_alerts_log add constraint weather_alerts_log_alert_date_key unique (tenant_id, alert_date);
