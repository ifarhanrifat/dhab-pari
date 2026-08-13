-- Migration 218: put the welfare money through the books properly.
--
-- ═════════════════════════════════════════════════════════════════════════
-- What was wrong
-- ═════════════════════════════════════════════════════════════════════════
-- zakat_disburse(), wazifa_pay_instalment() and wazifa_record_repayment() all
-- wrote straight into ledger_entries with reference_type='manual'. That gave
-- them no voucher number, no voucher type, no approval, no audit entry and no
-- reversal path — and made every one of them invisible in All Transactions,
-- which reads bills, payments, vouchers, donors and purchases, not loose
-- ledger rows.
--
-- Two more things were missing underneath:
--
--   No account for a student and none for an institution. Two students at the
--   same private school were indistinguishable — the only thing separating
--   them was text inside `particular` — and there was no school statement to
--   reconcile against at all.
--
--   A grant and a qarz-e-hasana posted identically. They are not the same
--   thing. A grant is money spent; a loan is money owed back. Booking a loan
--   as expenditure overstates what the committee has given away and hides an
--   asset it actually holds.

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Two new kinds of account
-- ═════════════════════════════════════════════════════════════════════════
INSERT INTO account_headers (system, code, label, label_ur, code_prefix, display_order, is_system) VALUES
  ('donors_projects', 'institution', 'Schools & Institutions', 'سکول و ادارے', 'DP-INS', 10, true),
  ('donors_projects', 'student', 'Students Supported', 'زیرِ کفالت طلبہ', 'DP-STU', 11, true)
