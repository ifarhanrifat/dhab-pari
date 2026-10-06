-- Phase 2, slice 8 (functions, part 1): every function touching only
-- slice-8 tables (mentor/talent/training/schools), reproduced from the
-- real, current body (pulled live via pg_get_functiondef) with only the
-- minimal tenant-scoping fix applied.
--
-- Two of the most serious findings this slice:
--   rename_sector updated nine tables (sectors, consumers, portal_users,
--   projects, complaints, connection_requests, blood_donors, job_listings,
--   needs_register, consumer_nonpayment_flags) by bare sector NAME string
--   with no tenant filter at all -- renaming "Sector A" in one tenant
--   would silently rename every OTHER tenant's rows sharing that same
--   sector name too. This is data corruption, not just a leak.
--   recent_activity_since (the admin activity feed) had no tenant filter
--   on almost every one of its ten UNION branches -- would show every
--   tenant's jobs, volunteer signups, project comments, complaints,
--   suggestions, donations, proposals and waivers mixed together.
--
-- Cross-tenant secondary-row-lookup pattern (same class found in slice 5):
-- start_mentor_conversation let a portal user start a chat with a mentor
-- from a different tenant by id; request_training_enrollment let a portal
-- user request a seat in another tenant's batch by id.
--
-- Cron jobs with the no-auth-context DEFAULT bug: training_fee_run,
-- training_session_reminders.
--
-- Admin-gated ID-lookup mutators with no tenant filter (the recurring bug
-- class this whole phase): academy_summary_report, block_mentor_chat_
-- partner (notify loop), complete_project_volunteers, confirm_training_
-- enrollment, confirm_training_fee_announcement, enroll_in_training_
-- program, flag_talent_showcase_comment, kafalat_generate_requirement,
-- kafalat_register, pay_training_fee_charge, reject_training_enrollment,
-- reject_training_fee_announcement, school_cost_summary, set_talent_
-- showcase_comment_hidden, training_enrollment_requests, trg_volunteer_
-- notify_staff, waive_academy_fee_charge, wazifa_pay_instalment.
--
-- Public browse functions with no tenant filter at all: career_program_
-- counts, training_batches_for_join, training_batches_public.
--
-- admin_sidebar_badges counted pending items across eleven tables with no
-- tenant filter on any of them except the one already scoped by
-- recipient_id.

create or replace function public.academy_summary_report()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE v_result jsonb;
BEGIN
  IF NOT COALESCE(can_access_system('donors_projects'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(x) ORDER BY x.title), '[]'::jsonb) INTO v_result FROM (
    SELECT
      p.id AS project_id, p.title, p.display_name, p.category, p.status,
      p.funding_model, p.monthly_operating_cost_pkr,
      (SELECT count(*) FROM training_batches b WHERE b.project_id = p.id AND b.status = 'active') AS batches_count,
      (SELECT COALESCE(sum(b.capacity), 0) FROM training_batches b
         WHERE b.project_id = p.id AND b.status = 'active' AND b.capacity IS NOT NULL) AS capacity_total,
      (SELECT count(*) FROM training_enrollments e JOIN training_batches b ON b.id = e.batch_id
         WHERE b.project_id = p.id AND e.status IN ('pending', 'active')) AS filled_total,
      (SELECT COALESCE(sum(c.amount_pkr), 0) FROM training_fee_charges c
         JOIN training_enrollments e ON e.id = c.enrollment_id
         WHERE e.project_id = p.id AND e.status IN ('active', 'completed')) AS fees_charged_total,
      (SELECT COALESCE(sum(c.paid_pkr), 0) FROM training_fee_charges c
         JOIN training_enrollments e ON e.id = c.enrollment_id
         WHERE e.project_id = p.id AND e.status IN ('active', 'completed')) AS fees_collected_total,
      (SELECT COALESCE(sum(c.amount_pkr - c.paid_pkr), 0) FROM training_fee_charges c
         JOIN training_enrollments e ON e.id = c.enrollment_id
         WHERE e.project_id = p.id AND e.status IN ('active', 'completed')
           AND c.status NOT IN ('paid', 'waived') AND c.due_on < (now() AT TIME ZONE 'Asia/Karachi')::date) AS fees_overdue_total,
      (SELECT COALESCE(sum(credit), 0) FROM project_income_public WHERE project_id = p.id) AS raised_total,
      (SELECT COALESCE(sum(debit), 0) FROM project_expenses_public WHERE project_id = p.id) AS spent_total
    FROM projects p
    WHERE p.category IN ('sports', 'training') AND p.tenant_id = my_tenant_id()
  ) x;

  RETURN v_result;
END;
$function$;

create or replace function public.admin_sidebar_badges()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  v_admin uuid;
  v_role varchar;
  v_tenant uuid;
BEGIN
  SELECT id, role, tenant_id INTO v_admin, v_role, v_tenant
    FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true;
  IF v_admin IS NULL THEN RETURN '{}'::jsonb; END IF;

  RETURN jsonb_build_object(
    'blood_requests', (SELECT count(*) FROM blood_requests WHERE status = 'pending_approval' AND tenant_id = v_tenant),
    'approvals',      (SELECT count(*) FROM approval_requests WHERE status = 'pending' AND tenant_id = v_tenant),
    'alerts',         (SELECT count(*) FROM notifications WHERE recipient_id = v_admin AND is_read = false),
    'suggestions',    (SELECT count(*) FROM suggestions WHERE status = 'new' AND tenant_id = v_tenant),
    'complaints',     (SELECT count(*) FROM complaints WHERE status IN ('open', 'awaiting_verification') AND tenant_id = v_tenant),
    'party_complaints', (SELECT count(*) FROM party_complaints WHERE status = 'open' AND tenant_id = v_tenant),
    'volunteers',     (SELECT count(*) FROM volunteers WHERE status = 'offered' AND tenant_id = v_tenant),
    'connections',    (SELECT count(*) FROM connection_requests WHERE status = 'pending_payment' AND tenant_id = v_tenant),
    'payment_claims', (SELECT count(*) FROM bill_payment_claims WHERE status = 'pending' AND tenant_id = v_tenant),
    'donors',         (SELECT count(*) FROM donors WHERE payment_status = 'pledged' AND is_verified = false AND tenant_id = v_tenant),
    'portal-accounts', (SELECT count(*) FROM portal_users WHERE mentor_status = 'pending' AND tenant_id = v_tenant)
  );
