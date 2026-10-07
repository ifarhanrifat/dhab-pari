-- Professional-grade platform hardening, part 1: plan limits that
-- actually enforce, a reachable trial state, a subscription lifecycle
-- sweep, and a platform-level audit log.
--
-- Confirmed before writing: max_admin_users was only ever displayed and
-- written, never checked anywhere; 'trialing' was a valid status value
-- every query accounted for, but no code path ever created a trialing
-- subscription -- platform_subscribe_tenant only ever inserted 'active'
-- directly. 'overdue' had the same problem on platform_invoices.

-- 1. Plan limit enforcement, on tenant-admin creation.
create or replace function public.platform_create_tenant_admin(p_tenant_id uuid, p_auth_user_id uuid, p_full_name character varying, p_email character varying)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_id uuid; v_max_admins int; v_current_count int; v_actor_id uuid; v_actor_name varchar;
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'Tenant not found';
  END IF;

  SELECT p.max_admin_users INTO v_max_admins
  FROM tenant_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
  WHERE s.tenant_id = p_tenant_id AND s.status IN ('active', 'trialing', 'past_due')
  LIMIT 1;

  IF v_max_admins IS NOT NULL THEN
    SELECT count(*) INTO v_current_count FROM admin_users WHERE tenant_id = p_tenant_id AND is_active = true;
    IF v_current_count >= v_max_admins THEN
      RAISE EXCEPTION 'This tenant''s plan allows up to % admin(s) — deactivate one or move it to a higher plan first.', v_max_admins;
    END IF;
  END IF;

  INSERT INTO admin_users (tenant_id, auth_user_id, full_name, email, role, is_active)
  VALUES (p_tenant_id, p_auth_user_id, p_full_name, p_email, 'super_admin', true)
  RETURNING id INTO v_id;

  v_actor_id := current_platform_admin_id();
  SELECT full_name INTO v_actor_name FROM platform_admins WHERE id = v_actor_id;
  INSERT INTO platform_audit_log (actor_platform_admin_id, actor_name, action, target_tenant_id, details)
  VALUES (v_actor_id, v_actor_name, 'tenant_admin_created', p_tenant_id, jsonb_build_object('email', p_email, 'full_name', p_full_name));

  RETURN v_id;
END;
$function$;

-- 2. Reachable trial state.
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

  v_actor_id := current_platform_admin_id();
  SELECT full_name INTO v_actor_name FROM platform_admins WHERE id = v_actor_id;
  INSERT INTO platform_audit_log (actor_platform_admin_id, actor_name, action, target_tenant_id, details)
  VALUES (v_actor_id, v_actor_name, 'tenant_subscribed', p_tenant_id, jsonb_build_object('plan', v_plan.name, 'status', v_status, 'billing_cycle', p_billing_cycle, 'trial_days', p_trial_days));

  RETURN v_id;
END;
$function$;

