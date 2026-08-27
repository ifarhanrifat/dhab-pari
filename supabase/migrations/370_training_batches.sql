-- Migration 370: an academy is one project, one card, one ledger account —
-- but a real academy usually runs several independent pricing groups
-- inside it (kids vs adults, tape ball vs hard ball, day vs floodlit
-- night), each with its own honest rate, not one flat number for the
-- whole academy. A "batch" is that group: it belongs to a project, carries
-- its own villager/outsider × monthly/full-course rate card (the same 4
-- fields 366 put directly on projects — moved here since one number per
-- academy was never going to be enough), and a schedule note so admin can
-- tell "Kids · Tape Ball · Day" from "Adults · Hard Ball · Night" at a
-- glance. An academy that only ever needs one price still just gets one
-- batch — nothing forces the split unless it's real.

CREATE TABLE IF NOT EXISTS training_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label varchar NOT NULL,
  label_ur varchar,
  schedule_note text,
  fee_villager_monthly_pkr decimal,
  fee_outsider_monthly_pkr decimal,
  fee_villager_full_pkr decimal,
  fee_outsider_full_pkr decimal,
  status varchar NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS training_batches_project_idx ON training_batches(project_id, status);

ALTER TABLE training_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY training_batches_admin ON training_batches FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects') AND current_admin_permission('manage_parties'));

-- A scoped trainer needs to see (and, in the collect-payment flow, name)
-- the batches on their own assigned academy, same narrowing as their
-- enrollment/charge visibility (367).
CREATE POLICY training_batches_trainer ON training_batches FOR SELECT TO authenticated
  USING (current_admin_can_collect_for_training_program(project_id));

-- Public/portal read — a batch's label and schedule aren't sensitive, and
-- a parent looking at "My academy fees" should be able to tell which
-- group their child is actually in.
CREATE POLICY training_batches_read ON training_batches FOR SELECT
  USING (true);

-- ── Enrollments now belong to a batch, not directly to a project ─────────
ALTER TABLE training_enrollments ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES training_batches(id);

-- Backfill: give every academy that already has enrollments (or a rate
-- card) exactly one "General" batch carrying over whatever was on the
-- project, and point its existing enrollments at it — nothing about an
-- already-enrolled student's fee changes.
DO $$
DECLARE r record; v_batch_id uuid;
BEGIN
  FOR r IN
    SELECT id, fee_villager_monthly_pkr, fee_outsider_monthly_pkr, fee_villager_full_pkr, fee_outsider_full_pkr
    FROM projects
    WHERE category IN ('sports', 'training')
      AND (
        EXISTS (SELECT 1 FROM training_enrollments e WHERE e.project_id = projects.id)
        OR fee_villager_monthly_pkr IS NOT NULL OR fee_outsider_monthly_pkr IS NOT NULL
        OR fee_villager_full_pkr IS NOT NULL OR fee_outsider_full_pkr IS NOT NULL
      )
  LOOP
    INSERT INTO training_batches (project_id, label, label_ur, fee_villager_monthly_pkr, fee_outsider_monthly_pkr, fee_villager_full_pkr, fee_outsider_full_pkr)
    VALUES (r.id, 'General', 'عمومی', r.fee_villager_monthly_pkr, r.fee_outsider_monthly_pkr, r.fee_villager_full_pkr, r.fee_outsider_full_pkr)
    RETURNING id INTO v_batch_id;

    UPDATE training_enrollments SET batch_id = v_batch_id WHERE project_id = r.id AND batch_id IS NULL;
  END LOOP;
END $$;

-- The rate card lives on training_batches now — remove the columns from
-- projects rather than leaving a second, now-unused copy to drift out of
-- sync with the batch that actually governs a student's fee.
ALTER TABLE projects
  DROP COLUMN IF EXISTS fee_villager_monthly_pkr,
  DROP COLUMN IF EXISTS fee_outsider_monthly_pkr,
  DROP COLUMN IF EXISTS fee_villager_full_pkr,
  DROP COLUMN IF EXISTS fee_outsider_full_pkr;

