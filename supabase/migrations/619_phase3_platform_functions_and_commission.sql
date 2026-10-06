-- Phase 3, part 3: platform tenant-management functions, and the
-- commission mechanism.
--
-- Commission design: the marketplace domain (vehicles/shops, Phase 2
-- slices 2-3) already computes a TENANT's own commission income on its
-- own marketplace transactions, posted to that tenant's own DP-4050
-- "Marketplace Commission Income" account -- that is the village
-- committee's own revenue, already live, and untouched here.
--
-- Platform commission is a different, outer layer: the SaaS platform's
-- own cut, charged to the TENANT, calculated as a percentage (the
-- subscription plan's commission_pct) of that tenant's own DP-4050
-- income for a billing period. platform_compute_tenant_commission is a
-- pure calculation over the tenant's existing ledger -- it does not post
-- anything anywhere, read or write any tenant-owned account, or move
-- real money. It only produces the number platform_generate_monthly_
-- invoices uses to fill in platform_invoices.commission_amount_pkr. This
-- keeps the mechanism reversible and auditable: generating an invoice
-- never touches a tenant's own books, and re-running it before the
-- period closes simply recomputes the same number.

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
    'admin_count', (SELECT count(*) FROM admin_users WHERE tenant_id = t.id AND is_active = true),
    'portal_user_count', (SELECT count(*) FROM portal_users WHERE tenant_id = t.id AND is_active = true),
    'subscription_status', (SELECT status FROM tenant_subscriptions WHERE tenant_id = t.id AND status IN ('active', 'trialing', 'past_due') LIMIT 1),
    'subscription_plan', (SELECT p.name FROM tenant_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.tenant_id = t.id AND s.status IN ('active', 'trialing', 'past_due') LIMIT 1)
  ) ORDER BY t.created_at), '[]'::jsonb)
  FROM tenants t;
END;
$function$;

-- platform_create_tenant: provisions the tenants row only. A tenant with
-- zero admin_users can't be signed into yet -- the deliberate next step
-- is platform_create_tenant_admin, kept separate so a platform admin can
-- review/adjust the tenant's settings before deciding who its first
-- admin is.
create or replace function public.platform_create_tenant(p_name character varying, p_slug character varying, p_name_ur character varying DEFAULT NULL::character varying)
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

  INSERT INTO tenants (name, name_ur, slug, is_active)
  VALUES (trim(p_name), NULLIF(trim(p_name_ur), ''), lower(trim(p_slug)), true)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- platform_create_tenant_admin: the first admin_users row for a freshly
-- provisioned tenant. Takes an existing auth.users id (the platform admin
-- is expected to have already created the Supabase auth user through the
-- normal invite/signup flow this app already uses elsewhere) rather than
-- creating one itself, consistent with how every other admin_users row
-- in this codebase is linked to auth.
create or replace function public.platform_create_tenant_admin(p_tenant_id uuid, p_auth_user_id uuid, p_full_name character varying, p_email character varying)
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
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'Tenant not found';
  END IF;

  INSERT INTO admin_users (tenant_id, auth_user_id, full_name, email, role, is_active)
  VALUES (p_tenant_id, p_auth_user_id, p_full_name, p_email, 'super_admin', true)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

create or replace function public.platform_set_tenant_active(p_tenant_id uuid, p_is_active boolean)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  UPDATE tenants SET is_active = p_is_active WHERE id = p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tenant not found'; END IF;
END;
$function$;

create or replace function public.platform_subscribe_tenant(p_tenant_id uuid, p_plan_id uuid, p_billing_cycle character varying DEFAULT 'monthly'::character varying)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_id uuid; v_period_end date;
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'Tenant not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM subscription_plans WHERE id = p_plan_id AND is_active = true) THEN
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

  RETURN v_id;
END;
$function$;

-- platform_compute_tenant_commission: a pure calculation, no side
-- effects -- sums the tenant's own DP-4050 marketplace commission income
-- for the given period and applies the plan's commission_pct to it.
create or replace function public.platform_compute_tenant_commission(p_tenant_id uuid, p_period_start date, p_period_end date)
 returns decimal
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  v_commission_pct decimal;
  v_tenant_marketplace_income decimal;
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT p.commission_pct INTO v_commission_pct
  FROM tenant_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
  WHERE s.tenant_id = p_tenant_id AND s.status IN ('active', 'trialing', 'past_due')
  LIMIT 1;
  IF v_commission_pct IS NULL OR v_commission_pct = 0 THEN RETURN 0; END IF;

  SELECT COALESCE(SUM(l.credit - l.debit), 0) INTO v_tenant_marketplace_income
  FROM ledger_entries l
  JOIN accounts a ON a.id = l.account_id
  WHERE a.tenant_id = p_tenant_id AND a.system = 'donors_projects' AND a.code = 'DP-4050'
    AND l.entry_date BETWEEN p_period_start AND p_period_end;

  RETURN round(GREATEST(v_tenant_marketplace_income, 0) * v_commission_pct / 100, 2);
END;
$function$;

-- platform_generate_monthly_invoices: the billing-period close. Run by a
-- platform admin (or, in the future, a scheduled job) once a period ends
-- -- for every tenant with a live subscription, computes that period's
-- subscription fee + commission and inserts one platform_invoices row.
-- Re-running it for a period that already has an invoice is a no-op
-- (checked by tenant_id + period_start, not a DB constraint, since a
-- platform admin may legitimately want to void and regenerate one).
create or replace function public.platform_generate_monthly_invoices(p_period_start date, p_period_end date)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  r record;
  v_commission decimal;
  v_total decimal;
  v_count int := 0;
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  FOR r IN
    SELECT s.id AS subscription_id, s.tenant_id, p.monthly_price_pkr
    FROM tenant_subscriptions s
    JOIN subscription_plans p ON p.id = s.plan_id
    WHERE s.status IN ('active', 'trialing', 'past_due')
  LOOP
    IF EXISTS (SELECT 1 FROM platform_invoices WHERE tenant_id = r.tenant_id AND period_start = p_period_start) THEN
      CONTINUE; -- already invoiced this period
    END IF;

    v_commission := platform_compute_tenant_commission(r.tenant_id, p_period_start, p_period_end);
    v_total := r.monthly_price_pkr + v_commission;

    INSERT INTO platform_invoices (
      tenant_id, subscription_id, invoice_number, period_start, period_end,
      subscription_amount_pkr, commission_amount_pkr, total_amount_pkr, status
    ) VALUES (
      r.tenant_id, r.subscription_id, next_platform_invoice_number(), p_period_start, p_period_end,
      r.monthly_price_pkr, v_commission, v_total, 'pending'
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('invoices_created', v_count, 'period_start', p_period_start, 'period_end', p_period_end);
END;
$function$;

create or replace function public.platform_mark_invoice_paid(p_invoice_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  UPDATE platform_invoices SET status = 'paid', paid_at = now() WHERE id = p_invoice_id AND status IN ('pending', 'overdue');
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found or already settled'; END IF;
END;
$function$;
