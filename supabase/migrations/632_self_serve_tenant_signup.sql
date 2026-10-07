-- Self-serve tenant onboarding + real subscription-based access
-- enforcement. Confirmed with the user: villages can now self-register
-- (reopening the earlier invite-only decision), auto-start on a trial,
-- and the system -- not manual gatekeeping -- enforces payment via the
-- trialing/past_due lifecycle already built. dhab-pari stays explicitly
-- exempt (it's the operator's own committee, never meant to be billed).
--
-- Also fixes a real bug found while re-pulling these functions fresh:
-- migration 628's CREATE OR REPLACE on platform_create_tenant and
-- platform_subscribe_tenant added new trailing params, which (same as
-- match_donor_account_by_phone's overload bug, migration 626-627) didn't
-- replace the old signature -- it created a second overload. Both old,
-- superseded 3-argument versions have sat alongside the real ones since
-- migration 628. Dropping them now.
drop function if exists public.platform_create_tenant(character varying, character varying, character varying);
drop function if exists public.platform_subscribe_tenant(uuid, uuid, character varying);

-- 1. Real subscription enforcement.
alter table tenants
  add column billing_exempt boolean not null default false,
  add column onboarding_status varchar not null default 'approved' check (onboarding_status in ('approved', 'pending_review'));

update tenants set billing_exempt = true where id = 'bf9e4815-4104-472a-ab32-114171b7e34d';

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
  )
  AND COALESCE(
    (SELECT t.billing_exempt OR EXISTS (
       SELECT 1 FROM tenant_subscriptions s WHERE s.tenant_id = t.id AND s.status IN ('trialing', 'active', 'past_due')
     )
     FROM admin_users au JOIN tenants t ON t.id = au.tenant_id
     WHERE au.auth_user_id = auth.uid() AND au.is_active = true
     LIMIT 1),
    false
  );
$function$;

-- 2. Self-serve signup. Same email-code pattern as portal signup
-- (migration 516/556) -- RLS enabled with zero policies, a pure
-- lockdown, since only the service-role request-code/confirm-code
-- routes below ever touch it.
create table platform_signup_verifications (
  email varchar primary key,
  code varchar not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  created_at timestamptz not null default now()
);
alter table platform_signup_verifications enable row level security;

-- No is_platform_admin() gate -- there is no admin session yet, this is
-- the function that creates the first one. Its own validation (slug
-- uniqueness, required fields) is the safety net; the calling API route
-- adds IP rate-limiting on top, same as /api/admin/login.
create or replace function public.platform_self_signup(
  p_tenant_name character varying,
  p_slug character varying,
  p_name_ur character varying,
  p_admin_full_name character varying,
  p_admin_email character varying,
  p_auth_user_id uuid,
  p_plan_id uuid,
  p_trial_days integer default 14
)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_tenant_id uuid; v_admin_id uuid; v_plan subscription_plans%rowtype; v_period_end date;
BEGIN
  IF p_tenant_name IS NULL OR trim(p_tenant_name) = '' THEN
    RAISE EXCEPTION 'A committee name is required';
  END IF;
  IF p_slug IS NULL OR trim(p_slug) = '' THEN
    RAISE EXCEPTION 'A subdomain is required';
  END IF;
  IF EXISTS (SELECT 1 FROM tenants WHERE slug = lower(trim(p_slug))) THEN
    RAISE EXCEPTION 'That subdomain is already taken — choose another.';
  END IF;
  SELECT * INTO v_plan FROM subscription_plans WHERE id = p_plan_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Plan not found or inactive';
  END IF;

  INSERT INTO tenants (name, name_ur, slug, is_active, water_supply_enabled, donors_enabled, onboarding_status)
  VALUES (trim(p_tenant_name), NULLIF(trim(p_name_ur), ''), lower(trim(p_slug)), true, v_plan.includes_water_supply, v_plan.includes_donors_projects, 'pending_review')
  RETURNING id INTO v_tenant_id;

  INSERT INTO admin_users (tenant_id, auth_user_id, full_name, email, role, is_active)
  VALUES (v_tenant_id, p_auth_user_id, p_admin_full_name, p_admin_email, 'super_admin', true)
  RETURNING id INTO v_admin_id;

  v_period_end := CASE WHEN p_trial_days > 0 THEN (current_date + (p_trial_days || ' days')::interval)::date ELSE (current_date + interval '1 month')::date END;

  INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, billing_cycle, current_period_start, current_period_end)
  VALUES (v_tenant_id, p_plan_id, CASE WHEN p_trial_days > 0 THEN 'trialing' ELSE 'active' END, 'monthly', current_date, v_period_end);

  INSERT INTO platform_audit_log (actor_platform_admin_id, actor_name, action, target_tenant_id, details)
  VALUES (NULL, 'Self-serve signup', 'tenant_created', v_tenant_id, jsonb_build_object('plan', v_plan.name, 'trial_days', p_trial_days, 'admin_email', p_admin_email));

  RETURN v_tenant_id;
END;
$function$;

-- 3. Surface onboarding_status in the platform console's tenant list.
create or replace function public.platform_list_tenants()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE(jsonb_agg(jsonb_build_object(
    'id', t.id, 'name', t.name, 'name_ur', t.name_ur, 'slug', t.slug,
    'is_active', t.is_active, 'water_supply_enabled', t.water_supply_enabled,
    'donors_enabled', t.donors_enabled, 'created_at', t.created_at,
    'billing_exempt', t.billing_exempt, 'onboarding_status', t.onboarding_status,
    'admin_count', (SELECT count(*) FROM admin_users WHERE tenant_id = t.id AND is_active = true),
    'portal_user_count', (SELECT count(*) FROM portal_users WHERE tenant_id = t.id AND is_active = true),
    'subscription_status', (SELECT status FROM tenant_subscriptions WHERE tenant_id = t.id AND status IN ('active', 'trialing', 'past_due') LIMIT 1),
    'subscription_plan', (SELECT p.name FROM tenant_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.tenant_id = t.id AND s.status IN ('active', 'trialing', 'past_due') LIMIT 1)
  ) ORDER BY t.created_at), '[]'::jsonb)
  FROM tenants t;
END;
$function$;
