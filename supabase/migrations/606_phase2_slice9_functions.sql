-- Phase 2, slice 9 (functions): every function touching only slice-9
-- tables (employees/payroll/monthly-closing), reproduced from the real,
-- current body (pulled live via pg_get_functiondef) with only the minimal
-- tenant-scoping fix applied.
--
-- compute_monthly_closing_core is the entire monthly financial closing
-- report engine -- the single biggest function in the system -- and had
-- NO tenant filter anywhere across its ~25 subqueries (accounts, bills,
-- payments, consumers, connection_requests, donors, projects, complaints,
-- audit_log, consumer_nonpayment_flags, approval_requests). Given a
-- `system` label ('water_supply'/'donors_projects') is shared across
-- every tenant, this would have produced a closing report mixing every
-- tenant's cash, billing, receivables and expenses together. Fixed by
-- adding an explicit `p_tenant_id uuid DEFAULT NULL` parameter (appended
-- as a trailing optional argument so CREATE OR REPLACE doesn't change the
-- call signature for existing callers), resolved via
-- `COALESCE(p_tenant_id, my_tenant_id())`, and threaded into every query.
--
-- run_monthly_closing_report (the nightly cron that calls it) is
-- restructured to loop over every active tenant as well as both systems,
-- passing each tenant's id explicitly (the no-auth-context DEFAULT bug,
-- same class fixed throughout this phase) -- and its `ON CONFLICT
-- (system, report_month, report_year)` target is updated to match the
-- re-keyed `(tenant_id, system, report_month, report_year)` constraint
-- from this slice's schema migration, which it would otherwise no longer
-- match at all.
--
-- edit_voucher let an admin pass a from/to account id belonging to a
-- DIFFERENT tenant that merely shared the same `system` label -- the
-- existing system-match check alone could never catch this, since system
-- names are shared across every tenant by design.
--
-- The remaining functions are the recurring admin-gated-ID-lookup-with-
-- no-tenant-filter bug class from the rest of this phase:
-- edit_employee_payslip_recognition (plus its WS-3011/3012/3013
-- business-key account lookups), regenerate_monthly_closing_report,
-- update_closing_report_non_payer_opinions, update_closing_report_
-- non_payers, update_closing_report_reconciliation_remarks.
--
-- reset_accounting_system is left untouched, consistent with every other
-- reset_* function in this phase (reset_welfare_and_projects_data,
-- reset_operational_data) -- an intentionally platform-wide super-admin
-- reset utility, not a per-tenant concern.

