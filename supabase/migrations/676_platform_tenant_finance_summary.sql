-- Migration 676: a cross-tenant finance/settlement report for the
-- platform console -- "full reports of the finance and settlements
-- with each village." One row per tenant: how much that village's
-- marketplace system has earned (its own commission revenue, which
-- stays the committee's own money), and how much it currently owes
-- the platform via pending subscription invoices.
--
-- Deliberately a fresh aggregation against ledger_entries/accounts
-- rather than reusing ledger_account_balances -- that view is itself
-- tenant-scoped (COALESCE(my_tenant_id(), request_tenant_id(), ...)),
-- which would collapse to just one tenant for a platform admin (no
-- tenant_id of their own at all).

CREATE OR REPLACE FUNCTION public.platform_tenant_finance_summary()
RETURNS TABLE (
  tenant_id uuid,
  tenant_name varchar,
  plan_name varchar,
  subscription_status varchar,
  marketplace_income_pkr decimal,
  marketplace_commission_pkr decimal,
  outstanding_invoices_pkr decimal,
  ilan_requests_pending int
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT
    t.id,
    t.name,
    sp.name,
    ts.status,
    COALESCE(income.total, 0),
    COALESCE(commission.total, 0),
    COALESCE(inv.total, 0),
    COALESCE(ilan.cnt, 0)::int
  FROM tenants t
  LEFT JOIN tenant_subscriptions ts ON ts.tenant_id = t.id AND ts.status IN ('active', 'trialing', 'past_due')
  LEFT JOIN subscription_plans sp ON sp.id = ts.plan_id
  LEFT JOIN (
    SELECT a.tenant_id, SUM(le.credit - le.debit) AS total
    FROM accounts a
    JOIN ledger_entries le ON le.account_id = a.id
    WHERE a.system = 'marketplace' AND a.type = 'income'
    GROUP BY a.tenant_id
  ) income ON income.tenant_id = t.id
  LEFT JOIN (
    SELECT a.tenant_id, SUM(le.credit - le.debit) AS total
    FROM accounts a
    JOIN ledger_entries le ON le.account_id = a.id
    WHERE a.system = 'marketplace' AND a.code = 'MKT-4050'
    GROUP BY a.tenant_id
  ) commission ON commission.tenant_id = t.id
  LEFT JOIN (
    SELECT pi.tenant_id, SUM(pi.total_amount_pkr) AS total
    FROM platform_invoices pi
    WHERE pi.status != 'paid'
    GROUP BY pi.tenant_id
  ) inv ON inv.tenant_id = t.id
  LEFT JOIN (
    SELECT ci.home_tenant_id, COUNT(*) AS cnt
    FROM commercial_ilans ci
    WHERE ci.status = 'pending_approval'
    GROUP BY ci.home_tenant_id
  ) ilan ON ilan.home_tenant_id = t.id
  ORDER BY t.name;
END;
$$;
