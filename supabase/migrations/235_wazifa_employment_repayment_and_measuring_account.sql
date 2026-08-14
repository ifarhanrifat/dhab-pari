-- Migration 235: repayment starts when a student has a job, not before —
-- and every account exists the moment the committee says yes, not the moment
-- someone remembers to create it.
--
-- ═════════════════════════════════════════════════════════════════════════
-- The policy this corrects
-- ═════════════════════════════════════════════════════════════════════════
-- wazifa_generate_repayment_plan() asked for a start date and a fixed number
-- of instalments, dividing the loan evenly between them — nothing stopped an
-- admin from starting that plan the week after an award was decided, while
-- the student was still studying and had no income to repay from.
--
-- The committee's real practice is different: a student is asked, while
-- applying, how much they could realistically pay back once working — not
-- how many instalments they want. Repayment does not begin until they
-- actually have a job. From then it continues, one month at a time, at
-- whatever amount the committee actually sets for them (which the student's
-- own figure only informs, never binds), until the loan reaches zero — not a
-- fixed count of instalments decided in advance, because nobody knows in
-- advance how long that will take.
--
-- A full waive-off remains available at any point (wazifa_write_off_loan,
-- migration 220, unchanged) — the committee's own decision, usually for a
-- family already on the zakat list, and never mentioned anywhere a donor or
-- applicant can read. Nothing here adds any wording about it to a form,
-- a notification, or a portal screen.

ALTER TABLE wazifa_students
  ADD COLUMN IF NOT EXISTS employment_status varchar NOT NULL DEFAULT 'studying'
    CHECK (employment_status IN ('studying', 'employed')),
  ADD COLUMN IF NOT EXISTS employed_on date,
  ADD COLUMN IF NOT EXISTS employer_note text;

ALTER TABLE wazifa_awards
  -- The figure the committee actually decided, once repayment starts. Not
  -- the same column as offered_monthly_contribution_pkr on the application —
  -- that was the student's own estimate, made before anyone knew the job or
  -- the wage. This is what the committee set once both were real.
  ADD COLUMN IF NOT EXISTS repayment_monthly_pkr decimal;

