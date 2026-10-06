-- Phase 1, function pass 1/2: the financial posting engine. RLS doesn't
-- apply to SECURITY DEFINER functions at all — every function below was
-- read in full (all 113 "pure phase-1" candidates from the earlier
-- classification) and this migration fixes the ones that actually touch
-- another tenant's rows if left alone. Three real bug classes found:
--
-- 1. Trigger-posted ledger entries (trg_bill_ledger, trg_payment_ledger,
--    trg_inventory_txn_apply, post_pool_voucher_legs, waive_bill,
--    kafalat_post_requirement_delta, wazifa_post_requirement_delta) never
--    set tenant_id on the ledger_entries rows they insert — relying on
--    the DEFAULT coalesce(my_tenant_id(), <dhab-pari>), which is WRONG
--    whenever the posting row's own tenant isn't the caller's (e.g. a
--    pg_cron job has no auth.uid() at all, so my_tenant_id() always falls
--    through to the hardcoded default regardless of which tenant the row
--    actually belongs to). Fixed by setting tenant_id explicitly from the
--    row already being posted (NEW.tenant_id) rather than trusting the
--    default — correct regardless of who or what triggered the write.
--
-- 2. Chart-of-account lookups by code ('WS-2001', 'DP-4002', etc.) with no
--    tenant filter. Account codes are unique per (tenant_id, code,
--    system) as of migration 566 — a bare WHERE code = 'WS-2001' can
--    silently match a DIFFERENT tenant's account the moment one exists,
--    posting real money into the wrong tenant's books. Fixed by filtering
--    on the posting row's own tenant.
--
-- 3. run_recurring_schedule — the pg_cron-driven engine behind every
--    recurring water bill and donation — inserts into bills/donors/
--    vouchers with no tenant_id at all, same no-auth-context DEFAULT
--    problem as #1. Fixed by using the schedule row's own tenant_id
--    (recurring_schedules.tenant_id), which is already correct.
--
-- Nothing here changes behavior for Dhab Pari today — there is only one
-- tenant, so "this row's tenant_id" and "the hardcoded default" are
-- currently the same value everywhere. It only matters the moment a
-- second tenant's data exists.

create or replace function public.next_voucher_no(p_system character varying, p_type character varying)
 returns character varying
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_prefix varchar;
  v_serial int;
  v_tenant uuid := coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
BEGIN
  UPDATE voucher_counters SET next_serial = next_serial + 1
  WHERE tenant_id = v_tenant AND system = p_system AND voucher_type = p_type
  RETURNING prefix, next_serial - 1 INTO v_prefix, v_serial;
  IF v_prefix IS NULL THEN
    RAISE EXCEPTION 'No voucher counter for %/%', p_system, p_type;
  END IF;
  RETURN v_prefix || '-' || lpad(v_serial::text, 4, '0');
END;
$function$;