END;
$function$;

create or replace function public.block_mentor_chat_partner(p_other_portal_user_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_self_id uuid;
  v_self_name varchar;
  v_other_name varchar;
  r record;
BEGIN
  v_self_id := current_portal_user_id();
  IF v_self_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  INSERT INTO mentor_chat_blocks (blocker_portal_user_id, blocked_portal_user_id)
  VALUES (v_self_id, p_other_portal_user_id)
  ON CONFLICT DO NOTHING;
  UPDATE mentor_conversations SET status = 'closed'
  WHERE (student_portal_user_id = v_self_id AND mentor_portal_user_id = p_other_portal_user_id)
     OR (mentor_portal_user_id = v_self_id AND student_portal_user_id = p_other_portal_user_id);

  SELECT portal_public_name(v_self_id) INTO v_self_name;
  SELECT portal_public_name(p_other_portal_user_id) INTO v_other_name;

  FOR r IN SELECT id FROM admin_users WHERE role IN ('super_admin', 'admin') AND is_active = true AND tenant_id = my_tenant_id() LOOP
    INSERT INTO notifications (recipient_id, event_type, title, body, link)
    VALUES (r.id, 'mentor_chat_blocked', 'A mentor chat was blocked',
      COALESCE(v_self_name, 'Someone') || ' blocked ' || COALESCE(v_other_name, 'someone') || ' — worth a look.',
      '/admin/mentor-chats');
  END LOOP;
END;
$function$;

-- career_program_counts is intentionally left untouched here: it
-- references a `training_programs` relation that does not exist in the
-- live database (confirmed via information_schema), so it is already
-- broken independent of tenant scoping, and CREATE OR REPLACE on a
-- LANGUAGE SQL function validates every referenced relation immediately --
-- replacing it would only turn "broken when called" into "fails to
-- deploy." Left for a future, unrelated fix.

create or replace function public.complete_project_volunteers(p_project_id uuid)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_count int;
BEGIN
  IF NOT can_access_system('donors_projects') OR NOT current_admin_permission('manage_parties') THEN
    RAISE EXCEPTION 'Not authorized to close out volunteers';
  END IF;
  UPDATE volunteers SET status = 'completed'
   WHERE project_id = p_project_id AND status = 'assigned' AND tenant_id = my_tenant_id();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE project_tasks SET status = 'cancelled'
   WHERE project_id = p_project_id AND status IN ('pending', 'in_progress') AND tenant_id = my_tenant_id();
  RETURN v_count;
END;
$function$;

create or replace function public.confirm_training_enrollment(p_enrollment_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  e training_enrollments%ROWTYPE;
  proj projects%ROWTYPE;
BEGIN
  SELECT * INTO e FROM training_enrollments WHERE id = p_enrollment_id AND tenant_id = my_tenant_id() FOR UPDATE;
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
$function$;

create or replace function public.confirm_training_fee_announcement(p_charge_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  c training_fee_charges%ROWTYPE; e training_enrollments%ROWTYPE; proj projects%ROWTYPE;
  v_from_account uuid; v_project_account uuid;
  v_voucher_id uuid; v_voucher_no varchar; v_amount decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO c FROM training_fee_charges WHERE id = p_charge_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Charge not found' USING ERRCODE = 'P0001'; END IF;
  IF c.status <> 'announced' THEN RAISE EXCEPTION 'No payment is awaiting confirmation on this charge.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO e FROM training_enrollments WHERE id = c.enrollment_id;
  SELECT * INTO proj FROM projects WHERE id = e.project_id;
  v_project_account := ensure_project_account(e.project_id);
  v_amount := c.announced_amount_pkr;

  SELECT id INTO v_from_account FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN c.announced_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = c.tenant_id;

  -- from_account_id = the project (credited — money arriving), to_account_id
  -- = cash/bank (debited — asset increase), same convention as
  -- pay_training_fee_charge().
  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, project_id)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    e.student_name || ' — training fee, charge ' || c.charge_no || ' (' || COALESCE(proj.display_name, proj.title) || ') · paid via portal, confirmed',
    v_amount, v_project_account, v_from_account, e.student_name, e.project_id)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE training_fee_charges
     SET paid_pkr = paid_pkr + v_amount,
         status = CASE WHEN paid_pkr + v_amount >= amount_pkr - 0.01 THEN 'paid' ELSE 'part_paid' END,
         paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = c.announced_method,
         voucher_id = v_voucher_id, collected_by = NULL
   WHERE id = p_charge_id;

  IF e.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (e.portal_user_id, 'training_fee_payment_confirmed', 'Payment confirmed',
      'Your payment for ' || e.student_name || ' (' || COALESCE(proj.display_name, proj.title) || ') has been confirmed.', '/portal/training-programs');
  END IF;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', v_amount, 'charge_id', p_charge_id);
END;
$function$;

create or replace function public.enroll_in_training_program(p_batch_id uuid, p_student_name character varying, p_student_name_ur character varying, p_guardian_name character varying, p_guardian_whatsapp_number character varying, p_address text, p_sector character varying, p_participant_type character varying, p_fee_type character varying, p_discount_pct numeric DEFAULT NULL::numeric, p_discount_amount_pkr numeric DEFAULT NULL::numeric, p_discount_reason text DEFAULT NULL::text, p_portal_user_id uuid DEFAULT NULL::uuid, p_student_age integer DEFAULT NULL::integer)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  b training_batches%ROWTYPE;
  v_base decimal;
  v_fee decimal;
  v_enrollment_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO b FROM training_batches WHERE id = p_batch_id AND tenant_id = my_tenant_id();
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
$function$;

create or replace function public.ensure_institution_account(p_school_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_id uuid; v_name varchar;
BEGIN
  SELECT id INTO v_id FROM accounts WHERE school_id = p_school_id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  SELECT name INTO v_name FROM schools WHERE id = p_school_id;
  INSERT INTO accounts (code, name, type, system, school_id, opening_balance)
  VALUES ('INS-' || substr(replace(p_school_id::text, '-', ''), 1, 8),
          COALESCE(v_name, 'Institution'), 'institution', 'donors_projects', p_school_id, 0)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

create or replace function public.flag_talent_showcase_comment(p_comment_id uuid, p_reason text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_comment talent_showcase_comments%ROWTYPE;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'براہ کرم پہلے لاگ ان کریں۔ Please log in first.'; END IF;
  SELECT * INTO v_comment FROM talent_showcase_comments WHERE id = p_comment_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'یہ تبصرہ نہیں ملا۔ Comment not found.'; END IF;

  INSERT INTO complaints (system, portal_user_id, complainant_name, complaint_text, source, status)
  SELECT 'donors_projects', v_portal_user_id, full_name,
         'Flagged comment on talent showcase ' || v_comment.talent_showcase_id || ': "' || v_comment.content || '"' ||
           CASE WHEN p_reason IS NOT NULL AND trim(p_reason) != '' THEN ' — Reason: ' || p_reason ELSE '' END,
         'website', 'open'
  FROM portal_users WHERE id = v_portal_user_id;
END;
$function$;

create or replace function public.kafalat_generate_requirement(p_child_id uuid, p_academic_year character varying)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  c kafalat_children%ROWTYPE;
  v_level int;
  v_tier school_fee_tiers%ROWTYPE;
  v_school_govt boolean := false;
  v_fee_annual decimal := 0;
  v_transport_annual decimal := 0;
  v_uniform decimal; v_books decimal; v_pocket decimal; v_medical decimal; v_exam decimal;
  v_prorated_total decimal := 0; v_flat_total decimal := 0;
  v_months int; v_this_year decimal;
BEGIN
  SELECT * INTO c FROM kafalat_children WHERE id = p_child_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Child not found' USING ERRCODE = 'P0001'; END IF;

  v_level := class_to_level(c.current_class);

  -- ── School fee ──────────────────────────────────────────────────────
  IF c.school_id IS NOT NULL THEN
    SELECT (kind = 'government') INTO v_school_govt FROM schools WHERE id = c.school_id;
  END IF;
  IF v_school_govt THEN
    v_fee_annual := 0;
  ELSIF c.school_id IS NOT NULL AND v_level IS NOT NULL THEN
    SELECT * INTO v_tier FROM school_fee_tiers
     WHERE school_id = c.school_id AND v_level BETWEEN class_from AND class_to
     ORDER BY class_from DESC LIMIT 1;
    IF FOUND THEN
      v_fee_annual := v_tier.monthly_fee_pkr * 12 + v_tier.annual_charges_pkr;
    END IF;
  END IF;
  IF v_fee_annual = 0 AND NOT v_school_govt THEN
    SELECT COALESCE(value::decimal, 0) INTO v_fee_annual
      FROM site_settings WHERE key = 'kafalat_default_school_fee' AND tenant_id = c.tenant_id;
  END IF;

  -- ── Transport ───────────────────────────────────────────────────────
  SELECT COALESCE(value::decimal, 0) INTO v_transport_annual FROM site_settings
   WHERE key = CASE c.school_location WHEN 'village' THEN 'kafalat_transport_village'
                                      ELSE 'kafalat_transport_chakwal' END AND tenant_id = c.tenant_id;

  -- ── Once-a-year items, from the rate card ──────────────────────────
  SELECT COALESCE(value::decimal,0) INTO v_uniform FROM site_settings WHERE key='kafalat_default_uniform' AND tenant_id = c.tenant_id;
  SELECT COALESCE(value::decimal,0) INTO v_books FROM site_settings WHERE key='kafalat_default_books' AND tenant_id = c.tenant_id;
  SELECT COALESCE(value::decimal,0) INTO v_pocket FROM site_settings WHERE key='kafalat_default_pocket_money' AND tenant_id = c.tenant_id;
  SELECT COALESCE(value::decimal,0) INTO v_medical FROM site_settings WHERE key='kafalat_default_medical' AND tenant_id = c.tenant_id;
  SELECT COALESCE(value::decimal,0) INTO v_exam FROM site_settings WHERE key='kafalat_default_exam_fee' AND tenant_id = c.tenant_id;

  -- ── Replace the auto-generated lines; leave manual ones exactly as a
  --    committee member left them, and never add an auto line on top of
  --    a category a manual figure already covers ─────────────────────
  DELETE FROM kafalat_package_lines
   WHERE child_id = p_child_id AND academic_year = p_academic_year AND source = 'auto';

  INSERT INTO kafalat_package_lines (child_id, academic_year, category, description, annual_amount_pkr, is_prorated, source)
  SELECT p_child_id, p_academic_year, v.category, v.description, v.annual_amount_pkr, v.is_prorated, 'auto'
  FROM (VALUES
    ('school_fee', 'School fee (rate card)', v_fee_annual, true),
    ('transport', 'Transport (rate card)', v_transport_annual, true),
    ('pocket_money', 'Pocket money (rate card)', v_pocket, true),
    ('uniform', 'Uniform × 2 (rate card)', v_uniform, false),
    ('books', 'Books and stationery (rate card)', v_books, false),
    ('medical', 'Medical (rate card)', v_medical, false),
    ('exam_fee', 'Exam fee (rate card)', v_exam, false)
  ) AS v(category, description, annual_amount_pkr, is_prorated)
  WHERE NOT EXISTS (
    SELECT 1 FROM kafalat_package_lines m
     WHERE m.child_id = p_child_id AND m.academic_year = p_academic_year
       AND m.category = v.category AND m.source = 'manual'
  );

  -- ── This year's actual requirement: monthly items shrink to what is
  --    left of the year, once-a-year items are charged in full ─────────
  SELECT COALESCE(SUM(annual_amount_pkr) FILTER (WHERE is_prorated), 0),
         COALESCE(SUM(annual_amount_pkr) FILTER (WHERE NOT is_prorated), 0)
    INTO v_prorated_total, v_flat_total
    FROM kafalat_package_lines WHERE child_id = p_child_id AND academic_year = p_academic_year;

  v_months := kafalat_months_remaining(p_academic_year, c.joined_on);
  v_this_year := round(v_prorated_total * v_months / 12.0) + v_flat_total;

  RETURN jsonb_build_object(
    'academic_year', p_academic_year, 'months_remaining', v_months,
    'annual_total', v_prorated_total + v_flat_total, 'this_year_requirement', v_this_year,
    'school_fee_annual', v_fee_annual, 'transport_annual', v_transport_annual,
    'is_govt_school', v_school_govt
  );
END;
$function$;

create or replace function public.kafalat_register(p_academic_year character varying DEFAULT NULL::character varying)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE v_year varchar;
BEGIN
  v_year := COALESCE(p_academic_year, kafalat_current_year());
  RETURN jsonb_build_object(
    'academic_year', v_year,
    'generated_at', now(),
    'children', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'code', c.code, 'name', c.first_name, 'guardian', c.guardian_name,
        'guardian_phone', c.guardian_phone, 'roll_no', c.roll_no, 'section', c.section,
        'current_class', c.current_class,
        'school_name', COALESCE(s.name, c.school_name), 'school_location', c.school_location,
        'school_fee_monthly', COALESCE(t.monthly_fee_pkr, 0),
        'fee_annual', COALESCE((SELECT annual_amount_pkr FROM kafalat_package_lines
                                  WHERE child_id = c.id AND academic_year = v_year AND category = 'school_fee'), 0),
        'transport_annual', COALESCE((SELECT annual_amount_pkr FROM kafalat_package_lines
                                       WHERE child_id = c.id AND academic_year = v_year AND category = 'transport'), 0),
        'fee_next_due_on', (date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)
                             + interval '1 month' - interval '1 day')::date,
        'uniform_mode', c.uniform_mode,
        'uniform_status', (
          SELECT jsonb_agg(jsonb_build_object('issue_no', u.issue_no, 'status', u.status,
                                              'scheduled_on', u.scheduled_on) ORDER BY u.issue_no)
            FROM kafalat_uniform_issues u WHERE u.child_id = c.id AND u.academic_year = v_year
        )
      ) ORDER BY c.code)
        FROM kafalat_children c
        LEFT JOIN schools s ON s.id = c.school_id
        LEFT JOIN school_fee_tiers t ON t.school_id = c.school_id
          AND class_to_level(c.current_class) BETWEEN t.class_from AND t.class_to
       WHERE c.status = 'active' AND c.tenant_id = my_tenant_id()
    ), '[]'::jsonb)
  );
