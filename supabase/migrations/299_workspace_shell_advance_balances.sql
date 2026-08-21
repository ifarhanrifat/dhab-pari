-- Migration 299: surface each consumer's unapplied advance credit
-- (migration 297) on the Generate Bill / Cash Receipt forms in the
-- Transactions Workspace too, not just on /admin/billing — the same
-- "money already on file, easy to forget" gap applies the moment an
-- accountant is about to create a new bill for that consumer.
--
-- Folded into the existing workspace-shell RPC (migration 164/168) rather
-- than a separate round trip, consistent with why that RPC exists at all —
-- one call instead of the many separate ones this page used to make.
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
    -- Spans both systems for roles allowed both (the account picker's original
    -- intent), but never leaks a book the caller has no access to — mirrors
    -- the accounts_read RLS policy this function bypasses.
    'accounts', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', a.id, 'name', a.name, 'name_ur', a.name_ur, 'type', a.type, 'code', a.code, 'system', a.system, 'opening_balance', a.opening_balance
      ) ORDER BY a.name), '[]'::jsonb) FROM accounts a WHERE a.is_active = true AND can_access_system(a.system)),
    'ledger_balances', (SELECT COALESCE(jsonb_agg(jsonb_build_object('account_id', l.account_id, 'debit', l.debit, 'credit', l.credit)), '[]'::jsonb)
      FROM ledger_entries l WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.id = l.account_id AND can_access_system(a.system))),
    'consumers', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('consumer_id', c.consumer_id, 'name', c.name, 'monthly_rate', c.monthly_rate, 'connections', c.connections) ORDER BY c.name), '[]'::jsonb)
       FROM consumers c WHERE c.status = 'active')
      ELSE '[]'::jsonb END,
    'advance_balances', CASE WHEN p_system = 'water_supply' THEN get_consumer_advance_balances() ELSE '{}'::jsonb END,
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