create or replace function public.compute_monthly_closing_core(p_system character varying, p_month integer, p_year integer, p_tenant_id uuid DEFAULT NULL::uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  v_tenant_id uuid := COALESCE(p_tenant_id, my_tenant_id());
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
  WHERE a.system = p_system AND a.type IN ('cash', 'bank') AND a.tenant_id = v_tenant_id;

  SELECT COALESCE(SUM(a.opening_balance + COALESCE(le.net, 0)), 0) INTO v_prev_month_cash
  FROM accounts a
  LEFT JOIN LATERAL (SELECT SUM(l.debit - l.credit) net FROM ledger_entries l WHERE l.account_id = a.id AND l.entry_date <= v_prev_month_end) le ON true
  WHERE a.system = p_system AND a.type IN ('cash', 'bank') AND a.tenant_id = v_tenant_id;

  SELECT COALESCE(SUM(a.opening_balance - COALESCE(le.net, 0)), 0) INTO v_total_payable
  FROM accounts a
  LEFT JOIN LATERAL (SELECT SUM(l.debit - l.credit) net FROM ledger_entries l WHERE l.account_id = a.id) le ON true
  WHERE a.system = p_system AND a.type = 'liability' AND a.tenant_id = v_tenant_id;

  SELECT COALESCE(SUM(l.debit), 0), COALESCE(SUM(l.credit), 0) INTO v_cash_in, v_cash_out
  FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
  WHERE a.system = p_system AND a.type IN ('cash', 'bank') AND a.tenant_id = v_tenant_id AND l.entry_date BETWEEN v_month_start AND v_month_end;

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
    WHERE a.system = p_system AND a.type IN ('cash', 'bank') AND a.tenant_id = v_tenant_id AND l.entry_date BETWEEN v_month_start AND v_month_end AND l.debit > 0
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
    WHERE a.system = p_system AND a.type IN ('cash', 'bank') AND a.tenant_id = v_tenant_id AND l.entry_date BETWEEN v_month_start AND v_month_end AND l.credit > 0
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
  WHERE c.system = p_system AND c.tenant_id = v_tenant_id AND c.created_at >= v_month_start AND c.created_at < v_month_end_excl;

  -- Check-and-balance: this month's opening cash must equal the previously
  -- reported month's closing cash. A mismatch means a prior-period
  -- transaction was edited/deleted after that month's report was presented.
  SELECT id, this_month_cash, created_at INTO v_prev_report_id, v_prev_report_this_month_cash, v_prev_report_created_at
  FROM monthly_closing_reports WHERE system = p_system AND report_month = v_prev_month AND report_year = v_prev_year AND tenant_id = v_tenant_id;

  IF v_prev_report_id IS NOT NULL THEN
    v_opening_expected := v_prev_report_this_month_cash;
    v_opening_actual := v_prev_month_cash;
    v_opening_mismatch := ABS(COALESCE(v_opening_expected, 0) - v_opening_actual) > 0.01;
    IF v_opening_mismatch THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('summary', summary, 'actor_name', actor_name, 'action', action, 'performed_at', performed_at) ORDER BY performed_at), '[]'::jsonb)
      INTO v_reconciliation_changes
      FROM audit_log
      WHERE system = p_system AND tenant_id = v_tenant_id AND table_name IN ('bills', 'payments', 'vouchers', 'donors')
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
    WHERE a.system = 'water_supply' AND a.type = 'consumer' AND a.tenant_id = v_tenant_id;

    SELECT COALESCE(SUM(amount_pkr), 0) INTO v_prev_month_billing FROM bills WHERE month = v_prev_month AND year = v_prev_year AND tenant_id = v_tenant_id;

    SELECT COALESCE(SUM(amount_pkr), 0), COALESCE(SUM(discount_amount), 0) INTO v_this_month_billed, v_this_month_discount
    FROM bills WHERE month = p_month AND year = p_year AND tenant_id = v_tenant_id;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('consumer_name', dc.cname, 'amount', dc.damt) ORDER BY dc.damt DESC), '[]'::jsonb) INTO v_discount_by_consumer
    FROM (
      SELECT c.name cname, SUM(b.discount_amount) damt
      FROM bills b JOIN consumers c ON c.consumer_id = b.consumer_id
      WHERE b.month = p_month AND b.year = p_year AND COALESCE(b.discount_amount, 0) > 0 AND b.tenant_id = v_tenant_id
      GROUP BY c.name
    ) dc;

    SELECT COALESCE(SUM(GREATEST(b.amount_pkr - COALESCE(b.discount_amount, 0) - COALESCE(pd.paid, 0), 0)), 0) INTO v_prev_month_receivable
    FROM bills b
    LEFT JOIN LATERAL (SELECT SUM(pm.amount_pkr) paid FROM payments pm WHERE pm.bill_id = b.id AND pm.paid_date <= v_prev_month_end) pd ON true
    WHERE b.created_at::date <= v_prev_month_end AND b.tenant_id = v_tenant_id;

    SELECT COALESCE(SUM(amount_pkr), 0) INTO v_this_month_recovery FROM payments WHERE paid_date BETWEEN v_month_start AND v_month_end AND tenant_id = v_tenant_id;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('consumer_name', c.name, 'incharge_name', au.full_name, 'activated', cr.status = 'installed') ORDER BY c.created_at), '[]'::jsonb)
    INTO v_new_connections_detail
    FROM consumers c
    JOIN connection_requests cr ON cr.consumer_id = c.consumer_id
    LEFT JOIN admin_users au ON au.id = cr.incharge_user_id
    WHERE c.created_at >= v_month_start AND c.created_at < v_month_end_excl AND c.tenant_id = v_tenant_id;
    v_new_connections := jsonb_array_length(v_new_connections_detail);

    SELECT COUNT(*) INTO v_disconnections FROM consumers WHERE disconnected_at::date BETWEEN v_month_start AND v_month_end AND tenant_id = v_tenant_id;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('request_number', cr.request_number, 'consumer_name', cr.consumer_name, 'sector', cr.sector, 'incharge_name', au.full_name, 'task_status', cr.task_status) ORDER BY cr.task_assigned_at), '[]'::jsonb)
    INTO v_task_progress
    FROM connection_requests cr
    LEFT JOIN admin_users au ON au.id = cr.incharge_user_id
    WHERE ((cr.task_assigned_at >= v_month_start AND cr.task_assigned_at < v_month_end_excl)
       OR (cr.task_done_at >= v_month_start AND cr.task_done_at < v_month_end_excl))
      AND cr.tenant_id = v_tenant_id;

    SELECT COALESCE(SUM(l.credit - l.debit), 0) INTO v_billing_income
    FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
    WHERE a.system = 'water_supply' AND a.code = 'WS-2001' AND a.tenant_id = v_tenant_id AND l.entry_date BETWEEN v_month_start AND v_month_end;

    SELECT COALESCE(SUM(l.credit - l.debit), 0) INTO v_sale_income
    FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
    WHERE a.system = 'water_supply' AND a.code IN ('WS-2002', 'WS-2003', 'WS-2004', 'WS-2005') AND a.tenant_id = v_tenant_id AND l.entry_date BETWEEN v_month_start AND v_month_end;

    v_total_pending_bills := v_total_receivable;

    SELECT COALESCE(jsonb_object_agg(sector, bal), '{}'::jsonb) INTO v_pending_by_sector FROM (
      SELECT COALESCE(c.sector, 'Unassigned') sector, SUM(GREATEST(a.opening_balance + COALESCE(le.net, 0), 0)) bal
      FROM accounts a
      LEFT JOIN LATERAL (SELECT SUM(l.debit - l.credit) net FROM ledger_entries l WHERE l.account_id = a.id) le ON true
      JOIN consumers c ON c.consumer_id = a.consumer_id
      WHERE a.system = 'water_supply' AND a.type = 'consumer' AND a.tenant_id = v_tenant_id
      GROUP BY c.sector
      HAVING SUM(GREATEST(a.opening_balance + COALESCE(le.net, 0), 0)) > 0
    ) s;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('consumer_name', pb.cname, 'sector', pb.sector, 'amount', pb.bal) ORDER BY pb.sector, pb.bal DESC), '[]'::jsonb) INTO v_pending_bills_by_consumer
    FROM (
      SELECT c.name cname, COALESCE(c.sector, 'Unassigned') sector, SUM(GREATEST(a.opening_balance + COALESCE(le.net, 0), 0)) bal
      FROM accounts a
      LEFT JOIN LATERAL (SELECT SUM(l.debit - l.credit) net FROM ledger_entries l WHERE l.account_id = a.id) le ON true
      JOIN consumers c ON c.consumer_id = a.consumer_id
      WHERE a.system = 'water_supply' AND a.type = 'consumer' AND a.tenant_id = v_tenant_id
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
      WHERE (b.amount_pkr - COALESCE(b.discount_amount, 0) - COALESCE(b.paid_amount, 0)) > 0 AND c.tenant_id = v_tenant_id
      GROUP BY c.consumer_id, c.name, c.sector
    ) np;

    -- consumer_nonpayment_flags (064) already detects exactly "2 consecutive
    -- unpaid months" — reused directly, not re-derived.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'consumer_name', c.name, 'sector', f.sector, 'outstanding', f.total_outstanding, 'flagged_since', f.first_flagged_at
    ) ORDER BY f.total_outstanding DESC), '[]'::jsonb) INTO v_two_month_defaulters
    FROM consumer_nonpayment_flags f
    JOIN consumers c ON c.consumer_id = f.consumer_id
    WHERE f.tenant_id = v_tenant_id;

    v_donor_breakdown := '{}'::jsonb;
    v_project_progress := '[]'::jsonb;
  ELSE
    v_total_receivable := 0;
    v_this_month_billed := NULL; v_this_month_discount := NULL; v_discount_by_consumer := '[]'::jsonb;
    SELECT COALESCE(SUM(amount_pkr), 0) INTO v_prev_month_billing FROM donors WHERE date BETWEEN v_prev_month_start AND v_prev_month_end AND tenant_id = v_tenant_id;
    v_prev_month_receivable := 0;
    SELECT COALESCE(SUM(amount_pkr), 0) INTO v_this_month_recovery FROM donors WHERE date BETWEEN v_month_start AND v_month_end AND tenant_id = v_tenant_id;
    v_new_connections := NULL;
    v_disconnections := NULL;
    v_new_connections_detail := '[]'::jsonb;
    v_task_progress := '[]'::jsonb;
    v_pending_bills_by_consumer := '[]'::jsonb;
    v_non_payers_due_to_complaint := '[]'::jsonb;
    v_two_month_defaulters := '[]'::jsonb;

    SELECT COALESCE(SUM(l.credit - l.debit), 0) INTO v_billing_income
    FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
    WHERE a.system = 'donors_projects' AND a.type = 'donor' AND a.tenant_id = v_tenant_id AND l.entry_date BETWEEN v_month_start AND v_month_end;
    v_sale_income := NULL;
    v_total_pending_bills := 0;
    v_pending_by_sector := '{}'::jsonb;

    SELECT jsonb_build_object(
      'by_project', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('title', COALESCE(p.title, '—'), 'total', s.total) ORDER BY s.total DESC)
        FROM (SELECT project_id, SUM(amount_pkr) total FROM donors WHERE date BETWEEN v_month_start AND v_month_end AND tenant_id = v_tenant_id GROUP BY project_id) s
        LEFT JOIN projects p ON p.id = s.project_id
      ), '[]'::jsonb),
      'by_type', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('type', COALESCE(donor_type, 'unspecified'), 'total', total) ORDER BY total DESC)
        FROM (SELECT donor_type, SUM(amount_pkr) total FROM donors WHERE date BETWEEN v_month_start AND v_month_end AND tenant_id = v_tenant_id GROUP BY donor_type) t
      ), '[]'::jsonb)
    ) INTO v_donor_breakdown;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('title', title, 'status', status, 'progress_percent', progress_percent, 'budget_pkr', budget_pkr, 'spent_pkr', spent_pkr) ORDER BY status, title), '[]'::jsonb)
    INTO v_project_progress FROM projects WHERE tenant_id = v_tenant_id;
  END IF;

  SELECT COALESCE(SUM(l.debit - l.credit), 0) INTO v_total_expenses
  FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
  WHERE a.system = p_system AND a.type = 'expense' AND a.code NOT IN ('WS-3008', 'WS-3009') AND a.tenant_id = v_tenant_id
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
        WHERE ar.kind = 'voucher' AND ar.reference_id = v.id AND ar.tenant_id = v_tenant_id
      ), '[]'::jsonb) AS approved_by,
      EXISTS (SELECT 1 FROM approval_requests ar WHERE ar.kind = 'voucher' AND ar.reference_id = v.id AND ar.auto_posted AND ar.tenant_id = v_tenant_id) AS auto_posted
    FROM ledger_entries l
    JOIN accounts a ON a.id = l.account_id
    JOIN vouchers v ON v.id = l.reference_id AND l.reference_type = 'voucher'
    WHERE a.system = p_system AND a.type = 'expense' AND a.code NOT IN ('WS-3008', 'WS-3009') AND a.tenant_id = v_tenant_id
      AND l.entry_date BETWEEN v_month_start AND v_month_end
    GROUP BY v.id, v.particular

    UNION ALL

    SELECT l.particular AS description, SUM(l.debit - l.credit) AS amount, '[]'::jsonb AS approved_by, false AS auto_posted
    FROM ledger_entries l
    JOIN accounts a ON a.id = l.account_id
    WHERE a.system = p_system AND a.type = 'expense' AND a.code NOT IN ('WS-3008', 'WS-3009') AND a.tenant_id = v_tenant_id
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
$function$;

