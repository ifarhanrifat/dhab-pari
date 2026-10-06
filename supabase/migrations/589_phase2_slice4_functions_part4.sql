-- Phase 2, slice 4 (functions, part 4): remaining Wazifa admin-gated
-- ID-lookup mutators and the one Zakat admin function not yet covered.
-- Same bug class as migration 586's header explains: current_admin_permission()
-- doesn't know which tenant's award/application/round is being touched.

create or replace function public.wazifa_activate_award(p_award_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE ag wazifa_agreements%ROWTYPE; aw wazifa_awards%ROWTYPE;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false)
     AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized to activate an award' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF aw.installment_active THEN
    RAISE EXCEPTION 'Already active.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO ag FROM wazifa_agreements
   WHERE award_id = p_award_id AND status = 'verified'
   ORDER BY witnessed_verified_at DESC NULLS LAST LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The signed, witnessed agreement has not been verified yet.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_agreements
     SET committee_confirmed_by = current_admin_user_id(), committee_confirmed_at = now()
   WHERE id = ag.id;

  UPDATE wazifa_awards
     SET installment_active = true,
         installment_started_on = (now() AT TIME ZONE 'Asia/Karachi')::date
   WHERE id = p_award_id;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

create or replace function public.wazifa_application_sheet(p_application_id uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT jsonb_build_object(
    'application', to_jsonb(a),
    'student', (SELECT to_jsonb(s) FROM wazifa_students s WHERE s.id = a.student_id),
    'family', (SELECT COALESCE(jsonb_agg(to_jsonb(f) ORDER BY f.created_at), '[]'::jsonb)
                 FROM wazifa_family_members f WHERE f.application_id = a.id),
    'academics', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.passing_year), '[]'::jsonb)
                    FROM wazifa_academic_records r WHERE r.application_id = a.id),
    'documents', (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.created_at), '[]'::jsonb)
                    FROM wazifa_documents d WHERE d.application_id = a.id),
    'verifications', (SELECT COALESCE(jsonb_agg(to_jsonb(v)), '[]'::jsonb)
                        FROM wazifa_verifications v WHERE v.application_id = a.id),
    'decision', (SELECT to_jsonb(x) FROM wazifa_decisions x
                  WHERE x.application_id = a.id ORDER BY x.created_at DESC LIMIT 1),
    'monthly_income', wazifa_monthly_income(a.id),
    'family_education_cost', wazifa_family_education_cost(a.id)
  ) FROM wazifa_applications a WHERE a.id = p_application_id AND a.tenant_id = my_tenant_id();
$function$;

create or replace function public.wazifa_award_calendar(p_award_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  aw wazifa_awards%ROWTYPE;
  v_start date; v_end date; v_month date; v_months jsonb := '[]'::jsonb;
  r wazifa_installment_charges%ROWTYPE;
BEGIN
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF aw.installment_start_date IS NULL THEN
    RETURN jsonb_build_object('months', '[]'::jsonb);
  END IF;

  v_start := date_trunc('month', aw.installment_start_date)::date;
  -- An open-ended settlement (no fixed end date — the "pay while
  -- studying, then settle until it's level" shape) has no natural stop,
  -- so the calendar shows a year ahead of whichever is further: the plan
  -- start, or today. A bounded collect-now plan just uses its own end
  -- date.
  v_end := COALESCE(date_trunc('month', aw.installment_end_date)::date,
    date_trunc('month', GREATEST((now() AT TIME ZONE 'Asia/Karachi')::date, aw.installment_start_date) + interval '11 months')::date);

  v_month := v_start;
  WHILE v_month <= v_end LOOP
    SELECT * INTO r FROM wazifa_installment_charges
     WHERE award_id = p_award_id AND due_on >= v_month AND due_on < v_month + interval '1 month'
     LIMIT 1;
    v_months := v_months || jsonb_build_object(
      'month', v_month,
      'charge_id', r.id,
      'amount', COALESCE(r.amount_pkr, aw.student_monthly_contribution_pkr),
      'paid_pkr', COALESCE(r.paid_pkr, 0),
      'status', COALESCE(r.status, CASE WHEN v_month > date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date
                                          THEN 'upcoming' ELSE 'due' END),
      'due_on', COALESCE(r.due_on, v_month + (aw.installment_due_day - 1))
    );
    v_month := v_month + interval '1 month';
  END LOOP;

  RETURN jsonb_build_object('months', v_months, 'monthly_amount', aw.student_monthly_contribution_pkr);
END;
$function$;

create or replace function public.wazifa_decide_offered_contribution(p_application_id uuid, p_decision character varying, p_revised_amount numeric DEFAULT NULL::numeric)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE a wazifa_applications%ROWTYPE;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false)
     AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_decision NOT IN ('approved', 'declined') THEN
    RAISE EXCEPTION 'Approve or decline — nothing else.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO a FROM wazifa_applications WHERE id = p_application_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Application not found' USING ERRCODE = 'P0001'; END IF;
  IF COALESCE(a.offered_monthly_contribution_pkr, 0) <= 0 THEN
    RAISE EXCEPTION 'Nothing was offered on this application.' USING ERRCODE = 'P0001';
  END IF;
  IF p_revised_amount IS NOT NULL AND p_revised_amount <= 0 THEN
    RAISE EXCEPTION 'Enter an amount greater than zero.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_applications
     SET offered_contribution_status = p_decision,
         offered_monthly_contribution_pkr = COALESCE(p_revised_amount, offered_monthly_contribution_pkr),
         offered_contribution_decided_by = current_admin_user_id(), offered_contribution_decided_at = now()
   WHERE id = p_application_id;

  RETURN jsonb_build_object('ok', true, 'status', p_decision);
END;
$function$;

create or replace function public.wazifa_decide_offered_contribution(p_application_id uuid, p_decision character varying)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE a wazifa_applications%ROWTYPE;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false)
     AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_decision NOT IN ('approved', 'declined') THEN
    RAISE EXCEPTION 'Approve or decline — nothing else.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO a FROM wazifa_applications WHERE id = p_application_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Application not found' USING ERRCODE = 'P0001'; END IF;
  IF COALESCE(a.offered_monthly_contribution_pkr, 0) <= 0 THEN
    RAISE EXCEPTION 'Nothing was offered on this application.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_applications
     SET offered_contribution_status = p_decision,
         offered_contribution_decided_by = current_admin_user_id(), offered_contribution_decided_at = now()
   WHERE id = p_application_id;

  RETURN jsonb_build_object('ok', true, 'status', p_decision);