create or replace function public.run_recurring_schedule(p_schedule_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  s recurring_schedules%ROWTYPE;
  v_new_id uuid;
  v_next timestamptz;
  v_due_date date;
  v_complaint record;
  v_project varchar;
  v_local timestamp;
BEGIN
  SELECT * INTO s FROM recurring_schedules
  WHERE id = p_schedule_id AND is_active = true AND next_run_date <= now()
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  v_local := s.next_run_date AT TIME ZONE 'Asia/Karachi';
  v_due_date := make_date(EXTRACT(YEAR FROM v_local)::int, EXTRACT(MONTH FROM v_local)::int, 7);

  IF s.schedule_type = 'bill' THEN
    INSERT INTO bills (consumer_id, month, year, amount_pkr, discount_amount, due_date, description, recurring_schedule_id, tenant_id)
    VALUES (s.consumer_id, EXTRACT(MONTH FROM v_local)::int, EXTRACT(YEAR FROM v_local)::int,
            s.amount_pkr, s.discount_amount, v_due_date, s.particular, s.id, s.tenant_id)
    ON CONFLICT (consumer_id, month, year) DO NOTHING
    RETURNING id INTO v_new_id;

    IF v_new_id IS NOT NULL THEN
      FOR v_complaint IN
        SELECT id FROM complaints WHERE system = 'water_supply' AND consumer_id = s.consumer_id AND status != 'verified' AND waiver_active = true
      LOOP
        PERFORM apply_complaint_waiver_to_bill(v_new_id, v_complaint.id);
      END LOOP;
    END IF;

  ELSIF s.schedule_type = 'donation' THEN
    INSERT INTO donors (
      name, name_ur, phone, donor_type, amount_pkr, date, payment_method, project_id,
      is_verified, is_anonymous, recurring_schedule_id, submitted_via,
      portal_user_id, payment_status, tenant_id
    )
    VALUES (
      s.donor_name, s.donor_name_ur, s.donor_phone, s.donor_type, s.amount_pkr, v_local::date,
      s.payment_method, s.project_id,
      s.created_by_portal_user_id IS NULL, false, s.id,
      CASE WHEN s.created_by_portal_user_id IS NULL THEN 'staff' ELSE 'public' END,
      s.created_by_portal_user_id,
      CASE WHEN s.created_by_portal_user_id IS NULL THEN 'paid' ELSE 'pledged' END,
      s.tenant_id
    )
    RETURNING id INTO v_new_id;

    IF v_new_id IS NOT NULL AND s.created_by_portal_user_id IS NULL THEN
      PERFORM assign_donor_numbers_internal(v_new_id);
    END IF;

    IF v_new_id IS NOT NULL AND s.created_by_portal_user_id IS NOT NULL THEN
      SELECT title INTO v_project FROM projects WHERE id = s.project_id;
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (
        s.created_by_portal_user_id, 'recurring_due',
        'Your monthly donation is due',
        'Rs. ' || trim(to_char(s.amount_pkr, 'FM999999999990')) ||
          COALESCE(' for ' || v_project, '') ||
          ' — announced on ' || to_char(v_local, 'DD/MM/YYYY') || '. Open My Giving to pay.',
        '/portal/statement'
      );
    END IF;

  ELSIF s.schedule_type = 'expense' THEN
    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name, recurring_schedule_id, tenant_id)
    VALUES (s.system, 'expense', v_local::date, COALESCE(s.particular, 'Recurring expense'), s.amount_pkr,
            s.from_account_id, s.to_account_id, s.party_name, s.id, s.tenant_id)
    RETURNING id INTO v_new_id;
  END IF;

  v_next := CASE s.frequency
    WHEN 'every_minute' THEN s.next_run_date + INTERVAL '1 minute'
    WHEN 'daily' THEN s.next_run_date + INTERVAL '1 day'
    WHEN 'weekly' THEN s.next_run_date + INTERVAL '7 days'
    WHEN 'monthly' THEN s.next_run_date + INTERVAL '1 month'
    WHEN 'semi_annual' THEN s.next_run_date + INTERVAL '6 months'
    WHEN 'yearly' THEN s.next_run_date + INTERVAL '1 year'
  END;

  UPDATE recurring_schedules SET
    next_run_date = v_next,
    last_run_at = now(),
    last_generated_type = s.schedule_type,
    last_generated_id = v_new_id
  WHERE id = p_schedule_id;
END;
$function$;

create or replace function public.trg_bill_ledger()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_account_id uuid;
  v_income_account_id uuid;
  v_sales_account_id uuid;
  v_discount_bills_account_id uuid;
  v_discount_sale_account_id uuid;
  v_particular text;
  v_other_charges_total decimal;
  v_inv_service_total decimal;
  v_inventory_total decimal;
  v_income_credit decimal;
  v_discountable_total decimal;
  v_discount_sale decimal;
  v_discount_bills decimal;
  r RECORD;
