-- Migration 287: pay while studying, collect once the course is over —
-- a second plan shape for Taleemi Wazifa, alongside the one already live.
--
-- ═════════════════════════════════════════════════════════════════════════
-- The actual request, worked through with real numbers
-- ═════════════════════════════════════════════════════════════════════════
-- A 2-year course costs Rs 480,000 (24 × Rs 20,000). The family can
-- manage half themselves — Rs 240,000, proven by what they already pay —
-- and asks the committee to cover the other Rs 240,000. The committee
-- verifies it the same way it verifies everything: genuine intent,
-- institute, course, actual cost, then family income/expenses/salary/
-- pension. It can grant the full Rs 240,000 or less.
--
-- What's different from the plan already live (migration 278/284/285):
-- that one starts collecting from the student the moment the plan is set,
-- which is backwards for someone who is, right now, a full-time student
-- with no income. This plan pays the committee's share OUT, monthly,
-- while the course is running, and only starts collecting it back once
-- the course ends (or, for a zakat-family student choosing to repay
-- voluntarily, once the committee marks them employed) — labelled
-- "settlement", not "instalment", because it is a genuinely different
-- moment in the relationship. The repayment figure is the family's own
-- proven monthly capacity, not a number recomputed from the award.
--
-- Both plans coexist. Nothing about the collect-now plan changes — every
-- award already on it (Muhammad Azan, TEST Aisha Khan) keeps working
-- exactly as before. A new decision picks one or the other.
--
-- The collection side needed almost nothing new: wazifa_installment_run,
-- wazifa_pay_installment_charge/_advance, wazifa_loan_position,
-- my_wazifa_loans and my_wazifa_dues already do the right thing once
-- installment_start_date is set — for "settle after the course",
-- that date just happens to be in the future (or unset, until an
-- employment trigger sets it), so the existing monthly job naturally
-- waits. The genuinely new half is the disbursement side — paying the
-- committee's share OUT — which reuses the wazifa_payment voucher type
-- and ledger legs that migration 218/224 already built and already
-- handle a loan correctly (debits the receivable, not an invented
-- negative expense); it just had nothing driving it automatically yet.

-- ── What the request actually said, versus what the committee gives ─────
ALTER TABLE wazifa_applications
  ADD COLUMN IF NOT EXISTS actual_course_cost_pkr decimal,
  ADD COLUMN IF NOT EXISTS family_monthly_capacity_pkr decimal;

-- ── The disbursement half — new; the settlement half reuses the fields
-- the collect-now plan already has (student_monthly_contribution_pkr,
-- installment_due_day, installment_start_date/end_date, installment_
-- active, installment_pay_to) rather than duplicating a second copy of
-- the same five columns under a different name ──────────────────────────
ALTER TABLE wazifa_awards
  ADD COLUMN IF NOT EXISTS plan_type varchar NOT NULL DEFAULT 'collect_now'
    CHECK (plan_type IN ('collect_now', 'disburse_then_settle')),
  ADD COLUMN IF NOT EXISTS disbursement_monthly_pkr decimal,
  ADD COLUMN IF NOT EXISTS disbursement_start_date date,
  ADD COLUMN IF NOT EXISTS disbursement_end_date date,
  ADD COLUMN IF NOT EXISTS disbursement_due_day int CHECK (disbursement_due_day BETWEEN 1 AND 28),
  ADD COLUMN IF NOT EXISTS disbursement_pay_to varchar NOT NULL DEFAULT 'student'
    CHECK (disbursement_pay_to IN ('institution', 'student', 'hostel')),
  ADD COLUMN IF NOT EXISTS disbursement_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS disbursed_pkr decimal NOT NULL DEFAULT 0,
  -- course_end: settlement starts a known number of months out, worked
  -- out the moment the plan is set. employment: a zakat-family student
  -- who chose to repay once working — nobody knows that date yet, so
  -- installment_start_date stays null until wazifa_trigger_settlement is
  -- called. none: a zakat-family student who is not repaying at all —
  -- installment_start_date is never set, full stop.
  ADD COLUMN IF NOT EXISTS settlement_trigger varchar
    CHECK (settlement_trigger IN ('course_end', 'employment', 'none'));

