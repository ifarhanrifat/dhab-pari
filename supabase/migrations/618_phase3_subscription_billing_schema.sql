-- Phase 3, part 1: subscription/billing schema.
--
-- subscription_plans: the platform's own price list (not tenant data --
-- genuinely platform-wide, same category as the dhab-pari-only
-- reference tables judged platform-level in Phase 2 slice 12).
--
-- tenant_subscriptions: which plan a tenant is on and its billing cycle.
-- commission_pct lives on the plan (not hardcoded), so different plans
-- can offer different platform commission rates.
--
-- platform_invoices: one row per tenant per billing period, combining
-- the plan's flat subscription fee with the computed commission amount
-- for that period (see migration 619's platform_compute_tenant_commission).
-- Deliberately a billing RECORD, not a payment processor integration --
-- marking an invoice paid/collecting the money is a manual admin action
-- for now (p_status transitions via platform_mark_invoice_paid in
-- migration 619), not wired to any payment gateway. Building that
-- integration without a specified gateway/contract to implement against
-- is exactly the kind of invented-requirement risk this whole project
-- has tried to avoid -- the invoice ledger here is real and usable today
-- (a platform admin can see what each tenant owes and mark it collected),
-- and gateway wiring is a natural, separate follow-up once one is chosen.

create table subscription_plans (
  id uuid primary key default gen_random_uuid(),
  key varchar not null unique,
  name varchar not null,
  monthly_price_pkr decimal not null default 0,
  commission_pct decimal not null default 0,
  max_admin_users int,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table subscription_plans enable row level security;

create policy subscription_plans_public_read on subscription_plans
  for select
  using (is_active = true);

create policy subscription_plans_platform_manage on subscription_plans
  for all to authenticated
  using (is_platform_admin())
  with check (is_platform_admin());

create table tenant_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  plan_id uuid not null references subscription_plans(id),
  status varchar not null default 'active' check (status in ('trialing', 'active', 'past_due', 'cancelled')),
  billing_cycle varchar not null default 'monthly' check (billing_cycle in ('monthly', 'annual')),
  current_period_start date not null default current_date,
  current_period_end date not null,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One live (non-cancelled) subscription per tenant at a time -- a plan
-- change is a new row only once the old one is cancelled, same
-- "supersede, don't mutate history" convention as every other
-- subscription/contract-shaped table in this codebase.
create unique index tenant_subscriptions_one_active_per_tenant
  on tenant_subscriptions (tenant_id)
  where status in ('trialing', 'active', 'past_due');

alter table tenant_subscriptions enable row level security;

create policy tenant_subscriptions_own_read on tenant_subscriptions
  for select to authenticated
  using (tenant_id = my_tenant_id() or is_platform_admin());

create policy tenant_subscriptions_platform_manage on tenant_subscriptions
  for all to authenticated
  using (is_platform_admin())
  with check (is_platform_admin());

create table platform_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  subscription_id uuid references tenant_subscriptions(id),
  invoice_number varchar not null unique,
  period_start date not null,
  period_end date not null,
  subscription_amount_pkr decimal not null default 0,
  commission_amount_pkr decimal not null default 0,
  total_amount_pkr decimal not null,
  status varchar not null default 'pending' check (status in ('pending', 'paid', 'overdue', 'void')),
  issued_at timestamptz not null default now(),
  paid_at timestamptz,
  notes text
);

alter table platform_invoices enable row level security;

create policy platform_invoices_own_read on platform_invoices
  for select to authenticated
  using (tenant_id = my_tenant_id() or is_platform_admin());

create policy platform_invoices_platform_manage on platform_invoices
  for all to authenticated
  using (is_platform_admin())
  with check (is_platform_admin());

create or replace function public.next_platform_invoice_number()
 returns varchar
 language sql
 security definer
 set search_path to 'public'
as $function$
  select 'PINV-' || to_char(now(), 'YYYYMM') || '-' || lpad((
    coalesce((select count(*) from platform_invoices where invoice_number like 'PINV-' || to_char(now(), 'YYYYMM') || '-%') + 1, 1)
  )::text, 4, '0');
$function$;
