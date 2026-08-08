-- Migration 168: SECURITY-CRITICAL FIX to the performance RPCs added today
-- (160/164/166).
--
-- Those functions are SECURITY DEFINER, which BYPASSES row-level security.
-- The client code they replaced used ordinary .from() queries, which went
-- THROUGH RLS and were therefore silently filtered per-role:
--   accounts_read      -> USING (can_access_system(system))      (014)
--   ledger_entries_read-> joins accounts, can_access_system()    (014)
--   complaints_read    -> USING (can_access_system(system))      (063)
-- Moving the same queries inside SECURITY DEFINER removed that filtering,
-- so a water_accountant loading the Transactions Workspace would receive
-- every donors_projects account (name + opening_balance) and every ledger
-- entry from both books, and the Meetings page would return complaints from
-- both systems. No UI displayed the donor accounts directly, but the data
-- was in the response payload — a real cross-system leak either way.
--
-- Fix: re-apply the same predicate the RLS policies use, explicitly, inside
-- each function. Behaviour for super_admin/admin/viewer is unchanged (their
-- can_access_system() returns true for both systems), so the account picker
-- still spans both books for the roles that were always meant to see both.

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

-- Same fix for the Meetings page's complaints panel (complaints_read RLS).
CREATE OR REPLACE FUNCTION get_meetings_core_data() RETURNS jsonb AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN jsonb_build_object(
    'meetings', (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.meeting_date DESC), '[]'::jsonb) FROM agenda_meetings m),
    'members', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'name_ur', c.name_ur, 'position', c.position, 'position_ur', c.position_ur,
        'phone', c.phone, 'admin_user_id', c.admin_user_id, 'proxy_admin_user_id', c.proxy_admin_user_id,
        'uses_smartphone', c.uses_smartphone, 'handles_non_whatsapp_notice', c.handles_non_whatsapp_notice
      ) ORDER BY c.display_order), '[]'::jsonb) FROM committee_members c),
    'admin_users', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', a.id, 'full_name', a.full_name) ORDER BY a.full_name), '[]'::jsonb) FROM admin_users a WHERE a.is_active = true),
    'items', (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.display_order), '[]'::jsonb) FROM agenda_items i),
    'assignees', (SELECT COALESCE(jsonb_agg(to_jsonb(ai)), '[]'::jsonb) FROM agenda_item_assignees ai),
    'complaints', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', co.id, 'complaint_number', co.complaint_number, 'complainant_name', co.complainant_name, 'sector', co.sector,
        'complaint_text', co.complaint_text, 'status', co.status, 'assigned_to', co.assigned_to, 'resolved_by', co.resolved_by,
        'resolved_at', co.resolved_at, 'created_at', co.created_at,
        'incharge_name', au1.full_name, 'resolved_by_name', au2.full_name
      ) ORDER BY co.created_at DESC), '[]'::jsonb)
      FROM complaints co
      LEFT JOIN admin_users au1 ON au1.id = co.assigned_to
      LEFT JOIN admin_users au2 ON au2.id = co.resolved_by
      WHERE can_access_system(co.system)
    ),
    'current_admin_id', (SELECT id FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
