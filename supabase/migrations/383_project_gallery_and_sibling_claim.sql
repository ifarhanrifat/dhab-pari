-- Migration 383: two gaps from actually using the academy feature —
--
--   1. project_media (116) already existed for a photo gallery but had
--      zero frontend usage — every project only ever had the single
--      before_image_url/after_image_url pair. Adding is_cover so an
--      admin can designate which one photo represents the project on
--      the home page / listing card, independent of before/after.
--
--   2. Sibling discount only ever auto-applied when the SAME portal
--      account had a prior pending/active enrollment — which misses the
--      real case an elder sibling registered under their own account,
--      or a different parent/guardian registered the first child. The
--      portal join form gets an explicit "this is a sibling of ..."
--      declaration instead of relying purely on account history; admin
--      still sees and can correct it at confirmation (same trust-but-
--      verify pattern as the villager/outsider sector-mismatch flag).

ALTER TABLE project_media ADD COLUMN IF NOT EXISTS is_cover boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS project_media_one_cover_per_project
  ON project_media (project_id) WHERE is_cover;

-- CREATE OR REPLACE only replaces a function whose argument list matches
-- exactly — adding p_sibling_note below would otherwise silently
-- overload this instead of replacing it (the exact mistake made and
-- fixed earlier this week on submit_combined_pledge_payment). Drop the
-- old 10-arg signature first so there's only ever one.
DROP FUNCTION IF EXISTS request_training_enrollment(uuid, varchar, varchar, int, varchar, varchar, text, varchar, varchar, varchar);

CREATE OR REPLACE FUNCTION request_training_enrollment(
  p_batch_id uuid, p_student_name varchar, p_student_name_ur varchar, p_student_age int,
  p_guardian_name varchar, p_guardian_whatsapp_number varchar, p_address text, p_sector varchar,
  p_participant_type varchar, p_fee_type varchar,
  p_sibling_note text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid;
  b training_batches%ROWTYPE;
  v_base decimal; v_fee decimal;
  v_taken int;
  v_sibling_count int;
  v_discount_pct decimal;
  v_discount_reason text;
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

  -- Sibling discount: either a 2nd (or later) pending/active request from
  -- this same portal account (anywhere, not just this academy/batch), OR
  -- an explicit "sibling of ..." note the parent typed in — the second
  -- path is what actually covers an elder sibling with their own
  -- account, or a different parent/guardian registering the first child.
  -- Either way it's the *new* batch's own discount rate, and admin still
  -- sees the claim (discount_reason) at confirmation to catch a false one.
  SELECT count(*) INTO v_sibling_count FROM training_enrollments
    WHERE portal_user_id = v_portal_user_id AND status IN ('pending', 'active');
  v_discount_pct := NULL;
  v_discount_reason := NULL;
  IF COALESCE(b.sibling_discount_pct, 0) > 0 THEN
    IF v_sibling_count > 0 THEN
      v_discount_pct := b.sibling_discount_pct;
      v_discount_reason := 'Sibling discount (auto-applied — same portal account)';
    ELSIF p_sibling_note IS NOT NULL AND trim(p_sibling_note) <> '' THEN
      v_discount_pct := b.sibling_discount_pct;
      v_discount_reason := 'Sibling discount (parent declared): ' || trim(p_sibling_note);
    END IF;
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
    p_participant_type, p_fee_type, v_fee, v_discount_pct, v_discount_reason, 'pending'
  ) RETURNING id INTO v_enrollment_id;

  RETURN v_enrollment_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION request_training_enrollment(uuid, varchar, varchar, int, varchar, varchar, text, varchar, varchar, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION request_training_enrollment(uuid, varchar, varchar, int, varchar, varchar, text, varchar, varchar, varchar, text) TO authenticated;
