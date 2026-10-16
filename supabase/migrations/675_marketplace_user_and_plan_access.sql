-- Migration 675: marketplace gets the same per-user access control and
-- per-tenant plan-gating water_supply/donors_projects already have.
--
-- Phase 0 (661/662) already added admin_users.access_marketplace and
-- taught role_grants_system()/system_access_for() about a 'marketplace'
-- system, but two real gaps were left: (1) admin_user_can_access_system()
-- -- the one actually used for approval routing -- never got the
-- matching 'accountant' arm, so an accountant with access_marketplace
-- checked still couldn't route marketplace approvals to themselves; (2)
-- there was no dedicated single-purpose role (mirroring water_accountant/
-- donor_accountant) for someone who only ever works in marketplace.
--
-- Separately: marketplace has never been plan-gated at all -- unlike
-- water_supply/donors_projects/commercial_ilans, tenants has no
-- marketplace_enabled column, so can_access_system('marketplace') has
-- always hit the generic `else true` fallback. Both new columns default
-- to true so the 3 tenants already live on marketplace today keep
-- working exactly as before -- this is additive plan-gating for future
-- tenants/plans, not a retroactive restriction.

ALTER TABLE admin_users
  DROP CONSTRAINT IF EXISTS admin_users_role_check,
  ADD CONSTRAINT admin_users_role_check CHECK (role::text = ANY (ARRAY['super_admin','admin','accountant','water_accountant','donor_accountant','marketplace_accountant','publisher','viewer']::text[]));

ALTER TABLE admin_users
  DROP CONSTRAINT IF EXISTS admin_users_secondary_role_check,
  ADD CONSTRAINT admin_users_secondary_role_check CHECK (secondary_role IS NULL OR secondary_role::text = ANY (ARRAY['super_admin','admin','accountant','water_accountant','donor_accountant','marketplace_accountant','publisher','viewer']::text[]));

-- Reproduced from its real, current body, with 'marketplace_accountant'
-- added as its own single-purpose arm (mirroring water_accountant/
-- donor_accountant exactly) and the pre-existing 'accountant' arm
-- extended to also check access_marketplace -- every other line is
-- untouched.
CREATE OR REPLACE FUNCTION public.admin_user_can_access_system(p_admin_user_id uuid, p_system character varying)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    (CASE role
      WHEN 'super_admin' THEN true WHEN 'admin' THEN true WHEN 'viewer' THEN true
      WHEN 'water_accountant' THEN p_system = 'water_supply'
      WHEN 'donor_accountant' THEN p_system = 'donors_projects'
      WHEN 'marketplace_accountant' THEN p_system = 'marketplace'
      WHEN 'accountant' THEN (p_system = 'water_supply' AND access_water_supply) OR (p_system = 'donors_projects' AND access_donors_projects) OR (p_system = 'marketplace' AND access_marketplace)
      ELSE false END)
    OR
    (CASE secondary_role
      WHEN 'super_admin' THEN true WHEN 'admin' THEN true WHEN 'viewer' THEN true
      WHEN 'water_accountant' THEN p_system = 'water_supply'
      WHEN 'donor_accountant' THEN p_system = 'donors_projects'
      WHEN 'marketplace_accountant' THEN p_system = 'marketplace'
      WHEN 'accountant' THEN (p_system = 'water_supply' AND access_water_supply) OR (p_system = 'donors_projects' AND access_donors_projects) OR (p_system = 'marketplace' AND access_marketplace)
      ELSE false END)
  FROM admin_users WHERE id = p_admin_user_id;
$function$;

-- ===================== Plan gating =====================

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS marketplace_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS includes_marketplace boolean NOT NULL DEFAULT true;

-- Reproduced from its real, current body, with one added WHEN arm.
CREATE OR REPLACE FUNCTION public.can_access_system(p_system character varying)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant_id uuid := my_tenant_id();
  v_enabled boolean;
begin
  if v_tenant_id is null then
    return false;
  end if;
  select case p_system
    when 'water_supply' then t.water_supply_enabled
    when 'donors_projects' then t.donors_enabled
    when 'commercial_ilans' then t.commercial_ilans_enabled
    when 'marketplace' then t.marketplace_enabled
    else true
  end into v_enabled
  from tenants t where t.id = v_tenant_id;
  return coalesce(v_enabled, true);
end;
$function$;

-- Reproduced from its real, current body, with one added UPDATE column.
CREATE OR REPLACE FUNCTION public.platform_subscribe_tenant(p_tenant_id uuid, p_plan_id uuid, p_billing_cycle character varying DEFAULT 'monthly'::character varying, p_trial_days integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_id uuid; v_period_end date; v_plan subscription_plans%rowtype; v_status varchar; v_actor_id uuid; v_actor_name varchar;
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

  UPDATE tenant_subscriptions SET status = 'cancelled', cancel_at_period_end = false, updated_at = now()
   WHERE tenant_id = p_tenant_id AND status IN ('trialing', 'active', 'past_due');

  IF p_trial_days IS NOT NULL AND p_trial_days > 0 THEN
    v_status := 'trialing';
    v_period_end := (current_date + (p_trial_days || ' days')::interval)::date;
  ELSE
    v_status := 'active';
    v_period_end := CASE p_billing_cycle WHEN 'annual' THEN (current_date + interval '1 year')::date ELSE (current_date + interval '1 month')::date END;
  END IF;

  INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, billing_cycle, current_period_start, current_period_end)
  VALUES (p_tenant_id, p_plan_id, v_status, p_billing_cycle, current_date, v_period_end)
  RETURNING id INTO v_id;

  UPDATE tenants SET water_supply_enabled = v_plan.includes_water_supply, donors_enabled = v_plan.includes_donors_projects,
    commercial_ilans_enabled = v_plan.includes_commercial_ilans, marketplace_enabled = v_plan.includes_marketplace
   WHERE id = p_tenant_id;

  PERFORM seed_default_chart_of_accounts(p_tenant_id, v_plan.includes_water_supply, v_plan.includes_donors_projects);
  PERFORM seed_voucher_counters(p_tenant_id, v_plan.includes_water_supply, v_plan.includes_donors_projects);

  v_actor_id := current_platform_admin_id();
  SELECT full_name INTO v_actor_name FROM platform_admins WHERE id = v_actor_id;
  INSERT INTO platform_audit_log (actor_platform_admin_id, actor_name, action, target_tenant_id, details)
  VALUES (v_actor_id, v_actor_name, 'tenant_subscribed', p_tenant_id, jsonb_build_object('plan', v_plan.name, 'status', v_status, 'billing_cycle', p_billing_cycle, 'trial_days', p_trial_days));

  RETURN v_id;
END;
$function$;