-- ── enroll_in_training_program(): resolves the rate from the chosen
--    batch instead of the project directly ───────────────────────────────
DROP FUNCTION IF EXISTS enroll_in_training_program(uuid, varchar, varchar, varchar, varchar, text, varchar, varchar, varchar, decimal, decimal, text, uuid);

CREATE OR REPLACE FUNCTION enroll_in_training_program(
  p_batch_id uuid, p_student_name varchar, p_student_name_ur varchar,
  p_guardian_name varchar, p_guardian_whatsapp_number varchar, p_address text, p_sector varchar,
  p_participant_type varchar, p_fee_type varchar,
  p_discount_pct decimal DEFAULT NULL, p_discount_amount_pkr decimal DEFAULT NULL, p_discount_reason text DEFAULT NULL,
  p_portal_user_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  b training_batches%ROWTYPE;
  v_base decimal;
  v_fee decimal;
  v_enrollment_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO b FROM training_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found' USING ERRCODE = 'P0001'; END IF;

  v_base := CASE
    WHEN p_fee_type = 'monthly' AND p_participant_type = 'villager' THEN COALESCE(b.fee_villager_monthly_pkr, 0)
    WHEN p_fee_type = 'monthly' AND p_participant_type = 'outsider' THEN COALESCE(b.fee_outsider_monthly_pkr, 0)
    WHEN p_fee_type = 'full_course' AND p_participant_type = 'villager' THEN COALESCE(b.fee_villager_full_pkr, 0)
    WHEN p_fee_type = 'full_course' AND p_participant_type = 'outsider' THEN COALESCE(b.fee_outsider_full_pkr, 0)
    ELSE 0
  END;

  v_fee := v_base;
  IF p_discount_pct IS NOT NULL THEN v_fee := v_fee - (v_fee * p_discount_pct / 100); END IF;
  IF p_discount_amount_pkr IS NOT NULL THEN v_fee := v_fee - p_discount_amount_pkr; END IF;
  IF v_fee < 0 THEN v_fee := 0; END IF;

  INSERT INTO training_enrollments (
    project_id, batch_id, portal_user_id, student_name, student_name_ur, guardian_name, guardian_whatsapp_number,
    address, sector, participant_type, fee_type, fee_amount_pkr,
    discount_pct, discount_amount_pkr, discount_reason, registered_by
  ) VALUES (
    b.project_id, p_batch_id, p_portal_user_id, p_student_name, p_student_name_ur, p_guardian_name, p_guardian_whatsapp_number,
    p_address, p_sector, p_participant_type, p_fee_type, v_fee,
    p_discount_pct, p_discount_amount_pkr, p_discount_reason, current_admin_user_id()
  ) RETURNING id INTO v_enrollment_id;

  IF p_fee_type = 'full_course' AND v_fee > 0 THEN
    INSERT INTO training_fee_charges (enrollment_id, charge_no, due_on, amount_pkr)
    VALUES (v_enrollment_id, 1, (now() AT TIME ZONE 'Asia/Karachi')::date, v_fee);
  END IF;

  RETURN v_enrollment_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION enroll_in_training_program(uuid, varchar, varchar, varchar, varchar, text, varchar, varchar, varchar, decimal, decimal, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION enroll_in_training_program(uuid, varchar, varchar, varchar, varchar, text, varchar, varchar, varchar, decimal, decimal, text, uuid) TO authenticated;

-- my_training_fees() gains the batch label so a parent can tell which
-- group their child is in.
CREATE OR REPLACE FUNCTION my_training_fees() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'enrollment_id', e.id, 'project_id', e.project_id,
    'program_title', COALESCE(proj.display_name, proj.title), 'batch_label', bat.label, 'student_name', e.student_name,
    'fee_type', e.fee_type, 'monthly_amount_pkr', e.fee_amount_pkr,
    'due_soon', (SELECT jsonb_agg(jsonb_build_object(
        'id', c.id, 'due_on', c.due_on, 'amount', c.amount_pkr, 'paid', c.paid_pkr, 'status', c.status
      ) ORDER BY c.due_on) FROM training_fee_charges c
      WHERE c.enrollment_id = e.id AND c.status IN ('due', 'part_paid')),
    'total_paid', (SELECT COALESCE(SUM(paid_pkr), 0) FROM training_fee_charges WHERE enrollment_id = e.id),
    'total_overdue', (SELECT COALESCE(SUM(amount_pkr - paid_pkr), 0) FROM training_fee_charges
      WHERE enrollment_id = e.id AND status IN ('due', 'part_paid') AND due_on < (now() AT TIME ZONE 'Asia/Karachi')::date)
  ) ORDER BY e.enrolled_at DESC), '[]'::jsonb)
  FROM training_enrollments e
  JOIN projects proj ON proj.id = e.project_id
  LEFT JOIN training_batches bat ON bat.id = e.batch_id
  WHERE e.portal_user_id = current_portal_user_id() AND e.status = 'active';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- my_training_academy_roster() (367) gains the batch label per student.
