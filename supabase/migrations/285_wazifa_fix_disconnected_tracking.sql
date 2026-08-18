-- Migration 285: the automated plan (278/284) never told the older
-- reporting functions it existed.
--
-- ═════════════════════════════════════════════════════════════════════════
-- What a live payment exposed
-- ═════════════════════════════════════════════════════════════════════════
-- Paid six real months in advance against a fresh award, cash actually
-- moved (contributed_pkr 0 → 60,000, a real voucher, six charges marked
-- paid) — and every screen that is supposed to show "how much has this
-- student paid" still said zero, before and after:
--
--   my_wazifa_loans()      "outstanding" is awarded_amount_pkr - repaid_pkr;
--                          repaid_pkr is the OLD post-employment field,
--                          never touched by wazifa_pay_installment_charge
--                          or wazifa_pay_installment_advance.
--   wazifa_loan_position() same repaid_pkr, plus "outstanding" is measured
--                          from wazifa_disbursed() — a sum of wazifa_payment
--                          vouchers, a type the new plan never posts.
--   my_wazifa_dues()       "due_soon" reads wazifa_repayment_schedule only
--                          — the fixed-count table the old "Repayment Plan"
--                          button wrote to. The new plan raises charges in
--                          wazifa_installment_charges instead, a table this
--                          function has never looked at.
--
-- All three predate migration 278 and were simply never revisited when the
-- automated plan replaced what they were built to describe. This is why
-- Muhammad Azan's own portal page showed a "Rs 8,333 due 21/08/2026" banner
-- that matched nothing about his actual plan (Rs 3,125/month, due the
-- 10th) — eighteen leftover rows in wazifa_repayment_schedule from before
-- his plan was set, still sitting there at Rs 149,995 / 18, that nothing
-- ever cleaned up once installment_active turned the real plan on.
--
-- The fix in each function is the same branch: an award running the
-- automated plan (installment_active) is measured from
-- wazifa_installment_charges and contributed_pkr; anything else keeps
-- reading exactly what it read before, unchanged, because that reporting
-- is still correct for the zakat / pre-278 loan shape it was built for.