create or replace function public.edit_employee_payslip_recognition(p_payslip_id uuid, p_overtime numeric, p_bonus numeric, p_emergency numeric)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_payslip employee_payslips%ROWTYPE;
  v_voucher vouchers%ROWTYPE;
  v_employee_account_id uuid;
  v_ws3011 uuid; v_ws3012 uuid; v_ws3013 uuid;
  v_new_total decimal;
BEGIN
  IF NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to edit this payslip';
  END IF;

  SELECT * INTO v_payslip FROM employee_payslips WHERE id = p_payslip_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Payslip not found'; END IF;
  IF v_payslip.recognition_voucher_id IS NULL THEN RAISE EXCEPTION 'No recognition voucher to edit — save the payslip first'; END IF;

  SELECT * INTO v_voucher FROM vouchers WHERE id = v_payslip.recognition_voucher_id;
  -- No settles_voucher_id/settled_at matching for employees under this
  -- model (advances net against the running account balance instead) — the
  -- real "already paid" guard is whether a payment voucher for this period
  -- already exists.
  IF EXISTS (SELECT 1 FROM vouchers WHERE employee_id = v_payslip.employee_id AND voucher_type = 'expense'
             AND particular LIKE 'Payslip Payment%' AND voucher_date >= make_date(v_payslip.year, v_payslip.month, 1)
             AND voucher_date < (make_date(v_payslip.year, v_payslip.month, 1) + interval '1 month')) THEN
    RAISE EXCEPTION 'This payslip has already been paid out and cannot be edited';
  END IF;

  v_employee_account_id := ensure_employee_account(v_payslip.employee_id);
  SELECT id INTO v_ws3011 FROM accounts WHERE system = 'water_supply' AND code = 'WS-3011' AND tenant_id = v_payslip.tenant_id;
  SELECT id INTO v_ws3012 FROM accounts WHERE system = 'water_supply' AND code = 'WS-3012' AND tenant_id = v_payslip.tenant_id;
  SELECT id INTO v_ws3013 FROM accounts WHERE system = 'water_supply' AND code = 'WS-3013' AND tenant_id = v_payslip.tenant_id;

  DELETE FROM ledger_entries WHERE reference_type = 'voucher' AND reference_id = v_payslip.recognition_voucher_id;
  -- Keep any job-earning (WS-3014) lines already attached — only the
  -- overtime/bonus/emergency lines are staff-editable on the payslip form.
  DELETE FROM voucher_line_items WHERE voucher_id = v_payslip.recognition_voucher_id
    AND account_id IN (v_ws3011, v_ws3012, v_ws3013);

  IF p_overtime > 0 THEN
    INSERT INTO voucher_line_items (voucher_id, account_id, amount, description)
    VALUES (v_payslip.recognition_voucher_id, v_ws3012, p_overtime, 'Overtime');
  END IF;
  IF p_bonus > 0 THEN
    INSERT INTO voucher_line_items (voucher_id, account_id, amount, description)
    VALUES (v_payslip.recognition_voucher_id, v_ws3011, p_bonus, 'Eid Bonus');
  END IF;
  IF p_emergency > 0 THEN
    INSERT INTO voucher_line_items (voucher_id, account_id, amount, description)
    VALUES (v_payslip.recognition_voucher_id, v_ws3013, p_emergency, 'Emergency Work Payment');
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_new_total FROM voucher_line_items WHERE voucher_id = v_payslip.recognition_voucher_id;

  UPDATE vouchers SET amount_pkr = v_new_total WHERE id = v_payslip.recognition_voucher_id RETURNING * INTO v_voucher;
  UPDATE employee_payslips SET overtime_amount = p_overtime, bonus_amount = p_bonus, emergency_amount = p_emergency, updated_at = now() WHERE id = p_payslip_id;

  IF v_voucher.status = 'posted' THEN
    PERFORM post_voucher_ledger_legs(v_voucher);
  END IF;
