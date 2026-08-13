-- Migration 214: verification, the committee's decision, reapplying, and the
-- repayment plan behind a qarz-e-hasana.
--
-- The path a form takes:
--
--   the family fills it in  →  it is printed  →  a committee member carries it
--   to the house and marks the verification block by hand  →  those marks are
--   typed back in here  →  the committee meets and decides  →  the applicant
--   reads the decision in the portal  →  if refused, they may apply again with
--   what was missing
--
-- The paper and the screen have to agree at every step, which is why the
-- printed block and the form below hold exactly the same questions in exactly
-- the same order.

-- ═════════════════════════════════════════════════════════════════════════
-- What a verifier actually checked
-- ═════════════════════════════════════════════════════════════════════════
-- Every line is yes / no / not applicable with room for what was seen. "Not
-- applicable" is a real answer and has to be available: a student still
-- waiting on admission has no fee challan to show, and forcing that to be a
-- "no" would make an honest applicant look like they were hiding something.
CREATE TABLE IF NOT EXISTS wazifa_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES wazifa_applications(id) ON DELETE CASCADE,
  admin_user_id uuid NOT NULL REFERENCES admin_users(id),
  visited_on date NOT NULL DEFAULT current_date,

  -- Identity
  cnic_seen varchar CHECK (cnic_seen IN ('yes', 'no', 'na')),
  cnic_note varchar,

  -- The education documents. This is the heart of it — marks on a form are a
  -- claim; marks on a DMC held in the verifier's hand are a fact.
  documents_seen varchar CHECK (documents_seen IN ('yes', 'no', 'na')),
  documents_note varchar,
  marks_verified varchar CHECK (marks_verified IN ('yes', 'no', 'na')),
  marks_note varchar,
  -- Filled when the DMC disagrees with the form, which is the single most
  -- useful thing a home visit produces.
  verified_obtained_marks decimal,
  verified_total_marks decimal,
  verified_grade varchar,

  admission_letter_seen varchar CHECK (admission_letter_seen IN ('yes', 'no', 'na')),
  admission_note varchar,
  fee_challan_seen varchar CHECK (fee_challan_seen IN ('yes', 'no', 'na')),
  fee_challan_note varchar,
  verified_annual_cost_pkr decimal,

  -- The household
  home_visited varchar CHECK (home_visited IN ('yes', 'no', 'na')),
  home_note varchar,
  household_matches varchar CHECK (household_matches IN ('yes', 'no', 'na')),
  household_note varchar,
  income_verified varchar CHECK (income_verified IN ('yes', 'no', 'na')),
  income_note varchar,
  observed_monthly_income_pkr decimal,
  siblings_education_verified varchar CHECK (siblings_education_verified IN ('yes', 'no', 'na')),
  siblings_note varchar,
  illness_verified varchar CHECK (illness_verified IN ('yes', 'no', 'na')),
  illness_note varchar,
  zakat_status_verified varchar CHECK (zakat_status_verified IN ('yes', 'no', 'na')),
  zakat_note varchar,

  -- The verifier's own conclusion, separate from the committee's decision.
  -- Keeping them apart matters: a committee that overrules a visit should
  -- have to do so visibly rather than by quietly rewriting the finding.
  recommendation varchar CHECK (recommendation IN ('full', 'partial', 'decline', 'defer')),
  recommended_amount_pkr decimal,
  overall_note text,

  -- Same rule as the needs register. A verifier related to the applicant
  -- declares it, and the declaration is printed on the decision sheet.
  relationship varchar NOT NULL DEFAULT 'none'
    CHECK (relationship IN ('none', 'parent', 'child', 'spouse', 'sibling', 'close_relative', 'other')),

  created_at timestamptz DEFAULT now(),
  UNIQUE (application_id, admin_user_id)
);

CREATE INDEX IF NOT EXISTS wazifa_verifications_app_idx ON wazifa_verifications(application_id);