-- ── The plan's own idea of what the full repayable amount is ────────────
-- Same formula wazifa_set_installment_plan already uses to size the
-- monthly figure — pulled out once so every reader agrees with it, rather
-- than each guessing awarded_amount_pkr is the whole story.
CREATE OR REPLACE FUNCTION wazifa_plan_total(p_award_id uuid) RETURNS decimal AS $$
  SELECT CASE WHEN installment_basis = 'percentage'
              THEN ROUND(awarded_amount_pkr * installment_percentage / 100)
              ELSE awarded_amount_pkr END
    FROM wazifa_awards WHERE id = p_award_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_plan_total(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_plan_total(uuid) TO authenticated;

-- ── The student's own "My qarz-e-hasana" numbers ─────────────────────────
CREATE OR REPLACE FUNCTION my_wazifa_loans()
RETURNS TABLE (
  award_id uuid, academic_year varchar, awarded_amount_pkr decimal,
  repaid_pkr decimal, outstanding decimal, next_due_on date, overdue int
) AS $$
  SELECT
    a.id, a.academic_year,
    CASE WHEN a.installment_active THEN wazifa_plan_total(a.id) ELSE a.awarded_amount_pkr END,
    CASE WHEN a.installment_active THEN a.contributed_pkr ELSE a.repaid_pkr END,
    CASE WHEN a.installment_active
      THEN GREATEST(wazifa_plan_total(a.id) - a.contributed_pkr - a.written_off_pkr, 0)
      ELSE GREATEST(a.awarded_amount_pkr - a.repaid_pkr, 0) END,
    CASE WHEN a.installment_active
      THEN (SELECT min(due_on) FROM wazifa_installment_charges WHERE award_id = a.id AND status IN ('due', 'part_paid'))
      ELSE (SELECT min(due_on) FROM wazifa_repayment_schedule WHERE award_id = a.id AND status IN ('due', 'part_paid')) END,
    CASE WHEN a.installment_active
      THEN (SELECT count(*)::int FROM wazifa_installment_charges
             WHERE award_id = a.id AND status IN ('due', 'part_paid') AND due_on < (now() AT TIME ZONE 'Asia/Karachi')::date)
      ELSE (SELECT count(*)::int FROM wazifa_repayment_schedule
             WHERE award_id = a.id AND status IN ('due', 'part_paid') AND due_on < (now() AT TIME ZONE 'Asia/Karachi')::date) END
  FROM wazifa_awards a
  JOIN wazifa_students s ON s.id = a.student_id
  WHERE a.is_loan AND s.portal_user_id = current_portal_user_id()
  ORDER BY a.created_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_wazifa_loans() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_wazifa_loans() TO authenticated;

-- ── The committee-wide / per-award position ──────────────────────────────
CREATE OR REPLACE FUNCTION wazifa_loan_position(p_award_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'awarded', a.awarded_amount_pkr,
    'disbursed', wazifa_disbursed(a.id),
    'committed_not_yet_disbursed', GREATEST(a.awarded_amount_pkr - wazifa_disbursed(a.id), 0),
    'repaid', CASE WHEN a.installment_active THEN a.contributed_pkr ELSE a.repaid_pkr END,
    'contributed', a.contributed_pkr,
    'written_off', a.written_off_pkr,
    'outstanding', CASE WHEN NOT a.is_loan THEN 0
      WHEN a.installment_active THEN GREATEST(wazifa_plan_total(a.id) - a.contributed_pkr - a.written_off_pkr, 0)
      ELSE GREATEST(wazifa_disbursed(a.id) - a.repaid_pkr - a.contributed_pkr - a.written_off_pkr, 0) END,
    'is_loan', a.is_loan,
    'monthly_contribution', a.student_monthly_contribution_pkr,
    'instalments', CASE WHEN a.installment_active
      THEN (SELECT count(*) FROM wazifa_installment_charges WHERE award_id = a.id)
      ELSE (SELECT count(*) FROM wazifa_repayment_schedule WHERE award_id = a.id) END,
    'paid_instalments', CASE WHEN a.installment_active
      THEN (SELECT count(*) FROM wazifa_installment_charges WHERE award_id = a.id AND status = 'paid')
      ELSE (SELECT count(*) FROM wazifa_repayment_schedule WHERE award_id = a.id AND status = 'paid') END,
    'overdue', CASE WHEN a.installment_active
      THEN (SELECT count(*) FROM wazifa_installment_charges
             WHERE award_id = a.id AND status IN ('due', 'part_paid') AND due_on < (now() AT TIME ZONE 'Asia/Karachi')::date)
      ELSE (SELECT count(*) FROM wazifa_repayment_schedule
             WHERE award_id = a.id AND status IN ('due', 'part_paid') AND due_on < (now() AT TIME ZONE 'Asia/Karachi')::date) END,
    'next_due_on', CASE WHEN a.installment_active
      THEN (SELECT min(due_on) FROM wazifa_installment_charges WHERE award_id = a.id AND status IN ('due', 'part_paid'))
      ELSE (SELECT min(due_on) FROM wazifa_repayment_schedule WHERE award_id = a.id AND status IN ('due', 'part_paid')) END
  ) FROM wazifa_awards a WHERE a.id = p_award_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION wazifa_loan_position(uuid) TO authenticated;

-- ── What's actually due soon, on the portal's own dashboard ──────────────
CREATE OR REPLACE FUNCTION my_wazifa_dues() RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'awards', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'award_id', a.id, 'academic_year', a.academic_year,
        'is_loan', a.is_loan, 'position', wazifa_loan_position(a.id)
      ) ORDER BY a.created_at DESC)
      FROM wazifa_awards a JOIN wazifa_students s ON s.id = a.student_id
     WHERE s.portal_user_id = current_portal_user_id() AND a.status <> 'cancelled'), '[]'::jsonb),
    'due_soon', COALESCE((
      SELECT jsonb_agg(x ORDER BY (x ->> 'due_on')::date)
      FROM (
        SELECT jsonb_build_object('id', c.id, 'due_on', c.due_on, 'amount', c.amount_pkr - c.paid_pkr, 'status', c.status) AS x
          FROM wazifa_installment_charges c
          JOIN wazifa_awards a ON a.id = c.award_id
          JOIN wazifa_students s ON s.id = a.student_id
         WHERE s.portal_user_id = current_portal_user_id()
           AND a.installment_active AND c.status IN ('due', 'part_paid')
        UNION ALL
        SELECT jsonb_build_object('id', r.id, 'due_on', r.due_on, 'amount', r.amount_pkr, 'status', r.status)
          FROM wazifa_repayment_schedule r
          JOIN wazifa_awards a ON a.id = r.award_id
          JOIN wazifa_students s ON s.id = a.student_id
         WHERE s.portal_user_id = current_portal_user_id()
           AND NOT a.installment_active AND r.status IN ('due', 'part_paid')
      ) t), '[]'::jsonb),
    'total_outstanding', COALESCE((
      SELECT SUM((wazifa_loan_position(a.id) ->> 'outstanding')::decimal)
        FROM wazifa_awards a JOIN wazifa_students s ON s.id = a.student_id
       WHERE s.portal_user_id = current_portal_user_id() AND a.is_loan), 0)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_wazifa_dues() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_wazifa_dues() TO authenticated;