CREATE OR REPLACE FUNCTION my_training_academy_roster() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'project_id', proj.id, 'program_title', COALESCE(proj.display_name, proj.title),
    'students', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'enrollment_id', en.id, 'student_name', en.student_name, 'batch_label', bat.label, 'participant_type', en.participant_type,
        'fee_type', en.fee_type, 'fee_amount_pkr', en.fee_amount_pkr, 'status', en.status,
        'charges', (SELECT jsonb_agg(jsonb_build_object(
            'id', c.id, 'charge_no', c.charge_no, 'due_on', c.due_on,
            'amount_pkr', c.amount_pkr, 'paid_pkr', c.paid_pkr, 'status', c.status
          ) ORDER BY c.charge_no) FROM training_fee_charges c WHERE c.enrollment_id = en.id)
      ) ORDER BY en.student_name), '[]'::jsonb)
      FROM training_enrollments en LEFT JOIN training_batches bat ON bat.id = en.batch_id
      WHERE en.project_id = proj.id AND en.status = 'active'
    )
  )), '[]'::jsonb)
  FROM projects proj
  JOIN admin_users au ON au.auth_user_id = auth.uid()
  WHERE au.is_active = true AND au.can_collect_payments
    AND proj.id = ANY(au.assigned_training_program_ids);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ── Retiring the old free-workshop system ─────────────────────────────
-- Preserve the one real workshop and its 2 real registrants as a genuine
-- project + batch + enrollments (free — fee_amount_pkr stays 0 throughout,
-- so training_fee_run() never raises a charge for them) rather than just
-- deleting real signups. Everything from here on, paid or free, is one
-- project-card system.
DO $$
DECLARE v_project_id uuid; v_batch_id uuid; prog record; reg record;
BEGIN
  IF EXISTS (SELECT 1 FROM training_programs) THEN
    FOR prog IN SELECT * FROM training_programs LOOP
      INSERT INTO projects (title, description, location, status, category, funding_model)
      VALUES (prog.title, prog.description, prog.location, prog.status, 'training', 'one_time')
      RETURNING id INTO v_project_id;

      INSERT INTO training_batches (project_id, label, label_ur, schedule_note)
      VALUES (v_project_id, 'General', 'عمومی', prog.location)
      RETURNING id INTO v_batch_id;

      FOR reg IN
        SELECT tr.portal_user_id, pu.full_name, pu.mobile
        FROM training_program_registrations tr JOIN portal_users pu ON pu.id = tr.portal_user_id
        WHERE tr.training_program_id = prog.id AND tr.status = 'registered'
      LOOP
        INSERT INTO training_enrollments (
          project_id, batch_id, portal_user_id, student_name, guardian_whatsapp_number,
          participant_type, fee_type, fee_amount_pkr, registered_by
        ) VALUES (
          v_project_id, v_batch_id, reg.portal_user_id, reg.full_name, reg.mobile,
          'villager', 'full_course', 0, NULL
        );
      END LOOP;
    END LOOP;
  END IF;
END $$;

DROP FUNCTION IF EXISTS register_for_training_program(uuid);
DROP TABLE IF EXISTS training_program_registrations;
DROP TABLE IF EXISTS training_programs;
