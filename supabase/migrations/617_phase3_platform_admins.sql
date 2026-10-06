-- Phase 3, part 1: the platform-admin role.
--
-- Design choice: platform admins are a separate identity from
-- tenant-scoped admin_users, not a flag bolted onto it. admin_users rows
-- are tenant_id NOT NULL everywhere (and every one of the ~600 RLS
-- policies and SECURITY DEFINER functions across Phase 2 was written
-- against that assumption via my_tenant_id()). Retrofitting a
-- "tenant_id can be NULL for a platform admin" exception into that whole
-- surface area is exactly the kind of sweeping, hard-to-verify change
-- this phase has spent 12 slices trying to get right one table at a
-- time -- doing it in one unattended overnight pass would be reckless.
--
-- Instead: platform_admins is its own small, standalone table (own
-- auth_user_id, no tenant_id at all, genuinely platform-wide by design).
-- A platform admin's cross-tenant visibility is granted exclusively
-- through a handful of new SECURITY DEFINER platform_* functions (this
-- migration and the next two), each explicitly gated by
-- is_platform_admin() -- every existing tenant-scoped RLS policy and
-- function is completely untouched and keeps working exactly as before
-- for tenant admin_users/portal_users.

create table platform_admins (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid references auth.users(id),
  full_name varchar not null,
  email varchar not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table platform_admins enable row level security;

-- A platform admin can see their own row (e.g. to render "signed in as");
-- nothing else is exposed via RLS at all -- creating/deactivating a
-- platform admin happens only via the service-role key (the same
-- deliberately-manual bootstrap pattern every admin_users/portal_users
-- row ultimately traces back to), never through a client-facing policy.
create policy platform_admins_self_read on platform_admins
  for select to authenticated
  using (auth_user_id = auth.uid());

create or replace function public.current_platform_admin_id()
 returns uuid
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select id from platform_admins where auth_user_id = auth.uid() and is_active = true limit 1;
$function$;

create or replace function public.is_platform_admin()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (select 1 from platform_admins where auth_user_id = auth.uid() and is_active = true);
$function$;

-- tenants: platform admins get full management through SECURITY DEFINER
-- functions in migration 619, but also a direct read/write RLS policy --
-- unlike those single-purpose functions, "edit a tenant's own fields" is
-- plausibly something a future admin screen wants to do with an ordinary
-- client update, not only through an RPC.
create policy tenants_platform_manage on tenants
  for all to authenticated
  using (is_platform_admin())
  with check (is_platform_admin());
