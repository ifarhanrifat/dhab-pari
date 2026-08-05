-- Migration 095: Running Capital accuracy fixes + professional redesign data.
-- Confirmed bugs fixed here: (1) "Billing Income" was net-of-discount revenue
-- shown as if it were the billed amount — now both are computed and returned
-- separately; (2) "new connections this month" used consumers.connection_date,
-- which is never written anywhere in the app (dead column) — always returned
-- zero; now uses consumers.created_at (set at Cash Receive) instead.

ALTER TABLE monthly_closing_reports ADD COLUMN IF NOT EXISTS this_month_billed decimal;
ALTER TABLE monthly_closing_reports ADD COLUMN IF NOT EXISTS this_month_discount decimal;
ALTER TABLE monthly_closing_reports ADD COLUMN IF NOT EXISTS discount_by_consumer jsonb DEFAULT '[]';
ALTER TABLE monthly_closing_reports ADD COLUMN IF NOT EXISTS cash_in decimal;
ALTER TABLE monthly_closing_reports ADD COLUMN IF NOT EXISTS cash_out decimal;
ALTER TABLE monthly_closing_reports ADD COLUMN IF NOT EXISTS new_connections_detail jsonb DEFAULT '[]';
ALTER TABLE monthly_closing_reports ADD COLUMN IF NOT EXISTS complaints_this_month jsonb DEFAULT '[]';
ALTER TABLE monthly_closing_reports ADD COLUMN IF NOT EXISTS task_progress jsonb DEFAULT '[]';
ALTER TABLE monthly_closing_reports ADD COLUMN IF NOT EXISTS donor_breakdown jsonb DEFAULT '{}';
ALTER TABLE monthly_closing_reports ADD COLUMN IF NOT EXISTS project_progress jsonb DEFAULT '[]';

