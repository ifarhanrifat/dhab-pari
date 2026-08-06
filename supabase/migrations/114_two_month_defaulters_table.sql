-- Migration 114: adds the 2-month defaulter list to the monthly report —
-- consumer_nonpayment_flags (migration 064) already detects exactly this
-- ("2 consecutive unpaid months"), reused directly rather than re-deriving it.

ALTER TABLE monthly_closing_reports ADD COLUMN IF NOT EXISTS two_month_defaulters jsonb DEFAULT '[]';

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
  v_pending_bills_by_consumer jsonb;
  v_non_payers_due_to_complaint jsonb;
  v_two_month_defaulters jsonb;

  v_this_month_billed decimal;
  v_this_month_discount decimal;
  v_discount_by_consumer jsonb;
  v_cash_in decimal;
  v_cash_out decimal;
  v_cash_in_breakdown jsonb;
  v_cash_out_breakdown jsonb;
  v_new_connections_detail jsonb;
  v_complaints_this_month jsonb;
  v_task_progress jsonb;
  v_donor_breakdown jsonb;
  v_project_progress jsonb;

  v_prev_report_id uuid;
  v_prev_report_this_month_cash decimal;
  v_prev_report_created_at timestamptz;
  v_opening_expected decimal;
  v_opening_actual decimal;
  v_opening_mismatch boolean := false;
  v_reconciliation_changes jsonb := '[]'::jsonb;
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

  SELECT COALESCE(jsonb_agg(jsonb_build_object('category', x.cat, 'amount', x.amt) ORDER BY x.amt DESC), '[]'::jsonb) INTO v_cash_in_breakdown
  FROM (
    SELECT
      CASE
        WHEN l.reference_type = 'payment' THEN (CASE WHEN p.bill_id IS NULL THEN 'Advance / Prepayment Received' ELSE 'Bill Collections' END)
        WHEN l.reference_type = 'voucher' THEN CASE v.voucher_type
          WHEN 'income' THEN 'Other Income'
          WHEN 'security_deposit' THEN 'Security Deposits Received'
          WHEN 'security_deposit_refund' THEN 'Security Deposit Refund Received'
          WHEN 'advance_settlement' THEN 'Advance Settlement Refund'
          WHEN 'contra' THEN 'Internal Transfer (Bank/Cash)'
          WHEN 'withdrawal' THEN 'Internal Transfer (Cash Withdrawal)'
          WHEN 'deposit' THEN 'Internal Transfer (Cash Deposit)'
          ELSE initcap(replace(v.voucher_type, '_', ' '))
        END
        WHEN l.reference_type = 'donation' THEN 'Donations Received'
        WHEN l.reference_type = 'collector_settlement' THEN 'Collector Settlement'
        WHEN l.reference_type = 'manual' THEN 'Manual Entry'
        ELSE 'Other'
      END AS cat,
      SUM(l.debit) AS amt
    FROM ledger_entries l
    JOIN accounts a ON a.id = l.account_id
    LEFT JOIN payments p ON l.reference_type = 'payment' AND p.id = l.reference_id
    LEFT JOIN vouchers v ON l.reference_type = 'voucher' AND v.id = l.reference_id
    WHERE a.system = p_system AND a.type IN ('cash', 'bank') AND l.entry_date BETWEEN v_month_start AND v_month_end AND l.debit > 0
    GROUP BY 1
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('category', x.cat, 'amount', x.amt) ORDER BY x.amt DESC), '[]'::jsonb) INTO v_cash_out_breakdown
  FROM (
    SELECT
      CASE
        WHEN l.reference_type = 'payment' THEN (CASE WHEN p.bill_id IS NULL THEN 'Advance / Prepayment Received' ELSE 'Bill Collections' END)
        WHEN l.reference_type = 'voucher' THEN CASE v.voucher_type
          WHEN 'expense' THEN 'Expenses Paid'
          WHEN 'advance' THEN 'Advance Paid to Worker/Contractor'
          WHEN 'advance_settlement' THEN 'Expenses Paid (Advance Settlement)'
          WHEN 'security_deposit_refund' THEN 'Security Deposit Refunded'
          WHEN 'contra' THEN 'Internal Transfer (Bank/Cash)'
          WHEN 'withdrawal' THEN 'Internal Transfer (Cash Withdrawal)'
          WHEN 'deposit' THEN 'Internal Transfer (Cash Deposit)'
          ELSE initcap(replace(v.voucher_type, '_', ' '))
        END
        WHEN l.reference_type = 'inventory' THEN (CASE WHEN it.txn_type = 'purchase' THEN 'Purchases' ELSE 'Inventory Adjustment' END)
        WHEN l.reference_type = 'collector_settlement' THEN 'Collector Settlement'
        WHEN l.reference_type = 'manual' THEN 'Manual Entry'
        ELSE 'Other'
      END AS cat,
      SUM(l.credit) AS amt
    FROM ledger_entries l
    JOIN accounts a ON a.id = l.account_id
    LEFT JOIN payments p ON l.reference_type = 'payment' AND p.id = l.reference_id
    LEFT JOIN vouchers v ON l.reference_type = 'voucher' AND v.id = l.reference_id
    LEFT JOIN inventory_transactions it ON l.reference_type = 'inventory' AND it.id = l.reference_id
    WHERE a.system = p_system AND a.type IN ('cash', 'bank') AND l.entry_date BETWEEN v_month_start AND v_month_end AND l.credit > 0
    GROUP BY 1
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name', c.complainant_name, 'sector', c.sector, 'text', c.complaint_text,
    'status', c.status, 'incharge_name', au_assigned.full_name,
    'resolved_by_name', au_resolved.full_name, 'resolved_at', c.resolved_at
  ) ORDER BY c.created_at), '[]'::jsonb)
  INTO v_complaints_this_month
  FROM complaints c
  LEFT JOIN admin_users au_assigned ON au_assigned.id = c.assigned_to
  LEFT JOIN admin_users au_resolved ON au_resolved.id = c.resolved_by
  WHERE c.system = p_system AND c.created_at >= v_month_start AND c.created_at < v_month_end_excl;

  -- Check-and-balance: this month's opening cash must equal the previously
  -- reported month's closing cash. A mismatch means a prior-period
  -- transaction was edited/deleted after that month's report was presented.
  SELECT id, this_month_cash, created_at INTO v_prev_report_id, v_prev_report_this_month_cash, v_prev_report_created_at
  FROM monthly_closing_reports WHERE system = p_system AND report_month = v_prev_month AND report_year = v_prev_year;

  IF v_prev_report_id IS NOT NULL THEN
    v_opening_expected := v_prev_report_this_month_cash;
    v_opening_actual := v_prev_month_cash;
    v_opening_mismatch := ABS(COALESCE(v_opening_expected, 0) - v_opening_actual) > 0.01;
    IF v_opening_mismatch THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('summary', summary, 'actor_name', actor_name, 'action', action, 'performed_at', performed_at) ORDER BY performed_at), '[]'::jsonb)
      INTO v_reconciliation_changes
      FROM audit_log
      WHERE system = p_system AND table_name IN ('bills', 'payments', 'vouchers', 'donors')
        AND action IN ('update', 'delete') AND performed_at > v_prev_report_created_at;
    END IF;
  ELSE
    v_opening_expected := NULL;
    v_opening_actual := v_prev_month_cash;
    v_opening_mismatch := false;
  END IF;

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

    SELECT COALESCE(jsonb_agg(jsonb_build_object('consumer_name', pb.cname, 'sector', pb.sector, 'amount', pb.bal) ORDER BY pb.sector, pb.bal DESC), '[]'::jsonb) INTO v_pending_bills_by_consumer
    FROM (
      SELECT c.name cname, COALESCE(c.sector, 'Unassigned') sector, SUM(GREATEST(a.opening_balance + COALESCE(le.net, 0), 0)) bal
      FROM accounts a
      LEFT JOIN LATERAL (SELECT SUM(l.debit - l.credit) net FROM ledger_entries l WHERE l.account_id = a.id) le ON true
      JOIN consumers c ON c.consumer_id = a.consumer_id
      WHERE a.system = 'water_supply' AND a.type = 'consumer'
      GROUP BY c.name, c.sector
      HAVING SUM(GREATEST(a.opening_balance + COALESCE(le.net, 0), 0)) > 0
    ) pb;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'consumer_id', np.consumer_id, 'name', np.name, 'sector', np.sector,
      'complaint_since', np.complaint_since, 'unpaid_since', np.unpaid_since, 'outstanding', np.outstanding
    ) ORDER BY np.complaint_since), '[]'::jsonb) INTO v_non_payers_due_to_complaint
    FROM (
      SELECT c.consumer_id, c.name, c.sector,
        MIN(cm.created_at) AS complaint_since,
        MIN(b.due_date) AS unpaid_since,
        SUM(GREATEST(b.amount_pkr - COALESCE(b.discount_amount, 0) - COALESCE(b.paid_amount, 0), 0)) AS outstanding
      FROM consumers c
      JOIN complaints cm ON cm.consumer_id = c.consumer_id AND cm.status != 'verified'
      JOIN bills b ON b.consumer_id = c.consumer_id
      WHERE (b.amount_pkr - COALESCE(b.discount_amount, 0) - COALESCE(b.paid_amount, 0)) > 0
      GROUP BY c.consumer_id, c.name, c.sector
    ) np;

    -- consumer_nonpayment_flags (064) already detects exactly "2 consecutive
    -- unpaid months" — reused directly, not re-derived.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'consumer_name', c.name, 'sector', f.sector, 'outstanding', f.total_outstanding, 'flagged_since', f.first_flagged_at
    ) ORDER BY f.total_outstanding DESC), '[]'::jsonb) INTO v_two_month_defaulters
    FROM consumer_nonpayment_flags f
    JOIN consumers c ON c.consumer_id = f.consumer_id;

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
    v_pending_bills_by_consumer := '[]'::jsonb;
    v_non_payers_due_to_complaint := '[]'::jsonb;
    v_two_month_defaulters := '[]'::jsonb;

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
  WHERE a.system = p_system AND a.type = 'expense' AND a.code NOT IN ('WS-3008', 'WS-3009')
    AND l.entry_date BETWEEN v_month_start AND v_month_end;

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
    WHERE a.system = p_system AND a.type = 'expense' AND a.code NOT IN ('WS-3008', 'WS-3009')
      AND l.entry_date BETWEEN v_month_start AND v_month_end
    GROUP BY v.id, v.particular

    UNION ALL

    SELECT l.particular AS description, SUM(l.debit - l.credit) AS amount, '[]'::jsonb AS approved_by, false AS auto_posted
    FROM ledger_entries l
    JOIN accounts a ON a.id = l.account_id
    WHERE a.system = p_system AND a.type = 'expense' AND a.code NOT IN ('WS-3008', 'WS-3009')
      AND l.entry_date BETWEEN v_month_start AND v_month_end
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
    'cash_in_breakdown', v_cash_in_breakdown, 'cash_out_breakdown', v_cash_out_breakdown,
    'opening_balance_expected', v_opening_expected, 'opening_balance_actual', v_opening_actual,
    'opening_balance_mismatch', v_opening_mismatch, 'reconciliation_changes', v_reconciliation_changes,
    'prev_month_billing', v_prev_month_billing, 'prev_month_receivable', v_prev_month_receivable,
    'this_month_billed', v_this_month_billed, 'this_month_discount', v_this_month_discount, 'discount_by_consumer', v_discount_by_consumer,
    'this_month_recovery', v_this_month_recovery,
    'total_receivable', v_total_receivable, 'total_payable', v_total_payable,
    'total_pending_bills', v_total_pending_bills, 'pending_by_sector', v_pending_by_sector,
    'pending_bills_by_consumer', v_pending_bills_by_consumer,
    'non_payers_due_to_complaint', v_non_payers_due_to_complaint,
    'two_month_defaulters', v_two_month_defaulters,
    'billing_income', v_billing_income, 'sale_income', v_sale_income,
    'total_expenses', v_total_expenses, 'expense_lines', v_expense_lines,
    'net_surplus', v_net_surplus,
    'complaints_this_month', v_complaints_this_month, 'task_progress', v_task_progress,
    'donor_breakdown', v_donor_breakdown, 'project_progress', v_project_progress
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION regenerate_monthly_closing_report(p_report_id uuid) RETURNS void AS $$
DECLARE
  v_report monthly_closing_reports%ROWTYPE;
  v_data jsonb;
