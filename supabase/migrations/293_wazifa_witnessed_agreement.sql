-- Migration 293: Phase 2 — the agreement becomes a real, physically
-- signed and witnessed document, not a typed name in a browser, and
-- activation waits for a staff member to have actually looked at it.
--
-- ═════════════════════════════════════════════════════════════════════════
-- What changes and why
-- ═════════════════════════════════════════════════════════════════════════
-- Money changing hands over years deserves the weight of a real
-- signature, not a text field someone can fill in from their phone in
-- five seconds. The new flow: the committee sends the agreement (real
-- numbers, real schedule, migration 278/287's own generated text) →
-- the family prints it → the student, the father/guardian, and two
-- witnesses sign it by hand, with CNIC photocopies attached → a photo of
-- the whole signed packet gets uploaded, the same upload mechanism
-- payment slips already use → a staff member actually looks at it and
-- marks it verified → only then can the award be activated. Digitally
-- typing your name and clicking a button is gone; wazifa_sign_agreement
-- is replaced outright rather than extended, the same way an overload
-- pile-up was cleaned up in migration 285 — one clear function, not an
-- old one left reachable underneath a new one.

ALTER TABLE wazifa_agreements
  ADD COLUMN IF NOT EXISTS father_name varchar,
  ADD COLUMN IF NOT EXISTS father_cnic varchar,
  ADD COLUMN IF NOT EXISTS father_phone varchar,
  ADD COLUMN IF NOT EXISTS witness1_name varchar,
  ADD COLUMN IF NOT EXISTS witness1_cnic varchar,
  ADD COLUMN IF NOT EXISTS witness1_phone varchar,
  ADD COLUMN IF NOT EXISTS witness2_name varchar,
  ADD COLUMN IF NOT EXISTS witness2_cnic varchar,
  ADD COLUMN IF NOT EXISTS witness2_phone varchar,
  ADD COLUMN IF NOT EXISTS signed_document_url text,
  ADD COLUMN IF NOT EXISTS witnessed_verified_by uuid REFERENCES admin_users(id),
  ADD COLUMN IF NOT EXISTS witnessed_verified_at timestamptz;

ALTER TABLE wazifa_agreements DROP CONSTRAINT IF EXISTS wazifa_agreements_status_check;
ALTER TABLE wazifa_agreements ADD CONSTRAINT wazifa_agreements_status_check
  CHECK (status IN ('pending', 'signed', 'verified', 'superseded'));

DROP FUNCTION IF EXISTS wazifa_sign_agreement(uuid, text);

-- ── The family's own step — physically signed, witnessed, uploaded ──────
CREATE OR REPLACE FUNCTION wazifa_submit_witnessed_agreement(
  p_agreement_id uuid,
  p_father_name text, p_father_cnic text, p_father_phone text,
  p_witness1_name text, p_witness1_cnic text, p_witness1_phone text,
  p_witness2_name text, p_witness2_cnic text, p_witness2_phone text,
  p_signed_document_url text
) RETURNS jsonb AS $$
DECLARE ag wazifa_agreements%ROWTYPE;
BEGIN
  IF current_portal_user_id() IS NULL THEN
    RAISE EXCEPTION 'Please sign in to submit this.' USING ERRCODE = 'P0001';
  END IF;
  IF trim(COALESCE(p_signed_document_url, '')) = '' THEN
    RAISE EXCEPTION 'Upload a photo of the signed, witnessed document.' USING ERRCODE = 'P0001';
  END IF;
  IF trim(COALESCE(p_father_name, '')) = '' OR trim(COALESCE(p_witness1_name, '')) = '' OR trim(COALESCE(p_witness2_name, '')) = '' THEN
    RAISE EXCEPTION 'The father/guardian and both witnesses are required.' USING ERRCODE = 'P0001';
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

  UPDATE wazifa_agreements SET
    status = 'signed',
    father_name = trim(p_father_name), father_cnic = trim(p_father_cnic), father_phone = trim(p_father_phone),
    witness1_name = trim(p_witness1_name), witness1_cnic = trim(p_witness1_cnic), witness1_phone = trim(p_witness1_phone),
    witness2_name = trim(p_witness2_name), witness2_cnic = trim(p_witness2_cnic), witness2_phone = trim(p_witness2_phone),
    signed_document_url = p_signed_document_url,
    student_signed_at = now()
  WHERE id = p_agreement_id;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_submit_witnessed_agreement(uuid, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_submit_witnessed_agreement(uuid, text, text, text, text, text, text, text, text, text, text) TO authenticated;

-- ── Staff actually looking at the uploaded document — the gate,
-- separate from and before activation itself ─────────────────────────────
CREATE OR REPLACE FUNCTION wazifa_verify_agreement(p_agreement_id uuid) RETURNS jsonb AS $$
DECLARE ag wazifa_agreements%ROWTYPE;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false)
     AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO ag FROM wazifa_agreements WHERE id = p_agreement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Agreement not found' USING ERRCODE = 'P0001'; END IF;
  IF ag.status <> 'signed' THEN
    RAISE EXCEPTION 'This agreement is not waiting for verification.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_agreements
     SET status = 'verified', witnessed_verified_by = current_admin_user_id(), witnessed_verified_at = now()
   WHERE id = p_agreement_id;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_verify_agreement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_verify_agreement(uuid) TO authenticated;

-- ── Activation now waits on the physical document being checked, not
-- just uploaded ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION wazifa_activate_award(p_award_id uuid) RETURNS jsonb AS $$
DECLARE ag wazifa_agreements%ROWTYPE; aw wazifa_awards%ROWTYPE;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false)
     AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized to activate an award' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF aw.installment_active THEN
    RAISE EXCEPTION 'Already active.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO ag FROM wazifa_agreements
   WHERE award_id = p_award_id AND status = 'verified'
   ORDER BY witnessed_verified_at DESC NULLS LAST LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The signed, witnessed agreement has not been verified yet.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_agreements
     SET committee_confirmed_by = current_admin_user_id(), committee_confirmed_at = now()
   WHERE id = ag.id;

  UPDATE wazifa_awards
     SET installment_active = true,
         installment_started_on = (now() AT TIME ZONE 'Asia/Karachi')::date
   WHERE id = p_award_id;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_activate_award(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_activate_award(uuid) TO authenticated;

-- ── A new agreement retires whatever wasn't already superseded — not
-- just a still-pending one. Sending a readjusted agreement on an award
-- that was already active left the old, already-verified agreement
-- sitting there forever otherwise, uncancelled, two "current" agreements
-- existing at once ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION wazifa_send_agreement(p_award_id uuid, p_terms_text text, p_terms_text_ur text DEFAULT NULL) RETURNS jsonb AS $$
DECLARE aw wazifa_awards%ROWTYPE; v_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF COALESCE(aw.student_monthly_contribution_pkr, 0) <= 0 OR aw.installment_due_day IS NULL THEN
    RAISE EXCEPTION 'Set the monthly amount and due day first.' USING ERRCODE = 'P0001';
  END IF;
  IF trim(COALESCE(p_terms_text, '')) = '' THEN
    RAISE EXCEPTION 'Write what the student is being asked to agree to.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_agreements SET status = 'superseded'
   WHERE award_id = p_award_id AND status <> 'superseded';

  INSERT INTO wazifa_agreements (
    award_id, awarded_amount_pkr, monthly_amount_pkr, due_day,
    terms_text, terms_text_ur, sent_by
  ) VALUES (
    p_award_id, aw.awarded_amount_pkr, aw.student_monthly_contribution_pkr, aw.installment_due_day,
    p_terms_text, p_terms_text_ur, current_admin_user_id()
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('agreement_id', v_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_send_agreement(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_send_agreement(uuid, text, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Readjustment — only the remainder moves, what's already settled stays
-- put, and it goes through the same signed-and-witnessed flow again
-- ═════════════════════════════════════════════════════════════════════════
-- Extending the return duration is the case actually asked for: the
-- remaining balance (whatever hasn't been paid or received yet) gets
-- spread across the new remaining months instead of the old ones. Any
-- charge already paid, or already raised and still due this month,
-- stays exactly as it is — only charges that haven't been raised yet
-- get cleared and re-raised at the new monthly figure going forward.

CREATE OR REPLACE FUNCTION wazifa_readjust_settlement(
  p_award_id uuid, p_new_end_date date, p_new_due_day int DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE;
  v_remaining decimal; v_today date; v_months int; v_new_monthly decimal;
  v_terms text; v_terms_ur text;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false) THEN
    RAISE EXCEPTION 'Only an approver can readjust a plan.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF NOT aw.installment_active THEN
    RAISE EXCEPTION 'Settlement has not started on this award yet.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;

  v_today := (now() AT TIME ZONE 'Asia/Karachi')::date;
  IF p_new_end_date <= v_today THEN
    RAISE EXCEPTION 'The new end date has to be in the future.' USING ERRCODE = 'P0001';
  END IF;

  v_remaining := GREATEST(
    CASE WHEN aw.plan_type = 'disburse_then_settle' THEN aw.disbursed_pkr ELSE wazifa_plan_total(p_award_id) END
    - aw.contributed_pkr, 0);
  IF v_remaining <= 0 THEN
    RAISE EXCEPTION 'Nothing is left owing — there is nothing to readjust.' USING ERRCODE = 'P0001';
  END IF;

  v_months := GREATEST(1, (
    (EXTRACT(YEAR FROM p_new_end_date) - EXTRACT(YEAR FROM v_today)) * 12
    + (EXTRACT(MONTH FROM p_new_end_date) - EXTRACT(MONTH FROM v_today)) + 1
  )::int);
  v_new_monthly := ROUND(v_remaining / v_months);

  -- Only charges never raised toward — untouched paid/part-paid/due
  -- charges are exactly what "the remainder only" means.
  DELETE FROM wazifa_installment_charges
   WHERE award_id = p_award_id AND status = 'due' AND due_on > v_today;

  UPDATE wazifa_awards SET
    student_monthly_contribution_pkr = v_new_monthly,
    installment_end_date = p_new_end_date,
    installment_due_day = COALESCE(p_new_due_day, installment_due_day)
  WHERE id = p_award_id;

  v_terms := format(
    'Your instalment plan has been readjusted. What was already paid stays paid — Rs %s is still owing, now to be paid at Rs %s per month, by the %s of each month, through %s (%s months).%s',
    trim(to_char(v_remaining, 'FM999,999,999,990')), trim(to_char(v_new_monthly, 'FM999,999,999,990')),
    COALESCE(p_new_due_day, aw.installment_due_day), to_char(p_new_end_date, 'Mon YYYY'), v_months,
    CASE WHEN p_reason IS NOT NULL THEN ' Reason: ' || p_reason ELSE '' END);
  v_terms_ur := format(
    'آپ کے قسطوں کے منصوبے میں تبدیلی کی گئی ہے۔ جو ادا ہو چکا وہ ادا شدہ ہی رہے گا — %s روپے ابھی باقی ہیں، اب ہر ماہ کی %s تاریخ تک %s روپے ماہانہ کی صورت میں، %s تک (%s ماہ)۔',
    trim(to_char(v_remaining, 'FM999,999,999,990')), COALESCE(p_new_due_day, aw.installment_due_day),
    trim(to_char(v_new_monthly, 'FM999,999,999,990')), to_char(p_new_end_date, 'Mon YYYY'), v_months);

  PERFORM wazifa_send_agreement(p_award_id, v_terms, v_terms_ur);

  RETURN jsonb_build_object('remaining', v_remaining, 'new_monthly', v_new_monthly, 'months', v_months);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_readjust_settlement(uuid, date, int, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_readjust_settlement(uuid, date, int, text) TO authenticated;

-- The disbursement side, symmetric — extending how long the committee
-- keeps paying out spreads what's left of the award across the new
-- remaining months, same "already-paid months untouched" rule.
CREATE OR REPLACE FUNCTION wazifa_readjust_disbursement(
  p_award_id uuid, p_new_end_date date, p_new_due_day int DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE;
  v_remaining decimal; v_today date; v_months int; v_new_monthly decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false) THEN
    RAISE EXCEPTION 'Only an approver can readjust a plan.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF aw.plan_type <> 'disburse_then_settle' OR NOT aw.disbursement_active THEN
    RAISE EXCEPTION 'This award has no active disbursement plan.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;

  v_today := (now() AT TIME ZONE 'Asia/Karachi')::date;
  IF p_new_end_date <= v_today THEN
    RAISE EXCEPTION 'The new end date has to be in the future.' USING ERRCODE = 'P0001';
  END IF;

  v_remaining := GREATEST(aw.awarded_amount_pkr - aw.disbursed_pkr, 0);
  IF v_remaining <= 0 THEN
    RAISE EXCEPTION 'Nothing is left to disburse — there is nothing to readjust.' USING ERRCODE = 'P0001';
  END IF;

  v_months := GREATEST(1, (
    (EXTRACT(YEAR FROM p_new_end_date) - EXTRACT(YEAR FROM v_today)) * 12
    + (EXTRACT(MONTH FROM p_new_end_date) - EXTRACT(MONTH FROM v_today)) + 1
  )::int);
  v_new_monthly := ROUND(v_remaining / v_months);

  DELETE FROM wazifa_disbursement_charges
   WHERE award_id = p_award_id AND status = 'due' AND due_on > v_today;

  UPDATE wazifa_awards SET
    disbursement_monthly_pkr = v_new_monthly,
    disbursement_end_date = p_new_end_date,
    disbursement_due_day = COALESCE(p_new_due_day, disbursement_due_day)
  WHERE id = p_award_id;

  RETURN jsonb_build_object('remaining', v_remaining, 'new_monthly', v_new_monthly, 'months', v_months);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_readjust_disbursement(uuid, date, int, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_readjust_disbursement(uuid, date, int, text) TO authenticated;
