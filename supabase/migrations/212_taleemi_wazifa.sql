-- Migration 212: Taleemi Wazifa — help for students who cannot pay to carry on.
--
-- Kafalat keeps a child in school. This is the next problem: the boy or girl
-- who finished matric or FSc well, wants college, university or a diploma,
-- and stops there because the family cannot find the admission fee. In a
-- village that is where most talent is lost — not at primary, but at the step
-- into Chakwal or Rawalpindi.
--
-- Named for what Pakistan already calls it. The Punjab Zakat & Ushr
-- Department runs "Education Stipends"; taleemi wazifa is the words people
-- here use, so nobody has to be taught a new term to apply for it.
--
-- ═════════════════════════════════════════════════════════════════════════
-- How this differs from Kafalat, and why it is its own module
-- ═════════════════════════════════════════════════════════════════════════
--   The applicant is an adult and applies for themselves.
--   Merit counts alongside need — a limited fund has to choose.
--   Costs are lumpy and dated: an admission fee in one month, a semester fee
--   in another, a hostel deposit before term starts. A flat monthly figure
--   does not describe it.
--   It renews on a result, not on a calendar. A student who fails is not
--   abandoned, but nor is the award automatic.

CREATE SEQUENCE IF NOT EXISTS wazifa_code_seq START 1;
CREATE OR REPLACE FUNCTION next_wazifa_code() RETURNS varchar AS $$
  SELECT 'WZF-' || lpad(nextval('wazifa_code_seq')::text, 4, '0');
$$ LANGUAGE sql;

CREATE TABLE IF NOT EXISTS wazifa_students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar NOT NULL UNIQUE DEFAULT next_wazifa_code(),

  full_name varchar NOT NULL,
  full_name_ur varchar,
  father_name varchar,
  cnic varchar,
  phone varchar,
  email varchar,
  address text,
  date_of_birth date,
  gender varchar CHECK (gender IN ('male', 'female')),
  portal_user_id uuid REFERENCES portal_users(id) ON DELETE SET NULL,
  register_id uuid REFERENCES needs_register(id) ON DELETE SET NULL,

  -- Adults, but still neighbours. Being publicly labelled as the family that
  -- could not pay follows a young person around a village for years, so the
  -- default is that only the code is shown outside the committee.
  display_consent boolean NOT NULL DEFAULT false,
  photo_url text,

  guardian_occupation varchar,
  household_monthly_income_pkr decimal,
  siblings_studying int NOT NULL DEFAULT 0,
  is_orphan boolean NOT NULL DEFAULT false,

  status varchar NOT NULL DEFAULT 'applicant'
    CHECK (status IN ('applicant', 'verified', 'awarded', 'studying',
                      'graduated', 'suspended', 'withdrawn', 'declined')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wazifa_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES wazifa_students(id) ON DELETE CASCADE,
  academic_year varchar NOT NULL,

  -- ── What they want to study ────────────────────────────────────────────
  level varchar NOT NULL
    CHECK (level IN ('intermediate', 'diploma', 'bachelors', 'masters',
                     'technical_certificate', 'medical', 'engineering', 'other')),
  institution varchar NOT NULL,
  programme varchar NOT NULL,
  city varchar,
  duration_years decimal,
  current_year int,
  admission_status varchar NOT NULL DEFAULT 'seeking'
    CHECK (admission_status IN ('seeking', 'admitted', 'enrolled', 'deferred')),

  -- ── Merit ──────────────────────────────────────────────────────────────
  -- A limited fund has to choose between applicants, and marks are the only
  -- measure available that does not come down to whose family the committee
  -- knows better.
  last_exam_name varchar,
  last_exam_marks decimal,
  last_exam_total decimal,
  last_exam_percent decimal,
  achievements text,

  -- ── Need ───────────────────────────────────────────────────────────────
  requested_amount_pkr decimal NOT NULL DEFAULT 0,
  other_support varchar,
  need_statement text,
  need_statement_ur text,

  documents_url text[],

  status varchar NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('draft', 'submitted', 'screening', 'interview',
                      'approved', 'waitlisted', 'declined', 'withdrawn')),
  merit_score decimal,
  need_score decimal,
  total_score decimal,
  review_note text,
  decline_reason text,
  reviewed_by uuid REFERENCES admin_users(id),
  reviewed_at timestamptz,

  created_at timestamptz DEFAULT now(),
  UNIQUE (student_id, academic_year)
);

