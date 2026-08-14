-- Migration 233: a year is long enough for a family's circumstances to
-- change, so the committee checks again.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Why re-verification is not the same form as the first one
-- ═════════════════════════════════════════════════════════════════════════
-- A father finds work. A brother finishes his own studies and starts
-- earning. A house that was rented is now owned. None of that shows up on
-- its own — the committee only learns it by going back and asking, the same
-- way it learned the need in the first place. Re-verification is that visit,
-- once a year, with the same weight as the original: two people go, one
-- form, one decision.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Kafalat and Wazifa, handled differently, deliberately
-- ═════════════════════════════════════════════════════════════════════════
-- Wazifa already has everything a re-check needs — wazifa_verifications, the
-- two-verifier gate, wazifa_record_decision. What it does not have is a way
-- to reuse that machinery for a SECOND year without the student re-typing
-- eleven sections from nothing. wazifa_start_renewal() below pre-fills a new
-- application from last year's answers and links it with the
-- supersedes_application_id column migration 212 already built for exactly
-- this — "a family applying again" — so the student edits what changed
-- instead of starting over, and the committee's existing verification and
-- decision screens need no changes at all.
--
-- Kafalat has no verification table yet — a child was approved by one admin
-- reading the package once. kafalat_reverifications below is the household
-- re-check: the same shape of questions as a Wazifa home visit, without the
-- exam marks a school-fee sponsorship has no reason to ask about, ending in
-- one of four honest outcomes — continue, adjust the package, hand off to
-- Wazifa because the child is now past class 10, or end the sponsorship.

-- ═════════════════════════════════════════════════════════════════════════
-- Kafalat: the household re-check
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS kafalat_reverifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id uuid NOT NULL REFERENCES kafalat_children(id) ON DELETE CASCADE,
  academic_year varchar NOT NULL,
  admin_user_id uuid NOT NULL REFERENCES admin_users(id),
  visited_on date NOT NULL DEFAULT current_date,

  home_visited varchar CHECK (home_visited IN ('yes', 'no', 'na')),
  household_matches varchar CHECK (household_matches IN ('yes', 'no', 'na')),
  household_note varchar,

  -- What changed since last year — the whole point of going back.
  father_employment_changed boolean NOT NULL DEFAULT false,
  father_employment_note varchar,
  siblings_employment_changed boolean NOT NULL DEFAULT false,
  siblings_employment_note varchar,
  income_verified varchar CHECK (income_verified IN ('yes', 'no', 'na')),
  observed_monthly_income_pkr decimal,

  school_continuing varchar CHECK (school_continuing IN ('yes', 'no', 'na')),
  current_class varchar,
  attendance_note varchar,

  -- The paper form's co-signers, typed up the way Wazifa's already are — the
  -- signatures are on the hard copy, not in this database.
  co_verifier_names text[],

  recommendation varchar CHECK (recommendation IN ('continue', 'adjust', 'graduate', 'end')),
  recommended_note text,
  overall_note text,

  created_at timestamptz DEFAULT now(),
  UNIQUE (child_id, academic_year)
);

CREATE INDEX IF NOT EXISTS kafalat_reverifications_child_idx ON kafalat_reverifications(child_id);

CREATE OR REPLACE FUNCTION kafalat_verifier_count(p_child_id uuid, p_academic_year varchar)
RETURNS int AS $$
  SELECT COALESCE(MAX(1 + COALESCE(array_length(r.co_verifier_names, 1), 0)), 0)::int
  FROM kafalat_reverifications r
  WHERE r.child_id = p_child_id AND r.academic_year = p_academic_year;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION kafalat_verifier_count(uuid, varchar) TO authenticated;

-- Which active children have not been re-checked yet this academic year —
-- the list a committee works from each spring.
CREATE OR REPLACE FUNCTION kafalat_reverification_due() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'child_id', c.id, 'code', c.code, 'name', c.first_name, 'guardian', c.guardian_name,
    'guardian_phone', c.guardian_phone, 'current_class', c.current_class, 'joined_on', c.joined_on,
    'last_verified', (SELECT max(r.academic_year) FROM kafalat_reverifications r WHERE r.child_id = c.id)
  ) ORDER BY c.code), '[]'::jsonb)
  FROM kafalat_children c
  WHERE c.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM kafalat_reverifications r
                     WHERE r.child_id = c.id AND r.academic_year = kafalat_current_year());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION kafalat_reverification_due() TO authenticated;

