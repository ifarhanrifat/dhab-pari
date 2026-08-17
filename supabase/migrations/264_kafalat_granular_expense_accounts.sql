-- Migration 264: Kafalat gets real, per-category expense accounts.
--
-- Every Kafalat payout -- whatever the category, school fee, transport,
-- admission fee -- has been debiting one shared account, DP-5020
-- "Education Expenditure -- Wazifa & Kafalat" (post_welfare_voucher_legs,
-- migration 224). The Trial Balance and P&L can't show "how much did we
-- spend on transport across the whole programme" because there's only one
-- line to look at; that breakdown only ever existed in the sub-ledger
-- tables (kafalat_fee_payments, kafalat_disbursements), never in the real
-- chart of accounts.
--
-- water_supply already solved exactly this the right way (migration 083):
-- a multi-category expense voucher debits each category's own real
-- account_id via voucher_line_items, one leg per line -- proven with 14
-- real accounts and real posted history (Repair & Maintenance, Fuel
-- Expense, Eid Bonus, and so on). Kafalat never adopted that pattern; this
-- migration does, without touching how Wazifa/Zakat/Ushr/Esal-e-Sawab post
-- (they stay on post_welfare_voucher_legs exactly as they are).
--
-- ═════════════════════════════════════════════════════════════════════════
-- Part A -- one real account per category
-- ═════════════════════════════════════════════════════════════════════════
INSERT INTO accounts (code, name, name_ur, type, system, description, is_protected) VALUES
  ('DP-5030', 'Kafalat — School Fee Expense', 'کفالت — سکول فیس اخراجات', 'expense', 'donors_projects', 'School fee paid on behalf of Kafalat children', true),
  ('DP-5031', 'Kafalat — Uniform Expense', 'کفالت — یونیفارم اخراجات', 'expense', 'donors_projects', 'Uniforms issued to Kafalat children', true),
  ('DP-5032', 'Kafalat — Books Expense', 'کفالت — کتب اخراجات', 'expense', 'donors_projects', 'Books paid for Kafalat children', true),
  ('DP-5033', 'Kafalat — Stationery Expense', 'کفالت — سٹیشنری اخراجات', 'expense', 'donors_projects', 'Stationery paid for Kafalat children', true),
  ('DP-5034', 'Kafalat — Transport Expense', 'کفالت — آمد و رفت اخراجات', 'expense', 'donors_projects', 'Transport/driver payments for Kafalat children', true),
  ('DP-5035', 'Kafalat — Pocket Money Expense', 'کفالت — جیب خرچ اخراجات', 'expense', 'donors_projects', 'Monthly pocket money for Kafalat children', true),
  ('DP-5036', 'Kafalat — Medical Expense', 'کفالت — طبی اخراجات', 'expense', 'donors_projects', 'Medical costs paid for Kafalat children', true),
  ('DP-5037', 'Kafalat — Exam Fee Expense', 'کفالت — امتحانی فیس اخراجات', 'expense', 'donors_projects', 'Exam fees paid for Kafalat children', true),
  ('DP-5038', 'Kafalat — Tuition Expense', 'کفالت — ٹیوشن اخراجات', 'expense', 'donors_projects', 'Tuition paid for Kafalat children', true),
  ('DP-5039', 'Kafalat — Admission Fee Expense', 'کفالت — داخلہ فیس اخراجات', 'expense', 'donors_projects', 'One-time school admission fee, paid once per child at registration', true),
  ('DP-5040', 'Kafalat — Other Expense', 'کفالت — دیگر اخراجات', 'expense', 'donors_projects', 'Kafalat spending that does not fit any other category', true)
ON CONFLICT (code, system) DO NOTHING;

