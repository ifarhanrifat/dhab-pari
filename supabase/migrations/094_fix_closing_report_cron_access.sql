-- Migration 094: compute_monthly_closing()'s can_access_system() check relies
-- on auth.uid(), which is NULL for both a service-role call AND the cron job
-- itself (pg_cron has no "logged in user" either) — so the check that was
-- meant to stop an unauthorized client from peeking at another system's
-- figures would also have silently broken the monthly cron sweep. Split into
-- an unchecked core (for cron / other SECURITY DEFINER callers) and a
-- checked wrapper (the only one granted to `authenticated`, used by the
-- client for the live current-month preview).

ALTER FUNCTION compute_monthly_closing(varchar, int, int) RENAME TO compute_monthly_closing_core;
REVOKE ALL ON FUNCTION compute_monthly_closing_core(varchar, int, int) FROM PUBLIC, authenticated;

CREATE OR REPLACE FUNCTION compute_monthly_closing_core(p_system varchar, p_month int, p_year int) RETURNS jsonb AS $$
DECLARE
  v_month_start date := make_date(p_year, p_month, 1);
  v_month_end date := (v_month_start + interval '1 month' - interval '1 day')::date;
  v_prev_month_start date := (v_month_start - interval '1 month')::date;
  v_prev_month_end date := (v_month_start - interval '1 day')::date;
  v_prev_month int := EXTRACT(MONTH FROM v_prev_month_start)::int;
  v_prev_year int := EXTRACT(YEAR FROM v_prev_month_start)::int;

  v_this_month_cash decimal;
  v_prev_month_cash decimal;
  v_total_receivable decimal;
  v_total_payable decimal;
  v_prev_month_billing decimal;
  v_prev_month_receivable decimal;
  v_this_month_recovery decimal;
  v_new_connections int;
  v_disconnections int;
  v_billing_income decimal;
  v_sale_income decimal;
  v_total_expenses decimal;
  v_expense_lines jsonb;
  v_net_surplus decimal;
  v_total_pending_bills decimal;
  v_pending_by_sector jsonb;
