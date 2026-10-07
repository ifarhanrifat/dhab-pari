-- Phase 3 follow-up: the platform-admin UI needs a way to see a tenant's
-- admin_users list. admin_users RLS is tenant_id = my_tenant_id() only, with
-- no is_platform_admin() bypass (deliberately — Phase 2's ~600 policies
-- were left untouched), so a platform admin's own session reading that
-- table directly always gets zero rows. This one read-only function is the
-- bypass, scoped to exactly this.
create or replace function public.platform_get_tenant_admins(p_tenant_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', id, 'full_name', full_name, 'email', email, 'role', role,
      'secondary_role', secondary_role, 'is_active', is_active, 'created_at', created_at
    ) ORDER BY created_at)
    FROM admin_users WHERE tenant_id = p_tenant_id
  ), '[]'::jsonb);
END;
$function$;

-- Bootstrap the first platform admin. Confirmed with the user: dhab-pari's
-- own (and only) super_admin, admin@dhabpari.com, is also the first
-- platform admin — one login for both the tenant's own admin panel and the
-- new cross-tenant platform panel, rather than a separate credential.
insert into platform_admins (auth_user_id, full_name, email)
select au.auth_user_id, 'Administrator', 'admin@dhabpari.com'
from admin_users au
where au.email = 'admin@dhabpari.com' and au.auth_user_id is not null
on conflict (email) do nothing;