-- One place the category-to-account mapping lives, so the payment
-- functions below (and anything written later) never have to repeat it.
CREATE OR REPLACE FUNCTION kafalat_expense_account(p_category varchar) RETURNS uuid AS $$
  SELECT id FROM accounts WHERE system = 'donors_projects' AND code = CASE p_category
    WHEN 'school_fee' THEN 'DP-5030'
    WHEN 'uniform' THEN 'DP-5031'
    WHEN 'books' THEN 'DP-5032'
    WHEN 'stationery' THEN 'DP-5033'
    WHEN 'transport' THEN 'DP-5034'
    WHEN 'pocket_money' THEN 'DP-5035'
    WHEN 'medical' THEN 'DP-5036'
    WHEN 'exam_fee' THEN 'DP-5037'
    WHEN 'tuition' THEN 'DP-5038'
    WHEN 'admission_fee' THEN 'DP-5039'
    ELSE 'DP-5040' END;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION kafalat_expense_account(varchar) TO authenticated;

ALTER TABLE kafalat_package_lines DROP CONSTRAINT IF EXISTS kafalat_package_lines_category_check;
ALTER TABLE kafalat_package_lines ADD CONSTRAINT kafalat_package_lines_category_check
  CHECK (category IN ('school_fee', 'uniform', 'books', 'stationery', 'transport',
                      'pocket_money', 'medical', 'exam_fee', 'tuition', 'admission_fee', 'other'));

-- ═════════════════════════════════════════════════════════════════════════
-- Part B -- kafalat_payment now posts through the real multi-category path
-- ═════════════════════════════════════════════════════════════════════════
-- Removed from the welfare list below; falls through to the generic
-- multi-line branch further down in this same function, which already
-- does exactly this for water_supply -- one debit per voucher_line_items
-- row, against that line's own real account. Wazifa/Zakat/Ushr/Esal-e-
-- Sawab are untouched.
--
-- The fund-balance draw-down and the child's own subsidiary-account mirror
-- (previously only inside post_welfare_voucher_legs) move here, generic to
-- any voucher_type -- both columns are only ever set on Kafalat vouchers
-- today, so this changes nothing for any other voucher.
CREATE OR REPLACE FUNCTION post_voucher_ledger_legs_base(p_voucher vouchers) RETURNS void AS $$
DECLARE
  v_bill_number varchar;
  v_line_total decimal;
  v_advance_amount decimal;
  v_diff decimal;
  v_advance_account_id uuid;
  v_project_account_id uuid;
  v_to_project_account_id uuid;
  v_project_amount decimal;
  v_from_title text;
  v_to_title text;
  v_fund_account uuid;
  v_child_account uuid;
  r RECORD;
