-- Self-inflicted repeat of the exact overload bug documented in 627/632:
-- migration 633 wrote platform_subscribe_tenant from a signature copied
-- out of migration 628's text instead of re-pulling the function fresh
-- first -- migration 631 had since added a 4th parameter (p_trial_days)
-- that 628's text never had. The CREATE OR REPLACE in 633 therefore
-- didn't touch the real, currently-called 4-param function at all; it
-- created a second, stale 3-param overload alongside it. Confirmed live
-- via pg_get_function_identity_arguments immediately after applying 633.
--
-- Drop the stale overload 633 introduced, then re-apply 633's actual
-- intent (seeding the chart of accounts on subscribe) against the real,
-- current 4-param function body (pulled fresh via pg_get_functiondef,
-- not retyped from memory).
drop function if exists public.platform_subscribe_tenant(uuid, uuid, character varying);

create or replace function public.platform_subscribe_tenant(p_tenant_id uuid, p_plan_id uuid, p_billing_cycle character varying DEFAULT 'monthly'::character varying, p_trial_days integer DEFAULT NULL::integer)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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

  UPDATE tenants SET water_supply_enabled = v_plan.includes_water_supply, donors_enabled = v_plan.includes_donors_projects
   WHERE id = p_tenant_id;

  PERFORM seed_default_chart_of_accounts(p_tenant_id, v_plan.includes_water_supply, v_plan.includes_donors_projects);

  v_actor_id := current_platform_admin_id();
  SELECT full_name INTO v_actor_name FROM platform_admins WHERE id = v_actor_id;
  INSERT INTO platform_audit_log (actor_platform_admin_id, actor_name, action, target_tenant_id, details)
  VALUES (v_actor_id, v_actor_name, 'tenant_subscribed', p_tenant_id, jsonb_build_object('plan', v_plan.name, 'status', v_status, 'billing_cycle', p_billing_cycle, 'trial_days', p_trial_days));

  RETURN v_id;
END;
$function$;
