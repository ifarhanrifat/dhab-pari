-- Phase 1, part 2/3: tenant_id defaults. Nothing in the app code sets
-- tenant_id explicitly yet (it didn't exist until the last migration) —
-- every existing INSERT across the whole app simply omits the column,
-- which means every one of them would now fail its NOT NULL constraint
-- the moment it ran, without this.
--
-- DEFAULT my_tenant_id() fixes this transparently and correctly, not just
-- as a stopgap: a logged-in admin or portal user's own insert
-- automatically lands in their own tenant forever, with no app code
-- having to learn about tenant_id at all for the common case. The
-- COALESCE only matters for the handful of INSERT policies that allow an
-- anonymous (logged-out) submitter — donors_public_submit chief among
-- them — where my_tenant_id() has no auth.uid() to resolve and returns
-- null; those fall back to the one real tenant that exists today. That
-- fallback is accurate right now (there is only one tenant) and is
-- exactly the kind of thing phase 2's routing layer (resolving a tenant
-- from the request's domain/path for a logged-out visitor) replaces
-- properly later — not a hack being quietly left to rot.
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
    'site_settings', 'audit_log',
    'voucher_counters', 'message_templates'
  ];
begin
  foreach v_table in array v_tables loop
    execute format(
      'alter table %I alter column tenant_id set default coalesce(my_tenant_id(), %L::uuid)',
      v_table, v_tenant_id
    );
  end loop;
end $$;
