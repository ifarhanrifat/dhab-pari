-- Migration 223: let an applicant finish their form, and stop them changing it
-- underneath a verification that has already been signed.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Two defects, found by driving the real flow as a real portal user
-- ═════════════════════════════════════════════════════════════════════════
-- Checked as role `authenticated` with a portal user's JWT, not as superuser
-- (RLS does not apply to superusers, so testing as one proves nothing).
--
-- 1. The application was WRITE-ONCE. wazifa_applications had an INSERT policy
--    and a SELECT policy and no UPDATE policy at all, so:
--
--        UPDATE wazifa_applications SET requested_amount_pkr = 75000
--         WHERE status = 'draft';                              -> UPDATE 0
--
--    A family filling in eleven sections — CNIC, B-form, every sibling, every
--    exam result, a scanned utility bill — got exactly one attempt, with no
--    way to save and come back, and no way to fix a typo a minute later. The
--    portal form matched: it inserted straight to 'submitted' and never
--    offered to reopen anything.
--
-- 2. The child tables were editable FOREVER. wazifa_family_members,
--    wazifa_academic_records, wazifa_documents and wazifa_results each had a
--    FOR ALL policy scoped to "this is my application" with no status
--    condition, so after the committee had moved the application to screening:
--
--        UPDATE wazifa_family_members SET income_pkr = 0,
--               full_name = 'CHANGED AFTER REVIEW';            -> UPDATE 1
--        DELETE FROM wazifa_family_members;                    -> DELETE 1
--
--    Two committee members visit the house, sign a paper form, and the family
--    can then zero the declared income and delete the siblings the visit was
--    about. The signed sheet no longer describes the record it belongs to, and
--    a verifier who marked a document as seen could have it deleted underneath
--    them.
--
-- The rule from here: everything about an application is the applicant's to
-- change until the committee starts reviewing it, and nobody's to change
-- afterwards except staff.

-- Editable while the committee has not started looking. 'submitted' still
-- counts — a form sitting in the queue nobody has opened is exactly when
-- somebody notices they typed the fee wrong.
CREATE OR REPLACE FUNCTION wazifa_app_is_open(p_application_id uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM wazifa_applications a
      JOIN wazifa_students s ON s.id = a.student_id
     WHERE a.id = p_application_id
       AND s.portal_user_id = current_portal_user_id()
       AND a.status IN ('draft', 'submitted'));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION wazifa_app_is_open(uuid) TO authenticated;

-- ── The application itself ───────────────────────────────────────────────
DROP POLICY IF EXISTS wazifa_applications_edit ON wazifa_applications;
CREATE POLICY wazifa_applications_edit ON wazifa_applications FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM wazifa_students s
             WHERE s.id = wazifa_applications.student_id
               AND s.portal_user_id = current_portal_user_id())
    AND status IN ('draft', 'submitted')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM wazifa_students s
             WHERE s.id = wazifa_applications.student_id
               AND s.portal_user_id = current_portal_user_id())
    -- They may move draft -> submitted, and no further. Every other status is
    -- the committee's to set.
    AND status IN ('draft', 'submitted')
    -- Once anybody has scored it, it is under review whatever the status says.
    AND merit_score IS NULL AND need_score IS NULL
  );

