-- CRITICAL SECURITY FIX: the `tenants` table had row level security
-- disabled entirely (relrowsecurity = false) AND the `anon` and
-- `authenticated` roles both held blanket INSERT/SELECT/UPDATE/DELETE/
-- TRUNCATE/REFERENCES/TRIGGER grants on it -- meaning any anonymous
-- visitor hitting the public Supabase REST API with nothing but the
-- public anon key could read the full tenant list, insert fake tenant
-- rows, or flip any tenant's (including dhab-pari's own) `is_active` flag
-- via a plain PATCH request. This was discovered while building the
-- platform-admin mechanism below, not something that mechanism caused --
-- it predates every slice of Phase 2.
--
-- Confirmed safe to fully lock down: no application code anywhere in
-- src/ queries the `tenants` table directly (grepped for
-- `.from('tenants')`/`.from("tenants")` -- zero matches). Every existing
-- code path resolves tenant context exclusively through the
-- SECURITY DEFINER `my_tenant_id()` function, never the table itself.
--
-- Fixed by enabling RLS with no anon/authenticated policies at all
-- (default-deny) and revoking the blanket grants, leaving `tenants`
-- readable/writable only via SECURITY DEFINER functions (the
-- platform_* functions below) or the service-role key. A narrow
-- authenticated-read policy is added for admin_users/portal_users to
-- read their OWN tenant's row (name/branding fields), since a future
-- screen may reasonably want to show "which village/tenant am I in."

alter table tenants enable row level security;

revoke insert, update, delete, truncate, references, trigger on tenants from anon;
revoke insert, update, delete, truncate, references, trigger on tenants from authenticated;
revoke select on tenants from anon;

create policy tenants_own_read on tenants
  for select to authenticated
  using (id = my_tenant_id());
