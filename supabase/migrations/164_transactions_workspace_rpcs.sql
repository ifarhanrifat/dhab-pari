-- Migration 164: fold the Transactions Workspace page's load() from 15+
-- separate round trips down to 2 RPCs — same pattern as migration 160 for
-- Meetings. Deliberately does NOT re-derive any of the card-building/badge/
-- folding logic in SQL (that stays exactly as-is in the client, pure JS
-- over already-fetched rows, zero further queries) — these two functions
-- only replace WHERE the raw rows come from, with identical field names/
-- shapes to what each individual .from() call selected today, so the
-- existing transformation code needs no behavioral changes, only a
-- different data source.
--
-- 1. get_transactions_workspace_shell(p_system) — accounts (spans both
--    systems, unchanged), ledger balances, consumers/projects, pending
--    approvals, inventory/service items, default connection-template items
--    (8-9 queries -> 1).
-- 2. get_transactions_workspace_documents(p_system) — bills, payments,
--    vouchers, donations, purchases (+ their line items), posted-approval
--    statuses (6-7 queries -> 1).

CREATE OR REPLACE FUNCTION get_transactions_workspace_shell(p_system varchar) RETURNS jsonb AS $$
DECLARE
  v_default_template_id uuid;
BEGIN
  IF NOT can_access_system(p_system) THEN
    RAISE EXCEPTION 'Not authorized for this system';
  END IF;

  IF p_system = 'water_supply' THEN
    SELECT id INTO v_default_template_id FROM connection_templates WHERE system = 'water_supply' AND is_default = true LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    -- Not scoped to p_system — the account picker shows the whole chart of
    -- accounts (both systems), same as the original unfiltered query.
    'accounts', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', a.id, 'name', a.name, 'name_ur', a.name_ur, 'type', a.type, 'code', a.code, 'system', a.system, 'opening_balance', a.opening_balance
      ) ORDER BY a.name), '[]'::jsonb) FROM accounts a WHERE a.is_active = true),
    'ledger_balances', (SELECT COALESCE(jsonb_agg(jsonb_build_object('account_id', l.account_id, 'debit', l.debit, 'credit', l.credit)), '[]'::jsonb) FROM ledger_entries l),
    'consumers', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('consumer_id', c.consumer_id, 'name', c.name, 'monthly_rate', c.monthly_rate, 'connections', c.connections) ORDER BY c.name), '[]'::jsonb)
       FROM consumers c WHERE c.status = 'active')
      ELSE '[]'::jsonb END,
    'projects', CASE WHEN p_system = 'donors_projects' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', pr.id, 'title', pr.title) ORDER BY pr.title), '[]'::jsonb) FROM projects pr)
      ELSE '[]'::jsonb END,
    'pending_approvals', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', ar.id, 'kind', ar.kind, 'particular', ar.particular, 'amount_pkr', ar.amount_pkr, 'created_at', ar.created_at
      ) ORDER BY ar.created_at DESC), '[]'::jsonb) FROM approval_requests ar WHERE ar.system = p_system AND ar.status = 'pending'),
    'inventory_items', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', ii.id, 'name', ii.name, 'unit_price', ii.unit_price, 'unit_cost', ii.unit_cost, 'unit', ii.unit) ORDER BY ii.name), '[]'::jsonb)
       FROM inventory_items ii WHERE ii.is_active = true)
      ELSE '[]'::jsonb END,
    'service_items', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', si.id, 'name', si.name, 'charge_amount', si.charge_amount) ORDER BY si.name), '[]'::jsonb)
       FROM service_items si WHERE si.is_active = true)
      ELSE '[]'::jsonb END,
    'default_template_items', CASE WHEN v_default_template_id IS NOT NULL THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'item_type', cti.item_type, 'inventory_item_id', cti.inventory_item_id, 'service_item_id', cti.service_item_id, 'quantity', cti.quantity
        )), '[]'::jsonb) FROM connection_template_items cti WHERE cti.template_id = v_default_template_id)
      ELSE '[]'::jsonb END
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION get_transactions_workspace_shell(varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_transactions_workspace_shell(varchar) TO authenticated;

CREATE OR REPLACE FUNCTION get_transactions_workspace_documents(p_system varchar) RETURNS jsonb AS $$
BEGIN
  IF NOT can_access_system(p_system) THEN
    RAISE EXCEPTION 'Not authorized for this system';
  END IF;

  RETURN jsonb_build_object(
    'bills', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', b.id, 'bill_number', b.bill_number, 'consumer_id', b.consumer_id, 'month', b.month, 'year', b.year,
          'amount_pkr', b.amount_pkr, 'discount_amount', b.discount_amount, 'paid_amount', b.paid_amount,
          'due_date', b.due_date, 'description', b.description, 'created_at', b.created_at,
          'security_deposit_amount', b.security_deposit_amount, 'security_deposit_voucher_id', b.security_deposit_voucher_id
        ) ORDER BY b.created_at DESC), '[]'::jsonb)
       FROM (SELECT * FROM bills ORDER BY created_at DESC LIMIT 50) b)
      ELSE '[]'::jsonb END,
    'payments', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', p.id, 'bill_id', p.bill_id, 'consumer_id', p.consumer_id, 'amount_pkr', p.amount_pkr, 'method', p.method,
          'paid_date', p.paid_date, 'receipt_no', p.receipt_no, 'note', p.note, 'created_at', p.created_at
        ) ORDER BY p.created_at DESC), '[]'::jsonb)
       FROM (SELECT * FROM payments ORDER BY created_at DESC LIMIT 50) p)
      ELSE '[]'::jsonb END,
    'vouchers', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', v.id, 'voucher_type', v.voucher_type, 'voucher_no', v.voucher_no, 'receipt_no', v.receipt_no,
        'voucher_date', v.voucher_date, 'particular', v.particular, 'amount_pkr', v.amount_pkr,
        'party_name', v.party_name, 'bill_id', v.bill_id, 'created_at', v.created_at
      ) ORDER BY v.created_at DESC), '[]'::jsonb)
     FROM (SELECT * FROM vouchers WHERE system = p_system AND status IN ('posted', 'approved') ORDER BY created_at DESC LIMIT 50) v),
    'donations', CASE WHEN p_system = 'donors_projects' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', d.id, 'name', d.name, 'name_ur', d.name_ur, 'amount_pkr', d.amount_pkr, 'date', d.date,
          'payment_method', d.payment_method, 'notes', d.notes, 'is_anonymous', d.is_anonymous,
          'is_verified', d.is_verified, 'voucher_no', d.voucher_no, 'created_at', d.created_at
        ) ORDER BY d.created_at DESC), '[]'::jsonb)
       FROM (SELECT * FROM donors ORDER BY created_at DESC LIMIT 50) d)
      ELSE '[]'::jsonb END,
    'purchases', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', pu.id, 'vendor', pu.vendor, 'purchase_date', pu.purchase_date, 'method', pu.method, 'note', pu.note,
          'attachment_url', pu.attachment_url, 'purchase_number', pu.purchase_number, 'created_at', pu.created_at
        ) ORDER BY pu.created_at DESC), '[]'::jsonb)
       FROM (SELECT * FROM purchases WHERE system = p_system AND status = 'posted' ORDER BY created_at DESC LIMIT 50) pu)
      ELSE '[]'::jsonb END,
    'purchase_line_items', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'purchase_id', it.purchase_id, 'quantity', it.quantity, 'unit_cost_at_time', it.unit_cost_at_time, 'item_name', ii.name
        )), '[]'::jsonb)
       FROM inventory_transactions it
       LEFT JOIN inventory_items ii ON ii.id = it.inventory_item_id
       WHERE it.purchase_id IN (SELECT id FROM purchases WHERE system = p_system AND status = 'posted' ORDER BY created_at DESC LIMIT 50))
      ELSE '[]'::jsonb END,
    'approval_statuses', (SELECT COALESCE(jsonb_agg(jsonb_build_object('reference_id', ar.reference_id, 'auto_posted', ar.auto_posted)), '[]'::jsonb)
      FROM approval_requests ar WHERE ar.system = p_system AND ar.status = 'posted')
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION get_transactions_workspace_documents(varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_transactions_workspace_documents(varchar) TO authenticated;