BEGIN
  v_account_id := ensure_consumer_account(NEW.consumer_id);
  v_particular := 'Water Bill #' || NEW.bill_number || ' - ' || to_char(make_date(NEW.year, NEW.month, 1), 'FMMonth YYYY')
    || CASE WHEN NEW.description IS NOT NULL AND trim(NEW.description) != '' THEN ' — ' || NEW.description ELSE '' END;

  DELETE FROM ledger_entries WHERE reference_type = 'bill' AND reference_id = NEW.id;

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, tenant_id)
  VALUES (v_account_id, make_date(NEW.year, NEW.month, 1), v_particular, NEW.amount_pkr, 0, 'bill', NEW.id, NEW.bill_number, NEW.tenant_id);

  SELECT COALESCE(SUM(line_total), 0) INTO v_other_charges_total
  FROM bill_line_items WHERE bill_id = NEW.id AND item_type = 'other_charge';

  FOR r IN
    SELECT charge_account_id, SUM(line_total) AS amt FROM bill_line_items
    WHERE bill_id = NEW.id AND item_type = 'other_charge' AND charge_account_id IS NOT NULL
    GROUP BY charge_account_id
  LOOP
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, tenant_id)
    VALUES (r.charge_account_id, make_date(NEW.year, NEW.month, 1), v_particular, 0, r.amt, 'bill', NEW.id, NEW.bill_number, NEW.tenant_id);
  END LOOP;

  SELECT COALESCE(SUM(line_total), 0) INTO v_inv_service_total
  FROM bill_line_items WHERE bill_id = NEW.id AND item_type IN ('inventory', 'service');

  SELECT COALESCE(SUM(line_total), 0) INTO v_inventory_total
  FROM bill_line_items WHERE bill_id = NEW.id AND item_type = 'inventory';

  IF v_inv_service_total > 0 THEN
    SELECT id INTO v_sales_account_id FROM accounts WHERE tenant_id = NEW.tenant_id AND system = 'water_supply' AND code = 'WS-2003';
    IF v_sales_account_id IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, tenant_id)
      VALUES (v_sales_account_id, make_date(NEW.year, NEW.month, 1), v_particular, 0, v_inv_service_total, 'bill', NEW.id, NEW.bill_number, NEW.tenant_id);
    END IF;
  END IF;

  v_income_credit := NEW.amount_pkr - v_other_charges_total - v_inv_service_total;
  IF v_income_credit > 0 THEN
    SELECT id INTO v_income_account_id FROM accounts WHERE tenant_id = NEW.tenant_id AND system = 'water_supply' AND code = 'WS-2001';
    IF v_income_account_id IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, tenant_id)
      VALUES (v_income_account_id, make_date(NEW.year, NEW.month, 1), v_particular, 0, v_income_credit, 'bill', NEW.id, NEW.bill_number, NEW.tenant_id);
    END IF;
  END IF;

  IF COALESCE(NEW.discount_amount, 0) > 0 THEN
    v_discountable_total := NEW.amount_pkr - v_other_charges_total;
    IF v_discountable_total > 0 AND v_inventory_total > 0 THEN
      v_discount_sale := ROUND(NEW.discount_amount * v_inventory_total / v_discountable_total, 2);
    ELSE
      v_discount_sale := 0;
    END IF;
    v_discount_bills := NEW.discount_amount - v_discount_sale;

    IF v_discount_sale > 0 THEN
      SELECT id INTO v_discount_sale_account_id FROM accounts WHERE tenant_id = NEW.tenant_id AND system = 'water_supply' AND code = 'WS-3009';
      IF v_discount_sale_account_id IS NOT NULL THEN
        INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, tenant_id)
        VALUES (v_discount_sale_account_id, make_date(NEW.year, NEW.month, 1), 'Discount on Sale — Bill #' || NEW.bill_number, v_discount_sale, 0, 'bill', NEW.id, NEW.bill_number, NEW.tenant_id);
        INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, tenant_id)
        VALUES (v_account_id, make_date(NEW.year, NEW.month, 1), 'Discount on Sale — Bill #' || NEW.bill_number, 0, v_discount_sale, 'bill', NEW.id, NEW.bill_number, NEW.tenant_id);
      END IF;
    END IF;

    IF v_discount_bills > 0 THEN
      SELECT id INTO v_discount_bills_account_id FROM accounts WHERE tenant_id = NEW.tenant_id AND system = 'water_supply' AND code = 'WS-3008';
      IF v_discount_bills_account_id IS NOT NULL THEN
        INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, tenant_id)
        VALUES (v_discount_bills_account_id, make_date(NEW.year, NEW.month, 1), 'Discount on Bills — Bill #' || NEW.bill_number, v_discount_bills, 0, 'bill', NEW.id, NEW.bill_number, NEW.tenant_id);
        INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, tenant_id)
        VALUES (v_account_id, make_date(NEW.year, NEW.month, 1), 'Discount on Bills — Bill #' || NEW.bill_number, 0, v_discount_bills, 'bill', NEW.id, NEW.bill_number, NEW.tenant_id);
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