-- Recording the visit. Two verifiers, the same rule as everywhere else this
-- codebase asks a committee to confirm something in person.
CREATE OR REPLACE FUNCTION kafalat_record_reverification(
  p_child_id uuid, p_home_visited varchar, p_household_matches varchar, p_household_note varchar,
  p_father_employment_changed boolean, p_father_employment_note varchar,
  p_siblings_employment_changed boolean, p_siblings_employment_note varchar,
  p_income_verified varchar, p_observed_monthly_income_pkr decimal,
  p_school_continuing varchar, p_current_class varchar, p_attendance_note varchar,
  p_co_verifier_names text[], p_recommendation varchar, p_recommended_note text, p_overall_note text
) RETURNS jsonb AS $$
DECLARE v_year varchar; v_id uuid; v_verifiers int;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  v_year := kafalat_current_year();

  INSERT INTO kafalat_reverifications (child_id, academic_year, admin_user_id, home_visited,
    household_matches, household_note, father_employment_changed, father_employment_note,
    siblings_employment_changed, siblings_employment_note, income_verified,
    observed_monthly_income_pkr, school_continuing, current_class, attendance_note,
    co_verifier_names, recommendation, recommended_note, overall_note)
  VALUES (p_child_id, v_year, current_admin_user_id(), p_home_visited, p_household_matches,
    p_household_note, p_father_employment_changed, p_father_employment_note,
    p_siblings_employment_changed, p_siblings_employment_note, p_income_verified,
    p_observed_monthly_income_pkr, p_school_continuing, p_current_class, p_attendance_note,
    p_co_verifier_names, p_recommendation, p_recommended_note, p_overall_note)
  ON CONFLICT (child_id, academic_year) DO UPDATE SET
    home_visited = EXCLUDED.home_visited, household_matches = EXCLUDED.household_matches,
    household_note = EXCLUDED.household_note,
    father_employment_changed = EXCLUDED.father_employment_changed,
    father_employment_note = EXCLUDED.father_employment_note,
    siblings_employment_changed = EXCLUDED.siblings_employment_changed,
    siblings_employment_note = EXCLUDED.siblings_employment_note,
    income_verified = EXCLUDED.income_verified,
    observed_monthly_income_pkr = EXCLUDED.observed_monthly_income_pkr,
    school_continuing = EXCLUDED.school_continuing, current_class = EXCLUDED.current_class,
    attendance_note = EXCLUDED.attendance_note, co_verifier_names = EXCLUDED.co_verifier_names,
    recommendation = EXCLUDED.recommendation, recommended_note = EXCLUDED.recommended_note,
    overall_note = EXCLUDED.overall_note
  RETURNING id INTO v_id;

  v_verifiers := kafalat_verifier_count(p_child_id, v_year);
  IF v_verifiers < 2 THEN
    RETURN jsonb_build_object('reverification_id', v_id, 'verifiers', v_verifiers,
      'note', 'Recorded, but a decision needs a second verifier''s name before it can be acted on.');
  END IF;

  -- Update the child's own class if the visit found it had moved on — the
  -- requirement calculation reads current_class directly.
  IF p_current_class IS NOT NULL THEN
    UPDATE kafalat_children SET current_class = p_current_class, updated_at = now() WHERE id = p_child_id;
  END IF;

  IF p_recommendation = 'graduate' THEN
    PERFORM kafalat_end_child(p_child_id, 'graduated', 'Past class 10 at re-verification — referred to Taleemi Wazifa.');
  ELSIF p_recommendation = 'end' THEN
    PERFORM kafalat_end_child(p_child_id, 'withdrawn', COALESCE(p_recommended_note, 'Ended at annual re-verification.'));
  ELSIF p_recommendation IN ('continue', 'adjust') THEN
    -- Re-run the rate card. 'adjust' matters when the committee has just
    -- hand-edited a package line to reflect what the visit found — this
    -- picks up the new figure rather than silently keeping last year's.
    PERFORM kafalat_generate_requirement(p_child_id, v_year);
  END IF;

  RETURN jsonb_build_object('reverification_id', v_id, 'verifiers', v_verifiers,
                            'recommendation', p_recommendation);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION kafalat_record_reverification(uuid, varchar, varchar, varchar, boolean, varchar,
  boolean, varchar, varchar, decimal, varchar, varchar, varchar, text[], varchar, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kafalat_record_reverification(uuid, varchar, varchar, varchar, boolean, varchar,
  boolean, varchar, varchar, decimal, varchar, varchar, varchar, text[], varchar, text, text) TO authenticated;

-- The printable sheet — one child, every year's visit, ready to carry to the
-- house and back.
CREATE OR REPLACE FUNCTION kafalat_reverification_sheet(p_child_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'child', (SELECT to_jsonb(c) FROM kafalat_children c WHERE c.id = p_child_id),
    'academic_year', kafalat_current_year(),
    'history', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'academic_year', r.academic_year, 'visited_on', r.visited_on,
        'verifier', (SELECT full_name FROM admin_users WHERE id = r.admin_user_id),
        'co_verifier_names', r.co_verifier_names,
        'household_matches', r.household_matches, 'household_note', r.household_note,
        'father_employment_changed', r.father_employment_changed,
        'father_employment_note', r.father_employment_note,
        'siblings_employment_changed', r.siblings_employment_changed,
        'siblings_employment_note', r.siblings_employment_note,
        'income_verified', r.income_verified, 'observed_monthly_income_pkr', r.observed_monthly_income_pkr,
        'school_continuing', r.school_continuing, 'current_class', r.current_class,
        'recommendation', r.recommendation, 'recommended_note', r.recommended_note,
        'overall_note', r.overall_note
      ) ORDER BY r.academic_year DESC)
        FROM kafalat_reverifications r WHERE r.child_id = p_child_id
    ), '[]'::jsonb)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION kafalat_reverification_sheet(uuid) TO authenticated;

