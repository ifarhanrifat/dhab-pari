-- Migration 670: the emergency/ilaan broadcast system.
--
-- Explicit ask: "there will be emergency and ilaan that we broadcast for
-- the villagers separately, it has nothing to do with marketplace
-- villages, and these systems will be controlled by the separate admin
-- and users." Two things follow from that:
--
-- 1. Posting identity is its own table, not admin_users/portal_users --
--    same design precedent as platform_admins (migration 617): own
--    auth_user_id, no tenant_id, genuinely separate from every
--    committee's own admin roster.
-- 2. Targeting is NOT gated by marketplace_share_agreements (667/668) or
--    by any per-village opt-in at all -- the user's own words rule that
--    out ("nothing to do with marketplace villages"). An emergency admin
--    picks target villages directly from the full tenant list, or
--    leaves it blank to reach every tenant. No committee action is
--    needed on either end.

-- ===================== Identity =====================

create table emergency_admins (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid references auth.users(id),
  full_name varchar not null,
  email varchar not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table emergency_admins enable row level security;

create policy emergency_admins_self_read on emergency_admins
  for select to authenticated
  using (auth_user_id = auth.uid());

create or replace function public.current_emergency_admin_id()
 returns uuid
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select id from emergency_admins where auth_user_id = auth.uid() and is_active = true limit 1;
$function$;

create or replace function public.is_emergency_admin()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (select 1 from emergency_admins where auth_user_id = auth.uid() and is_active = true);
$function$;

-- An emergency admin has no tenant_id of their own, so the existing
-- tenants RLS (own-tenant read, or is_platform_admin()) leaves them with
-- no way to see the village list to target a broadcast at. Narrow,
-- read-only addition -- just lets them see id/name, nothing else.
create policy tenants_emergency_admin_read on tenants
  for select to authenticated
  using (is_emergency_admin());

-- ===================== Broadcasts =====================

create table emergency_broadcasts (
  id uuid primary key default gen_random_uuid(),
  severity varchar not null check (severity in ('emergency', 'ilaan')),
  title_ur varchar not null,
  title_en varchar,
  body_ur text not null,
  body_en text,
  -- NULL = every tenant on the platform. Non-null = only these.
  target_tenant_ids uuid[],
  posted_by uuid not null references emergency_admins(id),
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table emergency_broadcasts enable row level security;

-- Same two-role split as news_ticker (549): a logged-in portal/admin
-- session resolves its tenant via my_tenant_id(), an anonymous public-
-- site visitor via the x-tenant-id subdomain header. Either way, only a
-- currently-live broadcast actually targeted at that tenant (or
-- untargeted) is visible.
create policy emergency_broadcasts_authenticated_read on emergency_broadcasts
  for select to authenticated
  using (
    is_active = true
    and starts_at <= now()
    and (expires_at is null or expires_at > now())
    and (
      target_tenant_ids is null
      or coalesce(my_tenant_id(), request_tenant_id()) = any(target_tenant_ids)
    )
  );

create policy emergency_broadcasts_public_read on emergency_broadcasts
  for select to anon
  using (
    is_active = true
    and starts_at <= now()
    and (expires_at is null or expires_at > now())
    and (target_tenant_ids is null or request_tenant_id() = any(target_tenant_ids))
  );

create policy emergency_broadcasts_admin_manage on emergency_broadcasts
  for all to authenticated
  using (is_emergency_admin())
  with check (is_emergency_admin());

create or replace function public.broadcast_emergency_alert(
  p_severity varchar,
  p_title_ur varchar,
  p_body_ur text,
  p_title_en varchar default null,
  p_body_en text default null,
  p_target_tenant_ids uuid[] default null,
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
  v_expires_at timestamptz;
begin
  if current_emergency_admin_id() is null then
    raise exception 'You do not have emergency-admin access';
  end if;
  if p_severity not in ('emergency', 'ilaan') then
    raise exception 'severity must be emergency or ilaan';
  end if;
  if coalesce(trim(p_title_ur), '') = '' or coalesce(trim(p_body_ur), '') = '' then
    raise exception 'A broadcast needs an Urdu title and message';
  end if;

  v_expires_at := coalesce(
    p_expires_at,
    now() + (case when p_severity = 'emergency' then interval '72 hours' else interval '7 days' end)
  );

  insert into emergency_broadcasts (
    severity, title_ur, title_en, body_ur, body_en,
    target_tenant_ids, posted_by, expires_at
  )
  values (
    p_severity, trim(p_title_ur), nullif(trim(coalesce(p_title_en, '')), ''),
    trim(p_body_ur), nullif(trim(coalesce(p_body_en, '')), ''),
    p_target_tenant_ids, current_emergency_admin_id(), v_expires_at
  )
  returning id into v_id;

  -- Same pipeline create_appeal() already rides (portal_notifications ->
  -- the shipped native FCM push), just fanned out across every targeted
  -- tenant's portal_users instead of one tenant's. tenant_id is taken
  -- from each recipient's own row explicitly -- portal_notifications'
  -- column default (my_tenant_id()) would resolve to NULL for this
  -- SECURITY DEFINER caller and silently misfile every row under the
  -- fallback tenant, which the per-tenant read RLS would then hide from
  -- everyone it was actually meant for.
  insert into portal_notifications (portal_user_id, tenant_id, event_type, title, body, link)
  select u.id, u.tenant_id, 'emergency_broadcast', trim(p_title_ur), trim(p_body_ur), '/portal'
    from portal_users u
   where u.is_active = true
     and (p_target_tenant_ids is null or u.tenant_id = any(p_target_tenant_ids));

  return v_id;
end;
$function$;
