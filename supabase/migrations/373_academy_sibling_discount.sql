-- Migration 373: an automatic sibling discount for a 2nd (or later) child
-- self-enrolled from the same portal account, plus what the redesigned
-- "Academies" portal tab needs to show fee+discount info up front.
--
-- Admin sets the discount per batch (same pattern as the fee columns
-- themselves — a cricket academy and a coding class can want different
-- policies, or none at all; default is no discount). Detection is
-- deliberately simple: whoever is signed in already can only ever
-- self-enroll their own children (every request ties to
-- current_portal_user_id(), there's no way to enroll someone else's kid)
-- — so a 2nd+ pending/active request from that same account, anywhere,
-- is by definition a sibling. Each still has to pass its own batch's
-- existing age-gate independently — a sibling in a different batch (a
-- different age bracket, even a different academy) still qualifies,
-- exactly as asked for; nothing new needed there since request_
-- training_enrollment() already gates every request by its own batch.

ALTER TABLE training_batches
  ADD COLUMN IF NOT EXISTS sibling_discount_pct decimal CHECK (sibling_discount_pct IS NULL OR (sibling_discount_pct >= 0 AND sibling_discount_pct <= 100));

CREATE OR REPLACE FUNCTION request_training_enrollment(
  p_batch_id uuid, p_student_name varchar, p_student_name_ur varchar, p_student_age int,
  p_guardian_name varchar, p_guardian_whatsapp_number varchar, p_address text, p_sector varchar,
  p_participant_type varchar, p_fee_type varchar
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid;
  b training_batches%ROWTYPE;
  v_base decimal; v_fee decimal;
  v_taken int;
  v_sibling_count int;
  v_discount_pct decimal;
  v_enrollment_id uuid;
BEGIN
  v_portal_user_id := current_portal_user_id();
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in to request a seat.' USING ERRCODE = 'P0001';
  END IF;
  IF p_student_name IS NULL OR trim(p_student_name) = '' THEN
    RAISE EXCEPTION 'Student name is required.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO b FROM training_batches WHERE id = p_batch_id AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'This batch is not open for joining.' USING ERRCODE = 'P0001'; END IF;

  IF (b.age_min IS NOT NULL OR b.age_max IS NOT NULL) THEN
    IF p_student_age IS NULL THEN
      RAISE EXCEPTION 'This batch has an age requirement — enter the student''s age.' USING ERRCODE = 'P0001';
    END IF;
    IF (b.age_min IS NOT NULL AND p_student_age < b.age_min) OR (b.age_max IS NOT NULL AND p_student_age > b.age_max) THEN
      RAISE EXCEPTION 'This batch is for ages % to % — pick the batch that matches the student''s age.',
        COALESCE(b.age_min::text, '0'), COALESCE(b.age_max::text, 'any') USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF b.capacity IS NOT NULL THEN
    SELECT count(*) INTO v_taken FROM training_enrollments
      WHERE batch_id = p_batch_id AND status IN ('pending', 'active');
    IF v_taken >= b.capacity THEN
      RAISE EXCEPTION 'This batch is full. Please choose another batch or session.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM training_enrollments
             WHERE batch_id = p_batch_id AND portal_user_id = v_portal_user_id
               AND student_name = p_student_name AND status IN ('pending', 'active')) THEN
    RAISE EXCEPTION 'You already have a request or seat for % in this batch.', p_student_name USING ERRCODE = 'P0001';
  END IF;

  v_base := CASE
    WHEN p_fee_type = 'monthly' AND p_participant_type = 'villager' THEN COALESCE(b.fee_villager_monthly_pkr, 0)
    WHEN p_fee_type = 'monthly' AND p_participant_type = 'outsider' THEN COALESCE(b.fee_outsider_monthly_pkr, 0)
    WHEN p_fee_type = 'full_course' AND p_participant_type = 'villager' THEN COALESCE(b.fee_villager_full_pkr, 0)
    WHEN p_fee_type = 'full_course' AND p_participant_type = 'outsider' THEN COALESCE(b.fee_outsider_full_pkr, 0)
    ELSE 0
  END;

  -- Sibling discount: a 2nd (or later) pending/active request from this
  -- same portal account, anywhere — not just this academy or batch —
  -- qualifies, using the *new* batch's own discount rate.
  SELECT count(*) INTO v_sibling_count FROM training_enrollments
    WHERE portal_user_id = v_portal_user_id AND status IN ('pending', 'active');
  v_discount_pct := NULL;
  IF v_sibling_count > 0 AND COALESCE(b.sibling_discount_pct, 0) > 0 THEN
    v_discount_pct := b.sibling_discount_pct;
  END IF;

  v_fee := v_base;
  IF v_discount_pct IS NOT NULL THEN v_fee := v_fee - (v_fee * v_discount_pct / 100); END IF;
  IF v_fee < 0 THEN v_fee := 0; END IF;

  INSERT INTO training_enrollments (
    project_id, batch_id, portal_user_id, student_name, student_name_ur, student_age,
    guardian_name, guardian_whatsapp_number, address, sector,
    participant_type, fee_type, fee_amount_pkr, discount_pct, discount_reason, status
  ) VALUES (
    b.project_id, p_batch_id, v_portal_user_id, p_student_name, p_student_name_ur, p_student_age,
    p_guardian_name, p_guardian_whatsapp_number, p_address, p_sector,
    p_participant_type, p_fee_type, v_fee, v_discount_pct,
    CASE WHEN v_discount_pct IS NOT NULL THEN 'Sibling discount (auto-applied)' ELSE NULL END, 'pending'
  ) RETURNING id INTO v_enrollment_id;

  RETURN v_enrollment_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- training_batches_for_join(): now also returns sibling_discount_pct so
