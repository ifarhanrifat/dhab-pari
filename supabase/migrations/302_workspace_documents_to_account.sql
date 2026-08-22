-- Migration 302: Recent Transactions needs a voucher's "paid to" account
-- (to_account_id) as well as its "paid from" one to lead each voucher row
-- with the two accounts actually involved (e.g. "Office Expense" / "Cash")
-- instead of the generic "Voucher #..." + free-text party name it showed
-- before. get_transactions_workspace_documents() (migration 265, extended
-- by 301 to add from_account_id) still didn't return to_account_id on
-- vouchers; this only adds that one field, nothing else changes.
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
          'security_deposit_amount', b.security_deposit_amount, 'security_deposit_voucher_id', b.security_deposit_voucher_id,
          'recurring_schedule_id', b.recurring_schedule_id
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
        'party_name', v.party_name, 'from_account_id', v.from_account_id, 'to_account_id', v.to_account_id,
        'bill_id', v.bill_id, 'created_at', v.created_at, 'recurring_schedule_id', v.recurring_schedule_id
      ) ORDER BY v.created_at DESC), '[]'::jsonb)
     FROM (SELECT * FROM vouchers WHERE system = p_system AND status IN ('posted', 'approved') ORDER BY created_at DESC LIMIT 50) v),
    'voucher_line_items', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'voucher_id', li.voucher_id, 'account_id', li.account_id, 'description', li.description, 'category', li.category, 'amount', li.amount
      ) ORDER BY li.category), '[]'::jsonb)
     FROM voucher_line_items li
     WHERE li.voucher_id IN (SELECT id FROM vouchers WHERE system = p_system AND status IN ('posted', 'approved') ORDER BY created_at DESC LIMIT 50)),
    'donations', CASE WHEN p_system = 'donors_projects' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', d.id, 'name', d.name, 'name_ur', d.name_ur, 'amount_pkr', d.amount_pkr, 'date', d.date,
          'payment_method', d.payment_method, 'notes', d.notes, 'is_anonymous', d.is_anonymous,
          'is_verified', d.is_verified, 'voucher_no', d.voucher_no, 'created_at', d.created_at,
          'recurring_schedule_id', d.recurring_schedule_id, 'payment_status', d.payment_status
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
       LEFT JOIN inventory_items ii ON ii.id = it.item_id
       WHERE it.purchase_id IN (SELECT id FROM purchases WHERE system = p_system AND status = 'posted' ORDER BY created_at DESC LIMIT 50))
      ELSE '[]'::jsonb END,
    'approval_statuses', (SELECT COALESCE(jsonb_agg(jsonb_build_object('reference_id', ar.reference_id, 'auto_posted', ar.auto_posted)), '[]'::jsonb)
      FROM approval_requests ar WHERE ar.system = p_system AND ar.status = 'posted')
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
