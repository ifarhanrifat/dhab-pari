-- Makes the module-enable columns tenants already had (water_supply_enabled,
-- donors_enabled -- added in the original tenants_foundation migration,
-- never wired into anything) into real enforcement, and lets subscription
-- plans define which modules they include by default.
--
-- can_access_system() is the one function nearly every water_supply/
-- donors_projects RLS policy and the admin UI's useSystemAccess() hook
-- already call -- ANDing the tenant's own enablement flag into it here
-- makes every one of those policies and every nav/settings check
-- automatically tenant-aware, with no changes needed anywhere else.
create or replace function public.can_access_system(p_system character varying)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(
    (SELECT role_grants_system(role, secondary_role, access_water_supply, access_donors_projects, p_system)
       FROM admin_users
      WHERE auth_user_id = auth.uid() AND is_active = true
      LIMIT 1),
    false
  )
  AND COALESCE(
    (SELECT CASE p_system
       WHEN 'water_supply' THEN t.water_supply_enabled
       WHEN 'donors_projects' THEN t.donors_enabled
       ELSE true
     END
     FROM admin_users au JOIN tenants t ON t.id = au.tenant_id
     WHERE au.auth_user_id = auth.uid() AND au.is_active = true
     LIMIT 1),
    false
  );
$function$;

-- What a plan offers by default. The tenant's own water_supply_enabled/
-- donors_enabled stay the live, directly-overridable setting (platform
-- admin can still revoke/restore a module for one tenant regardless of
-- its plan) -- these columns are only consulted at subscribe-time to set
-- that initial value.
alter table subscription_plans
  add column includes_water_supply boolean not null default true,
  add column includes_donors_projects boolean not null default true;

create or replace function public.platform_create_tenant(p_name character varying, p_slug character varying, p_name_ur character varying DEFAULT NULL::character varying, p_water_supply_enabled boolean DEFAULT true, p_donors_enabled boolean DEFAULT true)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_id uuid;
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'A tenant name is required';
  END IF;
  IF p_slug IS NULL OR trim(p_slug) = '' THEN
    RAISE EXCEPTION 'A tenant slug is required';
  END IF;

  INSERT INTO tenants (name, name_ur, slug, is_active, water_supply_enabled, donors_enabled)
  VALUES (trim(p_name), NULLIF(trim(p_name_ur), ''), lower(trim(p_slug)), true, p_water_supply_enabled, p_donors_enabled)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

create or replace function public.platform_subscribe_tenant(p_tenant_id uuid, p_plan_id uuid, p_billing_cycle character varying DEFAULT 'monthly'::character varying)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_id uuid; v_period_end date; v_plan subscription_plans%rowtype;
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'Tenant not found';
  END IF;
  SELECT * INTO v_plan FROM subscription_plans WHERE id = p_plan_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Plan not found or inactive';
  END IF;

  -- Superseding a live subscription rather than mutating it keeps the old
  -- row as history, same convention as every other contract-shaped table.
  UPDATE tenant_subscriptions SET status = 'cancelled', cancel_at_period_end = false, updated_at = now()
   WHERE tenant_id = p_tenant_id AND status IN ('trialing', 'active', 'past_due');

  v_period_end := CASE p_billing_cycle WHEN 'annual' THEN (current_date + interval '1 year')::date ELSE (current_date + interval '1 month')::date END;

  INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, billing_cycle, current_period_start, current_period_end)
  VALUES (p_tenant_id, p_plan_id, 'active', p_billing_cycle, current_date, v_period_end)
  RETURNING id INTO v_id;

  -- Set the tenant's live module flags to match the new plan. A platform
  -- admin can still override either flag directly afterwards (tenants_
  -- platform_manage already permits it) -- this only sets the starting point.
  UPDATE tenants SET water_supply_enabled = v_plan.includes_water_supply, donors_enabled = v_plan.includes_donors_projects
   WHERE id = p_tenant_id;

  RETURN v_id;
END;
$function$;