BEGIN
  IF p_voucher.bill_id IS NOT NULL THEN
    SELECT bill_number INTO v_bill_number FROM bills WHERE id = p_voucher.bill_id;
  END IF;

  IF p_voucher.reverses_voucher_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    SELECT l.account_id, p_voucher.voucher_date, p_voucher.particular,
           l.credit, l.debit, 'voucher', p_voucher.id, p_voucher.receipt_no, l.bill_number
      FROM ledger_entries l
     WHERE l.reference_type = 'voucher' AND l.reference_id = p_voucher.reverses_voucher_id;
    RETURN;
  END IF;

  IF p_voucher.voucher_type = 'pool_shortfall_cover' THEN
    PERFORM post_pool_voucher_legs(p_voucher);
    RETURN;
  END IF;

  IF p_voucher.voucher_type IN ('zakat_disbursement', 'ushr_disbursement', 'esal_e_sawab',
                                'wazifa_payment', 'wazifa_repayment', 'wazifa_contribution') THEN
    PERFORM post_welfare_voucher_legs(p_voucher);
    RETURN;
  END IF;

  IF p_voucher.voucher_type = 'project_transfer' THEN
    SELECT title INTO v_from_title FROM projects WHERE id = p_voucher.project_id;
    SELECT title INTO v_to_title FROM projects WHERE id = p_voucher.transfer_to_project_id;
    v_project_account_id := ensure_project_account(p_voucher.project_id);
    v_to_project_account_id := ensure_project_account(p_voucher.transfer_to_project_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_project_account_id, p_voucher.voucher_date,
            COALESCE(p_voucher.particular, '') || ' — transferred to ' || COALESCE(v_to_title, 'another project'),
            p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_to_project_account_id, p_voucher.voucher_date,
            COALESCE(p_voucher.particular, '') || ' — received from ' || COALESCE(v_from_title, 'another project'),
            0, p_voucher.amount_pkr, 'voucher', p_voucher.id, p_voucher.receipt_no);
    RETURN;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_line_total FROM voucher_line_items WHERE voucher_id = p_voucher.id;

  IF p_voucher.voucher_type = 'advance_settlement' THEN
    FOR r IN SELECT account_id, amount, description FROM voucher_line_items WHERE voucher_id = p_voucher.id LOOP
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (r.account_id, p_voucher.voucher_date, COALESCE(r.description, p_voucher.particular), r.amount, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    END LOOP;
    SELECT amount_pkr INTO v_advance_amount FROM vouchers WHERE id = p_voucher.settles_voucher_id;
    v_diff := v_advance_amount - v_line_total;
    SELECT id INTO v_advance_account_id FROM accounts WHERE system = p_voucher.system AND code = 'WS-4003';
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (v_advance_account_id, p_voucher.voucher_date, p_voucher.particular, 0, v_advance_amount, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    IF v_diff > 0 THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, v_diff, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    ELSIF v_diff < 0 THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, 0, -v_diff, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    END IF;
    UPDATE vouchers SET settled_at = now() WHERE id = p_voucher.settles_voucher_id;
    v_project_amount := v_line_total;

  ELSIF v_line_total > 0 THEN
    FOR r IN SELECT account_id, amount, description FROM voucher_line_items WHERE voucher_id = p_voucher.id LOOP
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
      VALUES (r.account_id, p_voucher.voucher_date, COALESCE(r.description, p_voucher.particular), r.amount, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    END LOOP;
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, 0, v_line_total, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    v_project_amount := v_line_total;

  ELSE
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (p_voucher.to_account_id, p_voucher.voucher_date, p_voucher.particular, p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (p_voucher.from_account_id, p_voucher.voucher_date, p_voucher.particular, 0, p_voucher.amount_pkr, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
    v_project_amount := p_voucher.amount_pkr;
  END IF;

  IF p_voucher.system = 'donors_projects' AND p_voucher.voucher_type = 'expense' AND p_voucher.project_id IS NOT NULL THEN
    v_project_account_id := ensure_project_account(p_voucher.project_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (v_project_account_id, p_voucher.voucher_date, p_voucher.particular, v_project_amount, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, v_bill_number);
  END IF;

  -- Restricted-fund draw-down and the child's own subsidiary mirror --
  -- moved here from post_welfare_voucher_legs so kafalat_payment keeps
  -- both even though it no longer routes through that function. Neither
  -- column is ever set on a non-Kafalat voucher today, so nothing else
  -- changes.
  IF p_voucher.fund_type IS NOT NULL THEN
    v_fund_account := fund_account_id(p_voucher.fund_type);
    IF v_fund_account IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
      VALUES (v_fund_account, p_voucher.voucher_date, p_voucher.particular, v_project_amount, 0, 'voucher', p_voucher.id, p_voucher.receipt_no);
    END IF;
  END IF;

  IF p_voucher.kafalat_child_id IS NOT NULL THEN
    v_child_account := ensure_kafalat_child_account(p_voucher.kafalat_child_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_child_account, p_voucher.voucher_date, p_voucher.particular, v_project_amount, 0, 'voucher', p_voucher.id, p_voucher.receipt_no);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- Part C -- the payment functions now write a real, categorised line item
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION kafalat_pay_fee_item(
  p_line_id uuid, p_amount decimal, p_method varchar, p_paid_to varchar DEFAULT NULL,
  p_signed_by varchar DEFAULT NULL, p_proof_url text DEFAULT NULL, p_note text DEFAULT NULL,
  p_months_covered int DEFAULT 1
) RETURNS jsonb AS $$
DECLARE
  l kafalat_package_lines%ROWTYPE; c kafalat_children%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_payment_id uuid; v_covers_until date; v_particular text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be more than zero.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO l FROM kafalat_package_lines WHERE id = p_line_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO c FROM kafalat_children WHERE id = l.child_id;

  v_covers_until := (CASE WHEN p_months_covered > 1
    THEN ((now() AT TIME ZONE 'Asia/Karachi')::date + (make_interval(months => p_months_covered - 1)))
    ELSE NULL END);

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  v_particular := c.first_name || ' (' || c.code || ') — ' || l.category || ', ' || l.academic_year
      || COALESCE(' — ' || p_paid_to, '')
      || CASE WHEN p_months_covered > 1 THEN ' — ' || p_months_covered || ' months in advance' ELSE '' END;

  -- Drafted, not inserted straight to its real status -- the ledger trigger
  -- fires the moment the voucher row exists, and a category-accurate
  -- posting needs the line item to already be there when that happens.
  -- finalize_voucher() (below) is what actually decides pending/posted and
  -- ledgers it, once the line item is attached.
  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, party_name, kafalat_child_id, fund_type, status)
  VALUES ('donors_projects', 'kafalat_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    v_particular, p_amount, v_cash, COALESCE(p_paid_to, c.first_name), l.child_id, 'kafalat', 'draft')
  RETURNING id INTO v_voucher_id;

  INSERT INTO voucher_line_items (voucher_id, account_id, amount, description, category, attachment_url, period_end)
  VALUES (v_voucher_id, kafalat_expense_account(l.category), p_amount, v_particular, l.category, p_proof_url, v_covers_until);

  INSERT INTO kafalat_fee_payments (package_line_id, child_id, category, amount_pkr, method,
    paid_to, signed_by, proof_url, note, voucher_id, created_by, months_covered, covers_until)
  VALUES (p_line_id, l.child_id, l.category, p_amount, p_method, p_paid_to, p_signed_by,
    p_proof_url, p_note, v_voucher_id, current_admin_user_id(), GREATEST(p_months_covered, 1), v_covers_until)
  RETURNING id INTO v_payment_id;

  PERFORM finalize_voucher(v_voucher_id);
  SELECT voucher_no INTO v_voucher_no FROM vouchers WHERE id = v_voucher_id;
  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount, 'payment_id', v_payment_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION kafalat_pay_disbursement(
  p_disbursement_id uuid, p_method varchar, p_signed_by varchar DEFAULT NULL,
  p_driver_name varchar DEFAULT NULL, p_signed_note text DEFAULT NULL, p_proof_url text DEFAULT NULL,
  p_months_covered int DEFAULT 1
) RETURNS jsonb AS $$
DECLARE
  d kafalat_disbursements%ROWTYPE; c kafalat_children%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_total decimal; v_month date; i int;
  v_future_id uuid; v_particular text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO d FROM kafalat_disbursements WHERE id = p_disbursement_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF d.status <> 'scheduled' THEN
    RAISE EXCEPTION 'This is already %.', d.status USING ERRCODE = 'P0001';
  END IF;
  IF d.category = 'transport' AND COALESCE(trim(p_driver_name), '') = '' THEN
    RAISE EXCEPTION 'Name the driver — this is a transport payment.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM kafalat_children WHERE id = d.child_id;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);
  v_total := d.amount_pkr;
  v_particular := c.first_name || ' (' || c.code || ') — ' || d.category || ', ' || to_char(d.month, 'Mon YYYY')
      || CASE WHEN p_months_covered > 1 THEN ' — ' || p_months_covered || ' months in advance' ELSE '' END;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, party_name, kafalat_child_id, fund_type, status)
  VALUES ('donors_projects', 'kafalat_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    v_particular, d.amount_pkr, v_cash, COALESCE(p_driver_name, c.first_name), d.child_id, 'kafalat', 'draft')
  RETURNING id INTO v_voucher_id;

  UPDATE kafalat_disbursements
     SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method,
         recipient = CASE WHEN p_driver_name IS NOT NULL THEN 'driver' ELSE recipient END,
         driver_name = p_driver_name, signed_by = p_signed_by, signed_note = p_signed_note,
         proof_url = p_proof_url, voucher_id = v_voucher_id
   WHERE id = p_disbursement_id;

  IF p_months_covered > 1 THEN
    FOR i IN 1..(p_months_covered - 1) LOOP
      v_month := (d.month + make_interval(months => i))::date;
      SELECT id INTO v_future_id FROM kafalat_disbursements
       WHERE child_id = d.child_id AND category = d.category AND month = v_month;
      IF v_future_id IS NULL THEN
        INSERT INTO kafalat_disbursements (child_id, category, month, amount_pkr, recipient, status)
        VALUES (d.child_id, d.category, v_month, d.amount_pkr,
                CASE WHEN d.category = 'transport' THEN 'driver' ELSE 'guardian' END, 'scheduled')
        RETURNING id INTO v_future_id;
      END IF;
      UPDATE kafalat_disbursements
         SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method,
             recipient = CASE WHEN p_driver_name IS NOT NULL THEN 'driver' ELSE recipient END,
             driver_name = p_driver_name, signed_by = p_signed_by,
             signed_note = COALESCE(signed_note, p_signed_note), proof_url = p_proof_url, voucher_id = v_voucher_id
       WHERE id = v_future_id AND status = 'scheduled';
      v_total := v_total + d.amount_pkr;
    END LOOP;
  END IF;

  -- One line item for the whole advance (finalize_voucher() sums this back
  -- into amount_pkr, so the manual months-covered total above is what
  -- actually posts).
  INSERT INTO voucher_line_items (voucher_id, account_id, amount, description, category, attachment_url)
  VALUES (v_voucher_id, kafalat_expense_account(d.category), v_total, v_particular, d.category, p_proof_url);

  PERFORM finalize_voucher(v_voucher_id);
  SELECT voucher_no INTO v_voucher_no FROM vouchers WHERE id = v_voucher_id;
  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION kafalat_issue_uniform(
  p_issue_id uuid, p_received_by varchar, p_signed_note text DEFAULT NULL, p_method varchar DEFAULT 'cash',
  p_proof_url text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  u kafalat_uniform_issues%ROWTYPE; c kafalat_children%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_particular text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO u FROM kafalat_uniform_issues WHERE id = p_issue_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF u.status <> 'scheduled' THEN
    RAISE EXCEPTION 'This uniform is already %.', u.status USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(trim(p_received_by), '') = '' THEN
    RAISE EXCEPTION 'Name whoever received it — the child, the guardian, or the shop.'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM kafalat_children WHERE id = u.child_id;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);
  v_particular := c.first_name || ' (' || c.code || ') — uniform ' || u.issue_no || '/2, ' || u.academic_year
      || CASE WHEN c.uniform_mode = 'cash' THEN ' (cash to guardian)' ELSE '' END;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, party_name, kafalat_child_id, fund_type, status)
  VALUES ('donors_projects', 'kafalat_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    v_particular, u.amount_pkr, v_cash, c.first_name, u.child_id, 'kafalat', 'draft')
  RETURNING id INTO v_voucher_id;

  INSERT INTO voucher_line_items (voucher_id, account_id, amount, description, category, attachment_url)
  VALUES (v_voucher_id, kafalat_expense_account('uniform'), u.amount_pkr, v_particular, 'uniform', p_proof_url);

  UPDATE kafalat_uniform_issues
     SET status = 'issued', issued_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
         received_by = p_received_by, signed_note = p_signed_note, proof_url = p_proof_url,
         voucher_id = v_voucher_id
   WHERE id = p_issue_id;

  PERFORM finalize_voucher(v_voucher_id);
  SELECT voucher_no INTO v_voucher_no FROM vouchers WHERE id = v_voucher_id;
  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', u.amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION kafalat_pay_fee_item(uuid, decimal, varchar, varchar, varchar, text, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kafalat_pay_fee_item(uuid, decimal, varchar, varchar, varchar, text, text, int) TO authenticated;
REVOKE ALL ON FUNCTION kafalat_pay_disbursement(uuid, varchar, varchar, varchar, text, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kafalat_pay_disbursement(uuid, varchar, varchar, varchar, text, text, int) TO authenticated;
REVOKE ALL ON FUNCTION kafalat_issue_uniform(uuid, varchar, text, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kafalat_issue_uniform(uuid, varchar, text, varchar, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Part D -- the combined monthly-payment voucher: real accounts per line,
-- and admission fee as its own selectable ad-hoc category
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION kafalat_record_monthly_payment(
  p_child_id uuid, p_method varchar, p_items jsonb
) RETURNS jsonb AS $$
DECLARE
  c kafalat_children%ROWTYPE; v_cash uuid;
  v_voucher_id uuid; v_voucher_no varchar;
  item jsonb; v_kind varchar; v_amount decimal; v_months int; v_desc text; v_category varchar;
  v_line kafalat_package_lines%ROWTYPE; v_disb kafalat_disbursements%ROWTYPE; v_unif kafalat_uniform_issues%ROWTYPE;
  v_covers_until date; v_month date; i int; v_future_id uuid;
  v_count int := 0;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM kafalat_children WHERE id = p_child_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Child not found' USING ERRCODE = 'P0001'; END IF;
  IF jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'Add at least one item.' USING ERRCODE = 'P0001'; END IF;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, party_name, kafalat_child_id, fund_type, status)
  VALUES ('donors_projects', 'kafalat_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    c.first_name || ' (' || c.code || ') — monthly payment', 0, v_cash, c.first_name, p_child_id, 'kafalat', 'draft')
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_kind := item->>'kind';
    v_amount := (item->>'amount')::decimal;
    v_months := GREATEST(COALESCE((item->>'months_covered')::int, 1), 1);
    v_category := COALESCE(item->>'category', 'other');
    IF v_amount <= 0 THEN CONTINUE; END IF;
    v_covers_until := NULL;

    IF v_kind = 'fee' THEN
      SELECT * INTO v_line FROM kafalat_package_lines WHERE id = (item->>'line_id')::uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'A budget line in this form no longer exists.' USING ERRCODE = 'P0001'; END IF;
      v_category := v_line.category;
      v_desc := initcap(replace(v_line.category, '_', ' ')) || ', ' || v_line.academic_year
        || CASE WHEN v_months > 1 THEN ' — ' || v_months || ' months in advance' ELSE '' END;
      IF v_months > 1 THEN v_covers_until := (now() AT TIME ZONE 'Asia/Karachi')::date + make_interval(months => v_months - 1); END IF;

      INSERT INTO kafalat_fee_payments (package_line_id, child_id, category, amount_pkr, method,
        proof_url, note, voucher_id, created_by, months_covered, covers_until)
      VALUES (v_line.id, p_child_id, v_line.category, v_amount, p_method,
        item->>'attachment_url', item->>'note', v_voucher_id, current_admin_user_id(), v_months, v_covers_until);

    ELSIF v_kind = 'disbursement' THEN
      SELECT * INTO v_disb FROM kafalat_disbursements WHERE id = (item->>'ref_id')::uuid FOR UPDATE;
      IF NOT FOUND OR v_disb.status <> 'scheduled' THEN
        RAISE EXCEPTION 'This month''s % is no longer awaiting payment.', v_category USING ERRCODE = 'P0001';
      END IF;
      v_category := v_disb.category;
      v_desc := initcap(replace(v_disb.category, '_', ' ')) || ', ' || to_char(v_disb.month, 'Mon YYYY')
        || CASE WHEN v_months > 1 THEN ' — ' || v_months || ' months in advance' ELSE '' END;

      UPDATE kafalat_disbursements SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
        method = p_method, proof_url = item->>'attachment_url', voucher_id = v_voucher_id,
        driver_name = COALESCE(item->>'paid_to', driver_name), signed_note = item->>'note'
       WHERE id = v_disb.id;

      IF v_months > 1 THEN
        FOR i IN 1..(v_months - 1) LOOP
          v_month := (v_disb.month + make_interval(months => i))::date;
          SELECT id INTO v_future_id FROM kafalat_disbursements
           WHERE child_id = p_child_id AND category = v_disb.category AND month = v_month;
          IF v_future_id IS NULL THEN
            INSERT INTO kafalat_disbursements (child_id, category, month, amount_pkr, recipient, status)
            VALUES (p_child_id, v_disb.category, v_month, v_disb.amount_pkr,
                    CASE WHEN v_disb.category = 'transport' THEN 'driver' ELSE 'guardian' END, 'scheduled')
            RETURNING id INTO v_future_id;
          END IF;
          UPDATE kafalat_disbursements SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
            method = p_method, proof_url = item->>'attachment_url', voucher_id = v_voucher_id
           WHERE id = v_future_id AND status = 'scheduled';
        END LOOP;
      END IF;

    ELSIF v_kind = 'uniform' THEN
      SELECT * INTO v_unif FROM kafalat_uniform_issues WHERE id = (item->>'ref_id')::uuid FOR UPDATE;
      IF NOT FOUND OR v_unif.status <> 'scheduled' THEN
        RAISE EXCEPTION 'This uniform is no longer awaiting payment.' USING ERRCODE = 'P0001';
      END IF;
      v_category := 'uniform';
      v_desc := 'Uniform ' || v_unif.issue_no || '/2, ' || v_unif.academic_year;
      UPDATE kafalat_uniform_issues SET status = 'issued', issued_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
        received_by = COALESCE(item->>'paid_to', c.first_name), signed_note = item->>'note',
        proof_url = item->>'attachment_url', voucher_id = v_voucher_id
       WHERE id = v_unif.id;

    ELSIF v_kind = 'other' THEN
      -- category comes straight from the form -- 'admission_fee' when the
      -- admin picks it, 'other' otherwise -- so it lands on its own real
      -- account instead of always being lumped as generic "other".
      v_desc := COALESCE(item->>'description', initcap(replace(v_category, '_', ' ')));
      INSERT INTO kafalat_fee_payments (package_line_id, child_id, category, amount_pkr, method,
        paid_to, proof_url, note, voucher_id, created_by, months_covered)
      VALUES (NULL, p_child_id, v_category, v_amount, p_method, item->>'paid_to',
        item->>'attachment_url', v_desc, v_voucher_id, current_admin_user_id(), 1);
    ELSE
      RAISE EXCEPTION 'Unknown item kind: %', v_kind USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO voucher_line_items (voucher_id, account_id, amount, description, category, attachment_url, period_start, period_end)
    VALUES (v_voucher_id, kafalat_expense_account(v_category), v_amount, v_desc, v_category, item->>'attachment_url',
      (now() AT TIME ZONE 'Asia/Karachi')::date, v_covers_until);
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    DELETE FROM vouchers WHERE id = v_voucher_id;
    RAISE EXCEPTION 'Nothing to save — every amount was zero.' USING ERRCODE = 'P0001';
  END IF;

  PERFORM finalize_voucher(v_voucher_id);
  RETURN (SELECT jsonb_build_object('voucher_id', id, 'voucher_no', voucher_no, 'status', status, 'amount', amount_pkr)
          FROM vouchers WHERE id = v_voucher_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION kafalat_record_monthly_payment(uuid, varchar, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kafalat_record_monthly_payment(uuid, varchar, jsonb) TO authenticated;