-- ── Marking a student employed ───────────────────────────────────────────
-- The single action that turns repayment on. Everything downstream —
-- instalments raised monthly, forever, until the balance clears — follows
-- from this one fact being recorded, the same way kafalat_approve_child()
-- is the one action that starts a child's whole year of costs.
CREATE OR REPLACE FUNCTION wazifa_mark_employed(
  p_student_id uuid, p_monthly_amount decimal, p_employer_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE s wazifa_students%ROWTYPE; v_awards int;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO s FROM wazifa_students WHERE id = p_student_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Student not found' USING ERRCODE = 'P0001'; END IF;
  IF p_monthly_amount < 0 THEN
    RAISE EXCEPTION 'The monthly amount cannot be negative.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_students
     SET employment_status = 'employed', employed_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
         employer_note = p_employer_note, updated_at = now()
   WHERE id = p_student_id;

  -- Every active loan this student carries starts repaying at the same
  -- figure — a student with two years' worth of awards does not get two
  -- separate instalments to track.
  UPDATE wazifa_awards
     SET repayment_monthly_pkr = p_monthly_amount, repay_starts_on = COALESCE(repay_starts_on, (now() AT TIME ZONE 'Asia/Karachi')::date)
   WHERE student_id = p_student_id AND is_loan AND status = 'active';
  GET DIAGNOSTICS v_awards = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'awards_started', v_awards);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_mark_employed(uuid, decimal, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_mark_employed(uuid, decimal, text) TO authenticated;

-- A student found a different job, or the committee revises the figure —
-- changes the going-forward amount without touching what has already been
-- scheduled or paid.
CREATE OR REPLACE FUNCTION wazifa_revise_repayment_amount(p_award_id uuid, p_monthly_amount decimal)
RETURNS jsonb AS $$
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_monthly_amount <= 0 THEN
    RAISE EXCEPTION 'Enter an amount greater than zero.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE wazifa_awards SET repayment_monthly_pkr = p_monthly_amount
   WHERE id = p_award_id AND is_loan;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not a loan, or not found.' USING ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_revise_repayment_amount(uuid, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_revise_repayment_amount(uuid, decimal) TO authenticated;

-- ── Raising the instalments — open-ended, not a fixed count ──────────────
-- Runs monthly, the same shape as every other recurring raise this codebase
-- now has. For each employed student's active loan, it adds one more
-- instalment at the committee's set figure and simply stops adding them once
-- the loan is repaid — nobody has to know in advance how many months that
-- will take, because nobody could know that in advance.
CREATE OR REPLACE FUNCTION wazifa_repayment_run() RETURNS jsonb AS $$
DECLARE
  v_month date; v_count int := 0; r record; v_next_no int; v_outstanding decimal; v_amount decimal;
BEGIN
  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;

  FOR r IN
    SELECT a.id AS award_id, a.awarded_amount_pkr, a.repaid_pkr, a.written_off_pkr,
           a.repayment_monthly_pkr
      FROM wazifa_awards a
      JOIN wazifa_students s ON s.id = a.student_id
     WHERE a.is_loan AND a.status = 'active'
       AND s.employment_status = 'employed'
       AND COALESCE(a.repayment_monthly_pkr, 0) > 0
       AND NOT EXISTS (SELECT 1 FROM wazifa_repayment_schedule rs
                        WHERE rs.award_id = a.id
                          AND rs.due_on >= v_month AND rs.due_on < v_month + interval '1 month')
  LOOP
    v_outstanding := GREATEST(r.awarded_amount_pkr - r.repaid_pkr - r.written_off_pkr, 0);
    IF v_outstanding <= 0 THEN CONTINUE; END IF;

    SELECT COALESCE(MAX(instalment_no), 0) + 1 INTO v_next_no
      FROM wazifa_repayment_schedule WHERE award_id = r.award_id;
    -- The last instalment is whatever is left, never more than the balance —
    -- an open-ended plan still has to stop exactly at zero, not run past it.
    v_amount := LEAST(r.repayment_monthly_pkr, v_outstanding);

    INSERT INTO wazifa_repayment_schedule (award_id, instalment_no, due_on, amount_pkr)
    VALUES (r.award_id, v_next_no, v_month, v_amount);
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('instalments_raised', v_count, 'month', v_month);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_repayment_run() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_repayment_run() TO authenticated;

DO $$
BEGIN
  PERFORM cron.schedule('wazifa-repayment-run', '15 4 * * *', 'SELECT wazifa_repayment_run()');
  RAISE NOTICE 'pg_cron: repayment instalments raised daily at 09:15 PKT for employed students';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable — run wazifa_repayment_run() by hand. %', SQLERRM;
END $$;

-- The old fixed-count planner still exists for a committee member who
-- genuinely wants to hand-schedule a short plan (a small remaining balance,
-- three instalments, done) — it is simply no longer the only way, and the
-- monthly job never touches an award that already has one of these rows for
-- the current month, so the two do not collide.

-- ═════════════════════════════════════════════════════════════════════════
-- Full automation: the account exists the moment the committee says yes
-- ═════════════════════════════════════════════════════════════════════════
-- ensure_wazifa_student_account() has existed since migration 218 and was
-- only ever called lazily, inside voucher posting — a student's subsidiary
-- ledger account did not exist until the first payment touched it. Called
-- here instead, so it exists the instant an award is decided, matching
-- Kafalat's kafalat_approve_child() which has always done this eagerly.
CREATE OR REPLACE FUNCTION wazifa_record_decision(
  p_application_id uuid,
  p_decision varchar,
  p_amount decimal DEFAULT 0,
  p_as_loan boolean DEFAULT false,
  p_funded_by varchar DEFAULT 'sadqa',
  p_reason text DEFAULT NULL,
  p_reason_ur text DEFAULT NULL,
  p_internal_note text DEFAULT NULL,
  p_meeting_id uuid DEFAULT NULL,
  p_shortfall_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  a wazifa_applications%ROWTYPE;
  v_award_id uuid;
  v_status varchar;
  v_year varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false)
     AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized to decide an application' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO a FROM wazifa_applications WHERE id = p_application_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Application not found' USING ERRCODE = 'P0001'; END IF;
  IF a.status IN ('approved', 'declined') THEN
    RAISE EXCEPTION 'This application has already been decided.' USING ERRCODE = 'P0001';
  END IF;

  IF p_decision IN ('approved_full', 'approved_partial') AND p_amount <= 0 THEN
    RAISE EXCEPTION 'An approved application needs an amount.' USING ERRCODE = 'P0001';
  END IF;
  IF p_decision = 'declined' AND (p_reason IS NULL OR trim(p_reason) = '') THEN
    RAISE EXCEPTION 'Write the reason for refusing — the family will read it, and they may apply again once they know what was missing.'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_as_loan AND p_funded_by = 'zakat' THEN
    RAISE EXCEPTION 'A repayable award cannot be funded from zakat. Choose sadqa or the general fund.'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO wazifa_decisions (
    application_id, meeting_id, decision, approved_amount_pkr, as_loan, funded_by,
    reason, reason_ur, internal_note, shortfall_note, decided_by
  ) VALUES (
    p_application_id, p_meeting_id, p_decision,
    CASE WHEN p_decision LIKE 'approved%' THEN p_amount ELSE 0 END,
    p_as_loan, p_funded_by, p_reason, p_reason_ur, p_internal_note, p_shortfall_note,
    current_admin_user_id()
  );

  v_status := CASE p_decision
    WHEN 'approved_full' THEN 'approved'
    WHEN 'approved_partial' THEN 'approved'
    WHEN 'declined' THEN 'declined'
    ELSE 'waitlisted'
  END;

  UPDATE wazifa_applications
     SET status = v_status, decided_at = now(),
         reviewed_by = current_admin_user_id(), reviewed_at = now(),
         decline_reason = CASE WHEN p_decision = 'declined' THEN p_reason ELSE decline_reason END
   WHERE id = p_application_id;

  IF p_decision LIKE 'approved%' THEN
    INSERT INTO wazifa_awards (
      application_id, student_id, academic_year, awarded_amount_pkr,
      funded_by, is_loan, created_by
    ) VALUES (
      p_application_id, a.student_id, a.academic_year, p_amount,
      p_funded_by, p_as_loan, current_admin_user_id()
    ) RETURNING id INTO v_award_id;

    UPDATE wazifa_students SET status = 'awarded', updated_at = now() WHERE id = a.student_id;

    -- The subsidiary ledger account, created now rather than at first
    -- payment — so "Rs 120,000 approved for Ahmed" is visible in the chart
    -- of accounts the same day, not only once a fee has actually been paid.
    PERFORM ensure_wazifa_student_account(a.student_id);

    -- The measuring account, credited the same way Kafalat's is at approval:
    -- the full amount, whether grant or loan. A loan's eventual repayment is
    -- a separate receivable coming back later — it does not reduce what has
    -- to be raised to fund the award today.
    v_year := a.academic_year;
    PERFORM wazifa_post_requirement_delta(v_year, p_amount,
      (SELECT full_name FROM wazifa_students WHERE id = a.student_id) || ' — approved ' || p_decision,
      a.student_id);
  END IF;

  RETURN jsonb_build_object('status', v_status, 'award_id', v_award_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- The Wazifa measuring account — the same idea as Kafalat's, with its own
-- definition of "required"
-- ═════════════════════════════════════════════════════════════════════════
-- Not a copy of Kafalat's calculation. A Kafalat child's cost is a forecast
-- read off a rate card; a Wazifa award is a number the committee decided,
-- sometimes as a loan whose repayment is a separate later event. What both
-- share is the shape: one account per academic year, debited when a
-- commitment is made, credited when real money reduces what is still owed —
-- which for Wazifa means either the committee disburses less than the full
-- award, or the student's own contribution while studying comes in. A loan
-- repayment, arriving after the student is employed, is not counted here —
-- it settles a receivable that already exists, it does not reduce what the
-- committee had to raise to fund the award in the first place.
CREATE OR REPLACE FUNCTION ensure_wazifa_measuring_account(p_academic_year varchar) RETURNS uuid AS $$
DECLARE v_id uuid; v_code varchar;
BEGIN
  v_code := 'WZF-MEASURE-' || split_part(p_academic_year, '-', 1);
  SELECT id INTO v_id FROM accounts WHERE code = v_code AND system = 'donors_projects';
  IF v_id IS NULL THEN
    INSERT INTO accounts (code, name, name_ur, type, system, fund_type, description, is_protected)
    VALUES (v_code, 'Mushtarka Taleemi Wazifa — Measuring ' || p_academic_year,
            'مشترکہ تعلیمی وظیفہ — پیمائش ' || p_academic_year,
            'restricted_fund', 'donors_projects', NULL,
            'What every awarded Wazifa student needs for ' || p_academic_year
              || ', against what has been confirmed so far. A requirement register, '
              || 'not a fund — it holds no money and never appears in a trial balance.',
            true)
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION ensure_wazifa_measuring_account(varchar) TO authenticated;

CREATE OR REPLACE FUNCTION wazifa_post_requirement_delta(
  p_academic_year varchar, p_delta decimal, p_particular text, p_student_id uuid DEFAULT NULL
) RETURNS void AS $$
DECLARE v_account uuid; v_student_account uuid;
BEGIN
  IF p_delta = 0 THEN RETURN; END IF;
  v_account := ensure_wazifa_measuring_account(p_academic_year);

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit)
  VALUES (v_account, (now() AT TIME ZONE 'Asia/Karachi')::date, p_particular,
          GREATEST(p_delta, 0), GREATEST(-p_delta, 0));

  IF p_student_id IS NOT NULL THEN
    SELECT id INTO v_student_account FROM accounts WHERE wazifa_student_id = p_student_id;
    IF v_student_account IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit)
      VALUES (v_student_account, (now() AT TIME ZONE 'Asia/Karachi')::date, p_particular,
              GREATEST(p_delta, 0), GREATEST(-p_delta, 0));
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION wazifa_post_requirement_delta(varchar, decimal, text, uuid) TO authenticated;