CREATE TABLE IF NOT EXISTS wazifa_disbursement_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  award_id uuid NOT NULL REFERENCES wazifa_awards(id) ON DELETE CASCADE,
  charge_no int NOT NULL,
  due_on date NOT NULL,
  amount_pkr decimal NOT NULL,
  paid_pkr decimal NOT NULL DEFAULT 0,
  status varchar NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'paid')),
  paid_on date,
  method varchar,
  voucher_id uuid REFERENCES vouchers(id),
  note text,
  paid_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE (award_id, charge_no)
);

CREATE INDEX IF NOT EXISTS wazifa_disbursement_charges_award_idx ON wazifa_disbursement_charges(award_id, status);

ALTER TABLE wazifa_disbursement_charges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wazifa_disbursement_charges_admin ON wazifa_disbursement_charges;
CREATE POLICY wazifa_disbursement_charges_admin ON wazifa_disbursement_charges FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));
DROP POLICY IF EXISTS wazifa_disbursement_charges_own ON wazifa_disbursement_charges;
CREATE POLICY wazifa_disbursement_charges_own ON wazifa_disbursement_charges FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM wazifa_awards a JOIN wazifa_students s ON s.id = a.student_id
                  WHERE a.id = wazifa_disbursement_charges.award_id AND s.portal_user_id = current_portal_user_id()));
REVOKE ALL ON wazifa_disbursement_charges FROM anon;

