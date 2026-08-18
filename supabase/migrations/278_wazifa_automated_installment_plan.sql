-- Migration 278: the committee sets the whole plan once, in the decision
-- itself — nothing left for staff to come back and click through
-- afterward.
--
-- ═════════════════════════════════════════════════════════════════════════
-- What this replaces
-- ═════════════════════════════════════════════════════════════════════════
-- Migration 269/270 built this as three separate staff actions: set a
-- monthly figure and due day, send an agreement, activate once signed.
-- Real committee practice is one conversation, one decision: "we'll cover
-- 60% of what he asked for, from September to June, he pays it back on
-- that schedule." The monthly figure was never really a number the
-- committee picked by itself — it falls out of the amount and the months,
-- and typing it by hand was one manual step this replaces with a
-- computation.
--
-- wazifa_record_decision() now optionally takes the whole plan and, when
-- given one, computes the monthly figure and sends the agreement itself —
-- approving the application and setting the plan become the same action.
-- Nothing here removes the student's own signature (migration 269) — that
-- stays theirs to give — but signing now activates the award immediately
-- rather than waiting on a second staff click (below).

ALTER TABLE wazifa_awards
  ADD COLUMN IF NOT EXISTS installment_start_date date,
  ADD COLUMN IF NOT EXISTS installment_end_date date,
  ADD COLUMN IF NOT EXISTS installment_basis varchar CHECK (installment_basis IN ('percentage', 'full')),
  ADD COLUMN IF NOT EXISTS installment_percentage decimal CHECK (installment_percentage > 0 AND installment_percentage <= 100);

