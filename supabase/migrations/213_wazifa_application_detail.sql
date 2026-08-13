-- Migration 213: the full Taleemi Wazifa application, and qarz-e-hasana.
--
-- The first version of the form asked what a website asks. This one asks what
-- a committee actually needs in order to sit in somebody's courtyard and check
-- that the answers are true — because the form is printed, carried to the
-- house, and gone through line by line.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Who is filling this in
-- ═════════════════════════════════════════════════════════════════════════
-- Three different people fill this form and they are not interchangeable:
-- the student themselves, a parent filling it in for their own child, and a
-- neighbour filling it in about somebody else's child. The third is the one
-- that matters most — the families least likely to apply are the ones who
-- most need to — and it is also the one where the committee has to speak to
-- the family before doing anything else.

ALTER TABLE wazifa_applications
  ADD COLUMN IF NOT EXISTS applicant_for varchar NOT NULL DEFAULT 'self'
    CHECK (applicant_for IN ('self', 'own_child', 'other_family')),
  -- Who held the pen, when that is not the student.
  ADD COLUMN IF NOT EXISTS applicant_name varchar,
  ADD COLUMN IF NOT EXISTS applicant_relation varchar,
  ADD COLUMN IF NOT EXISTS applicant_phone varchar,

  -- ── The household's real position ──────────────────────────────────────
  ADD COLUMN IF NOT EXISTS family_monthly_income_pkr decimal DEFAULT 0,
  ADD COLUMN IF NOT EXISTS father_alive boolean,
  ADD COLUMN IF NOT EXISTS father_occupation varchar,
  ADD COLUMN IF NOT EXISTS mother_occupation varchar,
  ADD COLUMN IF NOT EXISTS house_owned boolean,
  ADD COLUMN IF NOT EXISTS land_owned_kanal decimal,

  -- A long illness in the house is the single most common reason a family
  -- that could otherwise pay cannot. Income alone never shows it.
  ADD COLUMN IF NOT EXISTS has_long_term_patient boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS patient_relation varchar,
  ADD COLUMN IF NOT EXISTS patient_illness varchar,
  ADD COLUMN IF NOT EXISTS patient_monthly_cost_pkr decimal DEFAULT 0,

  -- ── Already receiving help ─────────────────────────────────────────────
  -- Asked because the answer helps rather than disqualifies. A family already
  -- on the zakat register has been visited and verified once already, which
  -- is corroboration the committee would otherwise have to go and gather
  -- again — and if the answer is yes, this application can be matched to the
  -- household's existing MST code instead of starting from nothing.
  --
  -- It also stops the opposite mistake: a family receiving help from four
  -- directions at once while a family receiving none is never reached.
  ADD COLUMN IF NOT EXISTS family_receives_zakat boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS zakat_sources varchar[],
  ADD COLUMN IF NOT EXISTS zakat_monthly_pkr decimal DEFAULT 0,
  -- Set by the committee once matched, never by the applicant.
  ADD COLUMN IF NOT EXISTS register_code varchar,

  -- ── Qarz-e-Hasana ──────────────────────────────────────────────────────
  -- The student may offer to return the money once they are earning. Nothing
  -- is conditional on it and nobody is ranked lower for declining — but a
  -- village that lends to one student and is repaid can educate the next one
  -- with the same rupees, which is how Akhuwat's model works and why it
  -- outlasts a grant fund of the same size.
  ADD COLUMN IF NOT EXISTS repayment_pledge boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS repayment_note text;

-- ── Everyone else in the house ───────────────────────────────────────────
-- One row per person, because "siblings studying: 3" tells the committee
-- nothing it can verify. Three children at the village school is a different
-- household from three children travelling to Chakwal.
CREATE TABLE IF NOT EXISTS wazifa_family_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES wazifa_applications(id) ON DELETE CASCADE,
  full_name varchar NOT NULL,
  relation varchar NOT NULL
    CHECK (relation IN ('father', 'mother', 'brother', 'sister', 'self',
                        'spouse', 'son', 'daughter', 'grandparent', 'other')),
  age int,
  marital_status varchar CHECK (marital_status IN ('single', 'married', 'widowed', 'divorced')),

  -- Studying
  is_studying boolean NOT NULL DEFAULT false,
  institution varchar,
  class_or_year varchar,
  study_location varchar CHECK (study_location IN ('village', 'chakwal', 'other')),
  annual_fee_pkr decimal DEFAULT 0,

  -- Earning
  is_working boolean NOT NULL DEFAULT false,
  occupation varchar,
  -- A mazdoor is paid by the day and a shopkeeper by the month. Forcing both
  -- into one column is how a daily wage gets recorded as a monthly salary and
  -- a family looks eight times better off than it is.
  income_period varchar CHECK (income_period IN ('daily', 'weekly', 'monthly')),
  income_pkr decimal DEFAULT 0,

  is_dependent boolean NOT NULL DEFAULT false,
  note varchar,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wazifa_family_app_idx ON wazifa_family_members(application_id);