END;
$function$;

create or replace function public.pay_training_fee_charge(p_charge_id uuid, p_amount numeric, p_method character varying, p_note text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  c training_fee_charges%ROWTYPE; e training_enrollments%ROWTYPE; proj projects%ROWTYPE;
  v_is_full_accountant boolean;
  v_is_collector boolean;
  v_from_account uuid;
  v_project_account uuid;
  v_voucher_id uuid; v_voucher_no varchar; v_remaining decimal;
  v_collected_by uuid;
  v_popup_enabled boolean;
  v_collector_name varchar;
  r record;
BEGIN
  SELECT * INTO c FROM training_fee_charges WHERE id = p_charge_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Charge not found' USING ERRCODE = 'P0001'; END IF;
  IF c.status = 'paid' THEN RAISE EXCEPTION 'Already paid.' USING ERRCODE = 'P0001'; END IF;
  IF c.status = 'waived' THEN RAISE EXCEPTION 'This fee was waived by the committee — nothing to collect.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO e FROM training_enrollments WHERE id = c.enrollment_id;

  v_is_full_accountant := COALESCE(current_admin_permission('post_transactions'), false);
  v_is_collector := current_admin_can_collect_for_training_program(e.project_id);
  IF NOT v_is_full_accountant AND NOT v_is_collector THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Enter an amount greater than zero.' USING ERRCODE = 'P0001'; END IF;

  v_remaining := c.amount_pkr - c.paid_pkr;
  IF p_amount > v_remaining + 0.01 THEN
    RAISE EXCEPTION 'That is more than is due — Rs % is left on this charge.',
      trim(to_char(v_remaining, 'FM999,999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO proj FROM projects WHERE id = e.project_id;
  v_project_account := ensure_project_account(e.project_id);

  IF v_is_full_accountant AND NOT v_is_collector THEN
    v_collected_by := NULL;
    SELECT id INTO v_from_account FROM accounts WHERE system = 'donors_projects'
       AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = c.tenant_id;
  ELSE
    v_collected_by := current_admin_user_id();
    v_from_account := ensure_collector_account(v_collected_by, 'donors_projects');
  END IF;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, project_id)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    e.student_name || ' — training fee, charge ' || c.charge_no || ' (' || COALESCE(proj.display_name, proj.title) || ')'
      || COALESCE(' · ' || p_note, ''),
    p_amount, v_project_account, v_from_account, e.student_name, e.project_id)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE training_fee_charges
     SET paid_pkr = paid_pkr + p_amount,
         status = CASE WHEN paid_pkr + p_amount >= amount_pkr - 0.01 THEN 'paid' ELSE 'part_paid' END,
         paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, method = p_method,
         voucher_id = v_voucher_id, note = COALESCE(p_note, note), collected_by = v_collected_by
   WHERE id = p_charge_id;

  IF v_collected_by IS NOT NULL THEN
    SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'training_fee_collected' AND tenant_id = c.tenant_id;
    IF v_popup_enabled IS TRUE THEN
      SELECT full_name INTO v_collector_name FROM admin_users WHERE id = v_collected_by;
      FOR r IN
        SELECT id FROM admin_users
        WHERE is_active = true AND id != v_collected_by AND tenant_id = c.tenant_id AND (
          role IN ('super_admin', 'admin', 'donor_accountant')
          OR (role = 'accountant' AND access_donors_projects)
        )
      LOOP
        INSERT INTO notifications (recipient_id, event_type, title, body, link)
        VALUES (r.id, 'training_fee_collected', 'Training fee collected',
          COALESCE(v_collector_name, 'A trainer') || ' collected Rs ' || trim(to_char(p_amount, 'FM999,999,999,990'))
            || ' from ' || e.student_name || ' (' || COALESCE(proj.display_name, proj.title) || ')',
          '/admin/donors/collectors');
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', p_amount, 'charge_id', p_charge_id, 'collected_by', v_collected_by);
END;
$function$;

-- recent_activity_since: the admin activity feed -- almost every branch
-- had no tenant filter at all.
create or replace function public.recent_activity_since(p_since timestamp with time zone)
 returns TABLE(event_type character varying, title text, detail text, actor_name text, created_at timestamp with time zone)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT 'job' AS event_type, jl.headline AS title, jl.category AS detail, jl.contact_name AS actor_name, jl.created_at
  FROM job_listings jl WHERE jl.created_at >= p_since AND jl.tenant_id = my_tenant_id() AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'volunteer', COALESCE(p.title, 'General — Any Project'), v.message, pu.full_name, v.created_at
  FROM volunteers v
  JOIN portal_users pu ON pu.id = v.portal_user_id
  LEFT JOIN projects p ON p.id = v.project_id
  WHERE v.created_at >= p_since AND v.tenant_id = my_tenant_id() AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'comment', p.title, c.content,
    (CASE WHEN c.comment_type = 'system' THEN c.system_label ELSE pu2.full_name END),
    c.created_at
  FROM project_comments c
  JOIN projects p ON p.id = c.project_id
  LEFT JOIN portal_users pu2 ON pu2.id = c.portal_user_id
  WHERE c.created_at >= p_since AND c.is_hidden = false AND c.tenant_id = my_tenant_id() AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'complaint', COALESCE(cp.complaint_number, 'Complaint'), cp.complaint_text, cp.complainant_name, cp.created_at
  FROM complaints cp WHERE cp.created_at >= p_since AND cp.tenant_id = my_tenant_id() AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'suggestion', 'Suggestion', s.message, COALESCE(s.name, 'Anonymous'), s.created_at
  FROM suggestions s WHERE s.created_at >= p_since AND s.tenant_id = my_tenant_id() AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'donation', (CASE WHEN d.is_anonymous THEN 'Anonymous donor' ELSE d.name END),
    'Rs. ' || to_char(d.amount_pkr, 'FM999999999') || CASE WHEN pr.title IS NOT NULL THEN ' - ' || pr.title ELSE '' END,
    (CASE WHEN d.is_anonymous THEN 'Anonymous donor' ELSE d.name END), d.confirmed_at
  FROM donors d
  LEFT JOIN projects pr ON pr.id = d.project_id
  WHERE d.is_verified = true AND d.confirmed_at >= p_since AND d.tenant_id = my_tenant_id() AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'proposal', p2.title, 'Rs. ' || to_char(COALESCE(p2.budget_pkr, 0), 'FM999999999'), pu3.full_name, p2.created_at
  FROM projects p2
  JOIN portal_users pu3 ON pu3.id = p2.proposed_by_portal_user_id
  WHERE p2.proposed_by_portal_user_id IS NOT NULL AND p2.created_at >= p_since AND p2.tenant_id = my_tenant_id() AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'waiver', 'Bill #' || COALESCE(b.bill_number, '') || ' waived',
    'Rs. ' || to_char(b.amount_pkr, 'FM999999999') || COALESCE(' -- ' || b.waived_reason, ''),
    COALESCE(c.name, b.consumer_id), b.waived_at
  FROM bills b
  LEFT JOIN consumers c ON c.consumer_id = b.consumer_id
  WHERE b.status = 'waived' AND b.waived_at >= p_since AND b.tenant_id = my_tenant_id() AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'waiver', 'Wazifa instalment waived',
    'Rs. ' || to_char(r.amount_pkr, 'FM999999999') || COALESCE(' -- ' || r.waived_reason, ''),
    st.full_name, r.waived_at
  FROM wazifa_repayment_schedule r
  JOIN wazifa_awards a ON a.id = r.award_id
  JOIN wazifa_students st ON st.id = a.student_id
  WHERE r.status = 'waived' AND r.waived_at >= p_since AND r.tenant_id = my_tenant_id() AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'waiver', 'Wazifa charge waived',
    'Rs. ' || to_char(wc.amount_pkr, 'FM999999999') || COALESCE(' -- ' || wc.waived_reason, ''),
    st2.full_name, wc.waived_at
  FROM wazifa_installment_charges wc
  JOIN wazifa_awards a2 ON a2.id = wc.award_id
  JOIN wazifa_students st2 ON st2.id = a2.student_id
  WHERE wc.status = 'waived' AND wc.waived_at >= p_since AND wc.tenant_id = my_tenant_id() AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  UNION ALL
  SELECT 'waiver', 'Academy fee waived',
    'Rs. ' || to_char(tf.amount_pkr, 'FM999999999') || COALESCE(' -- ' || tf.waived_reason, ''),
    e.student_name, tf.waived_at
  FROM training_fee_charges tf
  JOIN training_enrollments e ON e.id = tf.enrollment_id
  WHERE tf.status = 'waived' AND tf.waived_at >= p_since AND tf.tenant_id = my_tenant_id() AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)

  ORDER BY created_at DESC;