CREATE INDEX IF NOT EXISTS wazifa_applications_status_idx ON wazifa_applications(status, academic_year);

-- Weighting is a committee decision, not a developer's. Written down and
-- visible so an unsuccessful applicant can be told how the ranking worked.
INSERT INTO site_settings (key, value) VALUES
  ('wazifa_merit_weight', '50'),
  ('wazifa_need_weight', '50'),
  ('wazifa_min_percent', '60'),
  ('wazifa_pass_percent_to_continue', '50')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION wazifa_score_application(p_application_id uuid) RETURNS jsonb AS $$
DECLARE
  a wazifa_applications%ROWTYPE;
  s wazifa_students%ROWTYPE;
  v_merit decimal;
  v_need decimal;
  v_mw decimal;
  v_nw decimal;
  v_income decimal;
BEGIN
  SELECT * INTO a FROM wazifa_applications WHERE id = p_application_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Application not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO s FROM wazifa_students WHERE id = a.student_id;

  v_mw := COALESCE(nullif(setting_text('wazifa_merit_weight', '50'), '')::decimal, 50);
  v_nw := COALESCE(nullif(setting_text('wazifa_need_weight', '50'), '')::decimal, 50);

  v_merit := COALESCE(a.last_exam_percent,
                      CASE WHEN COALESCE(a.last_exam_total, 0) > 0
                           THEN a.last_exam_marks / a.last_exam_total * 100 END,
                      0);

  -- Need falls as income rises, floored at zero. Rs 60,000 a month in a
  -- village is comfortable; nothing at all scores full marks. Orphans and
  -- families already carrying other students in education get a lift,
  -- because both are real costs that income alone does not show.
  v_income := COALESCE(s.household_monthly_income_pkr, 0);
  v_need := GREATEST(100 - (v_income / 600), 0);
  IF s.is_orphan THEN v_need := LEAST(v_need + 15, 100); END IF;
  v_need := LEAST(v_need + (LEAST(s.siblings_studying, 4) * 3), 100);

  UPDATE wazifa_applications
     SET merit_score = round(v_merit, 2),
         need_score = round(v_need, 2),
         total_score = round((v_merit * v_mw + v_need * v_nw) / NULLIF(v_mw + v_nw, 0), 2),
         last_exam_percent = COALESCE(last_exam_percent, round(v_merit, 2))
   WHERE id = p_application_id;

  RETURN jsonb_build_object('merit', round(v_merit, 2), 'need', round(v_need, 2),
                            'total', round((v_merit * v_mw + v_need * v_nw) / NULLIF(v_mw + v_nw, 0), 2));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── The award, and its instalments ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS wazifa_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES wazifa_applications(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES wazifa_students(id) ON DELETE CASCADE,
  academic_year varchar NOT NULL,
  awarded_amount_pkr decimal NOT NULL CHECK (awarded_amount_pkr > 0),

  funded_by varchar NOT NULL DEFAULT 'sadqa'
    CHECK (funded_by IN ('sadqa', 'zakat', 'general', 'sponsor')),
  -- A donor may name a student, the way a kafalat sponsor names a child.
  sponsor_name varchar,
  sponsor_portal_user_id uuid REFERENCES portal_users(id) ON DELETE SET NULL,
  sponsor_is_anonymous boolean NOT NULL DEFAULT false,

  -- Continuation is conditional, and the condition is written on the award
  -- rather than remembered. A student who fails is spoken to, not silently
  -- dropped — but the money is not automatic either.
  continuation_condition text,
  status varchar NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'suspended', 'cancelled')),
  suspended_reason text,
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wazifa_instalments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  award_id uuid NOT NULL REFERENCES wazifa_awards(id) ON DELETE CASCADE,
  -- Real education costs are lumpy and dated, not a flat monthly figure.
  purpose varchar NOT NULL
    CHECK (purpose IN ('admission_fee', 'semester_fee', 'hostel', 'transport',
                       'books', 'equipment', 'exam_fee', 'stipend', 'other')),
  description varchar,
  due_on date,
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),

  -- Paying the institution against a challan is the tightest control, and is
  -- what the committee will want by default. Zakat-funded awards are the
  -- exception: tamleek means the money has to become the student's before it
  -- becomes the university's, so it goes to the student, who pays.
  pay_to varchar NOT NULL DEFAULT 'institution'
    CHECK (pay_to IN ('institution', 'student')),
  status varchar NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'paid', 'skipped', 'cancelled')),
  paid_on date,
  receipt_no varchar,
  challan_url text,
  method varchar CHECK (method IN ('cash', 'bank', 'jazzcash', 'easypaisa')),
  note text,
  paid_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wazifa_instalments_award_idx ON wazifa_instalments(award_id, status);