-- ═════════════════════════════════════════════════════════════════════════
-- The committee's decision
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS wazifa_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES wazifa_applications(id) ON DELETE CASCADE,
  meeting_id uuid REFERENCES agenda_meetings(id) ON DELETE SET NULL,
  decided_on date NOT NULL DEFAULT current_date,

  decision varchar NOT NULL
    CHECK (decision IN ('approved_full', 'approved_partial', 'declined', 'deferred')),
  approved_amount_pkr decimal NOT NULL DEFAULT 0,
  as_loan boolean NOT NULL DEFAULT false,
  funded_by varchar NOT NULL DEFAULT 'sadqa'
    CHECK (funded_by IN ('sadqa', 'zakat', 'general', 'sponsor')),

  -- Two separate fields on purpose. The applicant reads `reason`; the
  -- committee's own frank note stays internal. Merging them means either the
  -- committee writes nothing candid, or the family reads something that was
  -- never meant for them.
  reason text,
  reason_ur text,
  internal_note text,

  -- Written when a partial award is granted, so the family understands the
  -- number rather than only receiving it.
  shortfall_note text,

  decided_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wazifa_decisions_app_idx ON wazifa_decisions(application_id);

-- Reapplying after a refusal. The chain is kept so the committee can see that
-- this is a third attempt and what changed each time — and so a family is not
-- quietly refused four times by four different people for the same reason.
ALTER TABLE wazifa_applications
  ADD COLUMN IF NOT EXISTS supersedes_application_id uuid REFERENCES wazifa_applications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attempt int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz;