BEGIN
  SELECT * INTO v_report FROM monthly_closing_reports WHERE id = p_report_id;
  IF v_report.id IS NULL THEN RAISE EXCEPTION 'Report not found'; END IF;
  IF NOT can_access_system(v_report.system) OR NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to regenerate this report';
  END IF;

  v_data := compute_monthly_closing_core(v_report.system, v_report.report_month, v_report.report_year);

  UPDATE monthly_closing_reports SET
    new_connections = (v_data->>'new_connections')::int, disconnections = (v_data->>'disconnections')::int, new_connections_detail = v_data->'new_connections_detail',
    prev_month_cash = (v_data->>'prev_month_cash')::decimal, this_month_cash = (v_data->>'this_month_cash')::decimal,
    cash_in = (v_data->>'cash_in')::decimal, cash_out = (v_data->>'cash_out')::decimal,
    cash_in_breakdown = v_data->'cash_in_breakdown', cash_out_breakdown = v_data->'cash_out_breakdown',
    opening_balance_expected = (v_data->>'opening_balance_expected')::decimal, opening_balance_actual = (v_data->>'opening_balance_actual')::decimal,
    opening_balance_mismatch = (v_data->>'opening_balance_mismatch')::boolean, reconciliation_changes = v_data->'reconciliation_changes',
    prev_month_billing = (v_data->>'prev_month_billing')::decimal, prev_month_receivable = (v_data->>'prev_month_receivable')::decimal,
    this_month_billed = (v_data->>'this_month_billed')::decimal, this_month_discount = (v_data->>'this_month_discount')::decimal,
    discount_by_consumer = v_data->'discount_by_consumer', this_month_recovery = (v_data->>'this_month_recovery')::decimal,
    total_receivable = (v_data->>'total_receivable')::decimal, total_payable = (v_data->>'total_payable')::decimal,
    total_pending_bills = (v_data->>'total_pending_bills')::decimal, pending_by_sector = v_data->'pending_by_sector',
    pending_bills_by_consumer = v_data->'pending_bills_by_consumer', non_payers_due_to_complaint = v_data->'non_payers_due_to_complaint',
    two_month_defaulters = v_data->'two_month_defaulters',
    billing_income = (v_data->>'billing_income')::decimal, sale_income = (v_data->>'sale_income')::decimal,
    total_expenses = (v_data->>'total_expenses')::decimal, expense_lines = v_data->'expense_lines',
    net_surplus = (v_data->>'net_surplus')::decimal, complaints_this_month = v_data->'complaints_this_month',
    task_progress = v_data->'task_progress', donor_breakdown = v_data->'donor_breakdown', project_progress = v_data->'project_progress',
    updated_at = now()
  WHERE id = p_report_id;
  -- reconciliation_remarks/non_payers/non_payer_opinions deliberately untouched — human-entered, must survive a regenerate.
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