END;
$function$;

-- edit_voucher: p_from_account_id/p_to_account_id were only checked for a
-- matching `system` label (shared across every tenant) before now -- an
-- admin could redirect a voucher's legs to another tenant's account that
-- happened to share the same system name.
create or replace function public.edit_voucher(p_voucher_id uuid, p_amount numeric, p_date date, p_particular text, p_party_name character varying, p_from_account_id uuid, p_to_account_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v vouchers%ROWTYPE;
  v_from accounts%ROWTYPE;
  v_to accounts%ROWTYPE;
  v_lines int;
BEGIN
  SELECT * INTO v FROM vouchers WHERE id = p_voucher_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF v.id IS NULL THEN RAISE EXCEPTION 'Voucher not found'; END IF;

  IF NOT can_access_system(v.system) OR NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to edit this voucher';
  END IF;

  -- A voucher still in the approval queue was submitted at a particular amount;
  -- changing it underneath the approvers would defeat the gate. Delete and
  -- re-raise it instead.
  IF v.status IS DISTINCT FROM 'posted' THEN
    RAISE EXCEPTION 'Only a posted voucher can be edited — this one is %', COALESCE(v.status, 'unknown');
  END IF;

  -- Multi-line vouchers derive their total from voucher_line_items; editing the
  -- header amount alone would put the two out of step.
  SELECT count(*) INTO v_lines FROM voucher_line_items WHERE voucher_id = p_voucher_id;
  IF v_lines > 0 THEN
    RAISE EXCEPTION 'This voucher has itemised lines — edit it from the voucher form so the lines and the total stay in step';
  END IF;

  -- System-generated vouchers belong to the document that created them; editing
  -- one here would leave that document describing something that no longer
  -- matches.
  IF EXISTS (SELECT 1 FROM bills WHERE security_deposit_voucher_id = p_voucher_id OR waiver_voucher_id = p_voucher_id)
     OR EXISTS (SELECT 1 FROM connection_requests WHERE employee_charge_voucher_id = p_voucher_id)
     OR EXISTS (SELECT 1 FROM employee_payslips WHERE recognition_voucher_id = p_voucher_id)
     OR EXISTS (SELECT 1 FROM vouchers WHERE settles_voucher_id = p_voucher_id)
  THEN
    RAISE EXCEPTION 'This voucher was generated by another document (a bill, connection, payslip or settlement) — edit that document instead';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be greater than zero'; END IF;
  IF p_from_account_id = p_to_account_id THEN RAISE EXCEPTION 'A voucher cannot move money to the same account it came from'; END IF;

  SELECT * INTO v_from FROM accounts WHERE id = p_from_account_id AND tenant_id = v.tenant_id;
  SELECT * INTO v_to   FROM accounts WHERE id = p_to_account_id AND tenant_id = v.tenant_id;
  IF v_from.id IS NULL OR v_to.id IS NULL THEN RAISE EXCEPTION 'Account not found'; END IF;
  IF v_from.system <> v.system OR v_to.system <> v.system THEN
    RAISE EXCEPTION 'Both accounts must belong to the % system', v.system;
  END IF;

  -- Recorded before the change so the original figures survive the correction.
  INSERT INTO audit_log (table_name, record_id, action, record_data, old_data, system, summary, actor_id, actor_name)
  VALUES (
    'vouchers', v.id, 'update',
    jsonb_build_object('amount_pkr', p_amount, 'voucher_date', p_date, 'particular', p_particular,
                       'party_name', p_party_name, 'from_account_id', p_from_account_id, 'to_account_id', p_to_account_id),
    to_jsonb(v), v.system,
    'Voucher ' || COALESCE(v.voucher_no, '(unnumbered)') || ' edited — Rs. ' || v.amount_pkr || ' → Rs. ' || p_amount,
    current_admin_user_id(), current_admin_name()
  );

  UPDATE vouchers SET
    amount_pkr = p_amount, voucher_date = p_date, particular = p_particular,
    party_name = p_party_name, from_account_id = p_from_account_id, to_account_id = p_to_account_id
  WHERE id = p_voucher_id;

  -- Re-derive the postings. There is no UPDATE trigger on vouchers (only INSERT
  -- and DELETE), which is exactly why editing was never safe to do from the
  -- client: the row would change and the ledger would not follow.
  DELETE FROM ledger_entries WHERE reference_type = 'voucher' AND reference_id = p_voucher_id;
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (p_to_account_id, p_date, p_particular, p_amount, 0, 'voucher', p_voucher_id);
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (p_from_account_id, p_date, p_particular, 0, p_amount, 'voucher', p_voucher_id);
END;
$function$;

create or replace function public.regenerate_monthly_closing_report(p_report_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_report monthly_closing_reports%ROWTYPE;
  v_data jsonb;
BEGIN
  SELECT * INTO v_report FROM monthly_closing_reports WHERE id = p_report_id AND tenant_id = my_tenant_id();
  IF v_report.id IS NULL THEN RAISE EXCEPTION 'Report not found'; END IF;
  IF NOT can_access_system(v_report.system) OR NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to regenerate this report';
  END IF;

  v_data := compute_monthly_closing_core(v_report.system, v_report.report_month, v_report.report_year, v_report.tenant_id);

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
$function$;

-- run_monthly_closing_report: restructured to loop over every active
-- tenant as well as both systems, passing each tenant's id explicitly
-- (the same no-auth-context DEFAULT bug fixed throughout this phase).
-- The ON CONFLICT target is updated to match this slice's re-keyed
-- (tenant_id, system, report_month, report_year) constraint -- the old
-- (system, report_month, report_year) target no longer matches any
-- constraint at all once that migration lands.
create or replace function public.run_monthly_closing_report()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_prev_month_start date := (date_trunc('month', current_date) - interval '1 month')::date;
  v_month int := EXTRACT(MONTH FROM v_prev_month_start)::int;
  v_year int := EXTRACT(YEAR FROM v_prev_month_start)::int;
  v_sys varchar;
  v_tenant record;
  v_data jsonb;
BEGIN
  FOR v_tenant IN SELECT id FROM tenants WHERE is_active LOOP
    FOREACH v_sys IN ARRAY ARRAY['water_supply', 'donors_projects'] LOOP
      v_data := compute_monthly_closing_core(v_sys, v_month, v_year, v_tenant.id);
      INSERT INTO monthly_closing_reports (
        system, report_month, report_year, new_connections, disconnections, new_connections_detail,
        prev_month_cash, this_month_cash, cash_in, cash_out, cash_in_breakdown, cash_out_breakdown,
        opening_balance_expected, opening_balance_actual, opening_balance_mismatch, reconciliation_changes,
        prev_month_billing, prev_month_receivable, this_month_billed, this_month_discount, discount_by_consumer, this_month_recovery,
        total_receivable, total_payable, total_pending_bills, pending_by_sector,
        billing_income, sale_income, total_expenses, expense_lines, net_surplus,
        complaints_this_month, task_progress, donor_breakdown, project_progress, tenant_id
      ) VALUES (
        v_sys, v_month, v_year, (v_data->>'new_connections')::int, (v_data->>'disconnections')::int, v_data->'new_connections_detail',
        (v_data->>'prev_month_cash')::decimal, (v_data->>'this_month_cash')::decimal, (v_data->>'cash_in')::decimal, (v_data->>'cash_out')::decimal,
        v_data->'cash_in_breakdown', v_data->'cash_out_breakdown',
        (v_data->>'opening_balance_expected')::decimal, (v_data->>'opening_balance_actual')::decimal,
        (v_data->>'opening_balance_mismatch')::boolean, v_data->'reconciliation_changes',
        (v_data->>'prev_month_billing')::decimal, (v_data->>'prev_month_receivable')::decimal,
        (v_data->>'this_month_billed')::decimal, (v_data->>'this_month_discount')::decimal, v_data->'discount_by_consumer', (v_data->>'this_month_recovery')::decimal,
        (v_data->>'total_receivable')::decimal, (v_data->>'total_payable')::decimal,
        (v_data->>'total_pending_bills')::decimal, v_data->'pending_by_sector',
        (v_data->>'billing_income')::decimal, (v_data->>'sale_income')::decimal,
        (v_data->>'total_expenses')::decimal, v_data->'expense_lines', (v_data->>'net_surplus')::decimal,
        v_data->'complaints_this_month', v_data->'task_progress', v_data->'donor_breakdown', v_data->'project_progress', v_tenant.id
      )
      ON CONFLICT (tenant_id, system, report_month, report_year) DO UPDATE SET
        new_connections = EXCLUDED.new_connections, disconnections = EXCLUDED.disconnections, new_connections_detail = EXCLUDED.new_connections_detail,
        prev_month_cash = EXCLUDED.prev_month_cash, this_month_cash = EXCLUDED.this_month_cash, cash_in = EXCLUDED.cash_in, cash_out = EXCLUDED.cash_out,
        cash_in_breakdown = EXCLUDED.cash_in_breakdown, cash_out_breakdown = EXCLUDED.cash_out_breakdown,
        opening_balance_expected = EXCLUDED.opening_balance_expected, opening_balance_actual = EXCLUDED.opening_balance_actual,
        opening_balance_mismatch = EXCLUDED.opening_balance_mismatch, reconciliation_changes = EXCLUDED.reconciliation_changes,
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
        -- reconciliation_remarks deliberately excluded — accountant-entered, must survive a re-run.
    END LOOP;
  END LOOP;
END;
$function$;

create or replace function public.update_closing_report_non_payer_opinions(p_report_id uuid, p_opinions jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_system varchar;
BEGIN
  SELECT system INTO v_system FROM monthly_closing_reports WHERE id = p_report_id AND tenant_id = my_tenant_id();
  IF v_system IS NULL THEN RAISE EXCEPTION 'Report not found'; END IF;
  IF NOT can_access_system(v_system) OR NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to edit this report';
  END IF;
  UPDATE monthly_closing_reports SET non_payer_opinions = p_opinions, updated_at = now() WHERE id = p_report_id;
END;
$function$;

create or replace function public.update_closing_report_non_payers(p_report_id uuid, p_non_payers jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_system varchar;
BEGIN
  SELECT system INTO v_system FROM monthly_closing_reports WHERE id = p_report_id AND tenant_id = my_tenant_id();
  IF v_system IS NULL THEN RAISE EXCEPTION 'Report not found'; END IF;
  IF NOT can_access_system(v_system) OR NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to edit this report';
  END IF;
  UPDATE monthly_closing_reports SET non_payers = p_non_payers, updated_at = now() WHERE id = p_report_id;
END;
$function$;

create or replace function public.update_closing_report_reconciliation_remarks(p_report_id uuid, p_remarks text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_system varchar;
BEGIN
  SELECT system INTO v_system FROM monthly_closing_reports WHERE id = p_report_id AND tenant_id = my_tenant_id();
  IF v_system IS NULL THEN RAISE EXCEPTION 'Report not found'; END IF;
  IF NOT can_access_system(v_system) OR NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to edit this report';
  END IF;
  UPDATE monthly_closing_reports SET reconciliation_remarks = p_remarks, updated_at = now() WHERE id = p_report_id;
END;
$function$;