create or replace function public.trg_payment_ledger()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_account_id uuid;
  v_cash_account_id uuid;
  v_bill bills%ROWTYPE;
  v_total_paid decimal;
  v_net_payable decimal;
  v_status_note text;
  v_particular text;
  v_collector_name varchar;
BEGIN
  IF NEW.receipt_no IS NULL THEN
    NEW.receipt_no := next_receipt_no();
  END IF;
  v_account_id := ensure_consumer_account(NEW.consumer_id);

  IF NEW.collected_by IS NOT NULL THEN
    SELECT full_name INTO v_collector_name FROM admin_users WHERE id = NEW.collected_by;
  END IF;

  IF NEW.bill_id IS NULL THEN
    v_particular := 'Advance / Prepayment received (' || NEW.method || ')'
      || CASE WHEN v_collector_name IS NOT NULL THEN ' via collector ' || v_collector_name ELSE '' END
      || CASE WHEN NEW.note IS NOT NULL AND trim(NEW.note) != '' THEN ' — ' || NEW.note ELSE '' END;
  ELSE
    SELECT * INTO v_bill FROM bills WHERE id = NEW.bill_id;
    SELECT COALESCE(SUM(amount_pkr), 0) + NEW.amount_pkr INTO v_total_paid
      FROM payments WHERE bill_id = NEW.bill_id;
    v_net_payable := v_bill.amount_pkr - COALESCE(v_bill.discount_amount, 0);

    v_status_note := CASE
      WHEN v_total_paid >= v_net_payable THEN 'Bill Paid in Full'
      ELSE 'Partial Payment — Rs. ' || to_char(v_net_payable - v_total_paid, 'FM999999990.00') || ' remaining'
    END;

    v_particular := 'Payment received (' || NEW.method || ')'
      || CASE WHEN v_collector_name IS NOT NULL THEN ' via collector ' || v_collector_name ELSE '' END
      || ' — Bill #' || v_bill.bill_number || ' — ' || v_status_note
      || CASE WHEN NEW.note IS NOT NULL AND trim(NEW.note) != '' THEN ' — ' || NEW.note ELSE '' END;
  END IF;

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, receipt_no, tenant_id)
  VALUES (v_account_id, NEW.paid_date, v_particular, 0, NEW.amount_pkr, 'payment', NEW.id, v_bill.bill_number, NEW.receipt_no, NEW.tenant_id);

  IF NEW.collected_by IS NOT NULL THEN
    v_cash_account_id := ensure_collector_account(NEW.collected_by);
  ELSE
    SELECT id INTO v_cash_account_id FROM accounts
    WHERE tenant_id = NEW.tenant_id AND system = 'water_supply' AND code = (CASE WHEN NEW.method = 'cash' THEN 'WS-1001' ELSE 'WS-1002' END);
  END IF;
  IF v_cash_account_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, receipt_no, tenant_id)
    VALUES (v_cash_account_id, NEW.paid_date, v_particular, NEW.amount_pkr, 0, 'payment', NEW.id, v_bill.bill_number, NEW.receipt_no, NEW.tenant_id);
  END IF;

  IF NEW.bill_id IS NOT NULL THEN
    UPDATE bills SET
      paid_amount = v_total_paid,
      status = CASE WHEN v_total_paid >= v_net_payable THEN 'paid'
                    WHEN v_total_paid > 0 THEN 'partial'
                    ELSE v_bill.status END,
      paid_date = NEW.paid_date,
      payment_method = NEW.method
    WHERE id = NEW.bill_id;
  END IF;

  RETURN NEW;
