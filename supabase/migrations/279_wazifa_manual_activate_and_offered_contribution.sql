-- Migration 279: activation stays the committee's own click.
--
-- Migration 278 made signing auto-activate the award, reasoning that
-- nothing should be left for staff to come back and click. Corrected here,
-- on the strength of a more specific description of the flow: the intent
-- was to remove the separate "set plan" and "send agreement" steps (which
-- migration 278 already did — both happen inside the one decision now),
-- not the final activation. A signature that instantly goes live gives the
-- committee no chance to notice a wrong name or a mistyped date before
-- money starts moving — one confirming click is the safety margin that
-- buys, and wazifa_activate_award() (migration 269) already exists to be
-- that click. This just stops wazifa_sign_agreement from doing its job
-- for it.
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
     SET status = 'signed', student_signed_name = trim(p_typed_name), student_signed_at = now()
   WHERE id = p_agreement_id;

  -- No longer touches wazifa_awards.installment_active — the Activate
  -- button (wazifa_activate_award, migration 269) is what does that,
  -- and now only enables in the UI once this row's status is 'signed'.
  RETURN jsonb_build_object('ok', true, 'activated', false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_sign_agreement(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_sign_agreement(uuid, text) TO authenticated;

-- ── Reallocating the applicant's own offer, not just yes/no ─────────────
-- "The applicant said Rs 2,000 — the committee thinks Rs 3,000 is more
-- realistic given the family's income" is a real, common outcome, not a
-- decline. wazifa_decide_offered_contribution() only ever recorded
-- approved/declined against the figure as typed; this lets the committee
-- revise it in the same action.
CREATE OR REPLACE FUNCTION wazifa_decide_offered_contribution(
  p_application_id uuid, p_decision varchar, p_revised_amount decimal DEFAULT NULL
) RETURNS jsonb AS $$
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
  IF p_revised_amount IS NOT NULL AND p_revised_amount <= 0 THEN
    RAISE EXCEPTION 'Enter an amount greater than zero.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_applications
     SET offered_contribution_status = p_decision,
         offered_monthly_contribution_pkr = COALESCE(p_revised_amount, offered_monthly_contribution_pkr),
         offered_contribution_decided_by = current_admin_user_id(), offered_contribution_decided_at = now()
   WHERE id = p_application_id;

  RETURN jsonb_build_object('ok', true, 'status', p_decision);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
