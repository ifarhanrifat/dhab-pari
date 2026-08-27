-- Migration 372: portal self-enrollment ("Join Academy") for training
-- academies, on top of the batch/fee system (366/367/370).
--
-- Until now the only door into training_enrollments was staff typing a
-- student in at /admin/academy-fees. This adds a second, portal-facing
-- door: a signed-in donor/parent picks a batch and requests a seat
-- themselves. Same discipline every other self-submitted thing on this
-- site already follows (a donation "announced" then verified, a
-- complaint filed then reviewed) — a request lands as 'pending' and does
-- nothing financially until a trainer/accountant confirms it. Only once
-- confirmed does it become a real 'active' enrollment and start owing
-- fees through the existing training_fee_run()/pay_training_fee_charge()
-- machinery, unchanged.
--
-- Also adds what a real academy with several batches actually needs to
-- self-manage requests without a human re-checking each one by hand:
-- a capacity per batch (so a full batch can't silently overbook while
-- confirmations are pending) and an age range per batch (so "5-8 at 4pm"
-- vs "16+ at 8pm" is enforced at request time, not just written on a
-- schedule note). Both are optional — leave them null and a batch stays
-- exactly as unrestricted as it is today.

-- ── 1. training_batches: capacity, age range, and a real weekly schedule
--      (day-of-week + time) — the last of these is what actually lets a
--      reminder be sent "your session is today", not just described in
--      free text nobody but a human reads.
ALTER TABLE training_batches
  ADD COLUMN IF NOT EXISTS capacity int CHECK (capacity IS NULL OR capacity > 0),
  ADD COLUMN IF NOT EXISTS age_min int CHECK (age_min IS NULL OR age_min >= 0),
  ADD COLUMN IF NOT EXISTS age_max int CHECK (age_max IS NULL OR age_max >= 0),
  -- 0 = Sunday .. 6 = Saturday, matching JS Date#getDay() and Postgres
  -- EXTRACT(DOW FROM ...) — one convention, no translation layer needed
  -- between the frontend day-picker and the reminder cron below.
  ADD COLUMN IF NOT EXISTS session_days int[],
  ADD COLUMN IF NOT EXISTS session_time time;

-- ── 2. training_enrollments: a request lifecycle in front of 'active'.
ALTER TABLE training_enrollments DROP CONSTRAINT IF EXISTS training_enrollments_status_check;
ALTER TABLE training_enrollments ADD CONSTRAINT training_enrollments_status_check
  CHECK (status IN ('pending', 'active', 'completed', 'withdrawn', 'rejected'));

ALTER TABLE training_enrollments
  ADD COLUMN IF NOT EXISTS student_age int CHECK (student_age IS NULL OR student_age >= 0),
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_by uuid REFERENCES admin_users(id),
  ADD COLUMN IF NOT EXISTS rejected_reason text;

-- ── 3. request_training_enrollment() — the portal side. No manage_parties
--      check (that's the whole point); the caller must just be a real
--      signed-in portal user. Age and capacity are enforced here, at
--      request time, not left for a human to notice later.
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
  v_fee := v_base;

  INSERT INTO training_enrollments (
    project_id, batch_id, portal_user_id, student_name, student_name_ur, student_age,
    guardian_name, guardian_whatsapp_number, address, sector,
    participant_type, fee_type, fee_amount_pkr, status
  ) VALUES (
    b.project_id, p_batch_id, v_portal_user_id, p_student_name, p_student_name_ur, p_student_age,
    p_guardian_name, p_guardian_whatsapp_number, p_address, p_sector,
    p_participant_type, p_fee_type, v_fee, 'pending'
  ) RETURNING id INTO v_enrollment_id;

  RETURN v_enrollment_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION request_training_enrollment(uuid, varchar, varchar, int, varchar, varchar, text, varchar, varchar, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION request_training_enrollment(uuid, varchar, varchar, int, varchar, varchar, text, varchar, varchar, varchar) TO authenticated;

-- ── 4. training_batches_for_join() — what the portal join page reads:
--      public batch info plus a computed spots-left, without exposing the
--      roster itself (training_enrollments stays staff/own-row-only).
CREATE OR REPLACE FUNCTION training_batches_for_join(p_project_id uuid) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'label', b.label, 'label_ur', b.label_ur, 'schedule_note', b.schedule_note,
    'age_min', b.age_min, 'age_max', b.age_max, 'session_days', b.session_days, 'session_time', b.session_time,
    'fee_villager_monthly_pkr', b.fee_villager_monthly_pkr, 'fee_outsider_monthly_pkr', b.fee_outsider_monthly_pkr,
    'fee_villager_full_pkr', b.fee_villager_full_pkr, 'fee_outsider_full_pkr', b.fee_outsider_full_pkr,
    'capacity', b.capacity,
    'spots_left', CASE WHEN b.capacity IS NULL THEN NULL ELSE
      greatest(0, b.capacity - (SELECT count(*) FROM training_enrollments e
                                  WHERE e.batch_id = b.id AND e.status IN ('pending', 'active'))) END
  ) ORDER BY b.label), '[]'::jsonb)
  FROM training_batches b WHERE b.project_id = p_project_id AND b.status = 'active';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION training_batches_for_join(uuid) TO authenticated;

