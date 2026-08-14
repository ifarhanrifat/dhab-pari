-- Migration 227: the student holds the account.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Why applying on somebody else's behalf is being closed off
-- ═════════════════════════════════════════════════════════════════════════
-- The form let a father apply for his son, or a donor for a neighbour's
-- daughter. It reads as helpful and it is the wrong shape, because everything
-- that happens afterwards is addressed to whoever filled the form in:
--
--   the student cannot see what has been paid to their college
--   the student never learns what they owe on a qarz-e-hasana
--   the reminder before an instalment falls due goes to the father's phone
--   the father keeps getting alerts about an education that is not his
--   and when the father stops using the portal, the student's record has no
--   living owner at all
--
-- Taleemi Wazifa is for college, university and diploma students — old enough
-- to hold a phone and a CNIC, which the form already asks for. So the account
-- belongs to the person the money follows, and the alerts reach the person who
-- has to act on them.
--
-- Kafalat is deliberately untouched: those are school children, and the
-- guardian is the right account holder there.
--
-- Staff are exempt. A committee member typing up a paper form handed in at the
-- mosque is not the case this guards against, and the paper form is signed.

CREATE OR REPLACE FUNCTION trg_wazifa_application_self_only() RETURNS trigger AS $$
BEGIN
  -- Entered by staff from a signed paper form: leave it alone.
  IF current_admin_user_id() IS NOT NULL THEN RETURN NEW; END IF;

  IF current_portal_user_id() IS NULL THEN
    RAISE EXCEPTION 'Please sign in to apply.' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM wazifa_students s
     WHERE s.id = NEW.student_id
       AND s.portal_user_id = current_portal_user_id()
  ) THEN
    RAISE EXCEPTION
      'A student applies from their own account. Ask them to register on the portal with their own phone number so they can see their fees, their dues and their reminders.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Kept as a column because old rows carry it and the printed sheet shows
  -- it, but from here it can only say one thing.
  NEW.applicant_for := 'self';
  NEW.applicant_name := NULL;
  NEW.applicant_relation := NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS wazifa_application_self_only ON wazifa_applications;
CREATE TRIGGER wazifa_application_self_only
  BEFORE INSERT OR UPDATE ON wazifa_applications
  FOR EACH ROW EXECUTE FUNCTION trg_wazifa_application_self_only();

-- One student record per portal user. Without this a person could keep
-- creating students under their own account and apply for each of them,
-- which is the same hole through a different door.
CREATE UNIQUE INDEX IF NOT EXISTS wazifa_students_one_per_portal_user
  ON wazifa_students(portal_user_id) WHERE portal_user_id IS NOT NULL;

-- The student's own name comes from the account rather than a free-text box,
-- so the person on the award is the person who signed in.
CREATE OR REPLACE FUNCTION trg_wazifa_student_matches_account() RETURNS trigger AS $$
DECLARE u portal_users%ROWTYPE;
BEGIN
  IF current_admin_user_id() IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.portal_user_id IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO u FROM portal_users WHERE id = NEW.portal_user_id;
  IF FOUND THEN
    NEW.full_name := COALESCE(NULLIF(trim(NEW.full_name), ''), u.full_name);
    NEW.phone := COALESCE(NULLIF(trim(NEW.phone), ''), u.mobile);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS wazifa_student_matches_account ON wazifa_students;
CREATE TRIGGER wazifa_student_matches_account
  BEFORE INSERT OR UPDATE ON wazifa_students
  FOR EACH ROW EXECUTE FUNCTION trg_wazifa_student_matches_account();

-- ── What the student owes, in one place they can see ─────────────────────
-- The reason the account has to be theirs: this is the screen that tells them
-- an instalment is due, and it is worthless on somebody else's phone.
CREATE OR REPLACE FUNCTION my_wazifa_dues() RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'awards', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'award_id', a.id, 'academic_year', a.academic_year,
        'is_loan', a.is_loan, 'position', wazifa_loan_position(a.id)
      ) ORDER BY a.created_at DESC)
      FROM wazifa_awards a JOIN wazifa_students s ON s.id = a.student_id
     WHERE s.portal_user_id = current_portal_user_id() AND a.status <> 'cancelled'), '[]'::jsonb),
    'due_soon', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', r.id, 'due_on', r.due_on, 'amount', r.amount_pkr, 'status', r.status)
      ORDER BY r.due_on)
      FROM wazifa_repayment_schedule r
      JOIN wazifa_awards a ON a.id = r.award_id
      JOIN wazifa_students s ON s.id = a.student_id
     WHERE s.portal_user_id = current_portal_user_id()
       AND r.status IN ('due', 'part_paid')), '[]'::jsonb),
    'total_outstanding', COALESCE((
      SELECT SUM((wazifa_loan_position(a.id)->>'outstanding')::decimal)
        FROM wazifa_awards a JOIN wazifa_students s ON s.id = a.student_id
       WHERE s.portal_user_id = current_portal_user_id() AND a.is_loan), 0)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_wazifa_dues() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_wazifa_dues() TO authenticated;
