-- Migration 224: a student's own payment against a loan, and what "outstanding"
-- actually means.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Two defects, found by running one student all the way through
-- ═════════════════════════════════════════════════════════════════════════
-- Ahmed Raza, awarded Rs 120,000 as qarz-e-hasana. The committee paid the
-- college Rs 10,000 for semester one, he paid his own Rs 3,000 monthly share,
-- and later repaid Rs 5,000. Afterwards:
--
--     DP-4020  Student Loan Receivable      debit 10,000  credit 5,000
--     DP-5020  Education Expenditure        debit      0  credit 3,000
--
-- An expense account with a credit balance and no debit. Rs 3,000 of negative
-- expenditure that would sit in the accounts as though the committee had been
-- paid for teaching somebody.
--
-- 1. THE CONTRIBUTION WENT TO THE WRONG ACCOUNT.
--    post_welfare_voucher_legs branches on is_loan when it PAYS — a loan
--    debits the receivable, a grant debits expenditure — and then does not
--    branch at all when money comes BACK. A repayment credits the receivable;
--    a contribution always credits expenditure, loan or not.
--
--    On a grant that is right: the family paying part of their own fee reduces
--    what the committee had to bear. On a loan nothing was ever booked to
--    expenditure, so crediting it invents a negative expense and leaves the
--    student owing money he has already handed over.
--
-- 2. "OUTSTANDING" COUNTED MONEY THAT WAS NEVER LENT.
--    wazifa_loan_position reported outstanding 115,000 (120,000 awarded less
--    5,000 repaid) while the ledger said the receivable was 5,000. The gap is
--    110,000 of the award that has not been disbursed yet — a commitment for
--    four more years of fees, not a debt anybody owes today.
--
--    An award is a promise to pay fees as they fall due. It becomes a
--    receivable one instalment at a time, as the money actually leaves. So
--    outstanding is measured from what was disbursed, and the undisbursed
--    remainder is reported separately as what it is: a commitment.

-- What has actually been paid out under an award so far.
CREATE OR REPLACE FUNCTION wazifa_disbursed(p_award_id uuid) RETURNS decimal AS $$
  SELECT COALESCE(SUM(amount_pkr), 0) FROM vouchers
   WHERE wazifa_award_id = p_award_id
     AND voucher_type = 'wazifa_payment'
     AND reverses_voucher_id IS NULL
     AND reversed_by_voucher_id IS NULL;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION wazifa_disbursed(uuid) TO authenticated;