END;
$function$;

create or replace function public.wazifa_disbursement_calendar(p_award_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  aw wazifa_awards%ROWTYPE;
  v_start date; v_end date; v_month date; v_months jsonb := '[]'::jsonb;
  r wazifa_disbursement_charges%ROWTYPE;
BEGIN
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF aw.disbursement_start_date IS NULL THEN
    RETURN jsonb_build_object('months', '[]'::jsonb);
  END IF;

  v_start := date_trunc('month', aw.disbursement_start_date)::date;
  v_end := COALESCE(date_trunc('month', aw.disbursement_end_date)::date, v_start);

  v_month := v_start;
  WHILE v_month <= v_end LOOP
    SELECT * INTO r FROM wazifa_disbursement_charges
     WHERE award_id = p_award_id AND due_on >= v_month AND due_on < v_month + interval '1 month'
     LIMIT 1;
    v_months := v_months || jsonb_build_object(
      'month', v_month,
      'charge_id', r.id,
      'amount', COALESCE(r.amount_pkr, aw.disbursement_monthly_pkr),
      'status', COALESCE(r.status, CASE WHEN v_month > date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date
                                          THEN 'upcoming' ELSE 'due' END),
      'due_on', COALESCE(r.due_on, v_month + (aw.disbursement_due_day - 1))
    );
    v_month := v_month + interval '1 month';
  END LOOP;

  RETURN jsonb_build_object('months', v_months, 'monthly_amount', aw.disbursement_monthly_pkr);
END;
$function$;

create or replace function public.wazifa_end_award(p_award_id uuid, p_reason text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE aw wazifa_awards%ROWTYPE; v_remaining decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF aw.status <> 'active' THEN
    RAISE EXCEPTION 'This award is already %.', aw.status USING ERRCODE = 'P0001';
  END IF;

  v_remaining := GREATEST(aw.awarded_amount_pkr - wazifa_disbursed(p_award_id), 0);
  PERFORM wazifa_post_requirement_delta(aw.academic_year, -v_remaining,
    (SELECT full_name FROM wazifa_students WHERE id = aw.student_id) || ' — award ended: '
      || COALESCE(p_reason, 'no reason given'), aw.student_id);

  UPDATE wazifa_awards SET status = 'cancelled' WHERE id = p_award_id;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

create or replace function public.wazifa_generate_repayment_plan(p_award_id uuid, p_starts_on date, p_instalments integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  aw wazifa_awards%ROWTYPE;
  v_each decimal;
  v_last decimal;
  i int;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF NOT aw.is_loan THEN
    RAISE EXCEPTION 'This award is a grant, not a qarz-e-hasana — there is nothing to repay.'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_instalments < 1 THEN
    RAISE EXCEPTION 'At least one instalment is needed.' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM wazifa_repayment_schedule WHERE award_id = p_award_id AND paid_pkr = 0;

  -- Rounded down each month with the remainder on the last instalment, so the
  -- instalments are whole rupees and the total is exactly what was lent — not
  -- a rupee more.
  v_each := floor(aw.awarded_amount_pkr / p_instalments);
  v_last := aw.awarded_amount_pkr - (v_each * (p_instalments - 1));

  FOR i IN 1..p_instalments LOOP
    INSERT INTO wazifa_repayment_schedule (award_id, instalment_no, due_on, amount_pkr)
    VALUES (p_award_id, i,
            (p_starts_on + make_interval(months => i - 1))::date,
            CASE WHEN i = p_instalments THEN v_last ELSE v_each END)
    ON CONFLICT (award_id, instalment_no) DO NOTHING;
  END LOOP;

  UPDATE wazifa_awards SET repay_starts_on = p_starts_on WHERE id = p_award_id;

  RETURN jsonb_build_object('instalments', p_instalments, 'each', v_each, 'last', v_last);
END;
$function$;

create or replace function public.wazifa_mark_document_seen(p_document_id uuid, p_seen boolean)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT COALESCE(can_access_system('donors_projects'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  UPDATE wazifa_documents
     SET original_seen = p_seen,
         seen_by = CASE WHEN p_seen THEN current_admin_user_id() ELSE NULL END,
         seen_at = CASE WHEN p_seen THEN now() ELSE NULL END
   WHERE id = p_document_id AND tenant_id = my_tenant_id();
END;
$function$;

create or replace function public.wazifa_mark_employed(p_student_id uuid, p_monthly_amount numeric, p_employer_note text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE s wazifa_students%ROWTYPE; v_awards int;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO s FROM wazifa_students WHERE id = p_student_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Student not found' USING ERRCODE = 'P0001'; END IF;
  IF p_monthly_amount < 0 THEN
    RAISE EXCEPTION 'The monthly amount cannot be negative.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_students
     SET employment_status = 'employed', employed_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
         employer_note = p_employer_note, updated_at = now()
   WHERE id = p_student_id;

  -- Every active loan this student carries starts repaying at the same
  -- figure — a student with two years' worth of awards does not get two
  -- separate instalments to track.
  UPDATE wazifa_awards
     SET repayment_monthly_pkr = p_monthly_amount, repay_starts_on = COALESCE(repay_starts_on, (now() AT TIME ZONE 'Asia/Karachi')::date)
   WHERE student_id = p_student_id AND is_loan AND status = 'active';
  GET DIAGNOSTICS v_awards = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'awards_started', v_awards);
END;
$function$;

create or replace function public.wazifa_measuring_position(p_academic_year character varying DEFAULT NULL::character varying)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  v_year varchar; v_account uuid; v_required decimal; v_confirmed decimal;
  v_outstanding decimal; v_months int; v_monthly decimal; v_students int;
BEGIN
  v_year := COALESCE(p_academic_year, kafalat_current_year());
  v_account := ensure_wazifa_measuring_account(v_year);

  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0)
    INTO v_required, v_confirmed FROM ledger_entries WHERE account_id = v_account;
  v_outstanding := GREATEST(v_required - v_confirmed, 0);
  v_months := kafalat_months_remaining(v_year);
  v_monthly := round(v_outstanding / v_months);
  SELECT count(DISTINCT student_id) INTO v_students FROM wazifa_awards
   WHERE academic_year = v_year AND status = 'active'
     AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

  RETURN jsonb_build_object(
    'academic_year', v_year, 'account_code', 'WZF-MEASURE-' || split_part(v_year,'-',1),
    'required', v_required, 'confirmed', v_confirmed, 'outstanding', v_outstanding,
    'months_remaining', v_months, 'monthly_target', v_monthly, 'students_active', v_students
  );
END;
$function$;

create or replace function public.wazifa_readjust_disbursement(p_award_id uuid, p_new_end_date date, p_new_due_day integer DEFAULT NULL::integer, p_reason text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE;
  v_remaining decimal; v_today date; v_months int; v_new_monthly decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false) THEN
    RAISE EXCEPTION 'Only an approver can readjust a plan.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF aw.plan_type <> 'disburse_then_settle' OR NOT aw.disbursement_active THEN
    RAISE EXCEPTION 'This award has no active disbursement plan.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;

  v_today := (now() AT TIME ZONE 'Asia/Karachi')::date;
  IF p_new_end_date <= v_today THEN
    RAISE EXCEPTION 'The new end date has to be in the future.' USING ERRCODE = 'P0001';
  END IF;

  v_remaining := GREATEST(aw.awarded_amount_pkr - aw.disbursed_pkr, 0);
  IF v_remaining <= 0 THEN
    RAISE EXCEPTION 'Nothing is left to disburse — there is nothing to readjust.' USING ERRCODE = 'P0001';
  END IF;

  v_months := GREATEST(1, (
    (EXTRACT(YEAR FROM p_new_end_date) - EXTRACT(YEAR FROM v_today)) * 12
    + (EXTRACT(MONTH FROM p_new_end_date) - EXTRACT(MONTH FROM v_today)) + 1
  )::int);
  v_new_monthly := ROUND(v_remaining / v_months);

  DELETE FROM wazifa_disbursement_charges
   WHERE award_id = p_award_id AND status = 'due' AND due_on > v_today;

  UPDATE wazifa_awards SET
    disbursement_monthly_pkr = v_new_monthly,
    disbursement_end_date = p_new_end_date,
    disbursement_due_day = COALESCE(p_new_due_day, disbursement_due_day)
  WHERE id = p_award_id;

  RETURN jsonb_build_object('remaining', v_remaining, 'new_monthly', v_new_monthly, 'months', v_months);
END;
$function$;

create or replace function public.wazifa_readjust_settlement(p_award_id uuid, p_new_end_date date, p_new_due_day integer DEFAULT NULL::integer, p_reason text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE;
  v_remaining decimal; v_today date; v_months int; v_new_monthly decimal;
  v_terms text; v_terms_ur text;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false) THEN
    RAISE EXCEPTION 'Only an approver can readjust a plan.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF NOT aw.installment_active THEN
    RAISE EXCEPTION 'Settlement has not started on this award yet.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;

  v_today := (now() AT TIME ZONE 'Asia/Karachi')::date;
  IF p_new_end_date <= v_today THEN
    RAISE EXCEPTION 'The new end date has to be in the future.' USING ERRCODE = 'P0001';
  END IF;

  v_remaining := GREATEST(
    CASE WHEN aw.plan_type = 'disburse_then_settle' THEN aw.disbursed_pkr ELSE wazifa_plan_total(p_award_id) END
    - aw.contributed_pkr, 0);
  IF v_remaining <= 0 THEN
    RAISE EXCEPTION 'Nothing is left owing — there is nothing to readjust.' USING ERRCODE = 'P0001';
  END IF;

  v_months := GREATEST(1, (
    (EXTRACT(YEAR FROM p_new_end_date) - EXTRACT(YEAR FROM v_today)) * 12
    + (EXTRACT(MONTH FROM p_new_end_date) - EXTRACT(MONTH FROM v_today)) + 1
  )::int);
  v_new_monthly := ROUND(v_remaining / v_months);

  -- Only charges never raised toward — untouched paid/part-paid/due
  -- charges are exactly what "the remainder only" means.
  DELETE FROM wazifa_installment_charges
   WHERE award_id = p_award_id AND status = 'due' AND due_on > v_today;

  UPDATE wazifa_awards SET
    student_monthly_contribution_pkr = v_new_monthly,
    installment_end_date = p_new_end_date,
    installment_due_day = COALESCE(p_new_due_day, installment_due_day)
  WHERE id = p_award_id;

  v_terms := format(
    'Your instalment plan has been readjusted. What was already paid stays paid — Rs %s is still owing, now to be paid at Rs %s per month, by the %s of each month, through %s (%s months).%s',
    trim(to_char(v_remaining, 'FM999,999,999,990')), trim(to_char(v_new_monthly, 'FM999,999,999,990')),
    COALESCE(p_new_due_day, aw.installment_due_day), to_char(p_new_end_date, 'Mon YYYY'), v_months,
    CASE WHEN p_reason IS NOT NULL THEN ' Reason: ' || p_reason ELSE '' END);
  v_terms_ur := format(
    'آپ کے قسطوں کے منصوبے میں تبدیلی کی گئی ہے۔ جو ادا ہو چکا وہ ادا شدہ ہی رہے گا — %s روپے ابھی باقی ہیں، اب ہر ماہ کی %s تاریخ تک %s روپے ماہانہ کی صورت میں، %s تک (%s ماہ)۔',
    trim(to_char(v_remaining, 'FM999,999,999,990')), COALESCE(p_new_due_day, aw.installment_due_day),
    trim(to_char(v_new_monthly, 'FM999,999,999,990')), to_char(p_new_end_date, 'Mon YYYY'), v_months);

  PERFORM wazifa_send_agreement(p_award_id, v_terms, v_terms_ur);

  RETURN jsonb_build_object('remaining', v_remaining, 'new_monthly', v_new_monthly, 'months', v_months);
END;
$function$;

create or replace function public.wazifa_record_check_in(p_award_id uuid, p_method character varying, p_confirmed boolean, p_note text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM wazifa_awards WHERE id = p_award_id AND tenant_id = my_tenant_id()) THEN
    RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001';
  END IF;
  IF NOT p_confirmed AND trim(COALESCE(p_note, '')) = '' THEN
    RAISE EXCEPTION 'If this could not be confirmed, write what was actually said.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO wazifa_check_ins (award_id, method, confirmed, note, checked_by)
  VALUES (p_award_id, p_method, p_confirmed, p_note, current_admin_user_id())
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('check_in_id', v_id);
END;
$function$;

create or replace function public.wazifa_record_decision(p_application_id uuid, p_decision character varying, p_amount numeric DEFAULT 0, p_as_loan boolean DEFAULT false, p_funded_by character varying DEFAULT 'sadqa'::character varying, p_reason text DEFAULT NULL::text, p_reason_ur text DEFAULT NULL::text, p_internal_note text DEFAULT NULL::text, p_meeting_id uuid DEFAULT NULL::uuid, p_shortfall_note text DEFAULT NULL::text, p_installment_basis character varying DEFAULT NULL::character varying, p_installment_percentage numeric DEFAULT NULL::numeric, p_installment_start_date date DEFAULT NULL::date, p_installment_end_date date DEFAULT NULL::date, p_installment_due_day integer DEFAULT NULL::integer, p_installment_pay_to character varying DEFAULT 'student'::character varying)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  a wazifa_applications%ROWTYPE;
  v_award_id uuid;
  v_status varchar;
  v_year varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false)
     AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized to decide an application' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO a FROM wazifa_applications WHERE id = p_application_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Application not found' USING ERRCODE = 'P0001'; END IF;
  IF a.status IN ('approved', 'declined') THEN
    RAISE EXCEPTION 'This application has already been decided.' USING ERRCODE = 'P0001';
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

    PERFORM ensure_wazifa_student_account(a.student_id);

    v_year := a.academic_year;
    PERFORM wazifa_post_requirement_delta(v_year, p_amount,
      (SELECT full_name FROM wazifa_students WHERE id = a.student_id) || ' — approved ' || p_decision,
      a.student_id);

    IF p_installment_basis IS NOT NULL THEN
      PERFORM wazifa_set_installment_plan(v_award_id, p_installment_basis, p_installment_percentage,
        p_installment_start_date, p_installment_end_date, COALESCE(p_installment_due_day, 10),
        COALESCE(p_installment_pay_to, 'student'));
    END IF;
  END IF;

  RETURN jsonb_build_object('status', v_status, 'award_id', v_award_id);
END;
$function$;

create or replace function public.wazifa_renewal_due()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'award_id', a.id, 'student_name', s.full_name, 'student_code', s.code,
    'academic_year', ap.academic_year, 'institution', ap.institution,
    'is_loan', a.is_loan, 'awarded_amount', a.awarded_amount_pkr
  ) ORDER BY s.code), '[]'::jsonb)
  FROM wazifa_awards a
  JOIN wazifa_applications ap ON ap.id = a.application_id
  JOIN wazifa_students s ON s.id = a.student_id
  WHERE a.status = 'active' AND a.tenant_id = my_tenant_id()
    AND NOT EXISTS (SELECT 1 FROM wazifa_applications ap2
                     WHERE ap2.student_id = a.student_id AND ap2.supersedes_application_id = ap.id);