-- ── Setting the plan: both halves, one agreement, one signature ─────────
CREATE OR REPLACE FUNCTION wazifa_set_disbursement_settlement_plan(
  p_award_id uuid,
  p_disbursement_monthly decimal, p_disbursement_start date, p_disbursement_end date,
  p_disbursement_due_day int, p_disbursement_pay_to varchar,
  p_settlement_monthly decimal, p_settlement_trigger varchar, p_settlement_due_day int,
  p_terms_text text DEFAULT NULL, p_terms_text_ur text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE; ap wazifa_applications%ROWTYPE;
  v_settlement_start date; v_dest text; v_terms text; v_terms_ur text; v_months int;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false)
     AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_disbursement_monthly <= 0 THEN
    RAISE EXCEPTION 'The monthly support amount has to be more than zero.' USING ERRCODE = 'P0001';
  END IF;
  IF p_disbursement_end <= p_disbursement_start THEN
    RAISE EXCEPTION 'The end date has to be after the start date.' USING ERRCODE = 'P0001';
  END IF;
  IF p_disbursement_due_day < 1 OR p_disbursement_due_day > 28 THEN
    RAISE EXCEPTION 'Choose a due day between 1 and 28.' USING ERRCODE = 'P0001';
  END IF;
  IF p_disbursement_pay_to NOT IN ('institution', 'student', 'hostel') THEN
    RAISE EXCEPTION 'Choose institution, student, or hostel.' USING ERRCODE = 'P0001';
  END IF;
  IF p_settlement_trigger NOT IN ('course_end', 'employment', 'none') THEN
    RAISE EXCEPTION 'Choose when settlement starts.' USING ERRCODE = 'P0001';
  END IF;
  IF p_settlement_trigger <> 'none' AND (p_settlement_monthly IS NULL OR p_settlement_monthly <= 0) THEN
    RAISE EXCEPTION 'Enter the monthly settlement amount.' USING ERRCODE = 'P0001';
  END IF;
  IF p_settlement_trigger <> 'none' AND (p_settlement_due_day < 1 OR p_settlement_due_day > 28) THEN
    RAISE EXCEPTION 'Choose a settlement due day between 1 and 28.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  SELECT * INTO ap FROM wazifa_applications WHERE id = aw.application_id;

  -- The month after support ends, worked out now for course_end; left
  -- for wazifa_trigger_settlement to fill in later otherwise.
  v_settlement_start := CASE WHEN p_settlement_trigger = 'course_end'
    THEN (date_trunc('month', p_disbursement_end) + interval '1 month')::date
    ELSE NULL END;

  UPDATE wazifa_awards SET
    plan_type = 'disburse_then_settle',
    disbursement_monthly_pkr = p_disbursement_monthly,
    disbursement_start_date = p_disbursement_start,
    disbursement_end_date = p_disbursement_end,
    disbursement_due_day = p_disbursement_due_day,
    disbursement_pay_to = p_disbursement_pay_to,
    disbursement_active = true,
    settlement_trigger = p_settlement_trigger,
    -- Settlement reuses the collect-now plan's own fields — a single
    -- mechanism, just switched on at a different moment.
    student_monthly_contribution_pkr = COALESCE(p_settlement_monthly, 0),
    installment_due_day = p_settlement_due_day,
    installment_start_date = v_settlement_start,
    installment_end_date = NULL,
    installment_basis = NULL,
    installment_percentage = NULL,
    installment_pay_to = 'student',
    installment_active = (p_settlement_trigger = 'course_end')
  WHERE id = p_award_id;

  v_dest := CASE p_disbursement_pay_to
    WHEN 'institution' THEN COALESCE(ap.institution, 'the institution')
    WHEN 'hostel' THEN COALESCE(ap.hostel_name, 'the hostel')
    ELSE st.full_name END;
  v_months := GREATEST(1, (
    (EXTRACT(YEAR FROM p_disbursement_end) - EXTRACT(YEAR FROM p_disbursement_start)) * 12
    + (EXTRACT(MONTH FROM p_disbursement_end) - EXTRACT(MONTH FROM p_disbursement_start)) + 1
  )::int);

  v_terms := COALESCE(p_terms_text, format(
    'While you study: the committee will pay Rs %s per month to %s, from %s to %s (%s months), by the %s of each month — Rs %s in total toward %s''s education.%s',
    trim(to_char(p_disbursement_monthly, 'FM999,999,999,990')), v_dest,
    to_char(p_disbursement_start, 'Mon YYYY'), to_char(p_disbursement_end, 'Mon YYYY'),
    v_months, p_disbursement_due_day,
    trim(to_char(p_disbursement_monthly * v_months, 'FM999,999,999,990')), st.full_name,
    CASE p_settlement_trigger
      WHEN 'course_end' THEN format(
        ' After that: %s agrees to pay it back at Rs %s per month, starting %s, by the %s of each month, until it is settled in full. What comes back funds the next student.',
        st.full_name, trim(to_char(p_settlement_monthly, 'FM999,999,999,990')),
        to_char(v_settlement_start, 'Mon YYYY'), p_settlement_due_day)
      WHEN 'employment' THEN format(
        ' This is a zakat-family award. %s is not required to pay it back — but has agreed that once employed, they will pay Rs %s per month, by the %s of each month, until it is settled. What comes back funds the next student, not this one.',
        st.full_name, trim(to_char(p_settlement_monthly, 'FM999,999,999,990')), p_settlement_due_day)
      ELSE ' This is a zakat-family award and is not returnable.'
    END));
  v_terms_ur := COALESCE(p_terms_text_ur, format(
    'پڑھائی کے دوران: کمیٹی ہر ماہ کی %s تاریخ تک %s روپے ماہانہ %s کو ادا کرے گی، %s سے %s تک (%s ماہ) — %s کی تعلیم کے لیے کل %s روپے۔%s',
    p_disbursement_due_day, trim(to_char(p_disbursement_monthly, 'FM999,999,999,990')), v_dest,
    to_char(p_disbursement_start, 'Mon YYYY'), to_char(p_disbursement_end, 'Mon YYYY'), v_months,
    st.full_name, trim(to_char(p_disbursement_monthly * v_months, 'FM999,999,999,990')),
    CASE p_settlement_trigger
      WHEN 'course_end' THEN format(
        ' اس کے بعد: %s ہر ماہ کی %s تاریخ تک %s روپے ماہانہ واپس کرنے پر رضامند ہے، %s سے شروع، جب تک مکمل ادائیگی نہ ہو جائے۔ واپس آنے والی یہی رقم اگلے طالبِ علم تک پہنچے گی۔',
        st.full_name, p_settlement_due_day, trim(to_char(p_settlement_monthly, 'FM999,999,999,990')),
        to_char(v_settlement_start, 'Mon YYYY'))
      WHEN 'employment' THEN format(
        ' یہ زکوٰۃ خاندان کا وظیفہ ہے۔ %s پر واپسی لازم نہیں — مگر رضامند ہے کہ ملازمت ملنے پر ہر ماہ کی %s تاریخ تک %s روپے ماہانہ ادا کرے گا، جب تک مکمل ادائیگی نہ ہو جائے۔ واپس آنے والی رقم اسی طالبِ علم کے بجائے اگلے کی تعلیم پر خرچ ہوگی۔',
        st.full_name, p_settlement_due_day, trim(to_char(p_settlement_monthly, 'FM999,999,999,990')))
      ELSE ' یہ زکوٰۃ خاندان کا وظیفہ ہے اور واپس طلب نہیں کیا جائے گا۔'
    END));

  PERFORM wazifa_send_agreement(p_award_id, v_terms, v_terms_ur);

  RETURN jsonb_build_object(
    'disbursement_monthly', p_disbursement_monthly, 'disbursement_months', v_months,
    'settlement_trigger', p_settlement_trigger, 'settlement_start', v_settlement_start
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_set_disbursement_settlement_plan(uuid, decimal, date, date, int, varchar, decimal, varchar, int, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_set_disbursement_settlement_plan(uuid, decimal, date, date, int, varchar, decimal, varchar, int, text, text) TO authenticated;

-- ── Raising the monthly disbursement due, the same shape as
-- wazifa_installment_run raises what's due to come back ─────────────────
CREATE OR REPLACE FUNCTION wazifa_disbursement_run() RETURNS jsonb AS $$
DECLARE
  v_month date; v_count int := 0; v_next_no int; r record;
BEGIN
  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;

  FOR r IN
    SELECT a.id AS award_id, s.portal_user_id, s.full_name,
           a.disbursement_monthly_pkr AS amount, a.disbursement_due_day AS due_day
      FROM wazifa_awards a
      JOIN wazifa_students s ON s.id = a.student_id
     WHERE a.plan_type = 'disburse_then_settle' AND a.disbursement_active AND a.status = 'active'
       AND COALESCE(a.disbursement_monthly_pkr, 0) > 0 AND a.disbursement_due_day IS NOT NULL
       AND (a.disbursement_start_date IS NULL OR v_month >= date_trunc('month', a.disbursement_start_date)::date)
       AND (a.disbursement_end_date IS NULL OR v_month <= date_trunc('month', a.disbursement_end_date)::date)
       AND NOT EXISTS (SELECT 1 FROM wazifa_disbursement_charges dc
                        WHERE dc.award_id = a.id
                          AND dc.due_on >= v_month AND dc.due_on < v_month + interval '1 month')
  LOOP
    SELECT COALESCE(MAX(charge_no), 0) + 1 INTO v_next_no FROM wazifa_disbursement_charges WHERE award_id = r.award_id;

    INSERT INTO wazifa_disbursement_charges (award_id, charge_no, due_on, amount_pkr)
    VALUES (r.award_id, v_next_no, v_month + (r.due_day - 1), r.amount);

    IF r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (r.portal_user_id, 'wazifa_disbursement_due', 'Taleemi Wazifa support due this month',
        'Rs ' || trim(to_char(r.amount, 'FM999,999,999,990')) || ' is expected by ' || to_char(v_month + (r.due_day - 1), 'DD Mon'),
        '/portal/wazifa');
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('charges_raised', v_count, 'month', v_month);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_disbursement_run() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_disbursement_run() TO authenticated;

-- ── Actually releasing the cash — a deliberate admin action, same as
-- every other payment out of the committee's hand, using the wazifa_
-- payment voucher type and ledger legs migration 218/224 already built
-- and already handle a loan correctly ────────────────────────────────────
CREATE OR REPLACE FUNCTION wazifa_pay_disbursement_charge(
  p_charge_id uuid, p_method varchar, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  c wazifa_disbursement_charges%ROWTYPE; aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE; ap wazifa_applications%ROWTYPE;
  v_cash uuid; v_voucher_id uuid; v_voucher_no varchar; v_party varchar; v_dest_note text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO c FROM wazifa_disbursement_charges WHERE id = p_charge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF c.status = 'paid' THEN RAISE EXCEPTION 'Already paid.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = c.award_id;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  SELECT * INTO ap FROM wazifa_applications WHERE id = aw.application_id;
  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  v_party := CASE aw.disbursement_pay_to
    WHEN 'institution' THEN COALESCE(ap.institution, st.full_name)
    WHEN 'hostel' THEN COALESCE(ap.hostel_name, st.full_name)
    ELSE st.full_name END;
  v_dest_note := CASE aw.disbursement_pay_to
    WHEN 'institution' THEN COALESCE(' · a/c ' || NULLIF(ap.institute_bank_account_no, ''), '')
    WHEN 'hostel' THEN COALESCE(' · a/c ' || NULLIF(ap.hostel_bank_account_no, ''), '')
    ELSE '' END;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, wazifa_student_id, wazifa_award_id, fund_type)
  VALUES ('donors_projects', 'wazifa_payment', (now() AT TIME ZONE 'Asia/Karachi')::date,
    st.full_name || ' (' || st.code || ') — monthly support ' || to_char(c.due_on, 'Mon YYYY')
      || ' — paid to ' || v_party || v_dest_note || COALESCE(' · ' || p_note, ''),
    c.amount_pkr, v_cash, v_cash, v_party, aw.student_id, aw.id,
    CASE aw.funded_by WHEN 'zakat' THEN 'zakat' WHEN 'sadqa' THEN 'sadqa' ELSE 'kafalat' END)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE wazifa_disbursement_charges
     SET paid_pkr = amount_pkr, status = 'paid',
         paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method,
         voucher_id = v_voucher_id, note = COALESCE(p_note, note), paid_by = current_admin_user_id()
   WHERE id = p_charge_id;

  UPDATE wazifa_awards SET disbursed_pkr = disbursed_pkr + c.amount_pkr WHERE id = c.award_id;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', c.amount_pkr, 'charge_id', p_charge_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_pay_disbursement_charge(uuid, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_pay_disbursement_charge(uuid, varchar, text) TO authenticated;

-- ── The employment trigger — the one manual step in the whole engine,
-- because nobody can put a date on it in advance ─────────────────────────
CREATE OR REPLACE FUNCTION wazifa_trigger_settlement(p_award_id uuid) RETURNS jsonb AS $$
DECLARE aw wazifa_awards%ROWTYPE;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false)
     AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF aw.plan_type <> 'disburse_then_settle' OR aw.settlement_trigger <> 'employment' THEN
    RAISE EXCEPTION 'This award is not waiting on an employment trigger.' USING ERRCODE = 'P0001';
  END IF;
  IF aw.installment_active THEN
    RAISE EXCEPTION 'Settlement has already started.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_awards
     SET installment_start_date = (now() AT TIME ZONE 'Asia/Karachi')::date, installment_active = true
   WHERE id = p_award_id;

  RETURN jsonb_build_object('ok', true, 'started_on', (now() AT TIME ZONE 'Asia/Karachi')::date);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_trigger_settlement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_trigger_settlement(uuid) TO authenticated;

-- ── Outstanding, for an award mid-settlement on this plan, is measured
-- from what was actually disbursed — not a percentage of the award, which
-- this plan never used — the same correction migration 285 made for the
-- collect-now plan's own outstanding figure ───────────────────────────────
CREATE OR REPLACE FUNCTION wazifa_loan_position(p_award_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'awarded', a.awarded_amount_pkr,
    'disbursed', wazifa_disbursed(a.id),
    'committed_not_yet_disbursed', GREATEST(a.awarded_amount_pkr - wazifa_disbursed(a.id), 0),
    'repaid', CASE WHEN a.installment_active THEN a.contributed_pkr ELSE a.repaid_pkr END,
    'contributed', a.contributed_pkr,
    'written_off', a.written_off_pkr,
    -- A zakat-family "employment" award is never is_loan (tamleek — zakat
    -- has to pass into full ownership with nothing structurally owed
    -- back) even when the student has voluntarily agreed to give some of
    -- it back once working. That agreement is real and worth tracking —
    -- it just isn't a debt — so this plan's own progress is shown
    -- regardless of is_loan, checked before the is_loan gate rather than
    -- after it.
    'outstanding', CASE
      WHEN a.plan_type = 'disburse_then_settle' AND a.installment_active
        THEN GREATEST(a.disbursed_pkr - a.contributed_pkr - a.written_off_pkr, 0)
      WHEN NOT a.is_loan THEN 0
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

CREATE OR REPLACE FUNCTION my_wazifa_loans()
RETURNS TABLE (
  award_id uuid, academic_year varchar, awarded_amount_pkr decimal,
  repaid_pkr decimal, outstanding decimal, next_due_on date, overdue int
) AS $$
  SELECT
    a.id, a.academic_year,
    CASE WHEN a.installment_active AND a.plan_type = 'disburse_then_settle' THEN a.disbursed_pkr
         WHEN a.installment_active THEN wazifa_plan_total(a.id)
         ELSE a.awarded_amount_pkr END,
    CASE WHEN a.installment_active THEN a.contributed_pkr ELSE a.repaid_pkr END,
    CASE WHEN a.installment_active AND a.plan_type = 'disburse_then_settle'
        THEN GREATEST(a.disbursed_pkr - a.contributed_pkr - a.written_off_pkr, 0)
      WHEN a.installment_active THEN GREATEST(wazifa_plan_total(a.id) - a.contributed_pkr - a.written_off_pkr, 0)
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
  -- A voluntary zakat settlement (is_loan false, chosen once employed)
  -- belongs here too — it's not a debt, but the student who offered it
  -- should still see their own progress against it.
  WHERE (a.is_loan OR (a.plan_type = 'disburse_then_settle' AND a.settlement_trigger = 'employment'))
    AND s.portal_user_id = current_portal_user_id()
  ORDER BY a.created_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_wazifa_loans() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_wazifa_loans() TO authenticated;

-- ── What's due soon needs to include a disbursement due to the student
-- too, not just what the student owes back ────────────────────────────────
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
    'support_due_soon', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', dc.id, 'due_on', dc.due_on, 'amount', dc.amount_pkr - dc.paid_pkr)
        ORDER BY dc.due_on)
        FROM wazifa_disbursement_charges dc
        JOIN wazifa_awards a ON a.id = dc.award_id
        JOIN wazifa_students s ON s.id = a.student_id
       WHERE s.portal_user_id = current_portal_user_id() AND dc.status = 'due'), '[]'::jsonb),
    'total_outstanding', COALESCE((
      SELECT SUM((wazifa_loan_position(a.id) ->> 'outstanding')::decimal)
        FROM wazifa_awards a JOIN wazifa_students s ON s.id = a.student_id
       WHERE s.portal_user_id = current_portal_user_id()
         AND (a.is_loan OR (a.plan_type = 'disburse_then_settle' AND a.settlement_trigger = 'employment'))), 0)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_wazifa_dues() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_wazifa_dues() TO authenticated;

-- ── Both monthly jobs, actually scheduled — wazifa_installment_run has
-- existed since migration 278 and was never wired to anything that
-- fires it on its own; that gap gets closed here along with the new job,
-- rather than shipping a second job with the same unscheduled fate.
-- Same guarded pattern migration 234 established: pg_cron isn't present
-- everywhere this runs (the dry-run database, for one), and a missing
-- extension shouldn't fail the whole migration.
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'wazifa-installment-run';
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'wazifa-disbursement-run';
  PERFORM cron.schedule('wazifa-installment-run', '10 4 * * *', 'SELECT wazifa_installment_run()');
  PERFORM cron.schedule('wazifa-disbursement-run', '15 4 * * *', 'SELECT wazifa_disbursement_run()');
  RAISE NOTICE 'pg_cron: wazifa settlement and disbursement jobs run daily at 09:10/09:15 PKT';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable — these two jobs will not fire on their own. %', SQLERRM;
END $$;