-- ── The agreement text describes the real direction ──────────────────────
-- The ledger has always been right (post_welfare_voucher_legs debits cash
-- and credits the receivable on a wazifa_contribution voucher — money
-- coming IN, reducing what is owed). Only the sentence describing it was
-- backwards: "the committee will pay you" instead of "you agree to pay
-- back." installment_pay_to still picks whose name the payment is
-- recorded under (the student themselves, or their institution/hostel
-- remitting on their behalf) — the wording now says "paid by", not "paid
-- to", to match which direction the money actually moves.
CREATE OR REPLACE FUNCTION wazifa_set_installment_plan(
  p_award_id uuid, p_basis varchar, p_percentage decimal,
  p_start_date date, p_end_date date, p_due_day int, p_pay_to varchar DEFAULT 'student',
  p_terms_text text DEFAULT NULL, p_terms_text_ur text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE; ap wazifa_applications%ROWTYPE;
  v_total decimal; v_months int; v_monthly decimal; v_terms text; v_terms_ur text; v_dest text;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false)
     AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_basis NOT IN ('percentage', 'full') THEN
    RAISE EXCEPTION 'Choose percentage or full.' USING ERRCODE = 'P0001';
  END IF;
  IF p_basis = 'percentage' AND (p_percentage IS NULL OR p_percentage <= 0 OR p_percentage > 100) THEN
    RAISE EXCEPTION 'Enter a percentage between 1 and 100.' USING ERRCODE = 'P0001';
  END IF;
  IF p_end_date <= p_start_date THEN
    RAISE EXCEPTION 'The end date has to be after the start date.' USING ERRCODE = 'P0001';
  END IF;
  IF p_due_day < 1 OR p_due_day > 28 THEN
    RAISE EXCEPTION 'Choose a due day between 1 and 28, so it falls in every month.' USING ERRCODE = 'P0001';
  END IF;
  IF p_pay_to NOT IN ('institution', 'student', 'hostel') THEN
    RAISE EXCEPTION 'Choose institution, student, or hostel.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  SELECT * INTO ap FROM wazifa_applications WHERE id = aw.application_id;

  v_total := CASE WHEN p_basis = 'full' THEN aw.awarded_amount_pkr ELSE aw.awarded_amount_pkr * p_percentage / 100 END;
  v_months := GREATEST(1, (
    (EXTRACT(YEAR FROM p_end_date) - EXTRACT(YEAR FROM p_start_date)) * 12
    + (EXTRACT(MONTH FROM p_end_date) - EXTRACT(MONTH FROM p_start_date)) + 1
  )::int);
  v_monthly := ROUND(v_total / v_months);

  UPDATE wazifa_awards
     SET student_monthly_contribution_pkr = v_monthly, installment_due_day = p_due_day,
         installment_start_date = p_start_date, installment_end_date = p_end_date,
         installment_basis = p_basis, installment_percentage = CASE WHEN p_basis = 'percentage' THEN p_percentage ELSE NULL END,
         installment_pay_to = p_pay_to
   WHERE id = p_award_id;

  v_dest := CASE p_pay_to
    WHEN 'institution' THEN COALESCE(ap.institution, 'the institution')
    WHEN 'hostel' THEN COALESCE(ap.hostel_name, 'the hostel')
    ELSE st.full_name END;

  v_terms := COALESCE(p_terms_text, format(
    'You are awarded Rs %s toward %s''s education. Of that, Rs %s is qarz-e-hasana — %s agrees to pay it back at Rs %s per month, from %s to %s (%s months), due by the %s of each month. What comes back funds the next student.',
    trim(to_char(aw.awarded_amount_pkr, 'FM999,999,999,990')), st.full_name,
    trim(to_char(v_total, 'FM999,999,999,990')), v_dest,
    trim(to_char(v_monthly, 'FM999,999,999,990')),
    to_char(p_start_date, 'Mon YYYY'), to_char(p_end_date, 'Mon YYYY'), v_months, p_due_day));
  v_terms_ur := COALESCE(p_terms_text_ur, format(
    '%s کی تعلیم کے لیے %s روپے منظور ہوئے۔ اس میں سے %s روپے قرضِ حسنہ ہیں — %s ہر ماہ کی %s تاریخ تک، %s سے %s تک (%s ماہ)، %s روپے ماہانہ واپس کرے گا۔ واپس آنے والی یہی رقم اگلے طالبِ علم تک پہنچے گی۔',
    st.full_name, trim(to_char(aw.awarded_amount_pkr, 'FM999,999,999,990')),
    trim(to_char(v_total, 'FM999,999,999,990')), v_dest, p_due_day,
    to_char(p_start_date, 'Mon YYYY'), to_char(p_end_date, 'Mon YYYY'), v_months,
    trim(to_char(v_monthly, 'FM999,999,999,990'))));

  PERFORM wazifa_send_agreement(p_award_id, v_terms, v_terms_ur);

  RETURN jsonb_build_object('monthly_amount', v_monthly, 'months', v_months, 'total', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_set_installment_plan(uuid, varchar, decimal, date, date, int, varchar, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_set_installment_plan(uuid, varchar, decimal, date, date, int, varchar, text, text) TO authenticated;

-- ── The voucher trail says "received from", not "paid to" ────────────────
CREATE OR REPLACE FUNCTION wazifa_pay_installment_charge(
  p_charge_id uuid, p_amount decimal, p_method varchar, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  c wazifa_installment_charges%ROWTYPE; aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE; ap wazifa_applications%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_remaining decimal; v_party varchar; v_dest_note text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO c FROM wazifa_installment_charges WHERE id = p_charge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Instalment not found' USING ERRCODE = 'P0001'; END IF;
  IF c.status = 'paid' THEN RAISE EXCEPTION 'Already paid.' USING ERRCODE = 'P0001'; END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Enter an amount greater than zero.' USING ERRCODE = 'P0001'; END IF;

  v_remaining := c.amount_pkr - c.paid_pkr;
  IF p_amount > v_remaining + 0.01 THEN
    RAISE EXCEPTION 'That is more than is due — Rs % is left on this instalment.',
      trim(to_char(v_remaining, 'FM999,999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = c.award_id;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  SELECT * INTO ap FROM wazifa_applications WHERE id = aw.application_id;
  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  v_party := CASE aw.installment_pay_to
    WHEN 'institution' THEN COALESCE(ap.institution, st.full_name)
    WHEN 'hostel' THEN COALESCE(ap.hostel_name, st.full_name)
    ELSE st.full_name END;
  v_dest_note := CASE aw.installment_pay_to
    WHEN 'institution' THEN COALESCE(' · a/c ' || NULLIF(ap.institute_bank_account_no, ''), '')
    WHEN 'hostel' THEN COALESCE(' · a/c ' || NULLIF(ap.hostel_bank_account_no, ''), '')
    ELSE '' END;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, wazifa_student_id, wazifa_award_id, fund_type)
  VALUES ('donors_projects', 'wazifa_contribution', (now() AT TIME ZONE 'Asia/Karachi')::date,
    st.full_name || ' (' || st.code || ') — instalment due ' || to_char(c.due_on, 'Mon YYYY')
      || ' — received from ' || v_party || v_dest_note || COALESCE(' · ' || p_note, ''),
    p_amount, v_cash, v_cash, v_party, aw.student_id, aw.id,
    CASE aw.funded_by WHEN 'zakat' THEN 'zakat' WHEN 'sadqa' THEN 'sadqa' ELSE 'kafalat' END)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE wazifa_installment_charges
     SET paid_pkr = paid_pkr + p_amount,
         status = CASE WHEN paid_pkr + p_amount >= amount_pkr - 0.01 THEN 'paid' ELSE 'part_paid' END,
         paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method,
         voucher_id = v_voucher_id, note = COALESCE(p_note, note), paid_by = current_admin_user_id()
   WHERE id = p_charge_id;

  UPDATE wazifa_awards SET contributed_pkr = contributed_pkr + p_amount WHERE id = c.award_id;

  PERFORM wazifa_post_requirement_delta(aw.academic_year, -p_amount,
    st.full_name || ' — instalment ' || to_char(c.due_on, 'Mon YYYY'));

  PERFORM wazifa_allocate_qarz_repayment(aw.student_id, p_amount);

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount, 'charge_id', p_charge_id, 'paid_to', aw.installment_pay_to);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_pay_installment_charge(uuid, decimal, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_pay_installment_charge(uuid, decimal, varchar, text) TO authenticated;

CREATE OR REPLACE FUNCTION wazifa_pay_installment_advance(
  p_award_id uuid, p_months int, p_method varchar
) RETURNS jsonb AS $$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE; ap wazifa_applications%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_total decimal := 0; v_count int := 0;
  v_month date; v_next_no int; v_charge_id uuid; v_charge_ids uuid[] := '{}'; r record;
  v_party varchar; v_dest_note text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_months < 1 OR p_months > 12 THEN
    RAISE EXCEPTION 'Choose between 1 and 12 months.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF NOT aw.installment_active OR COALESCE(aw.student_monthly_contribution_pkr, 0) <= 0 THEN
    RAISE EXCEPTION 'This award has no active instalment plan.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  SELECT * INTO ap FROM wazifa_applications WHERE id = aw.application_id;

  FOR r IN
    SELECT c.id, c.amount_pkr - c.paid_pkr AS remaining, c.due_on
      FROM wazifa_installment_charges c
     WHERE c.award_id = p_award_id AND c.status IN ('due', 'part_paid')
     ORDER BY c.due_on
     LIMIT p_months
  LOOP
    UPDATE wazifa_installment_charges SET paid_pkr = amount_pkr, status = 'paid',
           paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method
     WHERE id = r.id;
    v_total := v_total + r.remaining;
    v_count := v_count + 1;
    v_charge_ids := v_charge_ids || r.id;
  END LOOP;

  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;
  WHILE v_count < p_months LOOP
    v_month := v_month + interval '1 month';
    EXIT WHEN aw.installment_end_date IS NOT NULL AND v_month > date_trunc('month', aw.installment_end_date)::date;
    IF NOT EXISTS (SELECT 1 FROM wazifa_installment_charges
                    WHERE award_id = p_award_id AND due_on >= v_month AND due_on < v_month + interval '1 month') THEN
      SELECT COALESCE(MAX(charge_no), 0) + 1 INTO v_next_no FROM wazifa_installment_charges WHERE award_id = p_award_id;
      INSERT INTO wazifa_installment_charges (award_id, charge_no, due_on, amount_pkr, paid_pkr, status, paid_on, method)
      VALUES (p_award_id, v_next_no, v_month + (aw.installment_due_day - 1), aw.student_monthly_contribution_pkr,
              aw.student_monthly_contribution_pkr, 'paid', (now() AT TIME ZONE 'Asia/Karachi')::date, p_method)
      RETURNING id INTO v_charge_id;
      v_total := v_total + aw.student_monthly_contribution_pkr;
      v_count := v_count + 1;
      v_charge_ids := v_charge_ids || v_charge_id;
    END IF;
  END LOOP;

  IF v_total <= 0 THEN
    RAISE EXCEPTION 'Nothing to pay — this plan has already ended.' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  v_party := CASE aw.installment_pay_to
    WHEN 'institution' THEN COALESCE(ap.institution, st.full_name)
    WHEN 'hostel' THEN COALESCE(ap.hostel_name, st.full_name)
    ELSE st.full_name END;
  v_dest_note := CASE aw.installment_pay_to
    WHEN 'institution' THEN COALESCE(' · a/c ' || NULLIF(ap.institute_bank_account_no, ''), '')
    WHEN 'hostel' THEN COALESCE(' · a/c ' || NULLIF(ap.hostel_bank_account_no, ''), '')
    ELSE '' END;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, wazifa_student_id, wazifa_award_id, fund_type)
  VALUES ('donors_projects', 'wazifa_contribution', (now() AT TIME ZONE 'Asia/Karachi')::date,
    st.full_name || ' (' || st.code || ') — ' || v_count || ' months paid in advance, received from ' || v_party || v_dest_note,
    v_total, v_cash, v_cash, v_party, aw.student_id, aw.id,
    CASE aw.funded_by WHEN 'zakat' THEN 'zakat' WHEN 'sadqa' THEN 'sadqa' ELSE 'kafalat' END)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE wazifa_installment_charges SET voucher_id = v_voucher_id, paid_by = current_admin_user_id()
   WHERE id = ANY(v_charge_ids);

  UPDATE wazifa_awards SET contributed_pkr = contributed_pkr + v_total WHERE id = p_award_id;

  PERFORM wazifa_post_requirement_delta(aw.academic_year, -v_total,
    st.full_name || ' — ' || v_count || ' months paid in advance');

  PERFORM wazifa_allocate_qarz_repayment(aw.student_id, v_total);

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'months_paid', v_count, 'total', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_pay_installment_advance(uuid, int, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_pay_installment_advance(uuid, int, varchar) TO authenticated;

-- ── Retiring the overloads migrations 278 and 284 left behind ───────────
-- Each of these added a parameter and used CREATE OR REPLACE, which only
-- replaces a function with the *exact same* argument list — adding a
-- parameter makes Postgres treat it as a second, separate function
-- instead. Both wazifa_set_installment_plan and wazifa_record_decision
-- have been quietly carrying their pre-284 (and for the decision
-- function, pre-278) selves ever since, reachable by anything that calls
-- them positionally instead of by name. The app itself was never at risk
-- — Supabase's .rpc() always sends named arguments, and only the newest
-- overload has p_pay_to / p_installment_pay_to — but a stray positional
-- call from a script or a future migration would silently hit the old,
-- wrongly-worded version. One current version per function, now.
DROP FUNCTION IF EXISTS wazifa_set_installment_plan(uuid, varchar, decimal, date, date, int, text, text);
DROP FUNCTION IF EXISTS wazifa_record_decision(uuid, varchar, decimal, boolean, varchar, text, text, text, uuid, text);
DROP FUNCTION IF EXISTS wazifa_record_decision(uuid, varchar, decimal, boolean, varchar, text, text, text, uuid, text, varchar, decimal, date, date, int);

-- ── Data cleanup: the leftover fixed-count schedule underneath awards
-- that have since moved to the automated plan ────────────────────────────
-- These are genuinely stale — created by the old "Repayment Plan" button
-- before migration 278 existed, or during this session's own testing of
-- it, and never touched again once installment_active turned the real
-- plan on. Paid rows are left alone on principle (a real payment record
-- is never deleted); only the never-paid leftovers go.
DELETE FROM wazifa_repayment_schedule
 WHERE paid_pkr = 0
   AND award_id IN (SELECT id FROM wazifa_awards WHERE installment_active);