-- Everything normalised to a month so the committee can total the column
-- without doing arithmetic in the courtyard.
CREATE OR REPLACE FUNCTION wazifa_monthly_income(p_application_id uuid) RETURNS decimal AS $$
  SELECT COALESCE(SUM(
    CASE income_period
      WHEN 'daily'   THEN income_pkr * 26   -- a working month, not 30 days
      WHEN 'weekly'  THEN income_pkr * 4.33
      ELSE income_pkr
    END), 0)
  FROM wazifa_family_members
  WHERE application_id = p_application_id AND is_working;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION wazifa_family_education_cost(p_application_id uuid) RETURNS decimal AS $$
  SELECT COALESCE(SUM(annual_fee_pkr), 0)
    FROM wazifa_family_members
   WHERE application_id = p_application_id AND is_studying;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION wazifa_monthly_income(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION wazifa_family_education_cost(uuid) TO authenticated;

-- ── The academic record ──────────────────────────────────────────────────
-- Marks out of a total, not a percentage typed in by hand. Matric out of 1100
-- and FSc out of 1100 are not comparable to a BA out of 800, and a committee
-- comparing bare percentages across boards is comparing nothing.
CREATE TABLE IF NOT EXISTS wazifa_academic_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES wazifa_applications(id) ON DELETE CASCADE,
  exam varchar NOT NULL
    CHECK (exam IN ('matric', 'fsc', 'fa', 'ics', 'icom', 'dae',
                    'ba', 'bsc', 'bs', 'bcom', 'masters', 'other')),
  exam_label varchar,
  board_university varchar,
  passing_year int,
  obtained_marks decimal,
  total_marks decimal,
  percent decimal,
  grade varchar,
  roll_no varchar,
  certificate_url text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wazifa_academic_app_idx ON wazifa_academic_records(application_id);

CREATE OR REPLACE FUNCTION trg_wazifa_academic_percent() RETURNS trigger AS $$
BEGIN
  IF NEW.total_marks IS NOT NULL AND NEW.total_marks > 0 AND NEW.obtained_marks IS NOT NULL THEN
    NEW.percent := round((NEW.obtained_marks / NEW.total_marks) * 100, 2);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wazifa_academic_percent ON wazifa_academic_records;
CREATE TRIGGER wazifa_academic_percent
  BEFORE INSERT OR UPDATE ON wazifa_academic_records
  FOR EACH ROW EXECUTE FUNCTION trg_wazifa_academic_percent();

-- The most recent qualification is what merit should be read from, so it is
-- lifted onto the application rather than left for a screen to work out.
CREATE OR REPLACE FUNCTION wazifa_sync_merit(p_application_id uuid) RETURNS void AS $$
DECLARE r wazifa_academic_records%ROWTYPE;
BEGIN
  SELECT * INTO r FROM wazifa_academic_records
   WHERE application_id = p_application_id AND percent IS NOT NULL
   ORDER BY passing_year DESC NULLS LAST, created_at DESC LIMIT 1;
  IF FOUND THEN
    UPDATE wazifa_applications
       SET last_exam_name = COALESCE(r.exam_label, upper(r.exam)),
           last_exam_marks = r.obtained_marks,
           last_exam_total = r.total_marks,
           last_exam_percent = r.percent
     WHERE id = p_application_id;
  END IF;
  PERFORM wazifa_score_application(p_application_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION wazifa_sync_merit(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- An award that has to be returned is a loan, and zakat cannot be lent
-- ═════════════════════════════════════════════════════════════════════════
-- Tamleek means the money becomes the recipient's outright. A zakat payment
-- carrying an obligation to give it back is not tamleek, so a repayable award
-- has to come from sadqa or the general fund. Enforced here rather than left
-- to be remembered, because it will be forgotten exactly once.
ALTER TABLE wazifa_awards
  ADD COLUMN IF NOT EXISTS is_loan boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS loan_terms text,
  ADD COLUMN IF NOT EXISTS repay_starts_on date,
  ADD COLUMN IF NOT EXISTS repaid_pkr decimal NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION trg_wazifa_award_loan_rules() RETURNS trigger AS $$
BEGIN
  IF NEW.is_loan AND NEW.funded_by = 'zakat' THEN
    RAISE EXCEPTION
      'A qarz-e-hasana cannot be funded from zakat. Zakat must pass into the student''s ownership with nothing owed back — fund a repayable award from sadqa or the general fund instead.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wazifa_award_loan_rules ON wazifa_awards;
CREATE TRIGGER wazifa_award_loan_rules
  BEFORE INSERT OR UPDATE ON wazifa_awards
  FOR EACH ROW EXECUTE FUNCTION trg_wazifa_award_loan_rules();

-- Repayments come back into the fund they came from, so the same rupees
-- educate the next student.
CREATE TABLE IF NOT EXISTS wazifa_repayments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  award_id uuid NOT NULL REFERENCES wazifa_awards(id) ON DELETE CASCADE,
  paid_on date NOT NULL DEFAULT current_date,
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  method varchar CHECK (method IN ('cash', 'bank', 'jazzcash', 'easypaisa')),
  receipt_no varchar,
  note text,
  received_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);

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

  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  v_receipt := next_receipt_no();
  v_fund := CASE aw.funded_by WHEN 'sadqa' THEN 'sadqa' ELSE 'kafalat' END;
  v_fund_account := fund_account_id(v_fund);
  SELECT id INTO v_cash_account FROM accounts
   WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

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

  UPDATE wazifa_awards a
     SET repaid_pkr = (SELECT COALESCE(SUM(amount_pkr), 0) FROM wazifa_repayments WHERE award_id = a.id)
   WHERE a.id = p_award_id;

  RETURN jsonb_build_object('receipt_no', v_receipt, 'amount', p_amount);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_record_repayment(uuid, decimal, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_record_repayment(uuid, decimal, varchar, text) TO authenticated;

ALTER TABLE wazifa_family_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE wazifa_academic_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE wazifa_repayments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wazifa_family_admin ON wazifa_family_members;
CREATE POLICY wazifa_family_admin ON wazifa_family_members FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

DROP POLICY IF EXISTS wazifa_family_own ON wazifa_family_members;
CREATE POLICY wazifa_family_own ON wazifa_family_members FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM wazifa_applications a JOIN wazifa_students s ON s.id = a.student_id
                  WHERE a.id = wazifa_family_members.application_id
                    AND s.portal_user_id = current_portal_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM wazifa_applications a JOIN wazifa_students s ON s.id = a.student_id
                       WHERE a.id = wazifa_family_members.application_id
                         AND s.portal_user_id = current_portal_user_id()));

DROP POLICY IF EXISTS wazifa_academic_admin ON wazifa_academic_records;
CREATE POLICY wazifa_academic_admin ON wazifa_academic_records FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

DROP POLICY IF EXISTS wazifa_academic_own ON wazifa_academic_records;
CREATE POLICY wazifa_academic_own ON wazifa_academic_records FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM wazifa_applications a JOIN wazifa_students s ON s.id = a.student_id
                  WHERE a.id = wazifa_academic_records.application_id
                    AND s.portal_user_id = current_portal_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM wazifa_applications a JOIN wazifa_students s ON s.id = a.student_id
                       WHERE a.id = wazifa_academic_records.application_id
                         AND s.portal_user_id = current_portal_user_id()));