ALTER TABLE kafalat_reverifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kafalat_reverifications_admin ON kafalat_reverifications;
CREATE POLICY kafalat_reverifications_admin ON kafalat_reverifications FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));
REVOKE ALL ON kafalat_reverifications FROM anon;

-- ═════════════════════════════════════════════════════════════════════════
-- Wazifa: a renewal is last year's application, editable, not a blank one
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION wazifa_start_renewal(p_award_id uuid) RETURNS jsonb AS $$
DECLARE
  a wazifa_awards%ROWTYPE; prev wazifa_applications%ROWTYPE; v_new_id uuid; v_year varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO a FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO prev FROM wazifa_applications WHERE id = a.application_id;

  v_year := CASE WHEN extract(month FROM (now() AT TIME ZONE 'Asia/Karachi')) >= 4
                 THEN extract(year FROM (now() AT TIME ZONE 'Asia/Karachi'))::text || '-'
                   || to_char((now() AT TIME ZONE 'Asia/Karachi') + interval '1 year', 'YY')
                 ELSE (extract(year FROM (now() AT TIME ZONE 'Asia/Karachi')) - 1)::text || '-'
                   || to_char((now() AT TIME ZONE 'Asia/Karachi'), 'YY') END;

  IF EXISTS (SELECT 1 FROM wazifa_applications
              WHERE student_id = prev.student_id AND academic_year = v_year
                AND status <> 'withdrawn') THEN
    RAISE EXCEPTION 'A renewal for % has already been started for %.', v_year,
      (SELECT full_name FROM wazifa_students WHERE id = prev.student_id) USING ERRCODE = 'P0001';
  END IF;

  -- Every field copied forward, ready for the student to correct what
  -- changed rather than retype eleven sections from nothing. status='draft'
  -- so it goes through migration 223's ordinary edit-until-reviewed path.
  INSERT INTO wazifa_applications (
    student_id, academic_year, level, institution, programme, city, duration_years,
    current_year, admission_status, last_exam_name, last_exam_marks, last_exam_total,
    requested_amount_pkr, other_support, need_statement, need_statement_ur,
    applicant_for, family_monthly_income_pkr, father_alive, father_occupation,
    mother_occupation, house_owned, land_owned_kanal, has_long_term_patient,
    patient_relation, patient_illness, patient_monthly_cost_pkr, family_receives_zakat,
    zakat_sources, zakat_monthly_pkr, requested_as, has_family_business,
    family_business_kind, family_business_share_pkr, family_business_note,
    declared_cnic, declared_b_form_no, declared_dob, declared_address,
    offered_monthly_contribution_pkr, institution_monthly_fee_pkr,
    status, supersedes_application_id, attempt
  )
  SELECT
    student_id, v_year, level, institution, programme, city, duration_years,
    COALESCE(current_year, 0) + 1, admission_status, last_exam_name, last_exam_marks, last_exam_total,
    requested_amount_pkr, other_support, need_statement, need_statement_ur,
    applicant_for, family_monthly_income_pkr, father_alive, father_occupation,
    mother_occupation, house_owned, land_owned_kanal, has_long_term_patient,
    patient_relation, patient_illness, patient_monthly_cost_pkr, family_receives_zakat,
    zakat_sources, zakat_monthly_pkr, requested_as, has_family_business,
    family_business_kind, family_business_share_pkr, family_business_note,
    declared_cnic, declared_b_form_no, declared_dob, declared_address,
    offered_monthly_contribution_pkr, institution_monthly_fee_pkr,
    'draft', prev.id, COALESCE(prev.attempt, 1) + 1
  FROM wazifa_applications WHERE id = prev.id
  RETURNING id INTO v_new_id;

  -- Family members carry forward too — ages and circumstances move on, but
  -- retyping every sibling from scratch is exactly the friction a renewal is
  -- meant to avoid.
  INSERT INTO wazifa_family_members (application_id, full_name, relation, age, marital_status,
    is_studying, institution, class_or_year, study_location, annual_fee_pkr, is_working,
    occupation, income_period, income_pkr, is_dependent, note, school_id)
  SELECT v_new_id, full_name, relation, COALESCE(age, 0) + 1, marital_status,
    is_studying, institution, class_or_year, study_location, annual_fee_pkr, is_working,
    occupation, income_period, income_pkr, is_dependent, note, school_id
  FROM wazifa_family_members WHERE application_id = prev.id;

  RETURN jsonb_build_object('application_id', v_new_id, 'academic_year', v_year,
                            'student_id', prev.student_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_start_renewal(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_start_renewal(uuid) TO authenticated;

-- Active awards nobody has renewed yet this academic year.
CREATE OR REPLACE FUNCTION wazifa_renewal_due() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'award_id', a.id, 'student_name', s.full_name, 'student_code', s.code,
    'academic_year', ap.academic_year, 'institution', ap.institution,
    'is_loan', a.is_loan, 'awarded_amount', a.awarded_amount_pkr
  ) ORDER BY s.code), '[]'::jsonb)
  FROM wazifa_awards a
  JOIN wazifa_applications ap ON ap.id = a.application_id
  JOIN wazifa_students s ON s.id = a.student_id
  WHERE a.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM wazifa_applications ap2
                     WHERE ap2.student_id = a.student_id AND ap2.supersedes_application_id = ap.id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION wazifa_renewal_due() TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- One reminder, once a year, to the people who can act on it