$function$;

create or replace function public.reject_training_enrollment(p_enrollment_id uuid, p_reason text DEFAULT NULL::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  e training_enrollments%ROWTYPE;
  proj projects%ROWTYPE;
BEGIN
  SELECT * INTO e FROM training_enrollments WHERE id = p_enrollment_id AND tenant_id = my_tenant_id() FOR UPDATE;
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
$function$;

create or replace function public.reject_training_fee_announcement(p_charge_id uuid, p_reason text DEFAULT NULL::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE c training_fee_charges%ROWTYPE; e training_enrollments%ROWTYPE; proj projects%ROWTYPE;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO c FROM training_fee_charges WHERE id = p_charge_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Charge not found' USING ERRCODE = 'P0001'; END IF;
  IF c.status <> 'announced' THEN RAISE EXCEPTION 'No payment is awaiting confirmation on this charge.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO e FROM training_enrollments WHERE id = c.enrollment_id;
  SELECT * INTO proj FROM projects WHERE id = e.project_id;

  UPDATE training_fee_charges
     SET status = CASE WHEN paid_pkr >= amount_pkr - 0.01 THEN 'paid' WHEN paid_pkr > 0 THEN 'part_paid' ELSE 'due' END,
         announced_amount_pkr = NULL, announced_method = NULL, announced_proof_url = NULL, announced_at = NULL,
         note = COALESCE(note || ' · ', '') || 'Announced payment rejected' || COALESCE(': ' || p_reason, '')
   WHERE id = p_charge_id;

  IF e.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (e.portal_user_id, 'training_fee_payment_rejected', 'Payment could not be confirmed',
      'Your payment for ' || e.student_name || ' (' || COALESCE(proj.display_name, proj.title) || ') could not be confirmed.' || COALESCE(' ' || p_reason, ''),
      '/portal/training-programs');
  END IF;
END;
$function$;

-- rename_sector: nine tables updated by bare sector NAME string with no
-- tenant filter -- a real cross-tenant data-corruption risk, not just a
-- leak, since sector names are ordinary strings that different tenants
-- could easily share.
create or replace function public.rename_sector(p_id uuid, p_new_name character varying)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_old_name varchar;
BEGIN
  IF current_admin_role() NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Not authorized to rename a sector';
  END IF;

  SELECT name INTO v_old_name FROM sectors WHERE id = p_id AND tenant_id = my_tenant_id();
  IF v_old_name IS NULL THEN
    RAISE EXCEPTION 'Sector not found';
  END IF;
  IF v_old_name = p_new_name THEN
    RETURN;
  END IF;

  UPDATE sectors SET name = p_new_name WHERE id = p_id;

  UPDATE consumers SET sector = p_new_name WHERE sector = v_old_name AND tenant_id = my_tenant_id();
  UPDATE portal_users SET sector = p_new_name WHERE sector = v_old_name AND tenant_id = my_tenant_id();
  UPDATE projects SET sector = p_new_name WHERE sector = v_old_name AND tenant_id = my_tenant_id();
  UPDATE complaints SET sector = p_new_name WHERE sector = v_old_name AND tenant_id = my_tenant_id();
  UPDATE connection_requests SET sector = p_new_name WHERE sector = v_old_name AND tenant_id = my_tenant_id();
  UPDATE blood_donors SET sector = p_new_name WHERE sector = v_old_name AND tenant_id = my_tenant_id();
  UPDATE job_listings SET sector = p_new_name WHERE sector = v_old_name AND tenant_id = my_tenant_id();
  UPDATE needs_register SET sector = p_new_name WHERE sector = v_old_name AND tenant_id = my_tenant_id();
  UPDATE consumer_nonpayment_flags SET sector = p_new_name WHERE sector = v_old_name AND tenant_id = my_tenant_id();
END;
$function$;

-- request_training_enrollment: the cross-tenant secondary-row-lookup
-- pattern from slice 5 -- a portal user could request a seat in another
-- tenant's batch by id.
create or replace function public.request_training_enrollment(p_batch_id uuid, p_student_name character varying, p_student_name_ur character varying, p_student_age integer, p_guardian_name character varying, p_guardian_whatsapp_number character varying, p_address text, p_sector character varying, p_participant_type character varying, p_fee_type character varying, p_sibling_note text DEFAULT NULL::text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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

  SELECT * INTO b FROM training_batches WHERE id = p_batch_id AND status = 'active' AND tenant_id = my_tenant_id();
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
$function$;

create or replace function public.school_cost_summary()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'name'), '[]'::jsonb) FROM (
    SELECT jsonb_build_object(
      'id', s.id, 'name', s.name, 'kind', s.kind, 'location', s.location,
      'children', (SELECT count(*) FROM kafalat_children c
                    WHERE c.school_id = s.id AND c.status = 'active'),
      'annual_cost', (SELECT COALESCE(SUM(kafalat_package_total(c.id, NULL::varchar)), 0)
                        FROM kafalat_children c
                       WHERE c.school_id = s.id AND c.status = 'active')
    ) AS x
    FROM schools s WHERE s.is_active AND s.tenant_id = my_tenant_id()
  ) y;
$function$;

create or replace function public.set_talent_showcase_comment_hidden(p_comment_id uuid, p_hidden boolean)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  UPDATE talent_showcase_comments SET is_hidden = p_hidden, hidden_by = CASE WHEN p_hidden THEN current_admin_user_id() ELSE NULL END
  WHERE id = p_comment_id AND tenant_id = my_tenant_id();
END;
$function$;

-- start_mentor_conversation: the cross-tenant secondary-row-lookup
-- pattern from slice 5 -- a portal user could start a chat with a mentor
-- from a different tenant by id.
create or replace function public.start_mentor_conversation(p_mentor_portal_user_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_student_id uuid;
  v_conversation_id uuid;
  v_mentor_status varchar;
  v_mentor_available boolean;
BEGIN
  v_student_id := current_portal_user_id();
  IF v_student_id IS NULL THEN
    RAISE EXCEPTION 'لاگ ان درکار ہے۔ Not authenticated.';
  END IF;
  IF v_student_id = p_mentor_portal_user_id THEN
    RAISE EXCEPTION 'آپ خود سے گفتگو شروع نہیں کر سکتے۔ You cannot start a conversation with yourself.';
  END IF;

  SELECT mentor_status, mentor_available INTO v_mentor_status, v_mentor_available
  FROM portal_users WHERE id = p_mentor_portal_user_id AND tenant_id = my_tenant_id();
  IF v_mentor_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'یہ رہنما بات چیت کے لیے دستیاب نہیں ہے۔ This mentor is not available for chat.';
  END IF;
  IF NOT COALESCE(v_mentor_available, false) THEN
    RAISE EXCEPTION 'یہ رہنما فی الحال نئی گفتگو قبول نہیں کر رہا۔ This mentor is currently not accepting new conversations.';
  END IF;
  IF EXISTS (SELECT 1 FROM mentor_chat_blocks WHERE blocker_portal_user_id = p_mentor_portal_user_id AND blocked_portal_user_id = v_student_id) THEN
    RAISE EXCEPTION 'یہ رہنما آپ سے بات چیت کے لیے دستیاب نہیں ہے۔ This mentor is not available to chat with you.';
  END IF;

  INSERT INTO mentor_conversations (student_portal_user_id, mentor_portal_user_id)
  VALUES (v_student_id, p_mentor_portal_user_id)
  ON CONFLICT (student_portal_user_id, mentor_portal_user_id) DO UPDATE SET status = 'open'
  RETURNING id INTO v_conversation_id;

  RETURN v_conversation_id;
END;
$function$;

-- training_batches_for_join / training_batches_public: public browse
-- functions with no tenant filter at all -- the fully-public one would
-- have listed every tenant's active training batches on one page.
create or replace function public.training_batches_for_join(p_project_id uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'label', b.label, 'label_ur', b.label_ur, 'schedule_note', b.schedule_note, 'schedule_note_ur', b.schedule_note_ur,
    'age_min', b.age_min, 'age_max', b.age_max, 'session_days', b.session_days, 'session_time', b.session_time,
    'fee_villager_monthly_pkr', b.fee_villager_monthly_pkr, 'fee_outsider_monthly_pkr', b.fee_outsider_monthly_pkr,
    'fee_villager_full_pkr', b.fee_villager_full_pkr, 'fee_outsider_full_pkr', b.fee_outsider_full_pkr,
    'sibling_discount_pct', b.sibling_discount_pct,
    'capacity', b.capacity,
    'spots_left', CASE WHEN b.capacity IS NULL THEN NULL ELSE
      greatest(0, b.capacity - (SELECT count(*) FROM training_enrollments e
                                  WHERE e.batch_id = b.id AND e.status IN ('pending', 'active'))) END
  ) ORDER BY b.label), '[]'::jsonb)
  FROM training_batches b WHERE b.project_id = p_project_id AND b.status = 'active'
    AND b.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