DROP POLICY IF EXISTS wazifa_repayments_admin ON wazifa_repayments;
CREATE POLICY wazifa_repayments_admin ON wazifa_repayments FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

REVOKE ALL ON wazifa_family_members FROM anon;
REVOKE ALL ON wazifa_academic_records FROM anon;
REVOKE ALL ON wazifa_repayments FROM anon;

-- ── The printed form ─────────────────────────────────────────────────────
-- Everything the committee carries to the house, in one call, so the printed
-- sheet and the screen can never disagree about what was declared.
CREATE OR REPLACE FUNCTION wazifa_application_sheet(p_application_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'application', to_jsonb(a),
    'student', (SELECT to_jsonb(s) FROM wazifa_students s WHERE s.id = a.student_id),
    'family', (SELECT COALESCE(jsonb_agg(to_jsonb(f) ORDER BY f.created_at), '[]'::jsonb)
                 FROM wazifa_family_members f WHERE f.application_id = a.id),
    'academics', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.passing_year), '[]'::jsonb)
                    FROM wazifa_academic_records r WHERE r.application_id = a.id),
    'monthly_income', wazifa_monthly_income(a.id),
    'family_education_cost', wazifa_family_education_cost(a.id)
  ) FROM wazifa_applications a WHERE a.id = p_application_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_application_sheet(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_application_sheet(uuid) TO authenticated;
