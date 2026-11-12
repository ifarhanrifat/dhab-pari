-- Migration 862: Fleet Reports, Phase 1 of the booking-system overhaul
-- plan — real ask: "what a garbage way of reporting... it would be
-- professional... not just one page, viewable and printable, along
-- with all transaction types, transaction numbers etc." The Reports
-- tab (860) only ever showed monthly aggregates; every one of these
-- line-item RPCs mirrors fleet_commission_settlements' own owner/staff
-- gate exactly, just returning the real underlying rows instead of a
-- SUM. fleet_counter_remittances needs no new RPC — its own RLS
-- (fleet_counter_remittances_owner_read, 855) already lets the owner
-- read it directly, embedded join to fleet_counters included.

CREATE OR REPLACE FUNCTION fleet_expense_transactions(p_fleet_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'txn_no', 'EXP-' || to_char(e.created_at, 'YYMM') || '-' || lpad(row_number() OVER (ORDER BY e.expense_date, e.created_at)::text, 4, '0'),
    'id', e.id, 'expense_date', e.expense_date, 'vehicle_id', e.vehicle_id, 'owner_name', v.owner_name,
    'category', e.category, 'note', e.note, 'amount_pkr', e.amount_pkr
  ) ORDER BY e.expense_date DESC, e.created_at DESC), '[]'::jsonb)
  FROM vehicle_expenses e
  JOIN vehicles v ON v.id = e.vehicle_id
  WHERE v.fleet_id = p_fleet_id AND can_manage_vehicle(e.vehicle_id);
$$;
REVOKE ALL ON FUNCTION fleet_expense_transactions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_expense_transactions(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION fleet_salary_payment_transactions(p_fleet_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'txn_no', 'SAL-' || to_char(p.created_at, 'YYMM') || '-' || lpad(row_number() OVER (ORDER BY p.paid_on, p.created_at)::text, 4, '0'),
    'id', p.id, 'paid_on', p.paid_on, 'full_name', pu.full_name, 'note', p.note, 'amount_pkr', p.amount_pkr
  ) ORDER BY p.paid_on DESC, p.created_at DESC), '[]'::jsonb)
  FROM fleet_staff_salary_payments p
  JOIN fleet_staff fs ON fs.id = p.fleet_staff_id
  JOIN portal_users pu ON pu.id = fs.portal_user_id
  WHERE fs.fleet_id = p_fleet_id
    AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id());
$$;
REVOKE ALL ON FUNCTION fleet_salary_payment_transactions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_salary_payment_transactions(uuid) TO authenticated;

-- Real ledger_entries rows (receipt_no, date, particular, debit/credit)
-- for every fleet vehicle's own account — same read-only, single-
-- account-at-a-time safety fleet_commission_settlements (860) already
-- established; this just skips the SUM/date_trunc aggregation.
CREATE OR REPLACE FUNCTION fleet_commission_ledger_lines(p_fleet_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'txn_no', le.receipt_no, 'id', le.id, 'entry_date', le.entry_date, 'vehicle_id', v.id, 'owner_name', v.owner_name,
    'particular', le.particular, 'debit', le.debit, 'credit', le.credit
  ) ORDER BY le.entry_date DESC, le.created_at DESC), '[]'::jsonb) INTO v_result
  FROM vehicles v
  JOIN ledger_entries le ON le.account_id = ensure_vehicle_account(v.id)
  WHERE v.fleet_id = p_fleet_id AND v.is_active;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION fleet_commission_ledger_lines(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_commission_ledger_lines(uuid) TO authenticated;