-- the portal join form can show "X% off if this is a 2nd child" up front
-- rather than only finding out after submitting.
CREATE OR REPLACE FUNCTION training_batches_for_join(p_project_id uuid) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'label', b.label, 'label_ur', b.label_ur, 'schedule_note', b.schedule_note,
    'age_min', b.age_min, 'age_max', b.age_max, 'session_days', b.session_days, 'session_time', b.session_time,
    'fee_villager_monthly_pkr', b.fee_villager_monthly_pkr, 'fee_outsider_monthly_pkr', b.fee_outsider_monthly_pkr,
    'fee_villager_full_pkr', b.fee_villager_full_pkr, 'fee_outsider_full_pkr', b.fee_outsider_full_pkr,
    'sibling_discount_pct', b.sibling_discount_pct,
    'capacity', b.capacity,
    'spots_left', CASE WHEN b.capacity IS NULL THEN NULL ELSE
      greatest(0, b.capacity - (SELECT count(*) FROM training_enrollments e
                                  WHERE e.batch_id = b.id AND e.status IN ('pending', 'active'))) END
  ) ORDER BY b.label), '[]'::jsonb)
  FROM training_batches b WHERE b.project_id = p_project_id AND b.status = 'active';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- training_batches_public(): a lighter, project-agnostic read for the
-- redesigned Academies catalog tab — every open academy's batches (fee +
-- spots) in one call instead of one round-trip per academy card.
CREATE OR REPLACE FUNCTION training_batches_public() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'project_id', b.project_id, 'label', b.label, 'label_ur', b.label_ur,
    'schedule_note', b.schedule_note, 'age_min', b.age_min, 'age_max', b.age_max,
    'fee_villager_monthly_pkr', b.fee_villager_monthly_pkr, 'fee_outsider_monthly_pkr', b.fee_outsider_monthly_pkr,
    'fee_villager_full_pkr', b.fee_villager_full_pkr, 'fee_outsider_full_pkr', b.fee_outsider_full_pkr,
    'sibling_discount_pct', b.sibling_discount_pct, 'capacity', b.capacity,
    'spots_left', CASE WHEN b.capacity IS NULL THEN NULL ELSE
      greatest(0, b.capacity - (SELECT count(*) FROM training_enrollments e
                                  WHERE e.batch_id = b.id AND e.status IN ('pending', 'active'))) END
  ) ORDER BY b.label), '[]'::jsonb)
  FROM training_batches b WHERE b.status = 'active';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION training_batches_public() TO authenticated;