$function$;

create or replace function public.wazifa_revise_repayment_amount(p_award_id uuid, p_monthly_amount numeric)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_monthly_amount <= 0 THEN
    RAISE EXCEPTION 'Enter an amount greater than zero.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE wazifa_awards SET repayment_monthly_pkr = p_monthly_amount
   WHERE id = p_award_id AND is_loan AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Not a loan, or not found.' USING ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

create or replace function public.wazifa_score_application(p_application_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  a wazifa_applications%ROWTYPE;
  s wazifa_students%ROWTYPE;
  v_merit decimal;
  v_need decimal;
  v_capacity decimal;
  v_mw decimal;
  v_nw decimal;
  v_cw decimal;
  v_income decimal;
  v_married_brother_income decimal;
  v_total decimal;
BEGIN
  SELECT * INTO a FROM wazifa_applications WHERE id = p_application_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Application not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO s FROM wazifa_students WHERE id = a.student_id;

  v_mw := COALESCE(nullif(setting_text('wazifa_merit_weight', '50'), '')::decimal, 50);
  v_nw := COALESCE(nullif(setting_text('wazifa_need_weight', '50'), '')::decimal, 50);
  v_cw := COALESCE(nullif(setting_text('wazifa_capacity_weight', '50'), '')::decimal, 50);

  v_merit := COALESCE(a.last_exam_percent,
                      CASE WHEN COALESCE(a.last_exam_total, 0) > 0
                           THEN a.last_exam_marks / a.last_exam_total * 100 END,
                      0);

  v_married_brother_income := COALESCE((
    SELECT SUM(CASE WHEN fm.income_period = 'yearly' THEN fm.income_pkr / 12 ELSE fm.income_pkr END)
      FROM wazifa_family_members fm
     WHERE fm.application_id = p_application_id
       AND fm.relation = 'brother' AND fm.marital_status = 'married'
  ), 0);
  v_income := GREATEST(
    COALESCE(a.family_monthly_income_pkr, s.household_monthly_income_pkr, 0)
    + CASE WHEN a.has_family_business THEN COALESCE(a.family_business_share_pkr, 0) ELSE 0 END
    - v_married_brother_income, 0);

  -- Need falls as income rises, floored at zero. Rs 60,000 a month in a
  -- village is comfortable; nothing at all scores full marks. Orphans and
  -- families already carrying other students in education get a lift,
  -- because both are real costs that income alone does not show.
  v_need := GREATEST(100 - (v_income / 600), 0);
  IF s.is_orphan THEN v_need := LEAST(v_need + 15, 100); END IF;
  v_need := LEAST(v_need + (LEAST(s.siblings_studying, 4) * 3), 100);

  -- Capacity rises with the same income, mirrored — the room a family
  -- has to actually make a monthly repayment, not a moral judgement.
  v_capacity := LEAST(v_income / 600, 100);

  v_total := CASE WHEN s.is_zakat_family
    THEN (v_merit * v_mw + v_need * v_nw) / NULLIF(v_mw + v_nw, 0)
    ELSE (v_merit * v_mw + v_capacity * v_cw) / NULLIF(v_mw + v_cw, 0) END;

  UPDATE wazifa_applications
     SET merit_score = round(v_merit, 2),
         need_score = round(v_need, 2),
         capacity_score = round(v_capacity, 2),
         total_score = round(v_total, 2),
         last_exam_percent = COALESCE(last_exam_percent, round(v_merit, 2))
   WHERE id = p_application_id;

  RETURN jsonb_build_object('merit', round(v_merit, 2), 'need', round(v_need, 2),
                            'capacity', round(v_capacity, 2), 'total', round(v_total, 2));
END;
$function$;

create or replace function public.wazifa_screen_application(p_application_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE a wazifa_applications%ROWTYPE; s wazifa_students%ROWTYPE; v_candidates jsonb;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO a FROM wazifa_applications WHERE id = p_application_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Application not found' USING ERRCODE = 'P0001'; END IF;
  IF a.status NOT IN ('submitted', 'screening') THEN
    RAISE EXCEPTION 'This application has moved past screening already.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO s FROM wazifa_students WHERE id = a.student_id;

  UPDATE wazifa_applications SET status = 'screening' WHERE id = p_application_id;

  v_candidates := wazifa_check_zakat_family(s.father_name, s.mother_name, a.declared_cnic);
  RETURN jsonb_build_object('candidates', v_candidates, 'already_confirmed', s.is_zakat_family);
END;
$function$;

create or replace function public.wazifa_send_agreement(p_award_id uuid, p_terms_text text, p_terms_text_ur text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE aw wazifa_awards%ROWTYPE; v_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF COALESCE(aw.student_monthly_contribution_pkr, 0) <= 0 OR aw.installment_due_day IS NULL THEN
    RAISE EXCEPTION 'Set the monthly amount and due day first.' USING ERRCODE = 'P0001';
  END IF;
  IF trim(COALESCE(p_terms_text, '')) = '' THEN
    RAISE EXCEPTION 'Write what the student is being asked to agree to.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_agreements SET status = 'superseded'
   WHERE award_id = p_award_id AND status <> 'superseded';

  INSERT INTO wazifa_agreements (
    award_id, awarded_amount_pkr, monthly_amount_pkr, due_day,
    terms_text, terms_text_ur, sent_by
  ) VALUES (
    p_award_id, aw.awarded_amount_pkr, aw.student_monthly_contribution_pkr, aw.installment_due_day,
    p_terms_text, p_terms_text_ur, current_admin_user_id()
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('agreement_id', v_id);
END;
$function$;

create or replace function public.wazifa_set_disbursement_settlement_plan(p_award_id uuid, p_disbursement_monthly numeric, p_disbursement_start date, p_disbursement_end date, p_disbursement_due_day integer, p_disbursement_pay_to character varying, p_settlement_monthly numeric, p_settlement_trigger character varying, p_settlement_due_day integer, p_terms_text text DEFAULT NULL::text, p_terms_text_ur text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE; ap wazifa_applications%ROWTYPE;
  v_settlement_start date; v_dest text; v_terms text; v_terms_ur text; v_months int;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false)
     AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_disbursement_monthly <= 0 THEN
    RAISE EXCEPTION 'The monthly support amount has to be more than zero.' USING ERRCODE = 'P0001';
  END IF;
  IF p_disbursement_end <= p_disbursement_start THEN
    RAISE EXCEPTION 'The end date has to be after the start date.' USING ERRCODE = 'P0001';
  END IF;
  IF p_disbursement_due_day < 1 OR p_disbursement_due_day > 28 THEN
    RAISE EXCEPTION 'Choose a due day between 1 and 28.' USING ERRCODE = 'P0001';
  END IF;
  IF p_disbursement_pay_to NOT IN ('institution', 'student', 'hostel') THEN
    RAISE EXCEPTION 'Choose institution, student, or hostel.' USING ERRCODE = 'P0001';
  END IF;
  IF p_settlement_trigger NOT IN ('course_end', 'employment', 'none') THEN
    RAISE EXCEPTION 'Choose when settlement starts.' USING ERRCODE = 'P0001';
  END IF;
  IF p_settlement_trigger <> 'none' AND (p_settlement_monthly IS NULL OR p_settlement_monthly <= 0) THEN
    RAISE EXCEPTION 'Enter the monthly settlement amount.' USING ERRCODE = 'P0001';
  END IF;
  IF p_settlement_trigger <> 'none' AND (p_settlement_due_day < 1 OR p_settlement_due_day > 28) THEN
    RAISE EXCEPTION 'Choose a settlement due day between 1 and 28.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  SELECT * INTO ap FROM wazifa_applications WHERE id = aw.application_id;

  -- The month after support ends, worked out now for course_end; left
  -- for wazifa_trigger_settlement to fill in later otherwise.
  v_settlement_start := CASE WHEN p_settlement_trigger = 'course_end'
    THEN (date_trunc('month', p_disbursement_end) + interval '1 month')::date
    ELSE NULL END;

  UPDATE wazifa_awards SET
    plan_type = 'disburse_then_settle',
    disbursement_monthly_pkr = p_disbursement_monthly,
    disbursement_start_date = p_disbursement_start,
    disbursement_end_date = p_disbursement_end,
    disbursement_due_day = p_disbursement_due_day,
    disbursement_pay_to = p_disbursement_pay_to,
    disbursement_active = true,
    settlement_trigger = p_settlement_trigger,
    -- Settlement reuses the collect-now plan's own fields — a single
    -- mechanism, just switched on at a different moment.
    student_monthly_contribution_pkr = COALESCE(p_settlement_monthly, 0),
    installment_due_day = p_settlement_due_day,
    installment_start_date = v_settlement_start,
    installment_end_date = NULL,
    installment_basis = NULL,
    installment_percentage = NULL,
    installment_pay_to = 'student',
    installment_active = (p_settlement_trigger = 'course_end')
  WHERE id = p_award_id;

  v_dest := CASE p_disbursement_pay_to
    WHEN 'institution' THEN COALESCE(ap.institution, 'the institution')
    WHEN 'hostel' THEN COALESCE(ap.hostel_name, 'the hostel')
    ELSE st.full_name END;
  v_months := GREATEST(1, (
    (EXTRACT(YEAR FROM p_disbursement_end) - EXTRACT(YEAR FROM p_disbursement_start)) * 12
    + (EXTRACT(MONTH FROM p_disbursement_end) - EXTRACT(MONTH FROM p_disbursement_start)) + 1
  )::int);

  v_terms := COALESCE(p_terms_text, format(
    'While you study: the committee will pay Rs %s per month to %s, from %s to %s (%s months), by the %s of each month — Rs %s in total toward %s''s education.%s',
    trim(to_char(p_disbursement_monthly, 'FM999,999,999,990')), v_dest,
    to_char(p_disbursement_start, 'Mon YYYY'), to_char(p_disbursement_end, 'Mon YYYY'),
    v_months, p_disbursement_due_day,
    trim(to_char(p_disbursement_monthly * v_months, 'FM999,999,999,990')), st.full_name,
    CASE p_settlement_trigger
      WHEN 'course_end' THEN format(
        ' After that: %s agrees to pay it back at Rs %s per month, starting %s, by the %s of each month, until it is settled in full. What comes back funds the next student.',
        st.full_name, trim(to_char(p_settlement_monthly, 'FM999,999,999,990')),
        to_char(v_settlement_start, 'Mon YYYY'), p_settlement_due_day)
      WHEN 'employment' THEN format(
        ' This is a zakat-family award. %s is not required to pay it back — but has agreed that once employed, they will pay Rs %s per month, by the %s of each month, until it is settled. What comes back funds the next student, not this one.',
        st.full_name, trim(to_char(p_settlement_monthly, 'FM999,999,999,990')), p_settlement_due_day)
      ELSE ' This is a zakat-family award and is not returnable.'
    END));
  v_terms_ur := COALESCE(p_terms_text_ur, format(
    'پڑھائی کے دوران: کمیٹی ہر ماہ کی %s تاریخ تک %s روپے ماہانہ %s کو ادا کرے گی، %s سے %s تک (%s ماہ) — %s کی تعلیم کے لیے کل %s روپے۔%s',
    p_disbursement_due_day, trim(to_char(p_disbursement_monthly, 'FM999,999,999,990')), v_dest,
    to_char(p_disbursement_start, 'Mon YYYY'), to_char(p_disbursement_end, 'Mon YYYY'), v_months,
    st.full_name, trim(to_char(p_disbursement_monthly * v_months, 'FM999,999,999,990')),
    CASE p_settlement_trigger
      WHEN 'course_end' THEN format(
        ' اس کے بعد: %s ہر ماہ کی %s تاریخ تک %s روپے ماہانہ واپس کرنے پر رضامند ہے، %s سے شروع، جب تک مکمل ادائیگی نہ ہو جائے۔ واپس آنے والی یہی رقم اگلے طالبِ علم تک پہنچے گی۔',
        st.full_name, p_settlement_due_day, trim(to_char(p_settlement_monthly, 'FM999,999,999,990')),
        to_char(v_settlement_start, 'Mon YYYY'))
      WHEN 'employment' THEN format(
        ' یہ زکوٰۃ خاندان کا وظیفہ ہے۔ %s پر واپسی لازم نہیں — مگر رضامند ہے کہ ملازمت ملنے پر ہر ماہ کی %s تاریخ تک %s روپے ماہانہ ادا کرے گا، جب تک مکمل ادائیگی نہ ہو جائے۔ واپس آنے والی رقم اسی طالبِ علم کے بجائے اگلے کی تعلیم پر خرچ ہوگی۔',
        st.full_name, p_settlement_due_day, trim(to_char(p_settlement_monthly, 'FM999,999,999,990')))
      ELSE ' یہ زکوٰۃ خاندان کا وظیفہ ہے اور واپس طلب نہیں کیا جائے گا۔'
    END));

  PERFORM wazifa_send_agreement(p_award_id, v_terms, v_terms_ur);

  RETURN jsonb_build_object(
    'disbursement_monthly', p_disbursement_monthly, 'disbursement_months', v_months,
    'settlement_trigger', p_settlement_trigger, 'settlement_start', v_settlement_start
  );
END;
$function$;

create or replace function public.wazifa_set_installment_plan(p_award_id uuid, p_basis character varying, p_percentage numeric, p_start_date date, p_end_date date, p_due_day integer, p_pay_to character varying DEFAULT 'student'::character varying, p_terms_text text DEFAULT NULL::text, p_terms_text_ur text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE; ap wazifa_applications%ROWTYPE;
  v_total decimal; v_months int; v_monthly decimal; v_terms text; v_terms_ur text; v_dest text;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false)
     AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_basis NOT IN ('percentage', 'full') THEN
    RAISE EXCEPTION 'Choose percentage or full.' USING ERRCODE = 'P0001';
  END IF;
  IF p_basis = 'percentage' AND (p_percentage IS NULL OR p_percentage <= 0 OR p_percentage > 100) THEN
    RAISE EXCEPTION 'Enter a percentage between 1 and 100.' USING ERRCODE = 'P0001';
  END IF;
  IF p_end_date <= p_start_date THEN
    RAISE EXCEPTION 'The end date has to be after the start date.' USING ERRCODE = 'P0001';
  END IF;
  IF p_due_day < 1 OR p_due_day > 28 THEN
    RAISE EXCEPTION 'Choose a due day between 1 and 28, so it falls in every month.' USING ERRCODE = 'P0001';
  END IF;
  IF p_pay_to NOT IN ('institution', 'student', 'hostel') THEN
    RAISE EXCEPTION 'Choose institution, student, or hostel.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  SELECT * INTO ap FROM wazifa_applications WHERE id = aw.application_id;

  v_total := CASE WHEN p_basis = 'full' THEN aw.awarded_amount_pkr ELSE aw.awarded_amount_pkr * p_percentage / 100 END;
  v_months := GREATEST(1, (
    (EXTRACT(YEAR FROM p_end_date) - EXTRACT(YEAR FROM p_start_date)) * 12
    + (EXTRACT(MONTH FROM p_end_date) - EXTRACT(MONTH FROM p_start_date)) + 1
  )::int);
  v_monthly := ROUND(v_total / v_months);

  UPDATE wazifa_awards
     SET student_monthly_contribution_pkr = v_monthly, installment_due_day = p_due_day,
         installment_start_date = p_start_date, installment_end_date = p_end_date,
         installment_basis = p_basis, installment_percentage = CASE WHEN p_basis = 'percentage' THEN p_percentage ELSE NULL END,
         installment_pay_to = p_pay_to
   WHERE id = p_award_id;

  v_dest := CASE p_pay_to
    WHEN 'institution' THEN COALESCE(ap.institution, 'the institution')
    WHEN 'hostel' THEN COALESCE(ap.hostel_name, 'the hostel')
    ELSE st.full_name END;

  v_terms := COALESCE(p_terms_text, format(
    'You are awarded Rs %s toward %s''s education. Of that, Rs %s is qarz-e-hasana — %s agrees to pay it back at Rs %s per month, from %s to %s (%s months), due by the %s of each month. What comes back funds the next student.',
    trim(to_char(aw.awarded_amount_pkr, 'FM999,999,999,990')), st.full_name,
    trim(to_char(v_total, 'FM999,999,999,990')), v_dest,
    trim(to_char(v_monthly, 'FM999,999,999,990')),
    to_char(p_start_date, 'Mon YYYY'), to_char(p_end_date, 'Mon YYYY'), v_months, p_due_day));
  v_terms_ur := COALESCE(p_terms_text_ur, format(
    '%s کی تعلیم کے لیے %s روپے منظور ہوئے۔ اس میں سے %s روپے قرضِ حسنہ ہیں — %s ہر ماہ کی %s تاریخ تک، %s سے %s تک (%s ماہ)، %s روپے ماہانہ واپس کرے گا۔ واپس آنے والی یہی رقم اگلے طالبِ علم تک پہنچے گی۔',
    st.full_name, trim(to_char(aw.awarded_amount_pkr, 'FM999,999,999,990')),
    trim(to_char(v_total, 'FM999,999,999,990')), v_dest, p_due_day,
    to_char(p_start_date, 'Mon YYYY'), to_char(p_end_date, 'Mon YYYY'), v_months,
    trim(to_char(v_monthly, 'FM999,999,999,990'))));

  PERFORM wazifa_send_agreement(p_award_id, v_terms, v_terms_ur);

  RETURN jsonb_build_object('monthly_amount', v_monthly, 'months', v_months, 'total', v_total);
END;
$function$;

create or replace function public.wazifa_set_monthly_installment(p_award_id uuid, p_amount numeric, p_due_day integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Enter a monthly amount greater than zero.' USING ERRCODE = 'P0001';
  END IF;
  IF p_due_day < 1 OR p_due_day > 28 THEN
    RAISE EXCEPTION 'Choose a due day between 1 and 28, so it falls in every month.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_awards
     SET student_monthly_contribution_pkr = p_amount, installment_due_day = p_due_day
   WHERE id = p_award_id AND status = 'active' AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Award not found, or not active.' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

create or replace function public.wazifa_start_interim_grant(p_award_id uuid, p_months integer, p_monthly_amount numeric, p_pay_to character varying DEFAULT 'institution'::character varying)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE; v_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  IF NOT st.is_zakat_family THEN
    RAISE EXCEPTION 'Interim support is for a confirmed zakat family — screen and confirm the match first.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT aw.is_loan THEN
    RAISE EXCEPTION 'This award was not decided as repayable.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM wazifa_interim_grant WHERE award_id = p_award_id AND status = 'active') THEN
    RAISE EXCEPTION 'An interim support plan is already active for this award.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO wazifa_interim_grant (award_id, months_awarded, monthly_amount_pkr, pay_to, created_by)
  VALUES (p_award_id, p_months, p_monthly_amount, p_pay_to, current_admin_user_id())
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('grant_id', v_id);
END;
$function$;

create or replace function public.wazifa_start_renewal(p_award_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  a wazifa_awards%ROWTYPE; prev wazifa_applications%ROWTYPE; v_new_id uuid; v_year varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO a FROM wazifa_awards WHERE id = p_award_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO prev FROM wazifa_applications WHERE id = a.application_id;

  v_year := CASE WHEN extract(month FROM (now() AT TIME ZONE 'Asia/Karachi')) >= 4
                 THEN extract(year FROM (now() AT TIME ZONE 'Asia/Karachi'))::text || '-'
                   || to_char((now() AT TIME ZONE 'Asia/Karachi') + interval '1 year', 'YY')
                 ELSE (extract(year FROM (now() AT TIME ZONE 'Asia/Karachi')) - 1)::text || '-'
                   || to_char((now() AT TIME ZONE 'Asia/Karachi'), 'YY') END;

  IF EXISTS (SELECT 1 FROM wazifa_applications
              WHERE student_id = prev.student_id AND academic_year = v_year
                AND status <> 'withdrawn') THEN
    RAISE EXCEPTION 'A renewal for % has already been started for %.', v_year,
      (SELECT full_name FROM wazifa_students WHERE id = prev.student_id) USING ERRCODE = 'P0001';
  END IF;

  -- Every field copied forward, ready for the student to correct what
  -- changed rather than retype eleven sections from nothing. status='draft'
  -- so it goes through migration 223's ordinary edit-until-reviewed path.
  INSERT INTO wazifa_applications (
    student_id, academic_year, level, institution, programme, city, duration_years,
    current_year, admission_status, last_exam_name, last_exam_marks, last_exam_total,
    requested_amount_pkr, other_support, need_statement, need_statement_ur,
    applicant_for, family_monthly_income_pkr, father_alive, father_occupation,
    mother_occupation, house_owned, land_owned_kanal, has_long_term_patient,
    patient_relation, patient_illness, patient_monthly_cost_pkr, family_receives_zakat,
    zakat_sources, zakat_monthly_pkr, requested_as, has_family_business,
    family_business_kind, family_business_share_pkr, family_business_note,
    declared_cnic, declared_b_form_no, declared_dob, declared_address,
    offered_monthly_contribution_pkr, institution_monthly_fee_pkr,
    status, supersedes_application_id, attempt
  )
  SELECT
    student_id, v_year, level, institution, programme, city, duration_years,
    COALESCE(current_year, 0) + 1, admission_status, last_exam_name, last_exam_marks, last_exam_total,
    requested_amount_pkr, other_support, need_statement, need_statement_ur,
    applicant_for, family_monthly_income_pkr, father_alive, father_occupation,
    mother_occupation, house_owned, land_owned_kanal, has_long_term_patient,
    patient_relation, patient_illness, patient_monthly_cost_pkr, family_receives_zakat,
    zakat_sources, zakat_monthly_pkr, requested_as, has_family_business,
    family_business_kind, family_business_share_pkr, family_business_note,
    declared_cnic, declared_b_form_no, declared_dob, declared_address,
    offered_monthly_contribution_pkr, institution_monthly_fee_pkr,
    'draft', prev.id, COALESCE(prev.attempt, 1) + 1
  FROM wazifa_applications WHERE id = prev.id
  RETURNING id INTO v_new_id;

  -- Family members carry forward too — ages and circumstances move on, but
  -- retyping every sibling from scratch is exactly the friction a renewal is
  -- meant to avoid.
  INSERT INTO wazifa_family_members (application_id, full_name, relation, age, marital_status,
    is_studying, institution, class_or_year, study_location, annual_fee_pkr, is_working,
    occupation, income_period, income_pkr, is_dependent, note, school_id)
  SELECT v_new_id, full_name, relation, COALESCE(age, 0) + 1, marital_status,
    is_studying, institution, class_or_year, study_location, annual_fee_pkr, is_working,
    occupation, income_period, income_pkr, is_dependent, note, school_id
  FROM wazifa_family_members WHERE application_id = prev.id;

  RETURN jsonb_build_object('application_id', v_new_id, 'academic_year', v_year,
                            'student_id', prev.student_id);
END;
$function$;

create or replace function public.wazifa_stop_interim_grant(p_grant_id uuid, p_reason text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_cancelled int;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF trim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'Write why this is being stopped — the file should say what was reported.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_instalments SET status = 'cancelled'
   WHERE interim_grant_id = p_grant_id AND status = 'scheduled';
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  UPDATE wazifa_interim_grant
     SET status = 'stopped', stopped_reason = p_reason,
         stopped_by = current_admin_user_id(), stopped_at = now()
   WHERE id = p_grant_id AND status = 'active' AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Not an active interim support plan.' USING ERRCODE = 'P0001'; END IF;

  RETURN jsonb_build_object('ok', true, 'unpaid_months_cancelled', v_cancelled);
END;
$function$;

create or replace function public.wazifa_students_for_naming()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'student_id', s.id, 'code', s.code, 'full_name', s.full_name,
    'institution', ap.institution, 'programme', ap.programme, 'level', ap.level,
    'awarded_amount', a.awarded_amount_pkr, 'is_loan', a.is_loan, 'is_zakat_family', s.is_zakat_family,
    'already_named', COALESCE((
      SELECT SUM(p.amount_pkr) FROM pool_payments p
       WHERE p.wazifa_student_id = s.id AND p.status = 'confirmed'
    ), 0)
  ) ORDER BY s.code), '[]'::jsonb)
  FROM wazifa_awards a
  JOIN wazifa_students s ON s.id = a.student_id
  JOIN wazifa_applications ap ON ap.id = a.application_id
  WHERE a.status = 'active'
    AND a.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
    AND (
      a.installment_active
      OR EXISTS (SELECT 1 FROM wazifa_interim_grant g WHERE g.award_id = a.id)
    );
$function$;

create or replace function public.wazifa_trigger_settlement(p_award_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE aw wazifa_awards%ROWTYPE;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false)
     AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF aw.plan_type <> 'disburse_then_settle' OR aw.settlement_trigger <> 'employment' THEN
    RAISE EXCEPTION 'This award is not waiting on an employment trigger.' USING ERRCODE = 'P0001';
  END IF;
  IF aw.installment_active THEN
    RAISE EXCEPTION 'Settlement has already started.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_awards
     SET installment_start_date = (now() AT TIME ZONE 'Asia/Karachi')::date, installment_active = true
   WHERE id = p_award_id;

  RETURN jsonb_build_object('ok', true, 'started_on', (now() AT TIME ZONE 'Asia/Karachi')::date);
END;
$function$;

create or replace function public.wazifa_verify_agreement(p_agreement_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE ag wazifa_agreements%ROWTYPE;
BEGIN
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false)
     AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO ag FROM wazifa_agreements WHERE id = p_agreement_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Agreement not found' USING ERRCODE = 'P0001'; END IF;
  IF ag.status <> 'signed' THEN
    RAISE EXCEPTION 'This agreement is not waiting for verification.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_agreements
     SET status = 'verified', witnessed_verified_by = current_admin_user_id(), witnessed_verified_at = now()
   WHERE id = p_agreement_id;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

create or replace function public.wazifa_withdraw_application(p_application_id uuid, p_reason text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE a wazifa_applications%ROWTYPE;
BEGIN
  SELECT * INTO a FROM wazifa_applications WHERE id = p_application_id AND tenant_id = my_tenant_id();
  IF NOT FOUND OR NOT wazifa_app_is_open(p_application_id) THEN
    RAISE EXCEPTION 'This application can no longer be withdrawn from here. Please speak to the committee.'
      USING ERRCODE = 'P0001';
  END IF;
  UPDATE wazifa_applications
     SET status = 'withdrawn', review_note = COALESCE(p_reason, review_note)
   WHERE id = p_application_id;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

create or replace function public.zakat_compute_round(p_round_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  r zakat_rounds%ROWTYPE;
  v_available decimal;
  v_weight_total decimal;
  v_per_weight decimal;
  v_total decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO r FROM zakat_rounds WHERE id = p_round_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Round not found' USING ERRCODE = 'P0001'; END IF;
  IF r.status NOT IN ('frozen', 'distributing') THEN
    RAISE EXCEPTION 'Freeze the household list before computing shares.' USING ERRCODE = 'P0001';
  END IF;

  v_available := fund_balance(r.fund_type);
  IF v_available <= 0 THEN
    RAISE EXCEPTION 'The % fund is empty — there is nothing to distribute.', upper(r.fund_type)
      USING ERRCODE = 'P0001';
  END IF;

  -- The declared formula gives each household a weight. The whole fund is
  -- then divided in proportion to those weights, so every rupee collected
  -- goes out and no household is left behind by a rounding rule.
  SELECT COALESCE(SUM(r.base_per_household + (r.per_dependant_increment * b.dependants)), 0)
    INTO v_weight_total
    FROM zakat_round_beneficiaries b
   WHERE b.round_id = p_round_id AND b.status = 'pending';

  IF v_weight_total <= 0 THEN
    -- Both parameters left at zero means "split it equally", which is a
    -- perfectly reasonable thing to want and should not be an error.
    UPDATE zakat_round_beneficiaries b
       SET amount_pkr = round(v_available / GREATEST((SELECT count(*) FROM zakat_round_beneficiaries WHERE round_id = p_round_id AND status = 'pending'), 1))
     WHERE b.round_id = p_round_id AND b.status = 'pending';
  ELSE
    v_per_weight := v_available / v_weight_total;
    UPDATE zakat_round_beneficiaries b
       SET amount_pkr = round((r.base_per_household + (r.per_dependant_increment * b.dependants)) * v_per_weight)
     WHERE b.round_id = p_round_id AND b.status = 'pending';
  END IF;

  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_total
    FROM zakat_round_beneficiaries WHERE round_id = p_round_id;

  UPDATE zakat_rounds SET collected_pkr = v_available, status = 'distributing' WHERE id = p_round_id;

  RETURN jsonb_build_object('available', v_available, 'allocated', v_total);
END;
$function$;
