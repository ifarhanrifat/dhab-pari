-- Migration 369: fixes a real ledger-direction bug found while first
-- exercising pay_training_fee_charge() (367) against live data — a
-- training fee payment was crediting the *collector's* clearing account
-- and debiting the *project's* account, the exact reverse of correct
-- double-entry (confirmed against the project_transfer branch's own
-- convention in post_voucher_ledger_legs_base: money arriving into a
-- project is a CREDIT there, same as the expense branch's project debit
-- for money leaving). A training fee is money arriving, so the project
-- account must be credited, not debited.
--
-- Root cause: the generic (no-special-case) branch of
-- post_voucher_ledger_legs_base() debits to_account_id and credits
-- from_account_id — from_account_id/to_account_id here were the wrong
-- way round.

CREATE OR REPLACE FUNCTION pay_training_fee_charge(
  p_charge_id uuid, p_amount decimal, p_method varchar, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  c training_fee_charges%ROWTYPE; e training_enrollments%ROWTYPE; proj projects%ROWTYPE;
  v_is_full_accountant boolean;
  v_is_collector boolean;
  v_from_account uuid;
  v_project_account uuid;
  v_voucher_id uuid; v_voucher_no varchar; v_remaining decimal;
  v_collected_by uuid;
  v_popup_enabled boolean;
  v_collector_name varchar;
  r record;
BEGIN
  SELECT * INTO c FROM training_fee_charges WHERE id = p_charge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Charge not found' USING ERRCODE = 'P0001'; END IF;
  IF c.status = 'paid' THEN RAISE EXCEPTION 'Already paid.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO e FROM training_enrollments WHERE id = c.enrollment_id;

  v_is_full_accountant := COALESCE(current_admin_permission('post_transactions'), false);
  v_is_collector := current_admin_can_collect_for_training_program(e.project_id);
  IF NOT v_is_full_accountant AND NOT v_is_collector THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Enter an amount greater than zero.' USING ERRCODE = 'P0001'; END IF;

  v_remaining := c.amount_pkr - c.paid_pkr;
  IF p_amount > v_remaining + 0.01 THEN
    RAISE EXCEPTION 'That is more than is due — Rs % is left on this charge.',
      trim(to_char(v_remaining, 'FM999,999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO proj FROM projects WHERE id = e.project_id;
  v_project_account := ensure_project_account(e.project_id);

  IF v_is_full_accountant AND NOT v_is_collector THEN
    v_collected_by := NULL;
    SELECT id INTO v_from_account FROM accounts WHERE system = 'donors_projects'
       AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);
  ELSE
    v_collected_by := current_admin_user_id();
    v_from_account := ensure_collector_account(v_collected_by, 'donors_projects');
  END IF;

  -- from_account_id = the project (credited — money arriving), to_account_id
  -- = cash/collector (debited — asset increase). See migration header.
  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, project_id)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    e.student_name || ' — training fee, charge ' || c.charge_no || ' (' || COALESCE(proj.display_name, proj.title) || ')'
      || COALESCE(' · ' || p_note, ''),
    p_amount, v_project_account, v_from_account, e.student_name, e.project_id)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE training_fee_charges
     SET paid_pkr = paid_pkr + p_amount,
         status = CASE WHEN paid_pkr + p_amount >= amount_pkr - 0.01 THEN 'paid' ELSE 'part_paid' END,
         paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method,
         voucher_id = v_voucher_id, note = COALESCE(p_note, note), collected_by = v_collected_by
   WHERE id = p_charge_id;

  IF v_collected_by IS NOT NULL THEN
    SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'training_fee_collected';
    IF v_popup_enabled IS TRUE THEN
      SELECT full_name INTO v_collector_name FROM admin_users WHERE id = v_collected_by;
      FOR r IN
        SELECT id FROM admin_users
        WHERE is_active = true AND id != v_collected_by AND (
          role IN ('super_admin', 'admin', 'donor_accountant')
          OR (role = 'accountant' AND access_donors_projects)
        )
      LOOP
        INSERT INTO notifications (recipient_id, event_type, title, body, link)
        VALUES (r.id, 'training_fee_collected', 'Training fee collected',
          COALESCE(v_collector_name, 'A trainer') || ' collected Rs ' || trim(to_char(p_amount, 'FM999,999,999,990'))
            || ' from ' || e.student_name || ' (' || COALESCE(proj.display_name, proj.title) || ')',
          '/admin/donors/collectors');
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount, 'charge_id', p_charge_id, 'collected_by', v_collected_by);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