-- Withdrawing an application that has not been reviewed. Deleting it outright
-- would take the audit trail with it, so this is a status change, not a DELETE
-- policy — and 'withdrawn' is outside the editable set, so it is one-way.
CREATE OR REPLACE FUNCTION wazifa_withdraw_application(p_application_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE a wazifa_applications%ROWTYPE;
BEGIN
  SELECT * INTO a FROM wazifa_applications WHERE id = p_application_id;
  IF NOT FOUND OR NOT wazifa_app_is_open(p_application_id) THEN
    RAISE EXCEPTION 'This application can no longer be withdrawn from here. Please speak to the committee.'
      USING ERRCODE = 'P0001';
  END IF;
  UPDATE wazifa_applications
     SET status = 'withdrawn', review_note = COALESCE(p_reason, review_note)
   WHERE id = p_application_id;
  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_withdraw_application(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_withdraw_application(uuid, text) TO authenticated;

-- RLS restricts which rows and which final values, but it cannot say "this
-- column may not change". Staff-only columns are pinned here instead, so an
-- applicant editing their own open form cannot hand themselves a score, a
-- review note or a decision by writing the field directly.
CREATE OR REPLACE FUNCTION trg_wazifa_application_guard_staff_fields() RETURNS trigger AS $$
BEGIN
  IF current_admin_user_id() IS NOT NULL THEN RETURN NEW; END IF;
  NEW.merit_score      := OLD.merit_score;
  NEW.need_score       := OLD.need_score;
  NEW.total_score      := OLD.total_score;
  NEW.review_note      := OLD.review_note;
  NEW.decline_reason   := OLD.decline_reason;
  NEW.reviewed_by      := OLD.reviewed_by;
  NEW.reviewed_at      := OLD.reviewed_at;
  NEW.decided_at       := OLD.decided_at;
  NEW.register_code    := OLD.register_code;
  NEW.family_check_note := OLD.family_check_note;
  NEW.attempt          := OLD.attempt;
  NEW.supersedes_application_id := OLD.supersedes_application_id;
  -- The signature and its timestamp are evidence of when the terms were
  -- accepted. Re-accepting is fine; back-dating is not.
  IF NEW.loan_terms_accepted AND NOT COALESCE(OLD.loan_terms_accepted, false) THEN
    NEW.loan_terms_accepted_at := now();
  ELSIF NOT NEW.loan_terms_accepted THEN
    NEW.loan_terms_accepted_at := NULL;
  ELSE
    NEW.loan_terms_accepted_at := OLD.loan_terms_accepted_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS wazifa_application_guard_staff_fields ON wazifa_applications;
CREATE TRIGGER wazifa_application_guard_staff_fields
  BEFORE UPDATE ON wazifa_applications
  FOR EACH ROW EXECUTE FUNCTION trg_wazifa_application_guard_staff_fields();

-- ── The student's own details ────────────────────────────────────────────
-- Correctable while any of their applications is still open, so a mistyped
-- B-form number is not permanent.
DROP POLICY IF EXISTS wazifa_students_edit ON wazifa_students;
CREATE POLICY wazifa_students_edit ON wazifa_students FOR UPDATE TO authenticated
  USING (
    portal_user_id = current_portal_user_id()
    AND EXISTS (SELECT 1 FROM wazifa_applications a
                 WHERE a.student_id = wazifa_students.id
                   AND a.status IN ('draft', 'submitted'))
  )
  WITH CHECK (portal_user_id = current_portal_user_id() AND status = 'applicant');

-- ── The child tables ─────────────────────────────────────────────────────
-- Same rule everywhere: mine, and writable only while the committee has not
-- started.
--
-- Reading and writing are separate policies rather than one FOR ALL. A single
-- FOR ALL policy governs SELECT too, so locking the write would also blind the
-- applicant to what they had submitted — they could no longer see the siblings
-- and marks the committee is about to visit them about. Being unable to change
-- your answers is the point; being unable to read them is a bug.
CREATE OR REPLACE FUNCTION wazifa_app_is_mine(p_application_id uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM wazifa_applications a
      JOIN wazifa_students s ON s.id = a.student_id
     WHERE a.id = p_application_id
       AND s.portal_user_id = current_portal_user_id());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION wazifa_app_is_mine(uuid) TO authenticated;

DROP POLICY IF EXISTS wazifa_family_own ON wazifa_family_members;
DROP POLICY IF EXISTS wazifa_family_read_own ON wazifa_family_members;
CREATE POLICY wazifa_family_read_own ON wazifa_family_members FOR SELECT TO authenticated
  USING (wazifa_app_is_mine(application_id));
DROP POLICY IF EXISTS wazifa_family_add_own ON wazifa_family_members;
CREATE POLICY wazifa_family_add_own ON wazifa_family_members FOR INSERT TO authenticated
  WITH CHECK (wazifa_app_is_open(application_id));
DROP POLICY IF EXISTS wazifa_family_change_own ON wazifa_family_members;
CREATE POLICY wazifa_family_change_own ON wazifa_family_members FOR UPDATE TO authenticated
  USING (wazifa_app_is_open(application_id))
  WITH CHECK (wazifa_app_is_open(application_id));
DROP POLICY IF EXISTS wazifa_family_remove_own ON wazifa_family_members;
CREATE POLICY wazifa_family_remove_own ON wazifa_family_members FOR DELETE TO authenticated
  USING (wazifa_app_is_open(application_id));

DROP POLICY IF EXISTS wazifa_academic_own ON wazifa_academic_records;
DROP POLICY IF EXISTS wazifa_academic_read_own ON wazifa_academic_records;
CREATE POLICY wazifa_academic_read_own ON wazifa_academic_records FOR SELECT TO authenticated
  USING (wazifa_app_is_mine(application_id));
DROP POLICY IF EXISTS wazifa_academic_add_own ON wazifa_academic_records;
CREATE POLICY wazifa_academic_add_own ON wazifa_academic_records FOR INSERT TO authenticated
  WITH CHECK (wazifa_app_is_open(application_id));
DROP POLICY IF EXISTS wazifa_academic_change_own ON wazifa_academic_records;
CREATE POLICY wazifa_academic_change_own ON wazifa_academic_records FOR UPDATE TO authenticated
  USING (wazifa_app_is_open(application_id))
  WITH CHECK (wazifa_app_is_open(application_id));
DROP POLICY IF EXISTS wazifa_academic_remove_own ON wazifa_academic_records;
CREATE POLICY wazifa_academic_remove_own ON wazifa_academic_records FOR DELETE TO authenticated
  USING (wazifa_app_is_open(application_id));

-- Documents split in two. A student may add and remove their own uploads
-- while the form is open — but a document a verifier has already ticked off is
-- evidence, and comes out of the applicant's reach the moment it is sighted,
-- even if the form is somehow still open.
DROP POLICY IF EXISTS wazifa_documents_own ON wazifa_documents;
DROP POLICY IF EXISTS wazifa_documents_read_own ON wazifa_documents;
CREATE POLICY wazifa_documents_read_own ON wazifa_documents FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM wazifa_applications a JOIN wazifa_students s ON s.id = a.student_id
                  WHERE a.id = wazifa_documents.application_id
                    AND s.portal_user_id = current_portal_user_id()));
