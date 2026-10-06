-- Phase 2, slice 4 (schema): tenant-scope the welfare-programs domain --
-- 44 tables covering Kafalat child sponsorship, Wazifa student loans/
-- scholarships, Sadqa Jariya (donated objects/upkeep), Zakat distribution,
-- Chanda campaigns, support pools (rotating/committee funds), and event
-- Salami accounts.
--
-- Every table here has a plain `id` primary key -- no composite/business-
-- key PK like fare_bands' `flow` this time. Four UNIQUE constraints ARE
-- business-key (not FK-based) and get re-keyed to include tenant_id, same
-- reasoning as accounts_code_system_key in migration 566:
--   kafalat_children_code_key (code), support_pools_code_key (code),
--   sadqa_objects_object_no_key (object_no), wazifa_students_code_key (code)
-- Every other UNIQUE constraint on these 44 tables (child_id+category+month,
-- pool_id+month, object_id+month, award_id+charge_no,
-- award_id+instalment_no, application_id+admin_user_id,
-- round_id+register_id, event_id+side) is FK-based against a specific,
-- already-tenant-scoped row and needs no change.

do $$
declare
  t text;
  tables text[] := array[
    'kafalat_children','kafalat_disbursements','kafalat_fee_payments',
    'kafalat_nominations','kafalat_package_lines','kafalat_progress',
    'kafalat_reverifications','kafalat_shares','kafalat_uniform_issues',
    'wazifa_academic_records','wazifa_agreements','wazifa_applications',
    'wazifa_awards','wazifa_check_ins','wazifa_contributions',
    'wazifa_decisions','wazifa_disbursement_charges','wazifa_documents',
    'wazifa_family_members','wazifa_installment_charges','wazifa_instalments',
    'wazifa_interim_grant','wazifa_repayment_schedule','wazifa_repayments',
    'wazifa_results','wazifa_students','wazifa_verifications',
    'sadqa_bills','sadqa_catalogue','sadqa_maintenance_log','sadqa_messages',
    'sadqa_objects','sadqa_receipts','sadqa_upkeep_charges',
    'zakat_round_beneficiaries','zakat_rounds','chanda_campaigns',
    'chanda_pledges','support_pools','pool_commitments','pool_months',
    'pool_payments','event_salami_accounts','event_salami_pledges'
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

alter table kafalat_children drop constraint kafalat_children_code_key;
alter table kafalat_children add constraint kafalat_children_code_key unique (tenant_id, code);

alter table support_pools drop constraint support_pools_code_key;
alter table support_pools add constraint support_pools_code_key unique (tenant_id, code);

alter table sadqa_objects drop constraint sadqa_objects_object_no_key;
alter table sadqa_objects add constraint sadqa_objects_object_no_key unique (tenant_id, object_no);

alter table wazifa_students drop constraint wazifa_students_code_key;
alter table wazifa_students add constraint wazifa_students_code_key unique (tenant_id, code);