CREATE OR REPLACE FUNCTION compute_monthly_closing_core(p_system varchar, p_month int, p_year int) RETURNS jsonb AS $$
DECLARE
  v_month_start date := make_date(p_year, p_month, 1);
  v_month_end date := (v_month_start + interval '1 month' - interval '1 day')::date;
  v_month_end_excl timestamptz := (v_month_end + interval '1 day')::timestamptz;
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

  v_this_month_billed decimal;
  v_this_month_discount decimal;
  v_discount_by_consumer jsonb;
  v_cash_in decimal;
  v_cash_out decimal;
  v_new_connections_detail jsonb;
  v_complaints_this_month jsonb;
  v_task_progress jsonb;
  v_donor_breakdown jsonb;
  v_project_progress jsonb;
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

  SELECT COALESCE(SUM(l.debit), 0), COALESCE(SUM(l.credit), 0) INTO v_cash_in, v_cash_out
  FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
  WHERE a.system = p_system AND a.type IN ('cash', 'bank') AND l.entry_date BETWEEN v_month_start AND v_month_end;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('name', complainant_name, 'sector', sector, 'text', complaint_text) ORDER BY created_at), '[]'::jsonb)
  INTO v_complaints_this_month
  FROM complaints WHERE system = p_system AND created_at >= v_month_start AND created_at < v_month_end_excl;

  IF p_system = 'water_supply' THEN
    SELECT COALESCE(SUM(GREATEST(a.opening_balance + COALESCE(le.net, 0), 0)), 0) INTO v_total_receivable
    FROM accounts a
    LEFT JOIN LATERAL (SELECT SUM(l.debit - l.credit) net FROM ledger_entries l WHERE l.account_id = a.id) le ON true
    WHERE a.system = 'water_supply' AND a.type = 'consumer';

    SELECT COALESCE(SUM(amount_pkr), 0) INTO v_prev_month_billing FROM bills WHERE month = v_prev_month AND year = v_prev_year;

    SELECT COALESCE(SUM(amount_pkr), 0), COALESCE(SUM(discount_amount), 0) INTO v_this_month_billed, v_this_month_discount
    FROM bills WHERE month = p_month AND year = p_year;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('consumer_name', dc.cname, 'amount', dc.damt) ORDER BY dc.damt DESC), '[]'::jsonb) INTO v_discount_by_consumer
    FROM (
      SELECT c.name cname, SUM(b.discount_amount) damt
      FROM bills b JOIN consumers c ON c.consumer_id = b.consumer_id
      WHERE b.month = p_month AND b.year = p_year AND COALESCE(b.discount_amount, 0) > 0
      GROUP BY c.name
    ) dc;

    SELECT COALESCE(SUM(GREATEST(b.amount_pkr - COALESCE(b.discount_amount, 0) - COALESCE(pd.paid, 0), 0)), 0) INTO v_prev_month_receivable
    FROM bills b
    LEFT JOIN LATERAL (SELECT SUM(pm.amount_pkr) paid FROM payments pm WHERE pm.bill_id = b.id AND pm.paid_date <= v_prev_month_end) pd ON true
    WHERE b.created_at::date <= v_prev_month_end;

    SELECT COALESCE(SUM(amount_pkr), 0) INTO v_this_month_recovery FROM payments WHERE paid_date BETWEEN v_month_start AND v_month_end;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('consumer_name', c.name, 'incharge_name', au.full_name, 'activated', cr.status = 'installed') ORDER BY c.created_at), '[]'::jsonb)
    INTO v_new_connections_detail
    FROM consumers c
    JOIN connection_requests cr ON cr.consumer_id = c.consumer_id
    LEFT JOIN admin_users au ON au.id = cr.incharge_user_id
    WHERE c.created_at >= v_month_start AND c.created_at < v_month_end_excl;
    v_new_connections := jsonb_array_length(v_new_connections_detail);

    SELECT COUNT(*) INTO v_disconnections FROM consumers WHERE disconnected_at::date BETWEEN v_month_start AND v_month_end;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('request_number', cr.request_number, 'consumer_name', cr.consumer_name, 'sector', cr.sector, 'incharge_name', au.full_name, 'task_status', cr.task_status) ORDER BY cr.task_assigned_at), '[]'::jsonb)
    INTO v_task_progress
    FROM connection_requests cr
    LEFT JOIN admin_users au ON au.id = cr.incharge_user_id
    WHERE (cr.task_assigned_at >= v_month_start AND cr.task_assigned_at < v_month_end_excl)
       OR (cr.task_done_at >= v_month_start AND cr.task_done_at < v_month_end_excl);

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

    v_donor_breakdown := '{}'::jsonb;
    v_project_progress := '[]'::jsonb;
  ELSE
    v_total_receivable := 0;
    v_this_month_billed := NULL; v_this_month_discount := NULL; v_discount_by_consumer := '[]'::jsonb;
    SELECT COALESCE(SUM(amount_pkr), 0) INTO v_prev_month_billing FROM donors WHERE date BETWEEN v_prev_month_start AND v_prev_month_end;
    v_prev_month_receivable := 0;
    SELECT COALESCE(SUM(amount_pkr), 0) INTO v_this_month_recovery FROM donors WHERE date BETWEEN v_month_start AND v_month_end;
    v_new_connections := NULL;
    v_disconnections := NULL;
    v_new_connections_detail := '[]'::jsonb;
    v_task_progress := '[]'::jsonb;

    SELECT COALESCE(SUM(l.credit - l.debit), 0) INTO v_billing_income
    FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
    WHERE a.system = 'donors_projects' AND a.type = 'donor' AND l.entry_date BETWEEN v_month_start AND v_month_end;
    v_sale_income := NULL;
    v_total_pending_bills := 0;
    v_pending_by_sector := '{}'::jsonb;

    SELECT jsonb_build_object(
      'by_project', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('title', COALESCE(p.title, '—'), 'total', s.total) ORDER BY s.total DESC)
        FROM (SELECT project_id, SUM(amount_pkr) total FROM donors WHERE date BETWEEN v_month_start AND v_month_end GROUP BY project_id) s
        LEFT JOIN projects p ON p.id = s.project_id
      ), '[]'::jsonb),
      'by_type', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('type', COALESCE(donor_type, 'unspecified'), 'total', total) ORDER BY total DESC)
        FROM (SELECT donor_type, SUM(amount_pkr) total FROM donors WHERE date BETWEEN v_month_start AND v_month_end GROUP BY donor_type) t
      ), '[]'::jsonb)
    ) INTO v_donor_breakdown;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('title', title, 'status', status, 'progress_percent', progress_percent, 'budget_pkr', budget_pkr, 'spent_pkr', spent_pkr) ORDER BY status, title), '[]'::jsonb)
    INTO v_project_progress FROM projects;
  END IF;

  SELECT COALESCE(SUM(l.debit - l.credit), 0) INTO v_total_expenses
  FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
  WHERE a.system = p_system AND a.type = 'expense' AND l.entry_date BETWEEN v_month_start AND v_month_end;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('description', x.description, 'amount', x.amount, 'approved_by', x.approved_by, 'auto_posted', x.auto_posted) ORDER BY x.amount DESC), '[]'::jsonb)
  INTO v_expense_lines
  FROM (
    SELECT v.particular AS description, SUM(l.debit - l.credit) AS amount,
      COALESCE((
        SELECT jsonb_agg(DISTINCT au.full_name)
        FROM approval_requests ar
        JOIN approval_confirmations ac ON ac.approval_request_id = ar.id AND ac.confirmed = true
        JOIN admin_users au ON au.id = ac.approver_id
        WHERE ar.kind = 'voucher' AND ar.reference_id = v.id
      ), '[]'::jsonb) AS approved_by,
      EXISTS (SELECT 1 FROM approval_requests ar WHERE ar.kind = 'voucher' AND ar.reference_id = v.id AND ar.auto_posted) AS auto_posted
    FROM ledger_entries l
    JOIN accounts a ON a.id = l.account_id
    JOIN vouchers v ON v.id = l.reference_id AND l.reference_type = 'voucher'
    WHERE a.system = p_system AND a.type = 'expense' AND l.entry_date BETWEEN v_month_start AND v_month_end
    GROUP BY v.id, v.particular

    UNION ALL

    SELECT l.particular AS description, SUM(l.debit - l.credit) AS amount, '[]'::jsonb AS approved_by, false AS auto_posted
    FROM ledger_entries l
    JOIN accounts a ON a.id = l.account_id
    WHERE a.system = p_system AND a.type = 'expense' AND l.entry_date BETWEEN v_month_start AND v_month_end
      AND l.reference_type IS DISTINCT FROM 'voucher'
    GROUP BY l.particular
  ) x;

  v_net_surplus := COALESCE(v_billing_income, 0) + COALESCE(v_sale_income, 0) - v_total_expenses;

  RETURN jsonb_build_object(
    'system', p_system, 'report_month', p_month, 'report_year', p_year,
    'new_connections', v_new_connections, 'disconnections', v_disconnections,
    'new_connections_detail', v_new_connections_detail,
    'prev_month_cash', v_prev_month_cash, 'this_month_cash', v_this_month_cash,
    'cash_in', v_cash_in, 'cash_out', v_cash_out,
    'prev_month_billing', v_prev_month_billing, 'prev_month_receivable', v_prev_month_receivable,
    'this_month_billed', v_this_month_billed, 'this_month_discount', v_this_month_discount, 'discount_by_consumer', v_discount_by_consumer,
    'this_month_recovery', v_this_month_recovery,
    'total_receivable', v_total_receivable, 'total_payable', v_total_payable,
    'total_pending_bills', v_total_pending_bills, 'pending_by_sector', v_pending_by_sector,
    'billing_income', v_billing_income, 'sale_income', v_sale_income,
    'total_expenses', v_total_expenses, 'expense_lines', v_expense_lines,
    'net_surplus', v_net_surplus,
    'complaints_this_month', v_complaints_this_month, 'task_progress', v_task_progress,
    'donor_breakdown', v_donor_breakdown, 'project_progress', v_project_progress
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

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
      system, report_month, report_year, new_connections, disconnections, new_connections_detail,
      prev_month_cash, this_month_cash, cash_in, cash_out,
      prev_month_billing, prev_month_receivable, this_month_billed, this_month_discount, discount_by_consumer, this_month_recovery,
      total_receivable, total_payable, total_pending_bills, pending_by_sector,
      billing_income, sale_income, total_expenses, expense_lines, net_surplus,
      complaints_this_month, task_progress, donor_breakdown, project_progress
    ) VALUES (
      v_sys, v_month, v_year, (v_data->>'new_connections')::int, (v_data->>'disconnections')::int, v_data->'new_connections_detail',
      (v_data->>'prev_month_cash')::decimal, (v_data->>'this_month_cash')::decimal, (v_data->>'cash_in')::decimal, (v_data->>'cash_out')::decimal,
      (v_data->>'prev_month_billing')::decimal, (v_data->>'prev_month_receivable')::decimal,
      (v_data->>'this_month_billed')::decimal, (v_data->>'this_month_discount')::decimal, v_data->'discount_by_consumer', (v_data->>'this_month_recovery')::decimal,
      (v_data->>'total_receivable')::decimal, (v_data->>'total_payable')::decimal,
      (v_data->>'total_pending_bills')::decimal, v_data->'pending_by_sector',
      (v_data->>'billing_income')::decimal, (v_data->>'sale_income')::decimal,
      (v_data->>'total_expenses')::decimal, v_data->'expense_lines', (v_data->>'net_surplus')::decimal,
      v_data->'complaints_this_month', v_data->'task_progress', v_data->'donor_breakdown', v_data->'project_progress'
    )
    ON CONFLICT (system, report_month, report_year) DO UPDATE SET
      new_connections = EXCLUDED.new_connections, disconnections = EXCLUDED.disconnections, new_connections_detail = EXCLUDED.new_connections_detail,
      prev_month_cash = EXCLUDED.prev_month_cash, this_month_cash = EXCLUDED.this_month_cash, cash_in = EXCLUDED.cash_in, cash_out = EXCLUDED.cash_out,
      prev_month_billing = EXCLUDED.prev_month_billing, prev_month_receivable = EXCLUDED.prev_month_receivable,
      this_month_billed = EXCLUDED.this_month_billed, this_month_discount = EXCLUDED.this_month_discount, discount_by_consumer = EXCLUDED.discount_by_consumer,
      this_month_recovery = EXCLUDED.this_month_recovery,
      total_receivable = EXCLUDED.total_receivable, total_payable = EXCLUDED.total_payable,
      total_pending_bills = EXCLUDED.total_pending_bills, pending_by_sector = EXCLUDED.pending_by_sector,
      billing_income = EXCLUDED.billing_income, sale_income = EXCLUDED.sale_income,
      total_expenses = EXCLUDED.total_expenses, expense_lines = EXCLUDED.expense_lines,
      net_surplus = EXCLUDED.net_surplus, complaints_this_month = EXCLUDED.complaints_this_month,
      task_progress = EXCLUDED.task_progress, donor_breakdown = EXCLUDED.donor_breakdown, project_progress = EXCLUDED.project_progress,
      updated_at = now();
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
