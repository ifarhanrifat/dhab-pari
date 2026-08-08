-- Migration 165: TEMPORARY unguarded debug wrappers for 164's two RPCs —
-- verify real JSON output shape against live data via service role (no
-- real browser session available to test with). Dropped in the very next
-- migration once inspected.
CREATE OR REPLACE FUNCTION _debug_workspace_shell(p_system varchar) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'accounts', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', a.id, 'name', a.name, 'type', a.type, 'code', a.code, 'system', a.system, 'opening_balance', a.opening_balance
      ) ORDER BY a.name), '[]'::jsonb) FROM accounts a WHERE a.is_active = true),
    'ledger_balances_count', (SELECT count(*) FROM ledger_entries),
    'consumers', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('consumer_id', c.consumer_id, 'name', c.name)), '[]'::jsonb) FROM consumers c WHERE c.status = 'active')
      ELSE '[]'::jsonb END,
    'projects', CASE WHEN p_system = 'donors_projects' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', pr.id, 'title', pr.title)), '[]'::jsonb) FROM projects pr)
      ELSE '[]'::jsonb END,
    'pending_approvals_count', (SELECT count(*) FROM approval_requests ar WHERE ar.system = p_system AND ar.status = 'pending'),
    'inventory_items', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', ii.id, 'name', ii.name)), '[]'::jsonb) FROM inventory_items ii WHERE ii.is_active = true)
      ELSE '[]'::jsonb END
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION _debug_workspace_documents(p_system varchar) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'bills', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', b.id, 'bill_number', b.bill_number)), '[]'::jsonb)
       FROM (SELECT * FROM bills ORDER BY created_at DESC LIMIT 50) b)
      ELSE '[]'::jsonb END,
    'payments', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', p.id)), '[]'::jsonb)
       FROM (SELECT * FROM payments ORDER BY created_at DESC LIMIT 50) p)
      ELSE '[]'::jsonb END,
    'vouchers', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', v.id, 'voucher_no', v.voucher_no)), '[]'::jsonb)
       FROM (SELECT * FROM vouchers WHERE system = p_system AND status IN ('posted', 'approved') ORDER BY created_at DESC LIMIT 50) v),
    'donations', CASE WHEN p_system = 'donors_projects' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', d.id, 'voucher_no', d.voucher_no, 'is_verified', d.is_verified)), '[]'::jsonb)
       FROM (SELECT * FROM donors ORDER BY created_at DESC LIMIT 50) d)
      ELSE '[]'::jsonb END,
    'purchases', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', pu.id, 'purchase_number', pu.purchase_number)), '[]'::jsonb)
       FROM (SELECT * FROM purchases WHERE system = p_system AND status = 'posted' ORDER BY created_at DESC LIMIT 50) pu)
      ELSE '[]'::jsonb END,
    'purchase_line_items', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('purchase_id', it.purchase_id, 'item_name', ii.name)), '[]'::jsonb)
       FROM inventory_transactions it LEFT JOIN inventory_items ii ON ii.id = it.item_id
       WHERE it.purchase_id IN (SELECT id FROM purchases WHERE system = p_system AND status = 'posted' ORDER BY created_at DESC LIMIT 50))
      ELSE '[]'::jsonb END,
    'approval_statuses_count', (SELECT count(*) FROM approval_requests ar WHERE ar.system = p_system AND ar.status = 'posted')
  );
$$ LANGUAGE sql STABLE;

GRANT EXECUTE ON FUNCTION _debug_workspace_shell(varchar) TO service_role;
GRANT EXECUTE ON FUNCTION _debug_workspace_documents(varchar) TO service_role;