-- ═════════════════════════════════════════════════════════════════════════
-- Runs once a month rather than daily — a re-verification list does not
-- change hour to hour, and a committee member does not need to be told about
-- the same twelve children every morning.
CREATE OR REPLACE FUNCTION welfare_reverification_reminder() RETURNS jsonb AS $$
DECLARE v_kf int; v_wz int; r record; v_sent int := 0;
BEGIN
  SELECT jsonb_array_length(kafalat_reverification_due()) INTO v_kf;
  SELECT jsonb_array_length(wazifa_renewal_due()) INTO v_wz;
  IF v_kf = 0 AND v_wz = 0 THEN
    RETURN jsonb_build_object('kafalat_due', 0, 'wazifa_due', 0, 'notified', 0);
  END IF;

  FOR r IN SELECT id FROM admin_users
            WHERE is_active AND (role IN ('super_admin', 'admin') OR can_verify_needs)
  LOOP
    INSERT INTO notifications (recipient_id, event_type, title, body, link)
    VALUES (r.id, 'welfare_reverification_due',
      'Annual re-verification due',
      v_kf || ' Kafalat child(ren) and ' || v_wz || ' Wazifa renewal(s) have not been re-checked for this academic year yet.',
      '/admin/kafalat');
    v_sent := v_sent + 1;
  END LOOP;

  RETURN jsonb_build_object('kafalat_due', v_kf, 'wazifa_due', v_wz, 'notified', v_sent);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION welfare_reverification_reminder() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION welfare_reverification_reminder() TO authenticated;

DO $$
BEGIN
  PERFORM cron.schedule('welfare-reverification-reminder', '0 5 1 * *',
    'SELECT welfare_reverification_reminder()');
  RAISE NOTICE 'pg_cron: re-verification reminder sent monthly, 1st at 10:00 PKT';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable — run welfare_reverification_reminder() by hand once a month. %', SQLERRM;
END $$;
