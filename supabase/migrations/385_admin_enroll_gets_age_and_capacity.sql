-- Migration 385: enroll_in_training_program() (the admin/trainer manual
-- add-a-student path) never had the checks request_training_enrollment()
-- (the portal self-service path) has had since 372 — no student age
-- captured or validated against the batch's age range, and no capacity
-- check. A trainer adding a walk-in in person could silently enrol a
-- 7-year-old into a 12-18 batch, or push a batch past its stated
-- capacity, with nothing in the system ever knowing.
--
-- Capacity is a warning in the UI (see the app-side change alongside
-- this), not a hard block here — unlike a portal visitor booking blind,
-- a trainer standing in front of the family is a legitimate judgment
-- call the committee may want to allow past a stated capacity. Age is a
-- hard block either way: a batch's age range is a real constraint
-- (the group the sessions are actually planned for), not a soft target.
DROP FUNCTION IF EXISTS enroll_in_training_program(uuid, varchar, varchar, varchar, varchar, text, varchar, varchar, varchar, decimal, decimal, text, uuid);

CREATE OR REPLACE FUNCTION enroll_in_training_program(
  p_batch_id uuid, p_student_name varchar, p_student_name_ur varchar,
  p_guardian_name varchar, p_guardian_whatsapp_number varchar, p_address text, p_sector varchar,
  p_participant_type varchar, p_fee_type varchar,
  p_discount_pct decimal DEFAULT NULL, p_discount_amount_pkr decimal DEFAULT NULL, p_discount_reason text DEFAULT NULL,
  p_portal_user_id uuid DEFAULT NULL, p_student_age int DEFAULT NULL
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

  IF (b.age_min IS NOT NULL OR b.age_max IS NOT NULL) THEN
    IF p_student_age IS NULL THEN
      RAISE EXCEPTION 'This batch has an age requirement — enter the student''s age.' USING ERRCODE = 'P0001';
    END IF;
    IF (b.age_min IS NOT NULL AND p_student_age < b.age_min) OR (b.age_max IS NOT NULL AND p_student_age > b.age_max) THEN
      RAISE EXCEPTION 'This batch is for ages % to % — pick the batch that matches the student''s age.',
        COALESCE(b.age_min::text, '0'), COALESCE(b.age_max::text, 'any') USING ERRCODE = 'P0001';
    END IF;
  END IF;

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
    project_id, batch_id, portal_user_id, student_name, student_name_ur, student_age, guardian_name, guardian_whatsapp_number,
    address, sector, participant_type, fee_type, fee_amount_pkr,
    discount_pct, discount_amount_pkr, discount_reason, registered_by
  ) VALUES (
    b.project_id, p_batch_id, p_portal_user_id, p_student_name, p_student_name_ur, p_student_age, p_guardian_name, p_guardian_whatsapp_number,
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

REVOKE ALL ON FUNCTION enroll_in_training_program(uuid, varchar, varchar, varchar, varchar, text, varchar, varchar, varchar, decimal, decimal, text, uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION enroll_in_training_program(uuid, varchar, varchar, varchar, varchar, text, varchar, varchar, varchar, decimal, decimal, text, uuid, int) TO authenticated;

-- The admin roster/enroll screens select training_batches directly
-- (unlike the portal, which goes through training_batches_for_join/
-- training_batches_public) — capacity and current fill weren't part of
-- that select at all. No RPC needed; the raw enrollment count per batch
-- is cheap enough to compute client-side from what the page already loads.