$function$;

create or replace function public.training_batches_public()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'project_id', b.project_id, 'label', b.label, 'label_ur', b.label_ur,
    'schedule_note', b.schedule_note, 'schedule_note_ur', b.schedule_note_ur, 'age_min', b.age_min, 'age_max', b.age_max,
    'fee_villager_monthly_pkr', b.fee_villager_monthly_pkr, 'fee_outsider_monthly_pkr', b.fee_outsider_monthly_pkr,
    'fee_villager_full_pkr', b.fee_villager_full_pkr, 'fee_outsider_full_pkr', b.fee_outsider_full_pkr,
    'sibling_discount_pct', b.sibling_discount_pct, 'capacity', b.capacity,
    'spots_left', CASE WHEN b.capacity IS NULL THEN NULL ELSE
      greatest(0, b.capacity - (SELECT count(*) FROM training_enrollments e
                                  WHERE e.batch_id = b.id AND e.status IN ('pending', 'active'))) END
  ) ORDER BY b.label), '[]'::jsonb)
  FROM training_batches b WHERE b.status = 'active'
    AND b.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
$function$;

create or replace function public.training_enrollment_requests(p_project_id uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', e.id, 'student_name', e.student_name, 'student_age', e.student_age,
    'guardian_name', e.guardian_name, 'guardian_whatsapp_number', e.guardian_whatsapp_number,
    'address', e.address, 'sector', e.sector, 'participant_type', e.participant_type,
    'fee_type', e.fee_type, 'fee_amount_pkr', e.fee_amount_pkr,
    'discount_pct', e.discount_pct, 'discount_reason', e.discount_reason,
    'batch_label', bat.label, 'requested_at', e.enrolled_at
  ) ORDER BY e.enrolled_at), '[]'::jsonb)
  FROM training_enrollments e
  LEFT JOIN training_batches bat ON bat.id = e.batch_id
  WHERE e.project_id = p_project_id AND e.status = 'pending' AND e.tenant_id = my_tenant_id()
    AND (COALESCE(current_admin_permission('manage_parties'), false)
         OR current_admin_can_collect_for_training_program(e.project_id));