-- ── 5. Staff side: confirm or reject a pending request.
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

  -- Same "no monthly cadence to wait for" rule enroll_in_training_program()
  -- already follows: a full-course fee is charged immediately on
  -- confirmation, a monthly fee picks up the next training_fee_run() pass.
  IF e.fee_type = 'full_course' AND e.fee_amount_pkr > 0 THEN
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

CREATE OR REPLACE FUNCTION reject_training_enrollment(p_enrollment_id uuid, p_reason text DEFAULT NULL) RETURNS void AS $$
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

  UPDATE training_enrollments SET status = 'rejected', rejected_reason = p_reason WHERE id = p_enrollment_id;

  IF e.portal_user_id IS NOT NULL THEN
    SELECT * INTO proj FROM projects WHERE id = e.project_id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (e.portal_user_id, 'training_enrollment_rejected', 'Request not confirmed',
      e.student_name || '''s request for ' || COALESCE(proj.display_name, proj.title) || ' could not be confirmed'
        || COALESCE(' — ' || p_reason, ''),
      '/portal/training-programs');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION confirm_training_enrollment(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION reject_training_enrollment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION confirm_training_enrollment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION reject_training_enrollment(uuid, text) TO authenticated;

-- Staff notification when a new request lands — same shape as
-- trg_payment_collector_notify/training_fee_collected: accountant-role
-- admins always, plus any trainer scoped to this specific academy.
CREATE OR REPLACE FUNCTION trg_training_enrollment_requested() RETURNS trigger AS $$
DECLARE
  proj projects%ROWTYPE;
  v_popup_enabled boolean;
  r record;
BEGIN
  IF NEW.status = 'pending' THEN
    SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'training_enrollment_requested';
    IF v_popup_enabled IS TRUE THEN
      SELECT * INTO proj FROM projects WHERE id = NEW.project_id;
      FOR r IN
        SELECT id FROM admin_users
        WHERE is_active = true AND (
          (COALESCE(can_manage_parties, false) AND access_donors_projects)
          OR NEW.project_id = ANY(assigned_training_program_ids)
        )
      LOOP
        INSERT INTO notifications (recipient_id, event_type, title, body, link)
        VALUES (r.id, 'training_enrollment_requested', 'New join request',
          NEW.student_name || ' requested a seat in ' || COALESCE(proj.display_name, proj.title),
          '/admin/academy-fees?project=' || NEW.project_id);
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS training_enrollment_requested_notify ON training_enrollments;
CREATE TRIGGER training_enrollment_requested_notify AFTER INSERT ON training_enrollments
  FOR EACH ROW EXECUTE FUNCTION trg_training_enrollment_requested();

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled)
VALUES ('training_enrollment_requested', 'A portal user requested to join a training academy', false, true)
ON CONFLICT (event_type) DO NOTHING;

-- ── 6. my_training_fees(): a portal user's own pending/rejected requests
--      now show up alongside active fee status — 'pending' rows just have
--      no charges yet, 'rejected' carries the reason, so nobody is left
--      wondering whether a request went anywhere.
CREATE OR REPLACE FUNCTION my_training_fees() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'enrollment_id', e.id, 'project_id', e.project_id, 'status', e.status,
    'program_title', COALESCE(proj.display_name, proj.title), 'batch_label', bat.label, 'student_name', e.student_name,
    'fee_type', e.fee_type, 'monthly_amount_pkr', e.fee_amount_pkr, 'rejected_reason', e.rejected_reason,
    'due_soon', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', c.id, 'due_on', c.due_on, 'amount', c.amount_pkr, 'paid', c.paid_pkr, 'status', c.status
      ) ORDER BY c.due_on), '[]'::jsonb) FROM training_fee_charges c
      WHERE c.enrollment_id = e.id AND c.status IN ('due', 'part_paid')),
    'total_paid', (SELECT COALESCE(SUM(paid_pkr), 0) FROM training_fee_charges WHERE enrollment_id = e.id),
    'total_overdue', (SELECT COALESCE(SUM(amount_pkr - paid_pkr), 0) FROM training_fee_charges
      WHERE enrollment_id = e.id AND status IN ('due', 'part_paid') AND due_on < (now() AT TIME ZONE 'Asia/Karachi')::date)
  ) ORDER BY e.enrolled_at DESC), '[]'::jsonb)
  FROM training_enrollments e
  JOIN projects proj ON proj.id = e.project_id
  LEFT JOIN training_batches bat ON bat.id = e.batch_id
  WHERE e.portal_user_id = current_portal_user_id() AND e.status IN ('pending', 'active', 'rejected');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ── 7. Pending-requests review list for staff — same shape my_training_fees
--      takes, but for whoever can act on requests, across every academy
--      they're allowed to touch (full accountant sees all; a scoped
--      trainer sees only their own academy — current_admin_can_collect_
--      for_training_program already encodes that narrowing).
CREATE OR REPLACE FUNCTION training_enrollment_requests(p_project_id uuid) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', e.id, 'student_name', e.student_name, 'student_age', e.student_age,
    'guardian_name', e.guardian_name, 'guardian_whatsapp_number', e.guardian_whatsapp_number,
    'address', e.address, 'sector', e.sector, 'participant_type', e.participant_type,
    'fee_type', e.fee_type, 'fee_amount_pkr', e.fee_amount_pkr,
    'batch_label', bat.label, 'requested_at', e.enrolled_at
  ) ORDER BY e.enrolled_at), '[]'::jsonb)
  FROM training_enrollments e
  LEFT JOIN training_batches bat ON bat.id = e.batch_id
  WHERE e.project_id = p_project_id AND e.status = 'pending'
    AND (COALESCE(current_admin_permission('manage_parties'), false)
         OR current_admin_can_collect_for_training_program(e.project_id));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION training_enrollment_requests(uuid) TO authenticated;

-- ── 8. Session-time reminders — "your session is today" for every portal
--      user with an active seat in a batch that meets today. Runs once
--      daily; the NOT EXISTS guard makes a manual re-run harmless instead
--      of double-notifying (training_fee_run's due_on window check plays
--      the same role for fee charges).
CREATE OR REPLACE FUNCTION training_session_reminders() RETURNS jsonb AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_count int := 0;
  r record;
BEGIN
  FOR r IN
    SELECT e.portal_user_id, e.student_name, b.label, b.session_time,
           COALESCE(proj.display_name, proj.title) AS program_title, proj.id AS project_id
      FROM training_batches b
      JOIN training_enrollments e ON e.batch_id = b.id AND e.status = 'active' AND e.portal_user_id IS NOT NULL
      JOIN projects proj ON proj.id = b.project_id
     WHERE b.status = 'active' AND b.session_days IS NOT NULL
       AND extract(dow FROM v_today)::int = ANY(b.session_days)
       AND NOT EXISTS (
         SELECT 1 FROM portal_notifications pn
         WHERE pn.portal_user_id = e.portal_user_id AND pn.event_type = 'training_session_reminder'
           AND pn.link = '/portal/training-programs' AND pn.body LIKE '%' || e.student_name || '%' || b.label || '%'
           AND pn.created_at >= v_today
       )
  LOOP
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.portal_user_id, 'training_session_reminder', 'Training today',
      r.student_name || ' has ' || r.program_title || ' (' || r.label || ') today'
        || COALESCE(' at ' || to_char(r.session_time, 'HH12:MI AM'), ''),
      '/portal/training-programs');
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('reminders_sent', v_count, 'date', v_today);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION training_session_reminders() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION training_session_reminders() TO authenticated;

DO $$
BEGIN
  PERFORM cron.schedule('training-session-reminders', '0 6 * * *', 'SELECT training_session_reminders()');
  RAISE NOTICE 'pg_cron: training session reminders sent daily at 11:00 PKT';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable — run training_session_reminders() by hand. %', SQLERRM;
END $$;