BEGIN
  SELECT COALESCE(SUM(a.opening_balance + COALESCE(le.net, 0)), 0) INTO v_this_month_cash
  FROM accounts a
  LEFT JOIN LATERAL (SELECT SUM(l.debit - l.credit) net FROM ledger_entries l WHERE l.account_id = a.id AND l.entry_date <= v_month_end) le ON true
  WHERE a.system = p_system AND a.type IN ('cash', 'bank');

  SELECT COALESCE(SUM(a.opening_balance + COALESCE(le.net, 0)), 0) INTO v_prev_month_cash
  FROM accounts a
  LEFT JOIN LATERAL (SELECT SUM(l.debit - l.credit) net FROM ledger_entries l WHERE l.account_id = a.id AND l.entry_date <= v_prev_month_end) le ON true
  WHERE a.system = p_system AND a.type IN ('cash', 'bank');

  SELECT COALESCE(SUM(a.opening_balance - COALESCE(le.net, 0)), 0) INTO v_total_payable
  FROM accounts a
  LEFT JOIN LATERAL (SELECT SUM(l.debit - l.credit) net FROM ledger_entries l WHERE l.account_id = a.id) le ON true
  WHERE a.system = p_system AND a.type = 'liability';

  IF p_system = 'water_supply' THEN
    SELECT COALESCE(SUM(GREATEST(a.opening_balance + COALESCE(le.net, 0), 0)), 0) INTO v_total_receivable
    FROM accounts a
    LEFT JOIN LATERAL (SELECT SUM(l.debit - l.credit) net FROM ledger_entries l WHERE l.account_id = a.id) le ON true
    WHERE a.system = 'water_supply' AND a.type = 'consumer';

    SELECT COALESCE(SUM(amount_pkr), 0) INTO v_prev_month_billing FROM bills WHERE month = v_prev_month AND year = v_prev_year;

    SELECT COALESCE(SUM(GREATEST(b.amount_pkr - COALESCE(b.discount_amount, 0) - COALESCE(pd.paid, 0), 0)), 0) INTO v_prev_month_receivable
    FROM bills b
    LEFT JOIN LATERAL (SELECT SUM(pm.amount_pkr) paid FROM payments pm WHERE pm.bill_id = b.id AND pm.paid_date <= v_prev_month_end) pd ON true
    WHERE b.created_at::date <= v_prev_month_end;

    SELECT COALESCE(SUM(amount_pkr), 0) INTO v_this_month_recovery FROM payments WHERE paid_date BETWEEN v_month_start AND v_month_end;

    SELECT COUNT(*) INTO v_new_connections FROM consumers WHERE connection_date BETWEEN v_month_start AND v_month_end;
    SELECT COUNT(*) INTO v_disconnections FROM consumers WHERE disconnected_at::date BETWEEN v_month_start AND v_month_end;

    SELECT COALESCE(SUM(l.credit - l.debit), 0) INTO v_billing_income
    FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
    WHERE a.system = 'water_supply' AND a.code = 'WS-2001' AND l.entry_date BETWEEN v_month_start AND v_month_end;

    SELECT COALESCE(SUM(l.credit - l.debit), 0) INTO v_sale_income
    FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
    WHERE a.system = 'water_supply' AND a.code IN ('WS-2002', 'WS-2003', 'WS-2004', 'WS-2005') AND l.entry_date BETWEEN v_month_start AND v_month_end;

    v_total_pending_bills := v_total_receivable;

    SELECT COALESCE(jsonb_object_agg(sector, bal), '{}'::jsonb) INTO v_pending_by_sector FROM (
      SELECT COALESCE(c.sector, 'Unassigned') sector, SUM(GREATEST(a.opening_balance + COALESCE(le.net, 0), 0)) bal
      FROM accounts a
      LEFT JOIN LATERAL (SELECT SUM(l.debit - l.credit) net FROM ledger_entries l WHERE l.account_id = a.id) le ON true
      JOIN consumers c ON c.consumer_id = a.consumer_id
      WHERE a.system = 'water_supply' AND a.type = 'consumer'
      GROUP BY c.sector
      HAVING SUM(GREATEST(a.opening_balance + COALESCE(le.net, 0), 0)) > 0
    ) s;
  ELSE
    v_total_receivable := 0;
    SELECT COALESCE(SUM(amount_pkr), 0) INTO v_prev_month_billing FROM donors WHERE date BETWEEN v_prev_month_start AND v_prev_month_end;
    v_prev_month_receivable := 0;
    SELECT COALESCE(SUM(amount_pkr), 0) INTO v_this_month_recovery FROM donors WHERE date BETWEEN v_month_start AND v_month_end;
    v_new_connections := NULL;
    v_disconnections := NULL;
    SELECT COALESCE(SUM(l.credit - l.debit), 0) INTO v_billing_income
    FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
    WHERE a.system = 'donors_projects' AND a.type = 'donor' AND l.entry_date BETWEEN v_month_start AND v_month_end;
    v_sale_income := NULL;
    v_total_pending_bills := 0;
    v_pending_by_sector := '{}'::jsonb;
  END IF;

  SELECT COALESCE(SUM(l.debit - l.credit), 0) INTO v_total_expenses
  FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
  WHERE a.system = p_system AND a.type = 'expense' AND l.entry_date BETWEEN v_month_start AND v_month_end;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('description', particular, 'amount', amt) ORDER BY amt DESC), '[]'::jsonb) INTO v_expense_lines
  FROM (
    SELECT l.particular, SUM(l.debit - l.credit) amt
    FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
    WHERE a.system = p_system AND a.type = 'expense' AND l.entry_date BETWEEN v_month_start AND v_month_end
    GROUP BY l.particular
  ) e;

  v_net_surplus := COALESCE(v_billing_income, 0) + COALESCE(v_sale_income, 0) - v_total_expenses;

  RETURN jsonb_build_object(
    'system', p_system, 'report_month', p_month, 'report_year', p_year,
    'new_connections', v_new_connections, 'disconnections', v_disconnections,
    'prev_month_cash', v_prev_month_cash, 'this_month_cash', v_this_month_cash,
    'prev_month_billing', v_prev_month_billing, 'prev_month_receivable', v_prev_month_receivable,
    'this_month_recovery', v_this_month_recovery,
    'total_receivable', v_total_receivable, 'total_payable', v_total_payable,
    'total_pending_bills', v_total_pending_bills, 'pending_by_sector', v_pending_by_sector,
    'billing_income', v_billing_income, 'sale_income', v_sale_income,
    'total_expenses', v_total_expenses, 'expense_lines', v_expense_lines,
    'net_surplus', v_net_surplus
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- The only entry point the client calls directly (via RPC) — enforces
-- can_access_system() before delegating to the unchecked core above.
CREATE OR REPLACE FUNCTION compute_monthly_closing(p_system varchar, p_month int, p_year int) RETURNS jsonb AS $$
BEGIN
  IF NOT can_access_system(p_system) THEN
    RAISE EXCEPTION 'No access to system %', p_system;
  END IF;
  RETURN compute_monthly_closing_core(p_system, p_month, p_year);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION compute_monthly_closing(varchar, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION compute_monthly_closing(varchar, int, int) TO authenticated;

-- Cron sweep now calls the unchecked core directly — it's a trusted internal
-- job, not a user session, and was never meant to be gated by can_access_system.
CREATE OR REPLACE FUNCTION run_monthly_closing_report() RETURNS void AS $$
DECLARE
  v_prev_month_start date := (date_trunc('month', current_date) - interval '1 month')::date;
  v_month int := EXTRACT(MONTH FROM v_prev_month_start)::int;
  v_year int := EXTRACT(YEAR FROM v_prev_month_start)::int;
  v_sys varchar;
  v_data jsonb;
BEGIN
  FOREACH v_sys IN ARRAY ARRAY['water_supply', 'donors_projects'] LOOP
    v_data := compute_monthly_closing_core(v_sys, v_month, v_year);
    INSERT INTO monthly_closing_reports (
      system, report_month, report_year, new_connections, disconnections,
      prev_month_cash, this_month_cash, prev_month_billing, prev_month_receivable, this_month_recovery,
      total_receivable, total_payable, total_pending_bills, pending_by_sector,
      billing_income, sale_income, total_expenses, expense_lines, net_surplus
    ) VALUES (
      v_sys, v_month, v_year, (v_data->>'new_connections')::int, (v_data->>'disconnections')::int,
      (v_data->>'prev_month_cash')::decimal, (v_data->>'this_month_cash')::decimal,
      (v_data->>'prev_month_billing')::decimal, (v_data->>'prev_month_receivable')::decimal, (v_data->>'this_month_recovery')::decimal,
      (v_data->>'total_receivable')::decimal, (v_data->>'total_payable')::decimal,
      (v_data->>'total_pending_bills')::decimal, v_data->'pending_by_sector',
      (v_data->>'billing_income')::decimal, (v_data->>'sale_income')::decimal,
      (v_data->>'total_expenses')::decimal, v_data->'expense_lines', (v_data->>'net_surplus')::decimal
    )
    ON CONFLICT (system, report_month, report_year) DO UPDATE SET
      new_connections = EXCLUDED.new_connections, disconnections = EXCLUDED.disconnections,
      prev_month_cash = EXCLUDED.prev_month_cash, this_month_cash = EXCLUDED.this_month_cash,
      prev_month_billing = EXCLUDED.prev_month_billing, prev_month_receivable = EXCLUDED.prev_month_receivable,
      this_month_recovery = EXCLUDED.this_month_recovery,
      total_receivable = EXCLUDED.total_receivable, total_payable = EXCLUDED.total_payable,
      total_pending_bills = EXCLUDED.total_pending_bills, pending_by_sector = EXCLUDED.pending_by_sector,
      billing_income = EXCLUDED.billing_income, sale_income = EXCLUDED.sale_income,
      total_expenses = EXCLUDED.total_expenses, expense_lines = EXCLUDED.expense_lines,
      net_surplus = EXCLUDED.net_surplus, updated_at = now();
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