-- The same student may apply again in the same year after a refusal, so the
-- one-application-per-year rule has to go.
ALTER TABLE wazifa_applications DROP CONSTRAINT IF EXISTS wazifa_applications_student_id_academic_year_key;
CREATE UNIQUE INDEX IF NOT EXISTS wazifa_applications_live_attempt_idx
  ON wazifa_applications(student_id, academic_year, attempt);

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
  -- The family is owed a reason far more when the answer is no.
  IF p_decision = 'declined' AND (p_reason IS NULL OR trim(p_reason) = '') THEN
    RAISE EXCEPTION 'Write the reason for refusing — the family will read it, and they may apply again once they know what was missing.'
      USING ERRCODE = 'P0001';
  END IF;
  -- A qarz-e-hasana carries an obligation to return the money, which is not
  -- tamleek, so zakat cannot fund it (migration 213).
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
  END IF;

  RETURN jsonb_build_object('status', v_status, 'award_id', v_award_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_record_decision(uuid, varchar, decimal, boolean, varchar, text, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_record_decision(uuid, varchar, decimal, boolean, varchar, text, text, text, uuid, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- The repayment plan
-- ═════════════════════════════════════════════════════════════════════════
-- Interest-free, so the plan is only ever the amount divided by the number of
-- instalments. Nothing is added, ever — which is why the amount is computed
-- here rather than trusted from a screen.
CREATE TABLE IF NOT EXISTS wazifa_repayment_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  award_id uuid NOT NULL REFERENCES wazifa_awards(id) ON DELETE CASCADE,
  instalment_no int NOT NULL,
  due_on date NOT NULL,
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  paid_pkr decimal NOT NULL DEFAULT 0,
  status varchar NOT NULL DEFAULT 'due'
    CHECK (status IN ('due', 'part_paid', 'paid', 'waived', 'deferred')),
  waived_reason text,
  created_at timestamptz DEFAULT now(),
  UNIQUE (award_id, instalment_no)
);

CREATE INDEX IF NOT EXISTS wazifa_repayment_schedule_award_idx
  ON wazifa_repayment_schedule(award_id, status);

CREATE OR REPLACE FUNCTION wazifa_generate_repayment_plan(
  p_award_id uuid, p_starts_on date, p_instalments int
) RETURNS jsonb AS $$
DECLARE
  aw wazifa_awards%ROWTYPE;
  v_each decimal;
  v_last decimal;
  i int;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF NOT aw.is_loan THEN
    RAISE EXCEPTION 'This award is a grant, not a qarz-e-hasana — there is nothing to repay.'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_instalments < 1 THEN
    RAISE EXCEPTION 'At least one instalment is needed.' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM wazifa_repayment_schedule WHERE award_id = p_award_id AND paid_pkr = 0;

  -- Rounded down each month with the remainder on the last instalment, so the
  -- instalments are whole rupees and the total is exactly what was lent — not
  -- a rupee more.
  v_each := floor(aw.awarded_amount_pkr / p_instalments);
  v_last := aw.awarded_amount_pkr - (v_each * (p_instalments - 1));

  FOR i IN 1..p_instalments LOOP
    INSERT INTO wazifa_repayment_schedule (award_id, instalment_no, due_on, amount_pkr)
    VALUES (p_award_id, i,
            (p_starts_on + make_interval(months => i - 1))::date,
            CASE WHEN i = p_instalments THEN v_last ELSE v_each END)
    ON CONFLICT (award_id, instalment_no) DO NOTHING;
  END LOOP;

  UPDATE wazifa_awards SET repay_starts_on = p_starts_on WHERE id = p_award_id;

  RETURN jsonb_build_object('instalments', p_instalments, 'each', v_each, 'last', v_last);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_generate_repayment_plan(uuid, date, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_generate_repayment_plan(uuid, date, int) TO authenticated;

-- A repayment is applied to the oldest unpaid instalment first, then spills
-- into the next. A student paying two months at once should not have to say
-- which two.
CREATE OR REPLACE FUNCTION wazifa_apply_repayment_to_schedule(p_award_id uuid, p_amount decimal)
RETURNS void AS $$
DECLARE
  r RECORD;
  v_left decimal := p_amount;
  v_take decimal;
BEGIN
  FOR r IN SELECT * FROM wazifa_repayment_schedule
            WHERE award_id = p_award_id AND status IN ('due', 'part_paid', 'deferred')
            ORDER BY instalment_no LOOP
    EXIT WHEN v_left <= 0;
    v_take := LEAST(v_left, r.amount_pkr - r.paid_pkr);
    IF v_take > 0 THEN
      UPDATE wazifa_repayment_schedule
         SET paid_pkr = paid_pkr + v_take,
             status = CASE WHEN paid_pkr + v_take >= amount_pkr THEN 'paid' ELSE 'part_paid' END
       WHERE id = r.id;
      v_left := v_left - v_take;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Extends migration 213's repayment so it also settles the schedule.
CREATE OR REPLACE FUNCTION wazifa_record_repayment(
  p_award_id uuid, p_amount decimal, p_method varchar, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  aw wazifa_awards%ROWTYPE;
  st wazifa_students%ROWTYPE;
  v_receipt varchar;
  v_fund_account uuid;
  v_cash_account uuid;
  v_fund varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF NOT aw.is_loan THEN
    RAISE EXCEPTION 'This award was a grant, not a qarz-e-hasana — nothing is owed on it.'
      USING ERRCODE = 'P0001';
  END IF;
  IF aw.repaid_pkr + p_amount > aw.awarded_amount_pkr + 0.01 THEN
    RAISE EXCEPTION 'That is more than is outstanding. Rs % is still owed.',
      trim(to_char(aw.awarded_amount_pkr - aw.repaid_pkr, 'FM999,999,999,990'))
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  v_receipt := next_receipt_no();
  v_fund := CASE aw.funded_by WHEN 'sadqa' THEN 'sadqa' ELSE 'kafalat' END;
  v_fund_account := fund_account_id(v_fund);
  SELECT id INTO v_cash_account FROM accounts
   WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  -- Cash comes in, and the fund it was lent from is made whole again — which
  -- is the entire point of a qarz-e-hasana: the same rupees educate the next
  -- student.
  IF v_cash_account IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_cash_account, (now() AT TIME ZONE 'Asia/Karachi')::date,
            'Qarz-e-Hasana repayment — ' || st.code, p_amount, 0, 'manual', p_award_id, v_receipt);
  END IF;
  IF v_fund_account IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_fund_account, (now() AT TIME ZONE 'Asia/Karachi')::date,
            'Qarz-e-Hasana repayment — ' || st.code, 0, p_amount, 'manual', p_award_id, v_receipt);
  END IF;

  INSERT INTO wazifa_repayments (award_id, amount_pkr, method, receipt_no, note, received_by)
  VALUES (p_award_id, p_amount, p_method, v_receipt, p_note, current_admin_user_id());

  PERFORM wazifa_apply_repayment_to_schedule(p_award_id, p_amount);

  UPDATE wazifa_awards a
     SET repaid_pkr = (SELECT COALESCE(SUM(amount_pkr), 0) FROM wazifa_repayments WHERE award_id = a.id),
         status = CASE
           WHEN (SELECT COALESCE(SUM(amount_pkr), 0) FROM wazifa_repayments WHERE award_id = a.id)
                >= a.awarded_amount_pkr - 0.01 THEN 'completed'
           ELSE a.status END
   WHERE a.id = p_award_id;

  RETURN jsonb_build_object('receipt_no', v_receipt, 'amount', p_amount);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION wazifa_record_repayment(uuid, decimal, varchar, text) TO authenticated;

-- Where a loan stands, for the screen and for the reminder that chases it.
CREATE OR REPLACE FUNCTION wazifa_loan_position(p_award_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'awarded', a.awarded_amount_pkr,
    'repaid', a.repaid_pkr,
    'outstanding', GREATEST(a.awarded_amount_pkr - a.repaid_pkr, 0),
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

-- ═════════════════════════════════════════════════════════════════════════
-- What the applicant is shown
-- ═════════════════════════════════════════════════════════════════════════
-- The decision, the reason, and — when refused — permission to try again.
-- Never the internal note.
CREATE OR REPLACE FUNCTION my_wazifa_decisions()
RETURNS TABLE (
  application_id uuid, academic_year varchar, programme varchar, institution varchar,
  status varchar, attempt int, decided_on date, decision varchar,
  approved_amount_pkr decimal, as_loan boolean, reason text, reason_ur text,
  shortfall_note text, can_reapply boolean
) AS $$
  SELECT
    a.id, a.academic_year, a.programme, a.institution,
    a.status, a.attempt, d.decided_on, d.decision,
    d.approved_amount_pkr, d.as_loan, d.reason, d.reason_ur, d.shortfall_note,
    -- Refused once is not refused for ever. A family that now has the missing
    -- document, or is willing to take the award as a loan, should be able to
    -- come back — and be told so on the same screen that refused them.
    (d.decision IN ('declined', 'deferred'))
  FROM wazifa_applications a
  JOIN wazifa_students s ON s.id = a.student_id
  LEFT JOIN LATERAL (
    SELECT * FROM wazifa_decisions x WHERE x.application_id = a.id
     ORDER BY x.created_at DESC LIMIT 1
  ) d ON true
  WHERE s.portal_user_id = current_portal_user_id()
  ORDER BY a.created_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_wazifa_decisions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_wazifa_decisions() TO authenticated;

CREATE OR REPLACE FUNCTION my_wazifa_loans()
RETURNS TABLE (
  award_id uuid, academic_year varchar, awarded_amount_pkr decimal,
  repaid_pkr decimal, outstanding decimal, next_due_on date, overdue int
) AS $$
  SELECT
    a.id, a.academic_year, a.awarded_amount_pkr, a.repaid_pkr,
    GREATEST(a.awarded_amount_pkr - a.repaid_pkr, 0),
    (SELECT min(due_on) FROM wazifa_repayment_schedule
      WHERE award_id = a.id AND status IN ('due', 'part_paid')),
    (SELECT count(*)::int FROM wazifa_repayment_schedule
      WHERE award_id = a.id AND status IN ('due', 'part_paid')
        AND due_on < (now() AT TIME ZONE 'Asia/Karachi')::date)
  FROM wazifa_awards a
  JOIN wazifa_students s ON s.id = a.student_id
  WHERE a.is_loan AND s.portal_user_id = current_portal_user_id()
  ORDER BY a.created_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_wazifa_loans() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_wazifa_loans() TO authenticated;

ALTER TABLE wazifa_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE wazifa_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wazifa_repayment_schedule ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wazifa_verifications_admin ON wazifa_verifications;
CREATE POLICY wazifa_verifications_admin ON wazifa_verifications FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

-- The applicant does not read the verification sheet. It contains a
-- verifier's frank impression of a household, written to be honest rather
-- than to be read by the family it describes.
DROP POLICY IF EXISTS wazifa_decisions_admin ON wazifa_decisions;
CREATE POLICY wazifa_decisions_admin ON wazifa_decisions FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

DROP POLICY IF EXISTS wazifa_schedule_admin ON wazifa_repayment_schedule;
CREATE POLICY wazifa_schedule_admin ON wazifa_repayment_schedule FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

DROP POLICY IF EXISTS wazifa_schedule_own ON wazifa_repayment_schedule;
CREATE POLICY wazifa_schedule_own ON wazifa_repayment_schedule FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM wazifa_awards a JOIN wazifa_students s ON s.id = a.student_id
                  WHERE a.id = wazifa_repayment_schedule.award_id
                    AND s.portal_user_id = current_portal_user_id()));

REVOKE ALL ON wazifa_verifications FROM anon;
REVOKE ALL ON wazifa_decisions FROM anon;
REVOKE ALL ON wazifa_repayment_schedule FROM anon;