create or replace function public.platform_mark_invoice_paid(p_invoice_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_actor_id uuid; v_actor_name varchar; v_tenant_id uuid;
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  UPDATE platform_invoices SET status = 'paid', paid_at = now() WHERE id = p_invoice_id AND status IN ('pending', 'overdue')
   RETURNING tenant_id INTO v_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found or already settled'; END IF;

  v_actor_id := current_platform_admin_id();
  SELECT full_name INTO v_actor_name FROM platform_admins WHERE id = v_actor_id;
  INSERT INTO platform_audit_log (actor_platform_admin_id, actor_name, action, target_tenant_id, details)
  VALUES (v_actor_id, v_actor_name, 'invoice_marked_paid', v_tenant_id, jsonb_build_object('invoice_id', p_invoice_id));
END;
$function$;

-- 3. Subscription/invoice lifecycle sweep -- same ungated-cron-function
-- reasoning as run_platform_monthly_invoicing (migration 629): the gated
-- RPCs above have no auth context under cron.
create or replace function public.run_platform_subscription_lifecycle()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_grace_days int := 7;
BEGIN
  -- An unpaid invoice sitting past the grace period becomes overdue --
  -- the status already existed on platform_invoices but nothing ever set it.
  UPDATE platform_invoices SET status = 'overdue'
   WHERE status = 'pending' AND issued_at < now() - (v_grace_days || ' days')::interval;

  -- A trial that ended with no real plan payment moves to past_due so a
  -- platform admin notices -- never auto-cancelled, that stays a human
  -- decision.
  UPDATE tenant_subscriptions SET status = 'past_due', updated_at = now()
   WHERE status = 'trialing' AND current_period_end < current_date;

  -- An active subscription with an overdue invoice does the same.
  UPDATE tenant_subscriptions ts SET status = 'past_due', updated_at = now()
   WHERE ts.status = 'active'
     AND EXISTS (SELECT 1 FROM platform_invoices pi WHERE pi.subscription_id = ts.id AND pi.status = 'overdue');
END;
$function$;

DO $$
BEGIN
  PERFORM cron.schedule('platform-subscription-lifecycle', '0 7 * * *', $cron$SELECT run_platform_subscription_lifecycle()$cron$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available — subscription lifecycle stays whatever it was last set to: %', SQLERRM;
END $$;

-- 4. Platform audit log.
create table platform_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_platform_admin_id uuid references platform_admins(id),
  actor_name varchar,
  action varchar not null,
  target_tenant_id uuid references tenants(id),
  details jsonb,
  performed_at timestamptz not null default now()
);
create index platform_audit_log_performed_at_idx on platform_audit_log(performed_at desc);

alter table platform_audit_log enable row level security;

-- Read-only to platform admins. No insert/update/delete policy for
-- authenticated at all -- every write happens through a SECURITY DEFINER
-- function or the trigger below, both owned by postgres and so not
-- subject to this table's own RLS.
create policy platform_audit_log_read on platform_audit_log
  for select to authenticated
  using (is_platform_admin());

-- One trigger catches every direct tenants edit uniformly (name/slug via
-- the platform console's Edit modal, module toggles, activate/deactivate,
-- and tenant creation) -- including ones made outside any specific RPC.
create or replace function public.trg_platform_audit_tenants()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_actor_id uuid; v_actor_name varchar;
BEGIN
  v_actor_id := current_platform_admin_id();
  SELECT full_name INTO v_actor_name FROM platform_admins WHERE id = v_actor_id;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO platform_audit_log (actor_platform_admin_id, actor_name, action, target_tenant_id, details)
    VALUES (v_actor_id, v_actor_name, 'tenant_created', NEW.id, jsonb_build_object('name', NEW.name, 'slug', NEW.slug));
    RETURN NEW;
  END IF;

  IF NEW.name IS DISTINCT FROM OLD.name OR NEW.name_ur IS DISTINCT FROM OLD.name_ur OR NEW.slug IS DISTINCT FROM OLD.slug THEN
    INSERT INTO platform_audit_log (actor_platform_admin_id, actor_name, action, target_tenant_id, details)
    VALUES (v_actor_id, v_actor_name, 'tenant_edited', NEW.id, jsonb_build_object(
      'before', jsonb_build_object('name', OLD.name, 'name_ur', OLD.name_ur, 'slug', OLD.slug),
      'after', jsonb_build_object('name', NEW.name, 'name_ur', NEW.name_ur, 'slug', NEW.slug)
    ));
  END IF;
  IF NEW.water_supply_enabled IS DISTINCT FROM OLD.water_supply_enabled THEN
    INSERT INTO platform_audit_log (actor_platform_admin_id, actor_name, action, target_tenant_id, details)
    VALUES (v_actor_id, v_actor_name, 'module_toggled', NEW.id, jsonb_build_object('module', 'water_supply', 'enabled', NEW.water_supply_enabled));
  END IF;
  IF NEW.donors_enabled IS DISTINCT FROM OLD.donors_enabled THEN
    INSERT INTO platform_audit_log (actor_platform_admin_id, actor_name, action, target_tenant_id, details)
    VALUES (v_actor_id, v_actor_name, 'module_toggled', NEW.id, jsonb_build_object('module', 'donors_projects', 'enabled', NEW.donors_enabled));
  END IF;
  IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    INSERT INTO platform_audit_log (actor_platform_admin_id, actor_name, action, target_tenant_id, details)
    VALUES (v_actor_id, v_actor_name, CASE WHEN NEW.is_active THEN 'tenant_activated' ELSE 'tenant_deactivated' END, NEW.id, '{}'::jsonb);
  END IF;
  RETURN NEW;
END;
$function$;

drop trigger if exists platform_audit_tenants_trigger on tenants;
create trigger platform_audit_tenants_trigger after insert or update on tenants
  for each row execute function trg_platform_audit_tenants();

-- 5. Invoice/gateway columns for the JazzCash integration (part 2).
alter table platform_invoices
  add column gateway_provider varchar,
  add column gateway_reference varchar;