CREATE OR REPLACE FUNCTION trg_wazifa_instalment_route() RETURNS trigger AS $$
DECLARE v_funded varchar;
BEGIN
  SELECT funded_by INTO v_funded FROM wazifa_awards WHERE id = NEW.award_id;
  IF v_funded = 'zakat' AND NEW.pay_to <> 'student' THEN
    -- Corrected rather than refused: the accountant should not have to know
    -- the fiqh to fill in the form correctly.
    NEW.pay_to := 'student';
    NEW.note := COALESCE(NEW.note || ' · ', '')
      || 'Zakat-funded: paid to the student, who pays the institution (tamleek).';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS wazifa_instalment_route ON wazifa_instalments;
CREATE TRIGGER wazifa_instalment_route
  BEFORE INSERT OR UPDATE ON wazifa_instalments
  FOR EACH ROW EXECUTE FUNCTION trg_wazifa_instalment_route();

-- ── Results, which is what the next year's award turns on ────────────────
CREATE TABLE IF NOT EXISTS wazifa_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES wazifa_students(id) ON DELETE CASCADE,
  award_id uuid REFERENCES wazifa_awards(id) ON DELETE SET NULL,
  term varchar NOT NULL,
  marks_percent decimal CHECK (marks_percent BETWEEN 0 AND 100),
  gpa decimal,
  passed boolean,
  transcript_url text,
  note text,
  created_at timestamptz DEFAULT now()
);

