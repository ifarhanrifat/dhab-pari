-- Migration 291: Phase 1 of the request-form/agreement redesign — the
-- application itself, and a real eligibility score for the track it's
-- actually asking for, not one need score applied to everyone alike.
--
-- ═════════════════════════════════════════════════════════════════════════
-- The real monthly cost, broken into what it's actually made of
-- ═════════════════════════════════════════════════════════════════════════
-- institution_monthly_fee_pkr and hostel_monthly_charges_pkr already
-- existed; transport didn't, and there was nowhere to say when a course
-- starts and ends, so "yearly admission fee" had no year to be per. Both
-- get added here, plain fields — the actual month-by-month/year-by-year
-- course-cost breakdown that these enable is Phase 3's job, once the
-- disbursement calendar exists to hand it to.
ALTER TABLE wazifa_applications
  ADD COLUMN IF NOT EXISTS transport_monthly_cost_pkr decimal NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS admission_fee_pkr decimal NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS course_start_date date,
  ADD COLUMN IF NOT EXISTS course_end_date date,
  ADD COLUMN IF NOT EXISTS capacity_score decimal;

-- ═════════════════════════════════════════════════════════════════════════
-- Two different questions, not one "need" score for every applicant
-- ═════════════════════════════════════════════════════════════════════════
-- A zakat-family award is a grant — zakat has to pass into full
-- ownership with nothing owed back, so the only real question is need,
-- and it should keep falling as income rises, same as before.
--
-- A qarz-e-hasana award is a loan. Checked against how real lenders and
-- grant-makers actually split this before writing it: need-based aid
-- looks at income and household size; loan underwriting looks at
-- repayment capacity — a fundamentally different question, and the
-- opposite direction from need. A family with more room in their budget
-- is a *safer bet to repay*, not a less deserving one, on this track
-- specifically. capacity_score mirrors need_score's own formula, just
-- inverted, so the two stay easy to compare side by side.
--
-- A married brother's income doesn't count either direction — he has
-- his own household now, not this one.
CREATE OR REPLACE FUNCTION wazifa_score_application(p_application_id uuid) RETURNS jsonb AS $$
DECLARE
  a wazifa_applications%ROWTYPE;
  s wazifa_students%ROWTYPE;
  v_merit decimal;
  v_need decimal;
  v_capacity decimal;
  v_mw decimal;
  v_nw decimal;
  v_cw decimal;
  v_income decimal;
  v_married_brother_income decimal;
  v_total decimal;
BEGIN
  SELECT * INTO a FROM wazifa_applications WHERE id = p_application_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Application not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO s FROM wazifa_students WHERE id = a.student_id;

  v_mw := COALESCE(nullif(setting_text('wazifa_merit_weight', '50'), '')::decimal, 50);
  v_nw := COALESCE(nullif(setting_text('wazifa_need_weight', '50'), '')::decimal, 50);
  v_cw := COALESCE(nullif(setting_text('wazifa_capacity_weight', '50'), '')::decimal, 50);

  v_merit := COALESCE(a.last_exam_percent,
                      CASE WHEN COALESCE(a.last_exam_total, 0) > 0
                           THEN a.last_exam_marks / a.last_exam_total * 100 END,
                      0);

  v_married_brother_income := COALESCE((
    SELECT SUM(CASE WHEN fm.income_period = 'yearly' THEN fm.income_pkr / 12 ELSE fm.income_pkr END)
      FROM wazifa_family_members fm
     WHERE fm.application_id = p_application_id
       AND fm.relation = 'brother' AND fm.marital_status = 'married'
  ), 0);
  v_income := GREATEST(
    COALESCE(a.family_monthly_income_pkr, s.household_monthly_income_pkr, 0)
    + CASE WHEN a.has_family_business THEN COALESCE(a.family_business_share_pkr, 0) ELSE 0 END
    - v_married_brother_income, 0);

  -- Need falls as income rises, floored at zero. Rs 60,000 a month in a
  -- village is comfortable; nothing at all scores full marks. Orphans and
  -- families already carrying other students in education get a lift,
  -- because both are real costs that income alone does not show.
  v_need := GREATEST(100 - (v_income / 600), 0);
  IF s.is_orphan THEN v_need := LEAST(v_need + 15, 100); END IF;
  v_need := LEAST(v_need + (LEAST(s.siblings_studying, 4) * 3), 100);

  -- Capacity rises with the same income, mirrored — the room a family
  -- has to actually make a monthly repayment, not a moral judgement.
  v_capacity := LEAST(v_income / 600, 100);

  v_total := CASE WHEN s.is_zakat_family
    THEN (v_merit * v_mw + v_need * v_nw) / NULLIF(v_mw + v_nw, 0)
    ELSE (v_merit * v_mw + v_capacity * v_cw) / NULLIF(v_mw + v_cw, 0) END;

  UPDATE wazifa_applications
     SET merit_score = round(v_merit, 2),
         need_score = round(v_need, 2),
         capacity_score = round(v_capacity, 2),
         total_score = round(v_total, 2),
         last_exam_percent = COALESCE(last_exam_percent, round(v_merit, 2))
   WHERE id = p_application_id;

  RETURN jsonb_build_object('merit', round(v_merit, 2), 'need', round(v_need, 2),
                            'capacity', round(v_capacity, 2), 'total', round(v_total, 2));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_score_application(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_score_application(uuid) TO authenticated;

INSERT INTO site_settings (key, value) VALUES ('wazifa_capacity_weight', '50')
ON CONFLICT (key) DO NOTHING;