END;
$function$;

create or replace function public.trg_inventory_txn_apply()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_item inventory_items%ROWTYPE;
  v_stock_account_id uuid;
  v_cogs_account_id uuid;
  v_cash_account_id uuid;
  v_system varchar;
  v_particular text;
  v_bill_number varchar;
  v_txn_cost decimal;
  v_new_avg_cost decimal;
BEGIN
  SELECT * INTO v_item FROM inventory_items WHERE id = NEW.item_id FOR UPDATE;
  IF NEW.txn_type = 'usage' AND v_item.quantity_on_hand + NEW.quantity < 0 THEN
    RAISE EXCEPTION 'Insufficient stock for %: % on hand, % requested', v_item.name, v_item.quantity_on_hand, -NEW.quantity;
  END IF;

  IF NEW.txn_type = 'purchase' THEN
    v_txn_cost := COALESCE(NEW.unit_cost_at_time, v_item.unit_cost);
    IF (v_item.quantity_on_hand + NEW.quantity) > 0 THEN
      v_new_avg_cost := (v_item.quantity_on_hand * v_item.unit_cost + NEW.quantity * v_txn_cost) / (v_item.quantity_on_hand + NEW.quantity);
    ELSE
      v_new_avg_cost := v_txn_cost;
    END IF;
    UPDATE inventory_items SET quantity_on_hand = quantity_on_hand + NEW.quantity, unit_cost = v_new_avg_cost WHERE id = NEW.item_id;
  ELSE
    v_txn_cost := COALESCE(NEW.unit_cost_at_time, v_item.unit_cost);
    UPDATE inventory_items SET quantity_on_hand = quantity_on_hand + NEW.quantity WHERE id = NEW.item_id;
  END IF;

  v_system := v_item.system;
  SELECT id INTO v_stock_account_id FROM accounts WHERE tenant_id = NEW.tenant_id AND system = v_system AND code = (CASE WHEN v_system = 'water_supply' THEN 'WS-4002' ELSE 'DP-4002' END);

  IF NEW.reference_type = 'bill' AND NEW.reference_id IS NOT NULL THEN
    SELECT bill_number INTO v_bill_number FROM bills WHERE id = NEW.reference_id;
  END IF;

  IF NEW.txn_type = 'purchase' THEN
    v_particular := 'Inventory purchase — ' || v_item.name || ' x' || NEW.quantity || ' ' || v_item.unit;
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, tenant_id)
    VALUES (v_stock_account_id, NEW.txn_date, v_particular, NEW.quantity * v_txn_cost, 0, 'inventory', NEW.id, v_bill_number, NEW.tenant_id);

    SELECT id INTO v_cash_account_id FROM accounts
    WHERE tenant_id = NEW.tenant_id AND system = v_system AND code = (CASE WHEN v_system = 'water_supply' THEN
      (CASE WHEN NEW.method = 'bank' THEN 'WS-1002' ELSE 'WS-1001' END)
    ELSE
      (CASE WHEN NEW.method = 'bank' THEN 'DP-1002' ELSE 'DP-1001' END)
    END);
    IF v_cash_account_id IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, tenant_id)
      VALUES (v_cash_account_id, NEW.txn_date, v_particular, 0, NEW.quantity * v_txn_cost, 'inventory', NEW.id, v_bill_number, NEW.tenant_id);
    END IF;

  ELSIF NEW.txn_type IN ('usage', 'adjustment') AND NEW.quantity < 0 THEN
    v_particular := 'Inventory issued — ' || v_item.name || ' x' || (-NEW.quantity) || ' ' || v_item.unit;
    SELECT id INTO v_cogs_account_id FROM accounts WHERE tenant_id = NEW.tenant_id AND system = v_system AND code = (CASE WHEN v_system = 'water_supply' THEN 'WS-3007' ELSE 'DP-3004' END);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, tenant_id)
    VALUES (v_cogs_account_id, NEW.txn_date, v_particular, (-NEW.quantity) * v_txn_cost, 0, 'inventory', NEW.id, v_bill_number, NEW.tenant_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, tenant_id)
    VALUES (v_stock_account_id, NEW.txn_date, v_particular, 0, (-NEW.quantity) * v_txn_cost, 'inventory', NEW.id, v_bill_number, NEW.tenant_id);

  ELSIF NEW.txn_type = 'adjustment' AND NEW.quantity > 0 THEN
    v_particular := 'Inventory restored — ' || v_item.name || ' x' || NEW.quantity || ' ' || v_item.unit;
    SELECT id INTO v_cogs_account_id FROM accounts WHERE tenant_id = NEW.tenant_id AND system = v_system AND code = (CASE WHEN v_system = 'water_supply' THEN 'WS-3007' ELSE 'DP-3004' END);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, tenant_id)
    VALUES (v_stock_account_id, NEW.txn_date, v_particular, NEW.quantity * v_txn_cost, 0, 'inventory', NEW.id, v_bill_number, NEW.tenant_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, tenant_id)
    VALUES (v_cogs_account_id, NEW.txn_date, v_particular, 0, NEW.quantity * v_txn_cost, 'inventory', NEW.id, v_bill_number, NEW.tenant_id);
  END IF;

  RETURN NEW;
