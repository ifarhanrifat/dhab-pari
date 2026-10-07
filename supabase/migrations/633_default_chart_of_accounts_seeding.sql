-- Real gap found 2026-10-08: tenants_foundation (566) and slice-12 (613)
-- scoped accounts/account_headers to tenant_id, but nothing has ever
-- seeded either table for a tenant created AFTER that migration ran.
-- Dhab Pari's own 23 headers + 483 accounts are pre-multi-tenancy
-- history that simply got backfilled onto its tenant_id -- every tenant
-- created since (platform_create_tenant, platform_self_signup) starts
-- with zero rows in both tables. Confirmed live: both "Dhab Khushal
-- Welfare Committee" and "Dhab Kalan Welfare Committee" have
-- accounts=0, account_headers=0 right now.
--
-- Without account_headers, accounts.type has nothing to satisfy its
-- composite FK (accounts_type_fkey -> account_headers(tenant_id, system,
-- code), migration 613) -- a brand new tenant could not create a single
-- account even by hand until this exists.
--
-- seed_default_chart_of_accounts() reproduces the ORIGINAL baseline this
-- project itself started from (migrations 006 + 008's seed, before 400+
-- commits of dhab-pari's own organic, dhab-pari-specific growth: Kafalat
-- sub-accounts, JazzCash/EasyPaisa wallets, restricted funds, tractor/
-- solar/tree-plantation expense lines, etc. -- none of that is a
-- universal default, all of it is one committee's own history). Headers
-- are seeded in full per system (every header category the system's own
-- auto-provisioning functions rely on -- consumer/donor/collector/
-- employee/project/institution/student/shop/vehicle_owner -- not just
-- the ones with a manually-seeded leaf account under them), gated by
-- which systems the tenant actually has enabled.
create or replace function public.seed_default_chart_of_accounts(
  p_tenant_id uuid,
  p_water_supply boolean,
  p_donors_projects boolean
)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF p_water_supply THEN
    INSERT INTO account_headers (tenant_id, system, code, label, label_ur, code_prefix, display_order, is_system) VALUES
      (p_tenant_id, 'water_supply', 'consumer',  'Consumers',         'صارفین',        'WS-CON', 0, true),
      (p_tenant_id, 'water_supply', 'cash',      'Cash-in-hand',      'نقد',           'WS-CSH', 1, true),
      (p_tenant_id, 'water_supply', 'bank',      'Bank A/Cs',         'بینک اکاؤنٹس',  'WS-BNK', 2, true),
      (p_tenant_id, 'water_supply', 'income',    'Income',            'آمدنی',         'WS-INC', 3, true),
      (p_tenant_id, 'water_supply', 'expense',   'Expenses',          'اخراجات',       'WS-EXP', 4, true),
      (p_tenant_id, 'water_supply', 'asset',     'Assets',            'اثاثے',         'WS-AST', 5, true),
      (p_tenant_id, 'water_supply', 'liability', 'Liabilities',       'ذمہ داریاں',    'WS-LIA', 6, true),
      (p_tenant_id, 'water_supply', 'collector', 'Field Collectors',  NULL,            'WS-COL', 7, true),
      (p_tenant_id, 'water_supply', 'employee',  'Employees Payable', NULL,            'WS-EMP', 8, true)
    ON CONFLICT (tenant_id, system, code) DO NOTHING;

    INSERT INTO accounts (tenant_id, code, name, name_ur, type, system, description) VALUES
      (p_tenant_id, 'WS-1001', 'Cash in Hand',         'نقد رقم',       'cash',    'water_supply', 'Physical cash held by water supply accountant'),
      (p_tenant_id, 'WS-1002', 'Bank Account',         'بینک اکاؤنٹ',   'bank',    'water_supply', 'Bank account for water supply funds'),
      (p_tenant_id, 'WS-2001', 'Water Bill Income',    'بل وصولی',      'income',  'water_supply', 'Monthly water bill collections'),
      (p_tenant_id, 'WS-2002', 'Connection Fee',       'کنکشن فیس',     'income',  'water_supply', 'New connection fee income'),
      (p_tenant_id, 'WS-3001', 'Salaries & Wages',     'تنخواہیں',      'expense', 'water_supply', 'Staff salaries and daily wages'),
      (p_tenant_id, 'WS-3002', 'Electricity Bill',     'بجلی بل',       'expense', 'water_supply', 'Electricity for pumps and office'),
      (p_tenant_id, 'WS-3003', 'Repair & Maintenance', 'مرمت',          'expense', 'water_supply', 'Pipeline, pump and infrastructure repairs'),
      (p_tenant_id, 'WS-3004', 'Chemical Treatment',   'کیمیکل',        'expense', 'water_supply', 'Water purification chemicals'),
      (p_tenant_id, 'WS-3005', 'Fuel Expense',         'ایندھن',        'expense', 'water_supply', 'Generator and vehicle fuel'),
      (p_tenant_id, 'WS-3006', 'Office Expense',       'دفتری اخراجات', 'expense', 'water_supply', 'Stationery and office supplies'),
      (p_tenant_id, 'WS-4001', 'Equipment & Assets',   'اثاثے',         'asset',   'water_supply', 'Pumps, tools and equipment inventory'),
      (p_tenant_id, 'WS-5001', 'Loan Payable',         'قرض',           'liability', 'water_supply', 'Outstanding loans or payables')
    ON CONFLICT (tenant_id, code, system) DO NOTHING;
  END IF;

  IF p_donors_projects THEN
    INSERT INTO account_headers (tenant_id, system, code, label, label_ur, code_prefix, display_order, is_system) VALUES
      (p_tenant_id, 'donors_projects', 'donor',          'Donors',                 'عطیہ دہندگان',  'DP-DNR', 0,  true),
      (p_tenant_id, 'donors_projects', 'cash',           'Cash-in-hand',           'نقد',           'DP-CSH', 1,  true),
      (p_tenant_id, 'donors_projects', 'bank',           'Bank A/Cs',              'بینک اکاؤنٹس',  'DP-BNK', 2,  true),
      (p_tenant_id, 'donors_projects', 'income',         'Income',                 'آمدنی',         'DP-INC', 3,  true),
      (p_tenant_id, 'donors_projects', 'expense',        'Expenses',               'اخراجات',       'DP-EXP', 4,  true),
      (p_tenant_id, 'donors_projects', 'asset',          'Assets',                 'اثاثے',         'DP-AST', 5,  true),
      (p_tenant_id, 'donors_projects', 'liability',      'Liabilities',            'ذمہ داریاں',    'DP-LIA', 6,  true),
      (p_tenant_id, 'donors_projects', 'collector',      'Field Collectors',       NULL,            'DP-COL', 7,  true),
      (p_tenant_id, 'donors_projects', 'project',        'Project Funds',          'منصوبہ جات',    'DP-PRJ', 8,  true),
      (p_tenant_id, 'donors_projects', 'restricted_fund','Restricted Funds',       NULL,            'DP-RF',  9,  true),
      (p_tenant_id, 'donors_projects', 'institution',    'Schools & Institutions', 'سکول و ادارے',  'DP-INS', 10, true),
      (p_tenant_id, 'donors_projects', 'student',        'Students Supported',     'زیرِ کفالت طلبہ','DP-STU', 11, true),
      (p_tenant_id, 'donors_projects', 'shop',           'Shop Owners',            NULL,            'DP-SHP', 11, true),
      (p_tenant_id, 'donors_projects', 'vehicle_owner',  'Vehicle Owners',         NULL,            'DP-VEH', 12, true)
    ON CONFLICT (tenant_id, system, code) DO NOTHING;

    INSERT INTO accounts (tenant_id, code, name, name_ur, type, system, description) VALUES
      (p_tenant_id, 'DP-1001', 'Cash in Hand',        'نقد رقم',        'cash',      'donors_projects', 'Cash held for donor and project funds'),
      (p_tenant_id, 'DP-1002', 'Bank Account',        'بینک اکاؤنٹ',    'bank',      'donors_projects', 'Bank account for project funds'),
      (p_tenant_id, 'DP-2001', 'Donations Income',    'عطیات',          'income',    'donors_projects', 'All donations and contributions received'),
      (p_tenant_id, 'DP-2002', 'Zakat Income',        'زکوٰۃ',          'income',    'donors_projects', 'Zakat contributions'),
      (p_tenant_id, 'DP-2003', 'Grant Income',        'گرانٹ',          'income',    'donors_projects', 'Government and NGO grants'),
      (p_tenant_id, 'DP-3001', 'Project Expenditure', 'منصوبہ اخراجات', 'expense',   'donors_projects', 'Direct project construction and material costs'),
      (p_tenant_id, 'DP-3002', 'Labour Cost',         'مزدوری',         'expense',   'donors_projects', 'Labour charges for projects'),
      (p_tenant_id, 'DP-3003', 'Administrative Cost', 'انتظامی',        'expense',   'donors_projects', 'Admin and overhead expenses'),
      (p_tenant_id, 'DP-4001', 'Equipment & Assets',  'اثاثے',          'asset',     'donors_projects', 'Purchased equipment and tools'),
      (p_tenant_id, 'DP-5001', 'Loan Payable',        'قرض',            'liability', 'donors_projects', 'Outstanding loans or payables')
    ON CONFLICT (tenant_id, code, system) DO NOTHING;
  END IF;
END;
$function$;

-- Wire into both tenant-creation paths. Same signatures as before (no
-- parameter list change -- this is a straight CREATE OR REPLACE, not the
-- overload-risk pattern from 627/632) -- just an added call at the end.
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

  PERFORM seed_default_chart_of_accounts(v_id, p_water_supply_enabled, p_donors_enabled);

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

  INSERT INTO admin_users (tenant_id, auth_user_id, full_name, email, role, is_active)
  VALUES (v_tenant_id, p_auth_user_id, p_admin_full_name, p_admin_email, 'super_admin', true)
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

-- platform_subscribe_tenant already flips water_supply_enabled/
-- donors_enabled to match the new plan (migration 628) -- a tenant
-- upgrading from a water-only plan to one that adds donors_projects
-- needs that module's headers/accounts seeded too, at the same moment,
-- not left for someone to notice is missing. seed_default_chart_of_
-- accounts is ON CONFLICT DO NOTHING throughout, so re-running it for a
-- module the tenant already has is always a safe no-op.
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

  UPDATE tenant_subscriptions SET status = 'cancelled', cancel_at_period_end = false, updated_at = now()
   WHERE tenant_id = p_tenant_id AND status IN ('trialing', 'active', 'past_due');

  v_period_end := CASE p_billing_cycle WHEN 'annual' THEN (current_date + interval '1 year')::date ELSE (current_date + interval '1 month')::date END;

  INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, billing_cycle, current_period_start, current_period_end)
  VALUES (p_tenant_id, p_plan_id, 'active', p_billing_cycle, current_date, v_period_end)
  RETURNING id INTO v_id;

  UPDATE tenants SET water_supply_enabled = v_plan.includes_water_supply, donors_enabled = v_plan.includes_donors_projects
   WHERE id = p_tenant_id;

  PERFORM seed_default_chart_of_accounts(p_tenant_id, v_plan.includes_water_supply, v_plan.includes_donors_projects);

  RETURN v_id;
END;
$function$;

-- Backfill the 2 real tenants created before this migration existed,
-- both currently at accounts=0 / account_headers=0.
do $$
declare
  t record;
begin
  for t in select id, water_supply_enabled, donors_enabled from tenants where id <> 'bf9e4815-4104-472a-ab32-114171b7e34d'
  loop
    perform seed_default_chart_of_accounts(t.id, t.water_supply_enabled, t.donors_enabled);
  end loop;
end $$;
