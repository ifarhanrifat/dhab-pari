-- Migration 374: a monthly academy fee's *first* charge is now raised the
-- moment a student is confirmed, not left for the next daily
-- training_fee_run() pass. There was never a real reason for this delay —
-- it just copied Wazifa's "next month's charge comes from the cron" shape
-- wholesale, including for the first month, which doesn't need to wait on
-- anything. A full_course fee already charges immediately on confirmation;
-- a monthly fee's first month should behave the same way. Only *future*
-- months genuinely belong on the daily schedule (you can't charge next
-- month in advance) — training_fee_run() is untouched, and its own
-- "does a charge already exist for this month" check means inserting the
-- first month's charge here doesn't create a duplicate when the cron
-- later runs for that same month.

CREATE OR REPLACE FUNCTION confirm_training_enrollment(p_enrollment_id uuid) RETURNS void AS $$
DECLARE
  e training_enrollments%ROWTYPE;
  proj projects%ROWTYPE;
BEGIN
  SELECT * INTO e FROM training_enrollments WHERE id = p_enrollment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found' USING ERRCODE = 'P0001'; END IF;
  IF e.status != 'pending' THEN RAISE EXCEPTION 'This request has already been actioned.' USING ERRCODE = 'P0001'; END IF;

  IF NOT (COALESCE(current_admin_permission('manage_parties'), false)
          OR COALESCE(current_admin_can_collect_for_training_program(e.project_id), false)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  UPDATE training_enrollments
     SET status = 'active', confirmed_at = now(), confirmed_by = current_admin_user_id()
   WHERE id = p_enrollment_id;

  -- Raise the first charge immediately regardless of fee_type — a
  -- full-course fee has no monthly cadence to wait for at all, and a
  -- monthly fee's *first* month shouldn't wait for tomorrow's cron either.
  IF e.fee_amount_pkr > 0 THEN
    INSERT INTO training_fee_charges (enrollment_id, charge_no, due_on, amount_pkr)
    VALUES (p_enrollment_id, 1, (now() AT TIME ZONE 'Asia/Karachi')::date, e.fee_amount_pkr);
  END IF;

  IF e.portal_user_id IS NOT NULL THEN
    SELECT * INTO proj FROM projects WHERE id = e.project_id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (e.portal_user_id, 'training_enrollment_confirmed', 'Seat confirmed',
      e.student_name || ' is confirmed for ' || COALESCE(proj.display_name, proj.title),
      '/portal/training-programs');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Same fix for the staff-direct enroll path (admin/trainer typing a
-- student in at /admin/academy-fees) — it should behave identically to
-- the self-enroll-then-confirm path, not just full_course.
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
    discount_pct, discount_amount_pkr, discount_reason, registered_by, status
  ) VALUES (
    b.project_id, p_batch_id, p_portal_user_id, p_student_name, p_student_name_ur, p_guardian_name, p_guardian_whatsapp_number,
    p_address, p_sector, p_participant_type, p_fee_type, v_fee,
    p_discount_pct, p_discount_amount_pkr, p_discount_reason, current_admin_user_id(), 'active'
  ) RETURNING id INTO v_enrollment_id;

  -- First charge now, regardless of fee_type — see migration comment above.
  IF v_fee > 0 THEN
    INSERT INTO training_fee_charges (enrollment_id, charge_no, due_on, amount_pkr)
    VALUES (v_enrollment_id, 1, (now() AT TIME ZONE 'Asia/Karachi')::date, v_fee);
  END IF;

  RETURN v_enrollment_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION enroll_in_training_program(uuid, varchar, varchar, varchar, varchar, text, varchar, varchar, varchar, decimal, decimal, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION enroll_in_training_program(uuid, varchar, varchar, varchar, varchar, text, varchar, varchar, varchar, decimal, decimal, text, uuid) TO authenticated;