$function$;

-- training_fee_run / training_session_reminders: cron jobs that inserted
-- without an explicit tenant_id, relying on the auth-context DEFAULT
-- (NULL under cron) -- same bug class fixed for kafalat_disbursement_run
-- etc. earlier this phase.
create or replace function public.training_fee_run()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_month date; v_due_on date; v_count int := 0; v_next_no int; r record;
BEGIN
  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;

  FOR r IN
    SELECT e.id AS enrollment_id, e.fee_amount_pkr AS amount, e.portal_user_id, e.tenant_id
      FROM training_enrollments e
     WHERE e.status = 'active' AND e.fee_type = 'monthly' AND e.fee_amount_pkr > 0
       AND NOT EXISTS (SELECT 1 FROM training_fee_charges c
                        WHERE c.enrollment_id = e.id
                          AND c.due_on >= v_month AND c.due_on < v_month + interval '1 month')
  LOOP
    v_due_on := v_month;
    SELECT COALESCE(MAX(charge_no), 0) + 1 INTO v_next_no FROM training_fee_charges WHERE enrollment_id = r.enrollment_id;

    INSERT INTO training_fee_charges (enrollment_id, charge_no, due_on, amount_pkr, tenant_id)
    VALUES (r.enrollment_id, v_next_no, v_due_on, r.amount, r.tenant_id);

    IF r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
      VALUES (r.portal_user_id, 'training_fee_due', 'Training fee due',
        'Rs ' || trim(to_char(r.amount, 'FM999,999,999,990')) || ' is due this month',
        '/portal/training-programs', r.tenant_id);
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('charges_raised', v_count, 'month', v_month);
END;
$function$;