-- A student's own contribution while studying reduces what the committee
-- still has to raise, the same principle a named Kafalat sponsor reduces a
-- child's requirement. wazifa_record_contribution (migration 219) already
-- posts the real donation; this adds the credit against the measuring
-- account on top of what it already did.
CREATE OR REPLACE FUNCTION wazifa_record_contribution(
  p_award_id uuid, p_amount decimal, p_method varchar, p_for_month date DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE; v_cash uuid;
  v_voucher_id uuid; v_voucher_no varchar; v_receipt varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, wazifa_student_id, wazifa_award_id, fund_type)
  VALUES ('donors_projects', 'wazifa_contribution', (now() AT TIME ZONE 'Asia/Karachi')::date,
    st.full_name || ' (' || st.code || ') — student''s own monthly share'
      || COALESCE(' · ' || to_char(p_for_month, 'Mon YYYY'), '') || COALESCE(' · ' || p_note, ''),
    p_amount, v_cash, v_cash, st.full_name, aw.student_id, aw.id,
    CASE aw.funded_by WHEN 'zakat' THEN 'zakat' WHEN 'sadqa' THEN 'sadqa' ELSE 'kafalat' END)
  RETURNING id, voucher_no, receipt_no INTO v_voucher_id, v_voucher_no, v_receipt;

  UPDATE wazifa_awards SET contributed_pkr = contributed_pkr + p_amount WHERE id = p_award_id;

  PERFORM wazifa_post_requirement_delta(aw.academic_year, -p_amount,
    st.full_name || ' contributed — ' || COALESCE(to_char(p_for_month, 'Mon YYYY'), to_char(now(), 'Mon YYYY')),
    aw.student_id);

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Ending an award before the year is out — declined-on-review reversal for
-- symmetry with Kafalat's kafalat_end_child(), in case an award needs to be
-- withdrawn (a student leaves the programme, a mistake is corrected).
CREATE OR REPLACE FUNCTION wazifa_end_award(p_award_id uuid, p_reason text DEFAULT NULL) RETURNS jsonb AS $$
DECLARE aw wazifa_awards%ROWTYPE; v_remaining decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF aw.status <> 'active' THEN
    RAISE EXCEPTION 'This award is already %.', aw.status USING ERRCODE = 'P0001';
  END IF;

  v_remaining := GREATEST(aw.awarded_amount_pkr - wazifa_disbursed(p_award_id), 0);
  PERFORM wazifa_post_requirement_delta(aw.academic_year, -v_remaining,
    (SELECT full_name FROM wazifa_students WHERE id = aw.student_id) || ' — award ended: '
      || COALESCE(p_reason, 'no reason given'), aw.student_id);

  UPDATE wazifa_awards SET status = 'cancelled' WHERE id = p_award_id;
  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_end_award(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_end_award(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION wazifa_measuring_position(p_academic_year varchar DEFAULT NULL) RETURNS jsonb AS $$
DECLARE
  v_year varchar; v_account uuid; v_required decimal; v_confirmed decimal;
  v_outstanding decimal; v_months int; v_monthly decimal; v_students int;
BEGIN
  v_year := COALESCE(p_academic_year, kafalat_current_year());
  v_account := ensure_wazifa_measuring_account(v_year);

  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0)
    INTO v_required, v_confirmed FROM ledger_entries WHERE account_id = v_account;
  v_outstanding := GREATEST(v_required - v_confirmed, 0);
  v_months := kafalat_months_remaining(v_year);
  v_monthly := round(v_outstanding / v_months);
  SELECT count(DISTINCT student_id) INTO v_students FROM wazifa_awards
   WHERE academic_year = v_year AND status = 'active';

  RETURN jsonb_build_object(
    'academic_year', v_year, 'account_code', 'WZF-MEASURE-' || split_part(v_year,'-',1),
    'required', v_required, 'confirmed', v_confirmed, 'outstanding', v_outstanding,
    'months_remaining', v_months, 'monthly_target', v_monthly, 'students_active', v_students
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION wazifa_measuring_position(varchar) TO authenticated, anon;

-- pool_monthly_target's wazifa branch summed every active award and divided
-- flat by twelve — the same defect Kafalat's had before migration 230, and
-- fixed the same way.
CREATE OR REPLACE FUNCTION pool_monthly_target(p_pool_id uuid) RETURNS decimal AS $$
DECLARE p support_pools%ROWTYPE; v decimal;
BEGIN
  SELECT * INTO p FROM support_pools WHERE id = p_pool_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF p.manual_monthly_target_pkr IS NOT NULL THEN RETURN p.manual_monthly_target_pkr; END IF;

  IF p.kind = 'kafalat' THEN
    v := (kafalat_measuring_position()->>'monthly_target')::decimal;
  ELSIF p.kind = 'wazifa' THEN
    v := (wazifa_measuring_position()->>'monthly_target')::decimal;
  ELSIF p.kind = 'project' AND p.project_id IS NOT NULL THEN
    SELECT COALESCE(monthly_operating_cost_pkr, 0) INTO v FROM projects WHERE id = p.project_id;
  ELSE
    v := 0;
  END IF;
  RETURN COALESCE(round(v), 0);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Confirming a pool donation must credit whichever measuring account the
-- pool actually belongs to — 231 only ever knew about Kafalat, since Wazifa's
-- did not exist yet.
CREATE OR REPLACE FUNCTION pool_post_confirmed_payment(
  p_pool_id uuid, p_commitment_id uuid, p_donor_name varchar, p_donor_name_ur varchar,
  p_donor_phone varchar, p_is_anonymous boolean, p_amount decimal, p_method varchar,
  p_portal_user_id uuid, p_month date, p_note text
) RETURNS jsonb AS $$
DECLARE pl support_pools%ROWTYPE; v_donor_id uuid; v_year varchar;
BEGIN
  SELECT * INTO pl FROM support_pools WHERE id = p_pool_id;

  INSERT INTO donors (name, name_ur, phone, amount_pkr, date, is_verified,
                      payment_method, is_anonymous, fund_type, portal_user_id,
                      payment_status, notes, submitted_via)
  VALUES (p_donor_name, p_donor_name_ur, p_donor_phone, p_amount,
          (now() AT TIME ZONE 'Asia/Karachi')::date, true, p_method, p_is_anonymous,
          pl.fund_type, p_portal_user_id, 'paid',
          pl.name || ' — ' || to_char(p_month, 'Mon YYYY') || COALESCE(' · ' || p_note, ''),
          'staff')
  RETURNING id INTO v_donor_id;

  IF p_commitment_id IS NOT NULL THEN
    UPDATE pool_commitments SET status = 'active', lapsed_at = NULL, updated_at = now()
     WHERE id = p_commitment_id AND status = 'lapsed';
  END IF;

  -- kafalat_current_year() is really just "the current Punjab school year,
  -- April to March" — Wazifa's own academic_year field already uses the same
  -- 'YYYY-YY' convention, so it is the correct shared boundary for both, not
  -- a Kafalat-only helper misapplied here.
  IF pl.kind = 'kafalat' THEN
    v_year := kafalat_current_year();
    PERFORM kafalat_post_requirement_delta(v_year, -p_amount,
      p_donor_name || ' confirmed — ' || to_char(p_month, 'Mon YYYY'));
  ELSIF pl.kind = 'wazifa' THEN
    v_year := kafalat_current_year();
    PERFORM wazifa_post_requirement_delta(v_year, -p_amount,
      p_donor_name || ' confirmed — ' || to_char(p_month, 'Mon YYYY'));
  END IF;

  RETURN jsonb_build_object('donor_id', v_donor_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION pool_post_confirmed_payment(uuid, uuid, varchar, varchar, varchar, boolean, decimal, varchar, uuid, date, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Fixing ensure_wazifa_student_account()'s sibling copy of the same bug
-- ═════════════════════════════════════════════════════════════════════════
-- ensure_kafalat_child_account() had this exact defect, fixed in migration
-- 232 the first time it was actually driven end to end. This is the same
-- function written the same day (migration 218) for Wazifa, with the same
-- account code built from the first eight hex characters of the student's
-- UUID instead of the student's own guaranteed-unique code sitting one line
-- above it in a variable. It was never caught because nothing called it
-- eagerly before this migration — wazifa_record_decision() now does, and
-- driving it surfaced the same collision risk immediately. No live data is
-- affected; nothing had posted against a wazifa student account before today.
CREATE OR REPLACE FUNCTION ensure_wazifa_student_account(p_student_id uuid) RETURNS uuid AS $$
DECLARE v_id uuid; v_code varchar;
BEGIN
  SELECT id INTO v_id FROM accounts WHERE wazifa_student_id = p_student_id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  SELECT code INTO v_code FROM wazifa_students WHERE id = p_student_id;
  INSERT INTO accounts (code, name, type, system, wazifa_student_id, opening_balance)
  VALUES ('STU-' || COALESCE(v_code, replace(p_student_id::text, '-', '')),
          COALESCE(v_code, 'Student'), 'student', 'donors_projects', p_student_id, 0)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION ensure_wazifa_student_account(uuid) TO authenticated;
