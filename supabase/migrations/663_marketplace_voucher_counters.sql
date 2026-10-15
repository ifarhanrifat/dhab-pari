-- Migration 663: Marketplace becomes its own accounting system —
-- missing piece found live while verifying 661/662: every voucher
-- insert goes through trg_voucher_before_insert() -> next_voucher_no(),
-- which requires a pre-seeded voucher_counters row for
-- (tenant_id, system, voucher_type) or raises "No voucher counter for
-- %/%" and aborts the insert. Confirmed by testing a real marketplace
-- voucher insert directly: it failed exactly this way, since nothing
-- seeded a 'marketplace' row anywhere. Every marketplace RPC touched in
-- 662 posts only 'income' (commission/gross-fare vouchers) or 'contra'
-- (shadi advance hold/release) vouchers — no expense/withdrawal/deposit
-- voucher type is ever used by marketplace, so only those two need a
-- counter, for every tenant (not just dhab-pari).
INSERT INTO voucher_counters (tenant_id, system, voucher_type, prefix)
SELECT t.id, 'marketplace', vt.voucher_type, vt.prefix
FROM tenants t
CROSS JOIN (VALUES ('income', 'MKT-INC-V'), ('contra', 'MKT-CTR-V')) AS vt(voucher_type, prefix)
ON CONFLICT (tenant_id, system, voucher_type) DO NOTHING;

-- A much bigger, pre-existing, unrelated gap surfaced by the same test:
-- voucher_counters was never tenant-scoped-seeded for ANY system at
-- tenant creation at all. Confirmed live: the two real non-dhab-pari
-- tenants (Dhab Khushal, Dhab Kalan Welfare Committees) have ZERO
-- voucher_counters rows for water_supply or donors_projects either —
-- meaning neither can post a single voucher of any kind today (every
-- attempt hits this same "No voucher counter" exception).
-- seed_default_chart_of_accounts()'s own comment already states its
-- intent is exactly this baseline (the "ORIGINAL baseline this project
-- itself started from", migration 009's own 5-type seed, not every
-- voucher type dhab-pari's own 400+ commits of organic growth added) —
-- it just never actually seeded voucher_counters. Backfilling the
-- baseline 5 types now for the two affected tenants, and extending the
-- seed function below so this can't recur for a tenant created after
-- this migration. Kafalat/wazifa/zakat/etc.'s own extra voucher types
-- remain a narrower, separate gap for if/when a tenant actually turns
-- on those specific features — not fixed here, out of this migration's
-- scope.
INSERT INTO voucher_counters (tenant_id, system, voucher_type, prefix)
SELECT t.id, s.system, vt.voucher_type, s.prefix || vt.suffix
FROM tenants t
CROSS JOIN (VALUES ('water_supply', 'WS-'), ('donors_projects', 'DP-')) AS s(system, prefix)
CROSS JOIN (VALUES ('expense', 'EXP-V'), ('income', 'INC-V'), ('contra', 'CTR-V'), ('withdrawal', 'WD-V'), ('deposit', 'DEP-V')) AS vt(voucher_type, suffix)
ON CONFLICT (tenant_id, system, voucher_type) DO NOTHING;

CREATE OR REPLACE FUNCTION seed_voucher_counters(p_tenant_id uuid, p_water_supply boolean, p_donors_projects boolean) RETURNS void AS $$
BEGIN
  IF p_water_supply THEN
    INSERT INTO voucher_counters (tenant_id, system, voucher_type, prefix) VALUES
      (p_tenant_id, 'water_supply', 'expense', 'WS-EXP-V'), (p_tenant_id, 'water_supply', 'income', 'WS-INC-V'),
      (p_tenant_id, 'water_supply', 'contra', 'WS-CTR-V'), (p_tenant_id, 'water_supply', 'withdrawal', 'WS-WD-V'),
      (p_tenant_id, 'water_supply', 'deposit', 'WS-DEP-V')
    ON CONFLICT (tenant_id, system, voucher_type) DO NOTHING;
  END IF;
  IF p_donors_projects THEN
    INSERT INTO voucher_counters (tenant_id, system, voucher_type, prefix) VALUES
      (p_tenant_id, 'donors_projects', 'expense', 'DP-EXP-V'), (p_tenant_id, 'donors_projects', 'income', 'DP-INC-V'),
      (p_tenant_id, 'donors_projects', 'contra', 'DP-CTR-V'), (p_tenant_id, 'donors_projects', 'withdrawal', 'DP-WD-V'),
      (p_tenant_id, 'donors_projects', 'deposit', 'DP-DEP-V')
    ON CONFLICT (tenant_id, system, voucher_type) DO NOTHING;
  END IF;
  INSERT INTO voucher_counters (tenant_id, system, voucher_type, prefix) VALUES
    (p_tenant_id, 'marketplace', 'income', 'MKT-INC-V'), (p_tenant_id, 'marketplace', 'contra', 'MKT-CTR-V')
  ON CONFLICT (tenant_id, system, voucher_type) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Both real tenant-provisioning paths call seed_default_chart_of_accounts
-- already — reproduced from their real, current bodies (platform_self_signup,
-- platform_subscribe_tenant) with one added PERFORM line each, right after
-- the existing seed_default_chart_of_accounts() call, so a tenant created
-- or newly subscribed from here on never hits this gap.
CREATE OR REPLACE FUNCTION public.platform_self_signup(p_tenant_name character varying, p_slug character varying, p_name_ur character varying, p_admin_full_name character varying, p_admin_email character varying, p_auth_user_id uuid, p_plan_id uuid, p_trial_days integer DEFAULT 14)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  INSERT INTO admin_users (
    tenant_id, auth_user_id, full_name, email, role, is_active,
    can_publish_news, can_publish_videos, can_publish_gallery, can_publish_ticker, can_publish_jobs, can_publish_poetry, can_publish_blog
  )
  VALUES (v_tenant_id, p_auth_user_id, p_admin_full_name, p_admin_email, 'super_admin', true, true, true, true, true, true, true, true)
  RETURNING id INTO v_admin_id;

  PERFORM seed_default_chart_of_accounts(v_tenant_id, v_plan.includes_water_supply, v_plan.includes_donors_projects);
  PERFORM seed_voucher_counters(v_tenant_id, v_plan.includes_water_supply, v_plan.includes_donors_projects);

  v_period_end := CASE WHEN p_trial_days > 0 THEN (current_date + (p_trial_days || ' days')::interval)::date ELSE (current_date + interval '1 month')::date END;

  INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, billing_cycle, current_period_start, current_period_end)
  VALUES (v_tenant_id, p_plan_id, CASE WHEN p_trial_days > 0 THEN 'trialing' ELSE 'active' END, 'monthly', current_date, v_period_end);

  INSERT INTO platform_audit_log (actor_platform_admin_id, actor_name, action, target_tenant_id, details)
  VALUES (NULL, 'Self-serve signup', 'tenant_created', v_tenant_id, jsonb_build_object('plan', v_plan.name, 'trial_days', p_trial_days, 'admin_email', p_admin_email));

  RETURN v_tenant_id;
END;
$function$;

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

  UPDATE tenants SET water_supply_enabled = v_plan.includes_water_supply, donors_enabled = v_plan.includes_donors_projects
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