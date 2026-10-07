-- Automates what was previously a manual "Generate Invoices" button click.
--
-- Does NOT call the existing platform_generate_monthly_invoices /
-- platform_compute_tenant_commission RPCs directly -- both are gated by
-- is_platform_admin(), which (like every other admin-gated function
-- called from pg_cron today) resolves false under cron's no-auth
-- context, since auth.uid() is null there. Rather than weakening either
-- already-shipped, client-facing function's authorization check, this is
-- a separate, cron-only function with the same core logic inlined --
-- never granted to anon/authenticated, only ever reachable via
-- cron.schedule, so it needs no gate of its own. The manual "Generate
-- Invoices" button in the platform console is completely untouched.
--
-- Same date-boundary convention as run_monthly_closing_report (migration
-- 604-606): computes the just-finished calendar month. Safe to re-run --
-- it skips any tenant+period that already has an invoice, same as the
-- function it mirrors.
create or replace function public.run_platform_monthly_invoicing()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_period_start date := (date_trunc('month', current_date) - interval '1 month')::date;
  v_period_end date := (date_trunc('month', current_date) - interval '1 day')::date;
  r record;
  v_commission_pct decimal;
  v_tenant_marketplace_income decimal;
  v_commission decimal;
  v_total decimal;
BEGIN
  FOR r IN
    SELECT s.id AS subscription_id, s.tenant_id, p.monthly_price_pkr, p.commission_pct
    FROM tenant_subscriptions s
    JOIN subscription_plans p ON p.id = s.plan_id
    WHERE s.status IN ('active', 'trialing', 'past_due')
  LOOP
    IF EXISTS (SELECT 1 FROM platform_invoices WHERE tenant_id = r.tenant_id AND period_start = v_period_start) THEN
      CONTINUE; -- already invoiced this period
    END IF;

    v_commission := 0;
    IF r.commission_pct IS NOT NULL AND r.commission_pct > 0 THEN
      SELECT COALESCE(SUM(l.credit - l.debit), 0) INTO v_tenant_marketplace_income
      FROM ledger_entries l
      JOIN accounts a ON a.id = l.account_id
      WHERE a.tenant_id = r.tenant_id AND a.system = 'donors_projects' AND a.code = 'DP-4050'
        AND l.entry_date BETWEEN v_period_start AND v_period_end;
      v_commission := round(GREATEST(v_tenant_marketplace_income, 0) * r.commission_pct / 100, 2);
    END IF;

    v_total := r.monthly_price_pkr + v_commission;

    INSERT INTO platform_invoices (
      tenant_id, subscription_id, invoice_number, period_start, period_end,
      subscription_amount_pkr, commission_amount_pkr, total_amount_pkr, status
    ) VALUES (
      r.tenant_id, r.subscription_id, next_platform_invoice_number(), v_period_start, v_period_end,
      r.monthly_price_pkr, v_commission, v_total, 'pending'
    );
  END LOOP;
END;
$function$;

-- Runs the day after monthly-closing-report (5am on the 1st) so it never
-- races the accounting close for the same period.
DO $$
BEGIN
  PERFORM cron.schedule('platform-monthly-invoicing', '0 6 1 * *', $cron$SELECT run_platform_monthly_invoicing()$cron$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available — platform invoicing stays manual via the platform console button: %', SQLERRM;
END $$;