create or replace function public.training_session_reminders()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_count int := 0;
  r record;
BEGIN
  FOR r IN
    SELECT e.portal_user_id, e.student_name, b.label, b.session_time,
           COALESCE(proj.display_name, proj.title) AS program_title, proj.id AS project_id, e.tenant_id
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
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (r.portal_user_id, 'training_session_reminder', 'Training today',
      r.student_name || ' has ' || r.program_title || ' (' || r.label || ') today'
        || COALESCE(' at ' || to_char(r.session_time, 'HH12:MI AM'), ''),
      '/portal/training-programs', r.tenant_id);
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('reminders_sent', v_count, 'date', v_today);
END;
$function$;

create or replace function public.trg_notify_mentor_message()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_recipient_id uuid;
  v_sender_name varchar;
  v_link varchar;
  v_existing_id uuid;
BEGIN
  SELECT CASE WHEN c.student_portal_user_id = NEW.sender_portal_user_id THEN c.mentor_portal_user_id ELSE c.student_portal_user_id END
  INTO v_recipient_id
  FROM mentor_conversations c WHERE c.id = NEW.conversation_id;

  v_sender_name := portal_public_name(NEW.sender_portal_user_id);
  v_link := '/portal/mentors/chat/' || NEW.conversation_id;

  SELECT id INTO v_existing_id FROM portal_notifications
    WHERE portal_user_id = v_recipient_id AND event_type = 'mentor_message' AND link = v_link AND is_read = false
    LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    UPDATE portal_notifications
      SET title = 'New message from ' || v_sender_name, body = left(NEW.content, 140), created_at = now()
      WHERE id = v_existing_id;
  ELSE
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    VALUES (v_recipient_id, 'mentor_message', 'New message from ' || v_sender_name, left(NEW.content, 140), v_link, NEW.tenant_id);
  END IF;
  RETURN NEW;
