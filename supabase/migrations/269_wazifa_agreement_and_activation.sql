-- Migration 269: the agreement a student actually signs, and the moment
-- "decided" becomes "active."
--
-- ═════════════════════════════════════════════════════════════════════════
-- The gap this closes
-- ═════════════════════════════════════════════════════════════════════════
-- wazifa_record_decision() (migration 235) already does a great deal the
-- instant an award is approved — the subsidiary account exists, the
-- measuring account is credited, the student's status flips to 'awarded'.
-- What it does not do, and what nothing in this schema has ever done, is
-- ask the student to agree to anything. A committee that has decided to pay
-- a fixed monthly share to an institute, on the understanding the student
-- pays their own fixed share back, has made a real arrangement — and until
-- now nothing wrote that arrangement down or asked the student to sign it.
--
-- This does not touch wazifa_record_decision, wazifa_awards.status, or
-- anything already posting to the measuring account. An award is exactly as
-- active as it always was the moment it is decided — this adds a second,
-- narrower gate specifically for the recurring monthly obligation, which is
-- new, and which is the one part of this arrangement a family should
-- actually have to agree to before it starts.

-- ── The terms the committee actually fixes ───────────────────────────────
-- student_monthly_contribution_pkr already existed (migration 219) but had
-- no setter and nothing read it automatically — an unused column. This
-- gives it one, and adds the two facts that were missing alongside it: which
-- day of the month it falls due, and whether the recurring obligation has
-- actually started.
ALTER TABLE wazifa_awards
  ADD COLUMN IF NOT EXISTS installment_due_day int CHECK (installment_due_day BETWEEN 1 AND 28),
  ADD COLUMN IF NOT EXISTS installment_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS installment_started_on date;

CREATE OR REPLACE FUNCTION wazifa_set_monthly_installment(
  p_award_id uuid, p_amount decimal, p_due_day int
) RETURNS jsonb AS $$
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Enter a monthly amount greater than zero.' USING ERRCODE = 'P0001';
  END IF;
  IF p_due_day < 1 OR p_due_day > 28 THEN
    RAISE EXCEPTION 'Choose a due day between 1 and 28, so it falls in every month.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_awards
     SET student_monthly_contribution_pkr = p_amount, installment_due_day = p_due_day
   WHERE id = p_award_id AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Award not found, or not active.' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_set_monthly_installment(uuid, decimal, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_set_monthly_installment(uuid, decimal, int) TO authenticated;

-- ── The agreement itself — a snapshot, not a live join ───────────────────
-- What a student signed has to keep reading the way they read it, even if
-- the committee revises the figure next year for a new attempt. A live join
-- to wazifa_awards would silently rewrite history; a snapshot cannot.
CREATE TABLE IF NOT EXISTS wazifa_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  award_id uuid NOT NULL REFERENCES wazifa_awards(id) ON DELETE CASCADE,

  awarded_amount_pkr decimal NOT NULL,
  monthly_amount_pkr decimal NOT NULL,
  due_day int NOT NULL,
  terms_text text NOT NULL,
  terms_text_ur text,

  status varchar NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'signed', 'superseded')),

  sent_by uuid REFERENCES admin_users(id),
  sent_at timestamptz DEFAULT now(),

  -- Clicked, not drawn — a typed full name plus a timestamp is the right
  -- weight for this, the same reasoning the loan terms signature elsewhere
  -- in this schema already rests on (wazifa_applications.loan_terms_signature).
  student_signed_name varchar,
  student_signed_at timestamptz,

  committee_confirmed_by uuid REFERENCES admin_users(id),
  committee_confirmed_at timestamptz,

  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wazifa_agreements_award_idx ON wazifa_agreements(award_id, status);

ALTER TABLE wazifa_agreements ENABLE ROW LEVEL SECURITY;

CREATE POLICY wazifa_agreements_admin ON wazifa_agreements FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

CREATE POLICY wazifa_agreements_own ON wazifa_agreements FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM wazifa_awards a JOIN wazifa_students s ON s.id = a.student_id
                  WHERE a.id = wazifa_agreements.award_id AND s.portal_user_id = current_portal_user_id()));
-- No portal INSERT/UPDATE policy — a student agrees through
-- wazifa_sign_agreement() below, never by writing the row directly.

-- ── Sending it ────────────────────────────────────────────────────────────
-- Whatever was pending before is superseded, not deleted — if a committee
-- revises the monthly figure before a student has signed, the old, unsigned
-- offer should stop being valid rather than sit there as a second live copy.
CREATE OR REPLACE FUNCTION wazifa_send_agreement(
  p_award_id uuid, p_terms_text text, p_terms_text_ur text DEFAULT NULL
) RETURNS jsonb AS $$
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
   WHERE award_id = p_award_id AND status = 'pending';

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

-- ── Signing it — the student's own click, from their own account ────────
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

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_sign_agreement(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_sign_agreement(uuid, text) TO authenticated;

-- ── Activating — the committee's own confirmation, and the only place
--    installment_active is ever set true ────────────────────────────────
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
   WHERE award_id = p_award_id AND status = 'signed'
   ORDER BY student_signed_at DESC NULLS LAST LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The student has not signed an agreement yet.' USING ERRCODE = 'P0001';
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

-- Read side: what's waiting for the student's own signature, and what they
-- already signed — my_wazifa_dues() (migration 227) covers what's owed, not
-- agreements, so this is a separate small read rather than widening that one.
CREATE OR REPLACE FUNCTION my_wazifa_agreements() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'agreement_id', ag.id, 'award_id', ag.award_id, 'academic_year', a.academic_year,
    'awarded_amount_pkr', ag.awarded_amount_pkr, 'monthly_amount_pkr', ag.monthly_amount_pkr,
    'due_day', ag.due_day, 'terms_text', ag.terms_text, 'terms_text_ur', ag.terms_text_ur,
    'status', ag.status, 'sent_at', ag.sent_at,
    'student_signed_name', ag.student_signed_name, 'student_signed_at', ag.student_signed_at,
    'installment_active', a.installment_active
  ) ORDER BY ag.sent_at DESC), '[]'::jsonb)
  FROM wazifa_agreements ag
  JOIN wazifa_awards a ON a.id = ag.award_id
  JOIN wazifa_students s ON s.id = a.student_id
  WHERE s.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_wazifa_agreements() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_wazifa_agreements() TO authenticated;
