-- Real gap found 2026-10-08 while auditing the sidebar module-gating
-- report below: every admin_users row's can_publish_* columns default
-- to false at the table level (migrations 202/303). The ONE place that
-- was ever set true for a super_admin/admin was a one-time backfill UPDATE
-- in migration 202, for admins that existed in 2026-09 — it was never a
-- rule applied to newly-created ones. Neither platform_create_tenant_admin
-- nor platform_self_signup (the two functions that create a tenant's
-- FOUNDING admin) ever set these, so every tenant created since has had
-- a super_admin who could not see any Content Publishing link in the
-- sidebar (fixed separately, AdminSidebar.tsx, to use the same
-- current_admin_can_publish() role-bypass instead of the raw columns) —
-- but the raw columns themselves were still wrong, and anything else
-- that ever checks them directly (as Talent Showcase's donor-matching
-- did for a different column) would have the same silent gap. Setting
-- them true here matches the original backfill's own intent for every
-- super_admin going forward, not just the ones that existed in September.
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

  INSERT INTO admin_users (
    tenant_id, auth_user_id, full_name, email, role, is_active,
    can_publish_news, can_publish_videos, can_publish_gallery, can_publish_ticker, can_publish_jobs, can_publish_poetry, can_publish_blog
  )
  VALUES (p_tenant_id, p_auth_user_id, p_full_name, p_email, 'super_admin', true, true, true, true, true, true, true, true)
  RETURNING id INTO v_id;

  v_actor_id := current_platform_admin_id();
  SELECT full_name INTO v_actor_name FROM platform_admins WHERE id = v_actor_id;
  INSERT INTO platform_audit_log (actor_platform_admin_id, actor_name, action, target_tenant_id, details)
  VALUES (v_actor_id, v_actor_name, 'tenant_admin_created', p_tenant_id, jsonb_build_object('email', p_email, 'full_name', p_full_name));

  RETURN v_id;
END;
$function$;

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

  INSERT INTO admin_users (
    tenant_id, auth_user_id, full_name, email, role, is_active,
    can_publish_news, can_publish_videos, can_publish_gallery, can_publish_ticker, can_publish_jobs, can_publish_poetry, can_publish_blog
  )
  VALUES (v_tenant_id, p_auth_user_id, p_admin_full_name, p_admin_email, 'super_admin', true, true, true, true, true, true, true, true)
  RETURNING id INTO v_admin_id;

  PERFORM seed_default_chart_of_accounts(v_tenant_id, v_plan.includes_water_supply, v_plan.includes_donors_projects);

  v_period_end := CASE WHEN p_trial_days > 0 THEN (current_date + (p_trial_days || ' days')::interval)::date ELSE (current_date + interval '1 month')::date END;

  INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, billing_cycle, current_period_start, current_period_end)
  VALUES (v_tenant_id, p_plan_id, CASE WHEN p_trial_days > 0 THEN 'trialing' ELSE 'active' END, 'monthly', current_date, v_period_end);

  INSERT INTO platform_audit_log (actor_platform_admin_id, actor_name, action, target_tenant_id, details)
  VALUES (NULL, 'Self-serve signup', 'tenant_created', v_tenant_id, jsonb_build_object('plan', v_plan.name, 'trial_days', p_trial_days, 'admin_email', p_admin_email));

  RETURN v_tenant_id;
END;
$function$;

-- Backfill the two real tenants created before this migration existed.
update admin_users set
  can_publish_news = true, can_publish_videos = true, can_publish_gallery = true,
  can_publish_ticker = true, can_publish_jobs = true, can_publish_poetry = true, can_publish_blog = true
where role = 'super_admin'
  and tenant_id in ('3003eced-193b-44b3-af12-7bcd74512893', '93c83cf1-e707-4298-961d-71ab7e21e7ab');