-- ── The computation, and the automatic agreement, as one action ─────────
-- Kept as its own function (not inlined into wazifa_record_decision) so a
-- committee revising a plan later — the amount turns out wrong, the dates
-- need to move — has the same single action available without redoing the
-- whole decision.
CREATE OR REPLACE FUNCTION wazifa_set_installment_plan(
  p_award_id uuid, p_basis varchar, p_percentage decimal,
  p_start_date date, p_end_date date, p_due_day int,
  p_terms_text text DEFAULT NULL, p_terms_text_ur text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE;
  v_total decimal; v_months int; v_monthly decimal; v_terms text; v_terms_ur text;
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

  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;

  v_total := CASE WHEN p_basis = 'full' THEN aw.awarded_amount_pkr ELSE aw.awarded_amount_pkr * p_percentage / 100 END;
  -- Inclusive month count: September to June is 10 months, not 9 or 121.
  v_months := GREATEST(1, (
    (EXTRACT(YEAR FROM p_end_date) - EXTRACT(YEAR FROM p_start_date)) * 12
    + (EXTRACT(MONTH FROM p_end_date) - EXTRACT(MONTH FROM p_start_date)) + 1
  )::int);
  v_monthly := ROUND(v_total / v_months);

  UPDATE wazifa_awards
     SET student_monthly_contribution_pkr = v_monthly, installment_due_day = p_due_day,
         installment_start_date = p_start_date, installment_end_date = p_end_date,
         installment_basis = p_basis, installment_percentage = CASE WHEN p_basis = 'percentage' THEN p_percentage ELSE NULL END
   WHERE id = p_award_id;

  -- Written out, not left for a staff member to draft — the whole point of
  -- "automated" is that nobody has to compose this each time.
  v_terms := COALESCE(p_terms_text, format(
    'You are awarded Rs %s toward %s. You agree to pay Rs %s per month, from %s to %s (%s months), by the %s of each month.',
    trim(to_char(v_total, 'FM999,999,999,990')), st.full_name,
    trim(to_char(v_monthly, 'FM999,999,999,990')), to_char(p_start_date, 'Mon YYYY'), to_char(p_end_date, 'Mon YYYY'),
    v_months, p_due_day));
  v_terms_ur := COALESCE(p_terms_text_ur, format(
    'آپ کو %s کے لیے %s روپے دیے گئے۔ آپ ہر ماہ کی %s تاریخ تک، %s سے %s تک (%s ماہ)، %s روپے ماہانہ ادا کرنے پر رضامند ہیں۔',
    st.full_name, trim(to_char(v_total, 'FM999,999,999,990')), p_due_day,
    to_char(p_start_date, 'Mon YYYY'), to_char(p_end_date, 'Mon YYYY'), v_months,
    trim(to_char(v_monthly, 'FM999,999,999,990'))));

  PERFORM wazifa_send_agreement(p_award_id, v_terms, v_terms_ur);

  RETURN jsonb_build_object('monthly_amount', v_monthly, 'months', v_months, 'total', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_set_installment_plan(uuid, varchar, decimal, date, date, int, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_set_installment_plan(uuid, varchar, decimal, date, date, int, text, text) TO authenticated;

-- ── The decision and the plan, in one call ────────────────────────────────
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
  p_shortfall_note text DEFAULT NULL,
  p_installment_basis varchar DEFAULT NULL,
  p_installment_percentage decimal DEFAULT NULL,
  p_installment_start_date date DEFAULT NULL,
  p_installment_end_date date DEFAULT NULL,
  p_installment_due_day int DEFAULT NULL
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

    PERFORM ensure_wazifa_student_account(a.student_id);

    v_year := a.academic_year;
    PERFORM wazifa_post_requirement_delta(v_year, p_amount,
      (SELECT full_name FROM wazifa_students WHERE id = a.student_id) || ' — approved ' || p_decision,
      a.student_id);

    -- The whole reason this migration exists: given a plan, set it and
    -- send the agreement right here, rather than leaving that for a
    -- second visit to the Awards tab.
    IF p_installment_basis IS NOT NULL THEN
      PERFORM wazifa_set_installment_plan(v_award_id, p_installment_basis, p_installment_percentage,
        p_installment_start_date, p_installment_end_date, COALESCE(p_installment_due_day, 10));
    END IF;
  END IF;

  RETURN jsonb_build_object('status', v_status, 'award_id', v_award_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── Signing now activates — the manual "Activate" click this removes ────
CREATE OR REPLACE FUNCTION wazifa_sign_agreement(p_agreement_id uuid, p_typed_name text) RETURNS jsonb AS $$
DECLARE ag wazifa_agreements%ROWTYPE;
BEGIN
  IF current_portal_user_id() IS NULL THEN
    RAISE EXCEPTION 'Please sign in to sign this.' USING ERRCODE = 'P0001';
  END IF;
  IF trim(COALESCE(p_typed_name, '')) = '' THEN
    RAISE EXCEPTION 'Type your full name to sign.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO ag FROM wazifa_agreements WHERE id = p_agreement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Agreement not found' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM wazifa_awards a JOIN wazifa_students s ON s.id = a.student_id
                  WHERE a.id = ag.award_id AND s.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'This agreement is not on your account.' USING ERRCODE = 'P0001';
  END IF;
  IF ag.status <> 'pending' THEN
    RAISE EXCEPTION 'This agreement is no longer waiting for a signature.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_agreements
     SET status = 'signed', student_signed_name = trim(p_typed_name), student_signed_at = now(),
         committee_confirmed_at = now()
   WHERE id = p_agreement_id;

  -- Nothing left for staff to click — the signature itself is what starts it.
  UPDATE wazifa_awards
     SET installment_active = true,
         installment_started_on = (now() AT TIME ZONE 'Asia/Karachi')::date
   WHERE id = ag.award_id AND NOT installment_active;

  RETURN jsonb_build_object('ok', true, 'activated', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_sign_agreement(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_sign_agreement(uuid, text) TO authenticated;

-- ── The plan stops raising charges once it says it ends ──────────────────
CREATE OR REPLACE FUNCTION wazifa_installment_run() RETURNS jsonb AS $$
DECLARE
  v_month date; v_count int := 0; v_next_no int; r record;
BEGIN
  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;

  FOR r IN
    SELECT a.id AS award_id, a.student_id, s.portal_user_id, s.full_name,
           a.student_monthly_contribution_pkr AS amount, a.installment_due_day AS due_day
      FROM wazifa_awards a
      JOIN wazifa_students s ON s.id = a.student_id
     WHERE a.installment_active AND a.status = 'active'
       AND COALESCE(a.student_monthly_contribution_pkr, 0) > 0
       AND a.installment_due_day IS NOT NULL
       AND (a.installment_start_date IS NULL OR v_month >= date_trunc('month', a.installment_start_date)::date)
       AND (a.installment_end_date IS NULL OR v_month <= date_trunc('month', a.installment_end_date)::date)
       AND NOT EXISTS (SELECT 1 FROM wazifa_installment_charges ic
                        WHERE ic.award_id = a.id
                          AND ic.due_on >= v_month AND ic.due_on < v_month + interval '1 month')
  LOOP
    SELECT COALESCE(MAX(charge_no), 0) + 1 INTO v_next_no
      FROM wazifa_installment_charges WHERE award_id = r.award_id;

    INSERT INTO wazifa_installment_charges (award_id, charge_no, due_on, amount_pkr)
    VALUES (r.award_id, v_next_no, v_month + (r.due_day - 1), r.amount);

    IF r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (r.portal_user_id, 'wazifa_installment_due', 'Taleemi Wazifa instalment due',
        'Rs ' || trim(to_char(r.amount, 'FM999,999,999,990')) || ' is due by ' || to_char(v_month + (r.due_day - 1), 'DD Mon'),
        '/portal/wazifa');
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('charges_raised', v_count, 'month', v_month);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_installment_run() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_installment_run() TO authenticated;

-- ── The applicant's own offer — approved or declined, its own decision ──
-- offered_monthly_contribution_pkr (migration 213/219) was always just a
-- number on the form nobody acted on. This is the missing step: the
-- committee says yes or no to it specifically, separate from deciding the
-- award itself, and the accountant's payment window (wazifa_record_
-- contribution, unchanged) only makes sense to use once they have.
ALTER TABLE wazifa_applications
  ADD COLUMN IF NOT EXISTS offered_contribution_status varchar NOT NULL DEFAULT 'pending'
    CHECK (offered_contribution_status IN ('pending', 'approved', 'declined')),
  ADD COLUMN IF NOT EXISTS offered_contribution_decided_by uuid REFERENCES admin_users(id),
  ADD COLUMN IF NOT EXISTS offered_contribution_decided_at timestamptz;

CREATE OR REPLACE FUNCTION wazifa_decide_offered_contribution(p_application_id uuid, p_decision varchar) RETURNS jsonb AS $$
DECLARE a wazifa_applications%ROWTYPE;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false)
     AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_decision NOT IN ('approved', 'declined') THEN
    RAISE EXCEPTION 'Approve or decline — nothing else.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO a FROM wazifa_applications WHERE id = p_application_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Application not found' USING ERRCODE = 'P0001'; END IF;
  IF COALESCE(a.offered_monthly_contribution_pkr, 0) <= 0 THEN
    RAISE EXCEPTION 'Nothing was offered on this application.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_applications
     SET offered_contribution_status = p_decision,
         offered_contribution_decided_by = current_admin_user_id(), offered_contribution_decided_at = now()
   WHERE id = p_application_id;

  RETURN jsonb_build_object('ok', true, 'status', p_decision);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_decide_offered_contribution(uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_decide_offered_contribution(uuid, varchar) TO authenticated;