END;
$function$;

create or replace function public.waive_bill(p_bill_id uuid, p_reason text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  b bills%ROWTYPE; v_admin_id uuid := current_admin_user_id();
  v_account_id uuid; v_discount_account_id uuid; v_waived_amount decimal; v_particular text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Give a reason for the waiver -- it is the only record of why this bill was forgiven.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO b FROM bills WHERE id = p_bill_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status = 'waived' THEN RAISE EXCEPTION 'This bill is already waived.' USING ERRCODE = 'P0001'; END IF;
  IF COALESCE(b.paid_amount, 0) > 0 THEN
    RAISE EXCEPTION 'This bill already has a payment recorded -- a waiver only applies to a bill nothing has been paid on yet.' USING ERRCODE = 'P0001';
  END IF;

  v_waived_amount := b.amount_pkr - COALESCE(b.discount_amount, 0);

  UPDATE bills SET
    discount_amount = amount_pkr,
    status = 'waived', waived_at = now(), waived_by_admin_id = v_admin_id, waived_reason = trim(p_reason)
  WHERE id = p_bill_id;

  IF v_waived_amount > 0 THEN
    v_account_id := ensure_consumer_account(b.consumer_id);
    SELECT id INTO v_discount_account_id FROM accounts WHERE tenant_id = b.tenant_id AND system = 'water_supply' AND code = 'WS-3008';
    IF v_discount_account_id IS NOT NULL THEN
      v_particular := 'Waived -- Bill #' || COALESCE(b.bill_number, '') || ' -- ' || trim(p_reason);
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, tenant_id)
      VALUES (v_discount_account_id, (now() AT TIME ZONE 'Asia/Karachi')::date, v_particular, v_waived_amount, 0, 'bill', b.id, b.bill_number, b.tenant_id);
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number, tenant_id)
      VALUES (v_account_id, (now() AT TIME ZONE 'Asia/Karachi')::date, v_particular, 0, v_waived_amount, 'bill', b.id, b.bill_number, b.tenant_id);
    END IF;
  END IF;
END;
$function$;