-- ── Paying an instalment ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION wazifa_pay_instalment(
  p_instalment_id uuid, p_method varchar, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  i wazifa_instalments%ROWTYPE;
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
  SELECT * INTO i FROM wazifa_instalments WHERE id = p_instalment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Instalment not found' USING ERRCODE = 'P0001'; END IF;
  IF i.status = 'paid' THEN RAISE EXCEPTION 'Already paid.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = i.award_id;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;

  v_fund := CASE aw.funded_by WHEN 'zakat' THEN 'zakat' WHEN 'sadqa' THEN 'sadqa' ELSE 'kafalat' END;
  v_fund_account := fund_account_id(v_fund);
  v_receipt := next_receipt_no();

  SELECT id INTO v_cash_account FROM accounts
   WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  -- The code, not the name — same rule as the zakat register. A student's
  -- financial need should not be legible to whoever opens the ledger.
  IF v_fund_account IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_fund_account, COALESCE(i.due_on, (now() AT TIME ZONE 'Asia/Karachi')::date),
            'Taleemi Wazifa — ' || st.code || ' · ' || i.purpose,
            i.amount_pkr, 0, 'manual', i.id, v_receipt);
  END IF;

  IF v_cash_account IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_cash_account, COALESCE(i.due_on, (now() AT TIME ZONE 'Asia/Karachi')::date),
            'Taleemi Wazifa — ' || st.code,
            0, i.amount_pkr, 'manual', i.id, v_receipt);
  END IF;

  UPDATE wazifa_instalments
     SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
         receipt_no = v_receipt, method = p_method,
         note = COALESCE(p_note, note), paid_by = current_admin_user_id()
   WHERE id = p_instalment_id;

  RETURN jsonb_build_object('receipt_no', v_receipt, 'amount', i.amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public_wazifa_summary() RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'students_supported', (SELECT count(*) FROM wazifa_students WHERE status IN ('awarded', 'studying')),
    'graduated', (SELECT count(*) FROM wazifa_students WHERE status = 'graduated'),
    'girls', (SELECT count(*) FROM wazifa_students WHERE status IN ('awarded', 'studying') AND gender = 'female'),
    'boys', (SELECT count(*) FROM wazifa_students WHERE status IN ('awarded', 'studying') AND gender = 'male'),
    'applications_open', (SELECT count(*) FROM wazifa_applications WHERE status IN ('submitted', 'screening', 'interview')),
    'awarded_this_year', (SELECT COALESCE(SUM(awarded_amount_pkr), 0) FROM wazifa_awards
                           WHERE created_at >= date_trunc('year', now())),
    'by_level', (SELECT COALESCE(jsonb_object_agg(level, c), '{}'::jsonb) FROM
                  (SELECT a.level, count(*) c FROM wazifa_applications a
                    JOIN wazifa_awards w ON w.application_id = a.id
                   WHERE w.status = 'active' GROUP BY a.level) x)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public_wazifa_summary() TO anon, authenticated;
REVOKE ALL ON FUNCTION wazifa_pay_instalment(uuid, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_pay_instalment(uuid, varchar, text) TO authenticated;
REVOKE ALL ON FUNCTION wazifa_score_application(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_score_application(uuid) TO authenticated;

ALTER TABLE wazifa_students ENABLE ROW LEVEL SECURITY;
ALTER TABLE wazifa_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE wazifa_awards ENABLE ROW LEVEL SECURITY;
ALTER TABLE wazifa_instalments ENABLE ROW LEVEL SECURITY;
ALTER TABLE wazifa_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wazifa_students_admin ON wazifa_students;
CREATE POLICY wazifa_students_admin ON wazifa_students FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

DROP POLICY IF EXISTS wazifa_students_own ON wazifa_students;
CREATE POLICY wazifa_students_own ON wazifa_students FOR SELECT TO authenticated
  USING (portal_user_id IS NOT NULL AND portal_user_id = current_portal_user_id());

DROP POLICY IF EXISTS wazifa_students_apply ON wazifa_students;
CREATE POLICY wazifa_students_apply ON wazifa_students FOR INSERT TO authenticated
  WITH CHECK (portal_user_id = current_portal_user_id() AND status = 'applicant');

DROP POLICY IF EXISTS wazifa_applications_admin ON wazifa_applications;
CREATE POLICY wazifa_applications_admin ON wazifa_applications FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

DROP POLICY IF EXISTS wazifa_applications_own ON wazifa_applications;
CREATE POLICY wazifa_applications_own ON wazifa_applications FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM wazifa_students s
                  WHERE s.id = wazifa_applications.student_id
                    AND s.portal_user_id = current_portal_user_id()));

DROP POLICY IF EXISTS wazifa_applications_submit ON wazifa_applications;
CREATE POLICY wazifa_applications_submit ON wazifa_applications FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM wazifa_students s
             WHERE s.id = wazifa_applications.student_id
               AND s.portal_user_id = current_portal_user_id())
    AND status IN ('draft', 'submitted')
    AND merit_score IS NULL AND need_score IS NULL
  );

DROP POLICY IF EXISTS wazifa_awards_admin ON wazifa_awards;
CREATE POLICY wazifa_awards_admin ON wazifa_awards FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

DROP POLICY IF EXISTS wazifa_awards_own ON wazifa_awards;
CREATE POLICY wazifa_awards_own ON wazifa_awards FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM wazifa_students s
                  WHERE s.id = wazifa_awards.student_id
                    AND s.portal_user_id = current_portal_user_id())
         OR sponsor_portal_user_id = current_portal_user_id());

DROP POLICY IF EXISTS wazifa_instalments_admin ON wazifa_instalments;
CREATE POLICY wazifa_instalments_admin ON wazifa_instalments FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

DROP POLICY IF EXISTS wazifa_results_admin ON wazifa_results;
CREATE POLICY wazifa_results_admin ON wazifa_results FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

DROP POLICY IF EXISTS wazifa_results_own ON wazifa_results;
CREATE POLICY wazifa_results_own ON wazifa_results FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM wazifa_students s
                  WHERE s.id = wazifa_results.student_id
                    AND s.portal_user_id = current_portal_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM wazifa_students s
                       WHERE s.id = wazifa_results.student_id
                         AND s.portal_user_id = current_portal_user_id()));

REVOKE ALL ON wazifa_students FROM anon;
REVOKE ALL ON wazifa_applications FROM anon;
REVOKE ALL ON wazifa_awards FROM anon;
REVOKE ALL ON wazifa_instalments FROM anon;
REVOKE ALL ON wazifa_results FROM anon;