ON CONFLICT (system, code) DO NOTHING;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS school_id uuid REFERENCES schools(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS wazifa_student_id uuid REFERENCES wazifa_students(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS kafalat_child_id uuid REFERENCES kafalat_children(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS accounts_school_id_key ON accounts(school_id) WHERE school_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_wazifa_student_id_key ON accounts(wazifa_student_id) WHERE wazifa_student_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_kafalat_child_id_key ON accounts(kafalat_child_id) WHERE kafalat_child_id IS NOT NULL;

-- Provisioned on first use, the same way project and collector accounts are.
CREATE OR REPLACE FUNCTION ensure_institution_account(p_school_id uuid) RETURNS uuid AS $$
DECLARE v_id uuid; v_name varchar;
BEGIN
  SELECT id INTO v_id FROM accounts WHERE school_id = p_school_id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  SELECT name INTO v_name FROM schools WHERE id = p_school_id;
  INSERT INTO accounts (code, name, type, system, school_id, opening_balance)
  VALUES ('INS-' || substr(replace(p_school_id::text, '-', ''), 1, 8),
          COALESCE(v_name, 'Institution'), 'institution', 'donors_projects', p_school_id, 0)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- The student's own sub-ledger, named by code rather than by name so the
-- chart of accounts does not become a list of which families needed help.
CREATE OR REPLACE FUNCTION ensure_wazifa_student_account(p_student_id uuid) RETURNS uuid AS $$
DECLARE v_id uuid; v_code varchar;
BEGIN
  SELECT id INTO v_id FROM accounts WHERE wazifa_student_id = p_student_id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  SELECT code INTO v_code FROM wazifa_students WHERE id = p_student_id;
  INSERT INTO accounts (code, name, type, system, wazifa_student_id, opening_balance)
  VALUES ('STU-' || substr(replace(p_student_id::text, '-', ''), 1, 8),
          COALESCE(v_code, 'Student'), 'student', 'donors_projects', p_student_id, 0)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION ensure_kafalat_child_account(p_child_id uuid) RETURNS uuid AS $$
DECLARE v_id uuid; v_code varchar;
BEGIN
  SELECT id INTO v_id FROM accounts WHERE kafalat_child_id = p_child_id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  SELECT code INTO v_code FROM kafalat_children WHERE id = p_child_id;
  INSERT INTO accounts (code, name, type, system, kafalat_child_id, opening_balance)
  VALUES ('KID-' || substr(replace(p_child_id::text, '-', ''), 1, 8),
          COALESCE(v_code, 'Child'), 'student', 'donors_projects', p_child_id, 0)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION ensure_institution_account(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION ensure_wazifa_student_account(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION ensure_kafalat_child_account(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. A loan is not an expense
-- ═════════════════════════════════════════════════════════════════════════
-- A grant leaves the committee for good and belongs in expenditure. A
-- qarz-e-hasana is money the committee still owns and expects back, so it
-- belongs in assets. Booking them the same way overstates what has been given
-- away and hides a receivable the committee actually holds.
INSERT INTO accounts (code, name, name_ur, type, system, description, is_protected) VALUES
  ('DP-4020', 'Student Loan Receivable (Qarz-e-Hasana)', 'قرضِ حسنہ واجب الوصول', 'asset', 'donors_projects',
   'Money lent to students under qarz-e-hasana and still owed back. Not expenditure — only a written-off loan becomes that.', true),
  ('DP-5020', 'Education Expenditure — Wazifa & Kafalat', 'تعلیمی اخراجات — وظیفہ و کفالت', 'expense', 'donors_projects',
   'Fees, books, uniforms and transport given as a grant rather than a loan.', true),
  ('DP-5021', 'Zakat & Ushr Distributed', 'زکوٰۃ و عشر کی تقسیم', 'expense', 'donors_projects',
   'Zakat and ushr handed over to verified households.', true),
  ('DP-5022', 'Esal-e-Sawab Objects', 'ایصالِ ثواب اشیاء', 'expense', 'donors_projects',
   'Sadqa-e-jariya objects purchased, installed and maintained.', true),
  ('DP-2020', 'Institutions Payable', 'اداروں کو واجب الادا', 'liability', 'donors_projects',
   'Fees committed to a school or college and not yet paid across.', true)
ON CONFLICT (code, system) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Every welfare payment becomes a real voucher
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE vouchers DROP CONSTRAINT IF EXISTS vouchers_voucher_type_check;
ALTER TABLE vouchers ADD CONSTRAINT vouchers_voucher_type_check
  CHECK (voucher_type IN ('expense', 'income', 'contra', 'withdrawal', 'deposit',
    'security_deposit', 'security_deposit_refund', 'advance', 'advance_settlement',
    'complaint_waiver', 'project_transfer',
    'zakat_disbursement', 'ushr_disbursement', 'esal_e_sawab',
    'kafalat_payment', 'wazifa_payment', 'wazifa_repayment', 'wazifa_contribution'));

INSERT INTO voucher_counters (system, voucher_type, prefix) VALUES
  ('donors_projects', 'zakat_disbursement', 'DP-ZKT-V'),
  ('donors_projects', 'ushr_disbursement', 'DP-USH-V'),
  ('donors_projects', 'esal_e_sawab', 'DP-ESW-V'),
  ('donors_projects', 'kafalat_payment', 'DP-KFL-V'),
  ('donors_projects', 'wazifa_payment', 'DP-WZF-V'),
  ('donors_projects', 'wazifa_repayment', 'DP-WZR-V'),
  ('donors_projects', 'wazifa_contribution', 'DP-WZC-V')
ON CONFLICT (system, voucher_type) DO NOTHING;

ALTER TABLE vouchers
  ADD COLUMN IF NOT EXISTS school_id uuid REFERENCES schools(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS wazifa_student_id uuid REFERENCES wazifa_students(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS wazifa_award_id uuid REFERENCES wazifa_awards(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS kafalat_child_id uuid REFERENCES kafalat_children(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS needs_code varchar,
  -- The number printed on the school's own challan. Without it a committee
  -- sitting with the school's accounts office has nothing to tick against.
  ADD COLUMN IF NOT EXISTS challan_no varchar,
  ADD COLUMN IF NOT EXISTS fund_type varchar;

CREATE INDEX IF NOT EXISTS vouchers_school_idx ON vouchers(school_id) WHERE school_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS vouchers_wazifa_student_idx ON vouchers(wazifa_student_id) WHERE wazifa_student_id IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. Ring-fencing zakat and esal-e-sawab
-- ═════════════════════════════════════════════════════════════════════════
-- Zakat has to reach a poor person and nothing else; a sadqa-e-jariya object
-- has been dedicated and cannot be turned back into cash for something else.
-- Enforced against the account itself, so no voucher type, no contra, no
-- withdrawal and no project transfer can move that money sideways.
CREATE OR REPLACE FUNCTION account_fund_type(p_account_id uuid) RETURNS varchar AS $$
  SELECT fund_type FROM accounts WHERE id = p_account_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION trg_vouchers_protect_restricted_funds() RETURNS trigger AS $$
DECLARE v_from varchar; v_to varchar;
BEGIN
  v_from := account_fund_type(NEW.from_account_id);
  v_to := account_fund_type(NEW.to_account_id);

  IF v_from IN ('zakat', 'ushr') AND NEW.voucher_type NOT IN ('zakat_disbursement', 'ushr_disbursement') THEN
    RAISE EXCEPTION
      'Zakat and Ushr can only leave their fund as a distribution to a verified household. This is a % voucher.',
      NEW.voucher_type USING ERRCODE = 'P0001';
  END IF;

  IF v_from = 'esal_e_sawab' AND NEW.voucher_type <> 'esal_e_sawab' THEN
    RAISE EXCEPTION
      'Esal-e-Sawab money is dedicated to the object it was given for and cannot be moved elsewhere.'
      USING ERRCODE = 'P0001';
  END IF;

  -- And nothing may be paid *into* a zakat fund from ordinary money, which
  -- would quietly turn general donations into zakat.
  IF v_to IN ('zakat', 'ushr') AND NEW.voucher_type NOT IN ('zakat_disbursement', 'ushr_disbursement') THEN
    RAISE EXCEPTION
      'Money cannot be moved into the Zakat or Ushr fund by a voucher. Zakat arrives only as a zakat donation.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vouchers_protect_restricted_funds ON vouchers;
CREATE TRIGGER vouchers_protect_restricted_funds
  BEFORE INSERT OR UPDATE ON vouchers
  FOR EACH ROW EXECUTE FUNCTION trg_vouchers_protect_restricted_funds();

-- Project transfers must not touch a restricted fund either.
CREATE OR REPLACE FUNCTION trg_vouchers_validate_project_transfer() RETURNS trigger AS $$
DECLARE v_available decimal;
BEGIN
  IF NEW.voucher_type <> 'project_transfer' THEN RETURN NEW; END IF;
  IF NEW.reverses_voucher_id IS NOT NULL THEN RETURN NEW; END IF;

  IF NEW.system <> 'donors_projects' THEN
    RAISE EXCEPTION 'Project fund transfers belong to the Donors & Projects system' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.project_id IS NULL OR NEW.transfer_to_project_id IS NULL THEN
    RAISE EXCEPTION 'A project transfer needs both a source project and a destination project' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.project_id = NEW.transfer_to_project_id THEN
    RAISE EXCEPTION 'The source and destination projects must be different' USING ERRCODE = 'P0001';
  END IF;

  NEW.from_account_id := ensure_project_account(NEW.project_id);
  NEW.to_account_id := ensure_project_account(NEW.transfer_to_project_id);

  IF TG_OP = 'INSERT' THEN
    v_available := project_fund_balance(NEW.project_id);
    IF NEW.amount_pkr > v_available THEN
      RAISE EXCEPTION 'This project holds Rs. % — it cannot transfer Rs. %.',
        trim(to_char(v_available, 'FM999,999,999,990.00')),
        trim(to_char(NEW.amount_pkr, 'FM999,999,999,990.00')) USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ═════════════════════════════════════════════════════════════════════════
-- 5. The legs for the new voucher types
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION post_welfare_voucher_legs(p_voucher vouchers) RETURNS void AS $$
DECLARE
  v_fund_account uuid;
  v_student_account uuid;
  v_institution_account uuid;
  v_expense uuid;
  v_receivable uuid;
  v_payable uuid;
  v_is_loan boolean := false;
  v_particular text;
BEGIN
  v_particular := p_voucher.particular;

  SELECT id INTO v_expense FROM accounts WHERE system = 'donors_projects' AND code =
    CASE p_voucher.voucher_type
      WHEN 'zakat_disbursement' THEN 'DP-5021'
      WHEN 'ushr_disbursement' THEN 'DP-5021'
      WHEN 'esal_e_sawab' THEN 'DP-5022'
      ELSE 'DP-5020' END;
  SELECT id INTO v_receivable FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4020';
  SELECT id INTO v_payable FROM accounts WHERE system = 'donors_projects' AND code = 'DP-2020';

  IF p_voucher.fund_type IS NOT NULL THEN
    v_fund_account := fund_account_id(p_voucher.fund_type);
  END IF;
  IF p_voucher.wazifa_award_id IS NOT NULL THEN
    SELECT is_loan INTO v_is_loan FROM wazifa_awards WHERE id = p_voucher.wazifa_award_id;
  END IF;

  -- ── Money leaving: cash out, and the balancing debit ───────────────────
  IF p_voucher.voucher_type IN ('zakat_disbursement', 'ushr_disbursement', 'esal_e_sawab',
                                'kafalat_payment', 'wazifa_payment') THEN
    -- Cash or bank goes down.
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (p_voucher.to_account_id, p_voucher.voucher_date, v_particular, 0, p_voucher.amount_pkr,
            'voucher', p_voucher.id, p_voucher.receipt_no);

    -- A qarz-e-hasana is a receivable, not expenditure. Only a grant is spent.
    IF v_is_loan THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
      VALUES (v_receivable, p_voucher.voucher_date, v_particular, p_voucher.amount_pkr, 0,
              'voucher', p_voucher.id, p_voucher.receipt_no);
    ELSE
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
      VALUES (v_expense, p_voucher.voucher_date, v_particular, p_voucher.amount_pkr, 0,
              'voucher', p_voucher.id, p_voucher.receipt_no);
    END IF;

    -- Memo leg: the restricted fund's unspent balance falls. Same style as
    -- the project-account leg from migration 118 — subsidiary, not part of
    -- the balancing pair.
    IF v_fund_account IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
      VALUES (v_fund_account, p_voucher.voucher_date, v_particular, p_voucher.amount_pkr, 0,
              'voucher', p_voucher.id, p_voucher.receipt_no);
    END IF;

  -- ── Money coming back: a repayment or a student's monthly contribution ─
  ELSIF p_voucher.voucher_type IN ('wazifa_repayment', 'wazifa_contribution') THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (p_voucher.to_account_id, p_voucher.voucher_date, v_particular, p_voucher.amount_pkr, 0,
            'voucher', p_voucher.id, p_voucher.receipt_no);

    IF p_voucher.voucher_type = 'wazifa_repayment' THEN
      -- The receivable shrinks — the student owes less.
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
      VALUES (v_receivable, p_voucher.voucher_date, v_particular, 0, p_voucher.amount_pkr,
              'voucher', p_voucher.id, p_voucher.receipt_no);
    ELSE
      -- A contribution reduces what the committee had to bear, so it lands
      -- against the expenditure rather than against a debt.
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
      VALUES (v_expense, p_voucher.voucher_date, v_particular, 0, p_voucher.amount_pkr,
              'voucher', p_voucher.id, p_voucher.receipt_no);
    END IF;

    IF v_fund_account IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
      VALUES (v_fund_account, p_voucher.voucher_date, v_particular, 0, p_voucher.amount_pkr,
              'voucher', p_voucher.id, p_voucher.receipt_no);
    END IF;
  END IF;

  -- ── Subsidiary ledgers ────────────────────────────────────────────────
  -- The institution's statement. Every line carries the student's code and
  -- the challan number, which is what lets two students at the same school
  -- be told apart and what the committee ticks against the school's own
  -- accounts.
  IF p_voucher.school_id IS NOT NULL THEN
    v_institution_account := ensure_institution_account(p_voucher.school_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (v_institution_account, p_voucher.voucher_date,
            v_particular, p_voucher.amount_pkr, 0,
            'voucher', p_voucher.id, p_voucher.receipt_no, p_voucher.challan_no);
  END IF;

  -- The student's own record of everything spent on them, and everything
  -- they have paid back.
  IF p_voucher.wazifa_student_id IS NOT NULL THEN
    v_student_account := ensure_wazifa_student_account(p_voucher.wazifa_student_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_student_account, p_voucher.voucher_date, v_particular,
            CASE WHEN p_voucher.voucher_type IN ('wazifa_repayment', 'wazifa_contribution') THEN 0 ELSE p_voucher.amount_pkr END,
            CASE WHEN p_voucher.voucher_type IN ('wazifa_repayment', 'wazifa_contribution') THEN p_voucher.amount_pkr ELSE 0 END,
            'voucher', p_voucher.id, p_voucher.receipt_no);
  END IF;

  IF p_voucher.kafalat_child_id IS NOT NULL THEN
    v_student_account := ensure_kafalat_child_account(p_voucher.kafalat_child_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_student_account, p_voucher.voucher_date, v_particular, p_voucher.amount_pkr, 0,
            'voucher', p_voucher.id, p_voucher.receipt_no);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Hooked into the one posting choke point, so welfare vouchers inherit
-- numbering, approval, audit and reversal like everything else.
CREATE OR REPLACE FUNCTION post_voucher_ledger_legs(p_voucher vouchers) RETURNS void AS $$
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

  IF p_voucher.voucher_type IN ('zakat_disbursement', 'ushr_disbursement', 'esal_e_sawab',
                                'kafalat_payment', 'wazifa_payment', 'wazifa_repayment',
                                'wazifa_contribution') THEN
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
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Welfare payouts are not held for approval — the committee already decided
-- when it approved the award or the round.
CREATE OR REPLACE FUNCTION voucher_requires_approval(p_system varchar, p_voucher_type varchar) RETURNS boolean AS $$
DECLARE v_requires boolean; v_has_approvers boolean;
BEGIN
  v_requires := p_voucher_type IN ('withdrawal', 'expense', 'advance', 'advance_settlement',
                                   'complaint_waiver', 'project_transfer')
    AND approval_type_enabled(p_system, CASE WHEN p_voucher_type = 'withdrawal' THEN 'withdrawal' ELSE 'expense' END);
  IF v_requires THEN
    SELECT EXISTS(SELECT 1 FROM approval_approvers WHERE system = p_system AND is_active = true) INTO v_has_approvers;
    v_requires := v_has_approvers;
  END IF;
  RETURN COALESCE(v_requires, false);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