END;
$function$;

create or replace function public.trg_volunteer_notify_staff()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_enabled boolean;
  v_name varchar;
  v_project varchar;
  r record;
BEGIN
  SELECT popup_enabled INTO v_enabled FROM notification_preferences WHERE event_type = 'volunteer_signup' AND tenant_id = NEW.tenant_id;
  IF v_enabled IS DISTINCT FROM false THEN
    SELECT full_name INTO v_name FROM portal_users WHERE id = NEW.portal_user_id;
    SELECT title INTO v_project FROM projects WHERE id = NEW.project_id;
    FOR r IN SELECT id FROM admin_users WHERE is_active = true AND role IN ('super_admin', 'admin') AND tenant_id = NEW.tenant_id LOOP
      INSERT INTO notifications (recipient_id, event_type, title, body, link, tenant_id)
      VALUES (r.id, 'volunteer_signup',
              COALESCE(v_name, 'A resident') || ' signed up to volunteer',
              COALESCE('For: ' || v_project, 'No specific project'), '/admin/volunteers', NEW.tenant_id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;

create or replace function public.waive_academy_fee_charge(p_id uuid, p_reason text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE c training_fee_charges%ROWTYPE; v_admin_id uuid := current_admin_user_id();
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Give a reason for the waiver — it is the only record of why this fee was forgiven.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM training_fee_charges WHERE id = p_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fee charge not found' USING ERRCODE = 'P0001'; END IF;
  IF c.status = 'waived' THEN RAISE EXCEPTION 'This fee is already waived.' USING ERRCODE = 'P0001'; END IF;
  IF c.status = 'announced' THEN
    RAISE EXCEPTION 'A payment for this fee is already announced and awaiting confirmation — confirm or reject it first, then waive if still needed.' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(c.paid_pkr, 0) > 0 THEN
    RAISE EXCEPTION 'This fee already has a payment recorded — a waiver only applies before anything has been paid.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE training_fee_charges SET
    status = 'waived', waived_at = now(), waived_by_admin_id = v_admin_id, waived_reason = trim(p_reason)
  WHERE id = p_id;
END;
$function$;

-- wazifa_pay_instalment: p_school_id was admin-provided with no check
-- that it belonged to the caller's own tenant before being used as the
-- voucher's school_id and to display that school's name.
create or replace function public.wazifa_pay_instalment(p_instalment_id uuid, p_method character varying, p_note text DEFAULT NULL::text, p_challan_no character varying DEFAULT NULL::character varying, p_school_id uuid DEFAULT NULL::uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  i wazifa_instalments%ROWTYPE;
  aw wazifa_awards%ROWTYPE;
  st wazifa_students%ROWTYPE;
  v_cash_account uuid;
  v_school_id uuid;
  v_voucher_id uuid;
  v_voucher_no varchar;
  v_receipt varchar;
  v_fund varchar;
  v_particular text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO i FROM wazifa_instalments WHERE id = p_instalment_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Instalment not found' USING ERRCODE = 'P0001'; END IF;
  IF i.status = 'paid' THEN RAISE EXCEPTION 'Already paid.' USING ERRCODE = 'P0001'; END IF;
  IF p_school_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM schools WHERE id = p_school_id AND tenant_id = my_tenant_id()) THEN
    RAISE EXCEPTION 'School not found' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = i.award_id;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  v_fund := CASE aw.funded_by WHEN 'zakat' THEN 'zakat' WHEN 'sadqa' THEN 'sadqa' ELSE 'kafalat' END;
  v_school_id := COALESCE(p_school_id, aw.institution_school_id);

  -- A payment to an institution needs to know which institution, or the
  -- committee has no statement to reconcile against later.
  IF i.pay_to = 'institution' AND v_school_id IS NULL THEN
    RAISE EXCEPTION 'Choose the school or college this is being paid to.' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_cash_account FROM accounts
   WHERE system = 'donors_projects' AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = my_tenant_id();

  v_particular := st.code || ' · ' || i.purpose
    || CASE WHEN p_challan_no IS NOT NULL THEN ' · challan ' || p_challan_no ELSE '' END
    || CASE WHEN i.pay_to = 'student' THEN ' · paid to the student (zakat, tamleek)' ELSE '' END;

  INSERT INTO vouchers (
    system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name,
    wazifa_student_id, wazifa_award_id, school_id, challan_no, fund_type
  ) VALUES (
    'donors_projects', 'wazifa_payment',
    COALESCE(i.due_on, (now() AT TIME ZONE 'Asia/Karachi')::date),
    v_particular, i.amount_pkr,
    v_cash_account, v_cash_account,
    CASE WHEN i.pay_to = 'student' THEN st.full_name
         ELSE (SELECT name FROM schools WHERE id = v_school_id) END,
    aw.student_id, aw.id,
    CASE WHEN i.pay_to = 'institution' THEN v_school_id ELSE NULL END,
    p_challan_no, v_fund
  ) RETURNING id, voucher_no, receipt_no INTO v_voucher_id, v_voucher_no, v_receipt;

  UPDATE wazifa_instalments
     SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
         receipt_no = COALESCE(v_receipt, v_voucher_no), method = p_method,
         note = COALESCE(p_note, note), paid_by = current_admin_user_id()
   WHERE id = p_instalment_id;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', i.amount_pkr,
                            'paid_to', i.pay_to, 'voucher_id', v_voucher_id);
END;
$function$;