DROP POLICY IF EXISTS wazifa_documents_add_own ON wazifa_documents;
CREATE POLICY wazifa_documents_add_own ON wazifa_documents FOR INSERT TO authenticated
  WITH CHECK (wazifa_app_is_open(application_id));
DROP POLICY IF EXISTS wazifa_documents_change_own ON wazifa_documents;
CREATE POLICY wazifa_documents_change_own ON wazifa_documents FOR UPDATE TO authenticated
  USING (wazifa_app_is_open(application_id) AND seen_by IS NULL)
  WITH CHECK (wazifa_app_is_open(application_id));
DROP POLICY IF EXISTS wazifa_documents_remove_own ON wazifa_documents;
CREATE POLICY wazifa_documents_remove_own ON wazifa_documents FOR DELETE TO authenticated
  USING (wazifa_app_is_open(application_id) AND seen_by IS NULL);

-- Results belong to the student across years rather than to one application,
-- so they are pinned to the student. A result the student is still entering is
-- theirs to correct; one already attached to an award is part of that
-- scholarship's record — continuation is decided on it — and is frozen. There
-- is no DELETE policy at all: a bad term is not erasable, only correctable
-- while it is still unattached.
DROP POLICY IF EXISTS wazifa_results_own ON wazifa_results;
DROP POLICY IF EXISTS wazifa_results_read_own ON wazifa_results;
CREATE POLICY wazifa_results_read_own ON wazifa_results FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM wazifa_students s
                  WHERE s.id = wazifa_results.student_id
                    AND s.portal_user_id = current_portal_user_id()));
DROP POLICY IF EXISTS wazifa_results_add_own ON wazifa_results;
CREATE POLICY wazifa_results_add_own ON wazifa_results FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM wazifa_students s
                       WHERE s.id = wazifa_results.student_id
                         AND s.portal_user_id = current_portal_user_id()));
DROP POLICY IF EXISTS wazifa_results_change_own ON wazifa_results;
CREATE POLICY wazifa_results_change_own ON wazifa_results FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM wazifa_students s
                  WHERE s.id = wazifa_results.student_id
                    AND s.portal_user_id = current_portal_user_id())
         AND award_id IS NULL)
  WITH CHECK (EXISTS (SELECT 1 FROM wazifa_students s
                       WHERE s.id = wazifa_results.student_id
                         AND s.portal_user_id = current_portal_user_id())
              AND award_id IS NULL);

-- ── What the applicant sees of their own form ────────────────────────────
-- One call returning the application and every child row, so the portal can
-- reopen a saved form for editing and show it read-only afterwards, with the
-- reason it locked spelled out rather than a disabled button.
CREATE OR REPLACE FUNCTION my_wazifa_application(p_application_id uuid DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE a wazifa_applications%ROWTYPE;
BEGIN
  SELECT app.* INTO a FROM wazifa_applications app
    JOIN wazifa_students s ON s.id = app.student_id
   WHERE s.portal_user_id = current_portal_user_id()
     AND (p_application_id IS NULL OR app.id = p_application_id)
   ORDER BY app.created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'application', to_jsonb(a),
    'student', (SELECT to_jsonb(s) FROM wazifa_students s WHERE s.id = a.student_id),
    'is_editable', a.status IN ('draft', 'submitted')
                   AND a.merit_score IS NULL AND a.need_score IS NULL,
    'locked_reason', CASE
      WHEN a.status IN ('draft', 'submitted')
           AND (a.merit_score IS NOT NULL OR a.need_score IS NOT NULL)
        THEN 'The committee has started reviewing this application.'
      WHEN a.status = 'screening'  THEN 'The committee is reviewing this application.'
      WHEN a.status = 'verified'   THEN 'Committee members have verified this application in person.'
      WHEN a.status = 'interview'  THEN 'This application is at the interview stage.'
      WHEN a.status = 'approved'   THEN 'This application has been approved.'
      WHEN a.status = 'declined'   THEN 'A decision has been made on this application.'
      WHEN a.status = 'waitlisted' THEN 'This application is on the waiting list.'
      WHEN a.status = 'withdrawn'  THEN 'This application was withdrawn.'
      ELSE NULL END,
    'family', COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.created_at)
                          FROM wazifa_family_members f WHERE f.application_id = a.id), '[]'::jsonb),
    'academics', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at)
                             FROM wazifa_academic_records r WHERE r.application_id = a.id), '[]'::jsonb),
    'documents', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                               'id', d.id, 'kind', d.kind, 'label', d.label, 'url', d.url,
                               'seen', d.seen_by IS NOT NULL)
                             ORDER BY d.created_at)
                             FROM wazifa_documents d WHERE d.application_id = a.id), '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_wazifa_application(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_wazifa_application(uuid) TO authenticated;
