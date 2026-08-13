-- Migration 216: one typed-up sheet, several signatures — and marking off the
-- documents that were actually seen.
--
-- ═════════════════════════════════════════════════════════════════════════
-- The signatures are on the paper, not in the software
-- ═════════════════════════════════════════════════════════════════════════
-- The first design had each verifier log in and file their own record. That is
-- how a system designed at a desk imagines it works. What actually happens is
-- that two or three members walk to the house together, go through the form,
-- and all sign the same sheet — and then one of them, later, sits down and
-- types it up.
--
-- Asking the other two to log in afterwards and re-enter the same findings
-- would get one of two outcomes: they never do it, and the application stalls;
-- or somebody logs in as them, which is worse than not recording it at all.
--
-- So the record is one row, entered by whoever typed it, naming the others who
-- signed. The signed hard copy is the evidence; this is the index to it.
ALTER TABLE wazifa_verifications
  -- Committee members who also went and signed. Stored as ids where they are
  -- in the system so a report can count them properly.
  ADD COLUMN IF NOT EXISTS co_verifier_ids uuid[],
  -- And as free text for anyone who is not — an imam, a schoolteacher, a
  -- neighbouring elder who came along. Their name belongs on the record even
  -- though they will never have a login.
  ADD COLUMN IF NOT EXISTS co_verifier_names text[],
  ADD COLUMN IF NOT EXISTS hard_copy_url text;

-- How many signatures the committee wants on a visit. Settable, because a
-- committee of three cannot always field three.
INSERT INTO site_settings (key, value) VALUES
  ('wazifa_min_verifiers', '2')
ON CONFLICT (key) DO NOTHING;

-- Counts the person who typed it plus everyone they named. The rule the
-- committee agreed is "two or more went", not "two or more typed".
CREATE OR REPLACE FUNCTION wazifa_verifier_count(p_application_id uuid) RETURNS int AS $$
  SELECT COALESCE(MAX(
    1
    + COALESCE(array_length(v.co_verifier_ids, 1), 0)
    + COALESCE(array_length(v.co_verifier_names, 1), 0)
  ), 0)::int
  FROM wazifa_verifications v
  WHERE v.application_id = p_application_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION wazifa_verifier_count(uuid) TO authenticated;

-- A distinct status between "somebody has been" and "the committee has
-- decided". Without it a verified application sits in the same bucket as one
-- nobody has looked at, and the committee has no queue to work from.
ALTER TABLE wazifa_applications DROP CONSTRAINT IF EXISTS wazifa_applications_status_check;
ALTER TABLE wazifa_applications ADD CONSTRAINT wazifa_applications_status_check
  CHECK (status IN ('draft', 'submitted', 'screening', 'verified', 'interview',
                    'approved', 'waitlisted', 'declined', 'withdrawn'));

-- ═════════════════════════════════════════════════════════════════════════
-- Marking off the documents
-- ═════════════════════════════════════════════════════════════════════════
-- An uploaded photograph is a claim. The original, held in the hand at the
-- house, is the evidence — and the difference between the two is exactly what
-- a verification visit exists to establish.
CREATE OR REPLACE FUNCTION wazifa_mark_document_seen(p_document_id uuid, p_seen boolean)
RETURNS void AS $$
BEGIN
  IF NOT COALESCE(can_access_system('donors_projects'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  UPDATE wazifa_documents
     SET original_seen = p_seen,
         seen_by = CASE WHEN p_seen THEN current_admin_user_id() ELSE NULL END,
         seen_at = CASE WHEN p_seen THEN now() ELSE NULL END
   WHERE id = p_document_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_mark_document_seen(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_mark_document_seen(uuid, boolean) TO authenticated;

-- What the committee reads before deciding: how many went, whether the
-- documents were actually seen, and what is still outstanding.
CREATE OR REPLACE FUNCTION wazifa_verification_summary(p_application_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'verifier_count', wazifa_verifier_count(p_application_id),
    'required', COALESCE(nullif(setting_text('wazifa_min_verifiers', '2'), '')::int, 2),
    'visited_on', (SELECT max(visited_on) FROM wazifa_verifications WHERE application_id = p_application_id),
    'documents_total', (SELECT count(*) FROM wazifa_documents WHERE application_id = p_application_id),
    'documents_seen', (SELECT count(*) FROM wazifa_documents
                        WHERE application_id = p_application_id AND original_seen),
    'documents_unseen', (SELECT COALESCE(jsonb_agg(kind), '[]'::jsonb) FROM wazifa_documents
                          WHERE application_id = p_application_id AND NOT original_seen),
    'recommendation', (SELECT recommendation FROM wazifa_verifications
                        WHERE application_id = p_application_id
                        ORDER BY created_at DESC LIMIT 1),
    'recommended_amount', (SELECT recommended_amount_pkr FROM wazifa_verifications
                            WHERE application_id = p_application_id
                            ORDER BY created_at DESC LIMIT 1)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_verification_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_verification_summary(uuid) TO authenticated;

-- The decision refuses to run until enough people actually went. Enforced in
-- the database rather than only greyed out in a screen, because the screen is
-- not the only way in.
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
  v_verifiers int;
  v_required int;
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

  -- A refusal needs no visit; there is nothing to verify about an application
  -- being turned down for a reason on its face. Approving money does.
  IF p_decision LIKE 'approved%' THEN
    v_verifiers := wazifa_verifier_count(p_application_id);
    v_required := COALESCE(nullif(setting_text('wazifa_min_verifiers', '2'), '')::int, 2);
    IF v_verifiers < v_required THEN
      RAISE EXCEPTION
        'This visit records % verifier(s); % must have gone and signed before money is approved.',
        v_verifiers, v_required USING ERRCODE = 'P0001';
    END IF;
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
  END IF;

  RETURN jsonb_build_object('status', v_status, 'award_id', v_award_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION wazifa_record_decision(uuid, varchar, decimal, boolean, varchar, text, text, text, uuid, text) TO authenticated;
