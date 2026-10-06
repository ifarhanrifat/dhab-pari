-- Phase 2, slice 5 (schema): tenant-scope the notifications/device-token
-- domain -- 7 tables. Chosen as the next slice specifically because many
-- functions deferred in slices 2-4 (cron jobs and order/dispatch-acceptance
-- flows) were held back only because they touch portal_notifications or
-- notifications; scoping these tables now lets a follow-up migration go
-- back and finish those.
--
-- notification_preferences (PK: event_type) and portal_signup_verifications
-- (PK: email) are both business-key PKs re-keyed to include tenant_id, same
-- pattern as voucher_counters/complaint_number_counters. fcm_device_tokens
-- (UNIQUE: token) and push_subscriptions (UNIQUE: endpoint) are re-keyed to
-- (tenant_id, token)/(tenant_id, endpoint) too, conservatively -- a device
-- token or push endpoint is normally one-device-one-row, but re-keying
-- costs nothing and avoids relying on cross-tenant uniqueness holding
-- forever.

do $$
declare
  t text;
  tables text[] := array[
    'fcm_device_tokens','notifications','notifications_log',
    'portal_notifications','push_subscriptions'
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

-- notification_preferences: PK re-keyed from (event_type) to (tenant_id, event_type).
alter table notification_preferences add column tenant_id uuid references tenants(id);
update notification_preferences set tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid where tenant_id is null;
alter table notification_preferences alter column tenant_id set not null;
alter table notification_preferences drop constraint notification_preferences_pkey;
alter table notification_preferences add primary key (tenant_id, event_type);
create index notification_preferences_tenant_id_idx on notification_preferences (tenant_id);
alter table notification_preferences alter column tenant_id set default coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

-- portal_signup_verifications: PK re-keyed from (email) to (tenant_id, email).
alter table portal_signup_verifications add column tenant_id uuid references tenants(id);
update portal_signup_verifications set tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid where tenant_id is null;
alter table portal_signup_verifications alter column tenant_id set not null;
alter table portal_signup_verifications drop constraint portal_signup_verifications_pkey;
alter table portal_signup_verifications add primary key (tenant_id, email);
create index portal_signup_verifications_tenant_id_idx on portal_signup_verifications (tenant_id);
alter table portal_signup_verifications alter column tenant_id set default coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

-- Business-key unique constraints re-keyed to include tenant_id.
alter table fcm_device_tokens drop constraint fcm_device_tokens_token_key;
alter table fcm_device_tokens add constraint fcm_device_tokens_token_key unique (tenant_id, token);

alter table push_subscriptions drop constraint push_subscriptions_endpoint_key;
alter table push_subscriptions add constraint push_subscriptions_endpoint_key unique (tenant_id, endpoint);