-- ── The legs, with the contribution branch corrected ─────────────────────
-- Re-declared from migration 218. Everything is unchanged except the ELSE
-- branch below, which now asks the same is_loan question the paying side
-- already asked.
CREATE OR REPLACE FUNCTION post_welfare_voucher_legs(p_voucher vouchers) RETURNS void AS $$
DECLARE
  v_expense uuid;
  v_receivable uuid;
  v_payable uuid;
  v_is_loan boolean := false;
  v_fund_account uuid;
  v_institution_account uuid;
  v_student_account uuid;
  v_child_account uuid;
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

  IF p_voucher.voucher_type IN ('zakat_disbursement', 'ushr_disbursement', 'esal_e_sawab',
                                'kafalat_payment', 'wazifa_payment') THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (p_voucher.to_account_id, p_voucher.voucher_date, v_particular, 0, p_voucher.amount_pkr,
            'voucher', p_voucher.id, p_voucher.receipt_no);

    IF v_is_loan THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
      VALUES (v_receivable, p_voucher.voucher_date, v_particular, p_voucher.amount_pkr, 0,
              'voucher', p_voucher.id, p_voucher.receipt_no);
    ELSE
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
      VALUES (v_expense, p_voucher.voucher_date, v_particular, p_voucher.amount_pkr, 0,
              'voucher', p_voucher.id, p_voucher.receipt_no);
    END IF;

    IF v_fund_account IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
      VALUES (v_fund_account, p_voucher.voucher_date, v_particular, p_voucher.amount_pkr, 0,
              'voucher', p_voucher.id, p_voucher.receipt_no);
    END IF;

  ELSIF p_voucher.voucher_type IN ('wazifa_repayment', 'wazifa_contribution') THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (p_voucher.to_account_id, p_voucher.voucher_date, v_particular, p_voucher.amount_pkr, 0,
            'voucher', p_voucher.id, p_voucher.receipt_no);

    -- Money coming back lands wherever the money going out landed. On a loan
    -- that is the receivable, whether the student calls it a repayment or his
    -- monthly share; on a grant there is no debt, so a contribution reduces
    -- what the committee had to bear.
    IF p_voucher.voucher_type = 'wazifa_repayment' OR v_is_loan THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
      VALUES (v_receivable, p_voucher.voucher_date, v_particular, 0, p_voucher.amount_pkr,
              'voucher', p_voucher.id, p_voucher.receipt_no);
    ELSE
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
  IF p_voucher.school_id IS NOT NULL THEN
    v_institution_account := ensure_institution_account(p_voucher.school_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no, bill_number)
    VALUES (v_institution_account, p_voucher.voucher_date, v_particular,
            p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no, p_voucher.challan_no);
  END IF;

  IF p_voucher.wazifa_student_id IS NOT NULL THEN
    v_student_account := ensure_wazifa_student_account(p_voucher.wazifa_student_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_student_account, p_voucher.voucher_date, v_particular,
            CASE WHEN p_voucher.voucher_type IN ('wazifa_repayment', 'wazifa_contribution')
                 THEN 0 ELSE p_voucher.amount_pkr END,
            CASE WHEN p_voucher.voucher_type IN ('wazifa_repayment', 'wazifa_contribution')
                 THEN p_voucher.amount_pkr ELSE 0 END,
            'voucher', p_voucher.id, p_voucher.receipt_no);
  END IF;

  IF p_voucher.kafalat_child_id IS NOT NULL THEN
    v_child_account := ensure_kafalat_child_account(p_voucher.kafalat_child_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_child_account, p_voucher.voucher_date, v_particular,
            p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── What the student actually owes ───────────────────────────────────────
CREATE OR REPLACE FUNCTION wazifa_loan_position(p_award_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'awarded', a.awarded_amount_pkr,
    -- Paid out so far. Until it leaves, it is a promise, not a debt.
    'disbursed', wazifa_disbursed(a.id),
    'committed_not_yet_disbursed',
      GREATEST(a.awarded_amount_pkr - wazifa_disbursed(a.id), 0),
    'repaid', a.repaid_pkr,
    'contributed', a.contributed_pkr,
    'written_off', a.written_off_pkr,
    -- On a loan the student's own monthly share reduces the debt exactly as a
    -- repayment does — the ledger has always treated it that way, and now the
    -- report agrees with the ledger.
    'outstanding', CASE WHEN a.is_loan
      THEN GREATEST(wazifa_disbursed(a.id) - a.repaid_pkr - a.contributed_pkr - a.written_off_pkr, 0)
      ELSE 0 END,
    'is_loan', a.is_loan,
    'monthly_contribution', a.student_monthly_contribution_pkr,
    'instalments', (SELECT count(*) FROM wazifa_repayment_schedule WHERE award_id = a.id),
    'paid_instalments', (SELECT count(*) FROM wazifa_repayment_schedule WHERE award_id = a.id AND status = 'paid'),
    'overdue', (SELECT count(*) FROM wazifa_repayment_schedule
                 WHERE award_id = a.id AND status IN ('due', 'part_paid')
                   AND due_on < (now() AT TIME ZONE 'Asia/Karachi')::date),
    'next_due_on', (SELECT min(due_on) FROM wazifa_repayment_schedule
                     WHERE award_id = a.id AND status IN ('due', 'part_paid'))
  ) FROM wazifa_awards a WHERE a.id = p_award_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION wazifa_loan_position(uuid) TO authenticated;

-- ── And the same correction in the committee-wide report ─────────────────
CREATE OR REPLACE FUNCTION welfare_position() RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'funds', fund_movement_report(),
    -- Now agrees with DP-4020 on the trial balance, which it did not before.
    'loans_outstanding', COALESCE((
      SELECT SUM(GREATEST(wazifa_disbursed(id) - repaid_pkr - contributed_pkr - written_off_pkr, 0))
        FROM wazifa_awards WHERE is_loan AND status <> 'cancelled'), 0),
    'loans_committed_not_disbursed', COALESCE((
      SELECT SUM(GREATEST(awarded_amount_pkr - wazifa_disbursed(id), 0))
        FROM wazifa_awards WHERE status = 'active'), 0),
    'loans_disbursed', COALESCE((
      SELECT SUM(wazifa_disbursed(id)) FROM wazifa_awards WHERE is_loan), 0),
    'loans_repaid', COALESCE((SELECT SUM(repaid_pkr) FROM wazifa_awards WHERE is_loan), 0),
    'loans_written_off', COALESCE((SELECT SUM(written_off_pkr) FROM wazifa_awards WHERE is_loan), 0),
    'student_contributions', COALESCE((SELECT SUM(contributed_pkr) FROM wazifa_awards), 0),
    'grants_given', COALESCE((SELECT SUM(wazifa_disbursed(id)) FROM wazifa_awards WHERE NOT is_loan), 0),
    'grants_awarded', COALESCE((SELECT SUM(awarded_amount_pkr) FROM wazifa_awards WHERE NOT is_loan), 0),
    'owed_to_institutions', COALESCE((SELECT SUM(l.credit - l.debit) FROM ledger_entries l
                                        JOIN accounts a ON a.id = l.account_id
                                       WHERE a.code = 'DP-2020'), 0),
    'paid_to_institutions', COALESCE((SELECT SUM(amount_pkr) FROM vouchers
                                       WHERE school_id IS NOT NULL AND status = 'posted'
                                         AND reverses_voucher_id IS NULL), 0)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION welfare_position() TO authenticated;
