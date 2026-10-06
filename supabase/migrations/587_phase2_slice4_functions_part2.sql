-- Phase 2, slice 4 (functions, part 2): admin-queue listings, public
-- dashboards, and remaining admin-gated ID-lookup mutators not covered in
-- migration 586. Same bug classes as that migration's header explains.

create or replace function public.admin_pool_recurring_lines()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'pool_kind', pl.kind, 'pool', pl.name,
    'donor_name', c.donor_name, 'donor_phone', c.donor_phone,
    'monthly_amount', c.monthly_amount_pkr, 'status', c.status,
    'started_on', c.started_on, 'lapsed_at', c.lapsed_at,
    'named', COALESCE(
      (SELECT first_name FROM kafalat_children WHERE id = c.kafalat_child_id),
      (SELECT full_name FROM wazifa_students WHERE id = c.wazifa_student_id),
      (SELECT item_name FROM sadqa_objects WHERE id = c.sadqa_object_id)
    ),
    'months_given', (SELECT count(DISTINCT for_month) FROM pool_payments
                      WHERE commitment_id = c.id AND status = 'confirmed'),
    'total_given', COALESCE((SELECT SUM(amount_pkr) FROM pool_payments
                              WHERE commitment_id = c.id AND status = 'confirmed'), 0)
  ) ORDER BY c.started_on DESC), '[]'::jsonb)
  FROM pool_commitments c JOIN support_pools pl ON pl.id = c.pool_id
  WHERE c.status IN ('active', 'lapsed') AND c.tenant_id = my_tenant_id();
$function$;

create or replace function public.admin_receive_program_cash(p_portal_user_id uuid, p_pool_code character varying, p_amount numeric, p_method character varying, p_kafalat_child_id uuid DEFAULT NULL::uuid, p_wazifa_student_id uuid DEFAULT NULL::uuid, p_sadqa_object_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  u portal_users%ROWTYPE; pl support_pools%ROWTYPE; v_month date; v_id uuid; v_posted jsonb;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_pool_code NOT IN ('POOL-KFL', 'POOL-WZF', 'POOL-SDQ') THEN
    RAISE EXCEPTION 'Not a recognised programme.' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'The amount must be more than zero.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO u FROM portal_users WHERE id = p_portal_user_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'That donor account was not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO pl FROM support_pools WHERE code = p_pool_code AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'That pool does not exist yet.' USING ERRCODE = 'P0001'; END IF;

  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;

  v_posted := pool_post_confirmed_payment(pl.id, NULL, u.full_name, u.name_ur, u.mobile, false,
    p_amount, p_method, u.id, v_month, p_note,
    p_kafalat_child_id, p_wazifa_student_id, p_sadqa_object_id);

  INSERT INTO pool_payments (pool_id, commitment_id, for_month, amount_pkr, method, is_one_time,
                             donor_id, note, created_by, status, confirmed_at, confirmed_by,
                             kafalat_child_id, wazifa_student_id, sadqa_object_id)
  VALUES (pl.id, NULL, v_month, p_amount, p_method, true,
          (v_posted->>'donor_id')::uuid, p_note, current_admin_user_id(),
          'confirmed', now(), current_admin_user_id(), p_kafalat_child_id, p_wazifa_student_id,
          p_sadqa_object_id)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('donor_id', v_posted->>'donor_id', 'payment_id', v_id, 'amount', p_amount);
END;
$function$;

create or replace function public.kafalat_accept_nomination(p_nomination_id uuid, p_child_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT COALESCE(can_access_system('donors_projects'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  UPDATE kafalat_nominations
     SET status = 'accepted', child_id = p_child_id,
         reviewed_at = now(), reviewed_by = current_admin_user_id()
   WHERE id = p_nomination_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
END;
$function$;

create or replace function public.kafalat_available_children()
 returns TABLE(id uuid, code character varying, first_name character varying, first_name_ur character varying, gender character varying, age integer, current_class character varying, school_location character varying, is_orphan boolean, annual_package_pkr numeric, committed_percent numeric, remaining_percent numeric, photo_url text)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT
    c.id, c.code,
    c.first_name, c.first_name_ur, c.gender,
    CASE WHEN c.date_of_birth IS NULL THEN NULL
         ELSE date_part('year', age(c.date_of_birth))::int END,
    c.current_class, c.school_location, c.is_orphan,
    kafalat_package_total(c.id, NULL::varchar),
    kafalat_committed_percent(c.id),
    GREATEST(100 - kafalat_committed_percent(c.id), 0),
    CASE WHEN c.photo_consent AND NOT c.do_not_display THEN c.photo_url ELSE NULL END
  FROM kafalat_children c
  WHERE c.status = 'active'
    AND c.guardian_consent_signed
    AND c.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
  ORDER BY kafalat_committed_percent(c.id) DESC, c.created_at;
$function$;

create or replace function public.kafalat_child_donor_count(p_child_id uuid)
 returns integer
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT count(DISTINCT portal_user_id)::int FROM pool_commitments
   WHERE kafalat_child_id = p_child_id AND status IN ('active', 'lapsed')
     AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
$function$;

create or replace function public.kafalat_child_expense_record(p_child_id uuid, p_academic_year character varying DEFAULT NULL::character varying)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  c kafalat_children%ROWTYPE; v_year varchar := COALESCE(p_academic_year, kafalat_current_year());
  v_lines jsonb; v_total decimal;
BEGIN
  SELECT * INTO c FROM kafalat_children WHERE id = p_child_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'paid_on'), '[]'::jsonb), COALESCE(SUM((x->>'amount')::decimal), 0)
    INTO v_lines, v_total
  FROM (
    SELECT jsonb_build_object(
      'category', fp.category, 'amount', fp.amount_pkr, 'paid_on', fp.paid_on, 'method', fp.method,
      'paid_to', fp.paid_to, 'signed_by', fp.signed_by, 'proof_url', fp.proof_url, 'note', fp.note
    ) AS x
    FROM kafalat_fee_payments fp
    WHERE fp.child_id = p_child_id AND fp.paid_on BETWEEN kafalat_year_starts(v_year) AND kafalat_year_ends(v_year)
    UNION ALL
    SELECT jsonb_build_object(
      'category', 'uniform', 'amount', u.amount_pkr, 'paid_on', u.issued_on, 'method', 'cash',
      'paid_to', u.received_by, 'signed_by', u.received_by, 'proof_url', u.proof_url,
      'note', 'Uniform ' || u.issue_no || '/2' || COALESCE(' — ' || u.signed_note, '')
    ) AS x
    FROM kafalat_uniform_issues u
    WHERE u.child_id = p_child_id AND u.academic_year = v_year AND u.status = 'issued'
    UNION ALL
    SELECT jsonb_build_object(
      'category', d.category, 'amount', d.amount_pkr, 'paid_on', d.paid_on, 'method', d.method,
      'paid_to', COALESCE(d.driver_name, d.recipient), 'signed_by', d.signed_by, 'proof_url', d.proof_url,
      'note', to_char(d.month, 'Mon YYYY') || COALESCE(' — ' || d.signed_note, '')
    ) AS x
    FROM kafalat_disbursements d
    WHERE d.child_id = p_child_id AND d.status = 'paid'
      AND d.month BETWEEN kafalat_year_starts(v_year) AND kafalat_year_ends(v_year)
  ) rows;

  RETURN jsonb_build_object(
    'child_code', c.code, 'child_name', c.first_name, 'full_name', c.full_name,
    'guardian_name', c.guardian_name, 'guardian_phone', c.guardian_phone,
    'school_name', c.school_name, 'current_class', c.current_class,
    'academic_year', v_year, 'lines', v_lines, 'total_spent', v_total
  );
END;
$function$;

create or replace function public.kafalat_child_package_breakdown(p_child_id uuid, p_academic_year character varying DEFAULT NULL::character varying)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  c kafalat_children%ROWTYPE; v_year varchar; v_months int; v_lines jsonb; v_total decimal;
BEGIN
  SELECT * INTO c FROM kafalat_children WHERE id = p_child_id AND status = 'active' AND NOT do_not_display
    AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  v_year := COALESCE(p_academic_year, kafalat_current_year());
  v_months := kafalat_months_remaining(v_year, c.joined_on);

  SELECT COALESCE(jsonb_agg(jsonb_build_object('category', category, 'amount', amount) ORDER BY category), '[]'::jsonb),
         COALESCE(SUM(amount), 0)
    INTO v_lines, v_total
  FROM (
    SELECT category, SUM(CASE WHEN is_prorated THEN round(annual_amount_pkr * v_months / 12.0) ELSE annual_amount_pkr END) AS amount
    FROM kafalat_package_lines WHERE child_id = p_child_id AND academic_year = v_year
    GROUP BY category
  ) grouped;

  RETURN jsonb_build_object('lines', v_lines, 'total', v_total, 'academic_year', v_year, 'months_remaining', v_months);
END;
$function$;

create or replace function public.kafalat_child_payment_form_data(p_child_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE v_year varchar := kafalat_current_year(); v_tenant uuid := my_tenant_id();
BEGIN
  RETURN jsonb_build_object(
    'fee_items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'line_id', l.id, 'category', l.category, 'description', l.description,
        'budgeted', l.annual_amount_pkr,
        'paid_so_far', COALESCE((SELECT SUM(amount_pkr) FROM kafalat_fee_payments WHERE package_line_id = l.id), 0),
        'covered_until', (SELECT MAX(covers_until) FROM kafalat_fee_payments WHERE package_line_id = l.id)
      ) ORDER BY l.category)
      FROM kafalat_package_lines l
      WHERE l.child_id = p_child_id AND l.academic_year = v_year AND l.tenant_id = v_tenant
        AND l.category IN ('school_fee', 'books', 'stationery', 'medical', 'exam_fee', 'tuition', 'other')
    ), '[]'::jsonb),
    'disbursements_due', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', d.id, 'category', d.category, 'month', d.month, 'amount', d.amount_pkr
      ) ORDER BY d.category)
      FROM kafalat_disbursements d
      WHERE d.child_id = p_child_id AND d.status = 'scheduled' AND d.tenant_id = v_tenant
    ), '[]'::jsonb),
    'uniform_due', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', u.id, 'issue_no', u.issue_no, 'academic_year', u.academic_year, 'amount', u.amount_pkr
      ) ORDER BY u.issue_no)
      FROM kafalat_uniform_issues u
      WHERE u.child_id = p_child_id AND u.status = 'scheduled' AND u.tenant_id = v_tenant
    ), '[]'::jsonb)
  );
END;
$function$;

create or replace function public.kafalat_child_public_expense_summary(p_child_id uuid, p_academic_year character varying DEFAULT NULL::character varying)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  c kafalat_children%ROWTYPE; v_year varchar := COALESCE(p_academic_year, kafalat_current_year());
  v_lines jsonb; v_total decimal;
BEGIN
  SELECT * INTO c FROM kafalat_children WHERE id = p_child_id AND status = 'active' AND NOT do_not_display
    AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'paid_on'), '[]'::jsonb), COALESCE(SUM((x->>'amount')::decimal), 0)
    INTO v_lines, v_total
  FROM (
    SELECT jsonb_build_object('category', fp.category, 'amount', fp.amount_pkr, 'paid_on', fp.paid_on) AS x
    FROM kafalat_fee_payments fp
    WHERE fp.child_id = p_child_id AND fp.paid_on BETWEEN kafalat_year_starts(v_year) AND kafalat_year_ends(v_year)
    UNION ALL
    SELECT jsonb_build_object('category', 'uniform', 'amount', u.amount_pkr, 'paid_on', u.issued_on) AS x
    FROM kafalat_uniform_issues u
    WHERE u.child_id = p_child_id AND u.academic_year = v_year AND u.status = 'issued'
    UNION ALL
    SELECT jsonb_build_object('category', d.category, 'amount', d.amount_pkr, 'paid_on', d.paid_on) AS x
    FROM kafalat_disbursements d
    WHERE d.child_id = p_child_id AND d.status = 'paid'
      AND d.month BETWEEN kafalat_year_starts(v_year) AND kafalat_year_ends(v_year)
  ) rows;

  RETURN jsonb_build_object(
    'child_name', c.first_name, 'academic_year', v_year, 'lines', v_lines, 'total_spent', v_total,
    'this_year_requirement', kafalat_this_year_requirement(p_child_id, v_year)
  );
END;
$function$;

create or replace function public.kafalat_children_for_naming()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'code', c.code, 'first_name', c.first_name, 'first_name_ur', c.first_name_ur,
    'current_class', c.current_class, 'is_orphan', c.is_orphan,
    'photo_url', CASE WHEN c.photo_consent AND NOT c.do_not_display THEN c.photo_url ELSE NULL END,
    'this_year_requirement', kafalat_this_year_requirement(c.id, kafalat_current_year()),
    'already_named', COALESCE((
      SELECT SUM(p.amount_pkr) FROM pool_payments p
       WHERE p.kafalat_child_id = c.id AND p.status = 'confirmed'
         AND p.for_month >= date_trunc('year', (now() AT TIME ZONE 'Asia/Karachi')::date) - interval '9 months'
    ), 0)
  ) ORDER BY c.code), '[]'::jsonb)
  FROM kafalat_children c
  WHERE c.status = 'active' AND NOT c.do_not_display
    AND c.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
$function$;

create or replace function public.kafalat_default_package(p_child_id uuid, p_academic_year character varying)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  c kafalat_children%ROWTYPE;
  f jsonb;
  v_transport decimal;
BEGIN
  SELECT * INTO c FROM kafalat_children WHERE id = p_child_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RETURN; END IF;

  DELETE FROM kafalat_package_lines
   WHERE child_id = p_child_id AND academic_year = p_academic_year;

  IF c.school_id IS NOT NULL THEN
    f := school_fee_for_class(c.school_id, c.current_class);
  END IF;

  IF f IS NOT NULL THEN
    -- The school's own van if it runs one; otherwise the committee's standing
    -- figure for getting a child to Chakwal and back.
    v_transport := (f->>'transport_annual')::decimal;
    IF v_transport = 0 AND (f->>'location') = 'chakwal' THEN
      v_transport := setting_text('kafalat_transport_chakwal', '48000')::decimal;
    END IF;

    INSERT INTO kafalat_package_lines (child_id, academic_year, category, description, annual_amount_pkr) VALUES
      (p_child_id, p_academic_year, 'school_fee',
       (f->>'monthly_fee') || ' x ' || (f->>'months_charged') || ' months',
       (f->>'annual_fee')::decimal + (f->>'annual_charges')::decimal),
      (p_child_id, p_academic_year, 'uniform', NULL,
       COALESCE(NULLIF((f->>'uniform')::decimal, 0), setting_text('kafalat_default_uniform', '8000')::decimal)),
      (p_child_id, p_academic_year, 'books', NULL,
       COALESCE(NULLIF((f->>'books')::decimal, 0), setting_text('kafalat_default_books', '6000')::decimal)),
      (p_child_id, p_academic_year, 'transport', NULL, v_transport),
      (p_child_id, p_academic_year, 'pocket_money', NULL, setting_text('kafalat_default_pocket_money', '12000')::decimal),
      (p_child_id, p_academic_year, 'medical', NULL, setting_text('kafalat_default_medical', '4000')::decimal),
      (p_child_id, p_academic_year, 'exam_fee', NULL,
       COALESCE(NULLIF((f->>'exam_fee')::decimal, 0), setting_text('kafalat_default_exam_fee', '3000')::decimal));
    RETURN;
  END IF;

  -- No school on the register yet: fall back to the committee's defaults.
  v_transport := CASE c.school_location
    WHEN 'village' THEN setting_text('kafalat_transport_village', '0')::decimal
    ELSE setting_text('kafalat_transport_chakwal', '48000')::decimal
  END;

  INSERT INTO kafalat_package_lines (child_id, academic_year, category, annual_amount_pkr) VALUES
    (p_child_id, p_academic_year, 'school_fee',   setting_text('kafalat_default_school_fee', '24000')::decimal),
    (p_child_id, p_academic_year, 'uniform',      setting_text('kafalat_default_uniform', '8000')::decimal),
    (p_child_id, p_academic_year, 'books',        setting_text('kafalat_default_books', '6000')::decimal),
    (p_child_id, p_academic_year, 'transport',    v_transport),
    (p_child_id, p_academic_year, 'pocket_money', setting_text('kafalat_default_pocket_money', '12000')::decimal),
    (p_child_id, p_academic_year, 'medical',      setting_text('kafalat_default_medical', '4000')::decimal),
    (p_child_id, p_academic_year, 'exam_fee',     setting_text('kafalat_default_exam_fee', '3000')::decimal);
END;
$function$;

create or replace function public.kafalat_disbursement_queue()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT jsonb_build_object(
    'uniforms', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', u.id, 'child_code', c.code, 'child_name', c.first_name, 'guardian', c.guardian_name,
        'guardian_phone', c.guardian_phone, 'issue_no', u.issue_no, 'scheduled_on', u.scheduled_on,
        'amount', u.amount_pkr, 'uniform_mode', c.uniform_mode
      ) ORDER BY u.scheduled_on)
        FROM kafalat_uniform_issues u JOIN kafalat_children c ON c.id = u.child_id
       WHERE u.status = 'scheduled' AND u.scheduled_on <= (now() AT TIME ZONE 'Asia/Karachi')::date
         AND u.tenant_id = my_tenant_id()
    ), '[]'::jsonb),
    'disbursements', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', d.id, 'child_code', c.code, 'child_name', c.first_name, 'guardian', c.guardian_name,
        'guardian_phone', c.guardian_phone, 'category', d.category, 'month', d.month, 'amount', d.amount_pkr
      ) ORDER BY d.month, d.category)
        FROM kafalat_disbursements d JOIN kafalat_children c ON c.id = d.child_id
       WHERE d.status = 'scheduled' AND d.tenant_id = my_tenant_id()
    ), '[]'::jsonb)
  );
$function$;

create or replace function public.kafalat_end_child(p_child_id uuid, p_status character varying, p_reason text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE c kafalat_children%ROWTYPE; v_year varchar; v_req jsonb;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_status NOT IN ('graduated', 'withdrawn', 'left_village') THEN
    RAISE EXCEPTION 'Not a valid ending status.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM kafalat_children WHERE id = p_child_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Child not found' USING ERRCODE = 'P0001'; END IF;

  v_year := kafalat_current_year();
  IF c.status = 'active' THEN
    -- Undo whatever this year's requirement had added, then delete the
    -- current year's auto lines so a re-approval later starts clean.
    v_req := kafalat_generate_requirement(p_child_id, v_year);
    PERFORM kafalat_post_requirement_delta(v_year, -(v_req->>'this_year_requirement')::decimal,
      c.first_name || ' (' || c.code || ') — sponsorship ended: ' || p_status, p_child_id);
    DELETE FROM kafalat_package_lines WHERE child_id = p_child_id AND academic_year = v_year AND source = 'auto';
  END IF;

  UPDATE kafalat_children
     SET status = p_status, ended_on = (now() AT TIME ZONE 'Asia/Karachi')::date,
         ended_reason = p_reason, updated_at = now()
   WHERE id = p_child_id;

  RETURN jsonb_build_object('ok', true, 'status', p_status);
END;
$function$;

create or replace function public.kafalat_fee_queue()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'line_id', l.id, 'child_id', l.child_id, 'child_code', c.code, 'child_name', c.first_name,
    'guardian', c.guardian_name, 'guardian_phone', c.guardian_phone,
    'category', l.category, 'description', l.description, 'academic_year', l.academic_year,
    'budgeted', l.annual_amount_pkr,
    'paid_so_far', COALESCE((SELECT SUM(amount_pkr) FROM kafalat_fee_payments WHERE package_line_id = l.id), 0),
    'covered_until', (SELECT MAX(covers_until) FROM kafalat_fee_payments WHERE package_line_id = l.id)
  ) ORDER BY c.code, l.category), '[]'::jsonb)
  FROM kafalat_package_lines l JOIN kafalat_children c ON c.id = l.child_id
  WHERE l.category IN ('school_fee', 'books', 'stationery', 'medical', 'exam_fee', 'tuition', 'other')
    AND c.status = 'active' AND l.academic_year = kafalat_current_year()
    AND l.tenant_id = my_tenant_id();
$function$;

create or replace function public.kafalat_measuring_position(p_academic_year character varying DEFAULT NULL::character varying)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  v_year varchar; v_account uuid; v_required decimal; v_confirmed decimal;
  v_outstanding decimal; v_months int; v_monthly decimal; v_children int;
BEGIN
  v_year := COALESCE(p_academic_year, kafalat_current_year());
  v_account := ensure_kafalat_measuring_account(v_year);

  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0)
    INTO v_required, v_confirmed FROM ledger_entries WHERE account_id = v_account;
  v_outstanding := GREATEST(v_required - v_confirmed, 0);
  v_months := kafalat_months_remaining(v_year);
  v_monthly := round(v_outstanding / v_months);
  SELECT count(*) INTO v_children FROM kafalat_children
   WHERE status = 'active' AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

  RETURN jsonb_build_object(
    'academic_year', v_year, 'account_code', 'KFL-MEASURE-' || split_part(v_year,'-',1),
    'required', v_required, 'confirmed', v_confirmed, 'outstanding', v_outstanding,
    'months_remaining', v_months, 'monthly_target', v_monthly, 'children_active', v_children,
    'year_starts', kafalat_year_starts(v_year), 'year_ends', kafalat_year_ends(v_year)
  );
END;
$function$;

create or replace function public.kafalat_nominations_with_referrer()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', n.id, 'child_name', n.child_name, 'guardian_name', n.guardian_name,
    'approximate_age', n.approximate_age, 'gender', n.gender, 'address_hint', n.address_hint,
    'reason', n.reason, 'status', n.status, 'created_at', n.created_at,
    'referrer_name', COALESCE((SELECT full_name FROM portal_users WHERE id = n.nominated_by_portal_user_id), NULL),
    'referrer_phone', COALESCE(n.nominator_phone, (SELECT mobile FROM portal_users WHERE id = n.nominated_by_portal_user_id)),
    'child_id', n.child_id,
    'child_code', (SELECT code FROM kafalat_children WHERE id = n.child_id)
  ) ORDER BY n.created_at DESC), '[]'::jsonb)
  FROM kafalat_nominations n
  WHERE n.tenant_id = my_tenant_id();
$function$;

create or replace function public.kafalat_public_dashboard()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE v_meas jsonb; v_tenant uuid := coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
BEGIN
  v_meas := kafalat_measuring_position();
  RETURN jsonb_build_object(
    'children_active', (SELECT count(*) FROM kafalat_children WHERE status = 'active' AND NOT do_not_display AND tenant_id = v_tenant),
    'monthly_target', v_meas->>'monthly_target',
    'outstanding', v_meas->>'outstanding',
    'confirmed', v_meas->>'confirmed',
    'required', v_meas->>'required',
    'on_track', (COALESCE((v_meas->>'confirmed')::decimal, 0) >= COALESCE((v_meas->>'required')::decimal, 0) * 0.9)
  );
END;
$function$;

create or replace function public.kafalat_record_reverification(p_child_id uuid, p_home_visited character varying, p_household_matches character varying, p_household_note character varying, p_father_employment_changed boolean, p_father_employment_note character varying, p_siblings_employment_changed boolean, p_siblings_employment_note character varying, p_income_verified character varying, p_observed_monthly_income_pkr numeric, p_school_continuing character varying, p_current_class character varying, p_attendance_note character varying, p_co_verifier_names text[], p_recommendation character varying, p_recommended_note text, p_overall_note text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_year varchar; v_id uuid; v_verifiers int;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kafalat_children WHERE id = p_child_id AND tenant_id = my_tenant_id()) THEN
    RAISE EXCEPTION 'Child not found' USING ERRCODE = 'P0001';
  END IF;
  v_year := kafalat_current_year();

  INSERT INTO kafalat_reverifications (child_id, academic_year, admin_user_id, home_visited,
    household_matches, household_note, father_employment_changed, father_employment_note,
    siblings_employment_changed, siblings_employment_note, income_verified,
    observed_monthly_income_pkr, school_continuing, current_class, attendance_note,
    co_verifier_names, recommendation, recommended_note, overall_note)
  VALUES (p_child_id, v_year, current_admin_user_id(), p_home_visited, p_household_matches,
    p_household_note, p_father_employment_changed, p_father_employment_note,
    p_siblings_employment_changed, p_siblings_employment_note, p_income_verified,
    p_observed_monthly_income_pkr, p_school_continuing, p_current_class, p_attendance_note,
    p_co_verifier_names, p_recommendation, p_recommended_note, p_overall_note)
  ON CONFLICT (child_id, academic_year) DO UPDATE SET
    home_visited = EXCLUDED.home_visited, household_matches = EXCLUDED.household_matches,
    household_note = EXCLUDED.household_note,
    father_employment_changed = EXCLUDED.father_employment_changed,
    father_employment_note = EXCLUDED.father_employment_note,
    siblings_employment_changed = EXCLUDED.siblings_employment_changed,
    siblings_employment_note = EXCLUDED.siblings_employment_note,
    income_verified = EXCLUDED.income_verified,
    observed_monthly_income_pkr = EXCLUDED.observed_monthly_income_pkr,
    school_continuing = EXCLUDED.school_continuing, current_class = EXCLUDED.current_class,
    attendance_note = EXCLUDED.attendance_note, co_verifier_names = EXCLUDED.co_verifier_names,
    recommendation = EXCLUDED.recommendation, recommended_note = EXCLUDED.recommended_note,
    overall_note = EXCLUDED.overall_note
  RETURNING id INTO v_id;

  v_verifiers := kafalat_verifier_count(p_child_id, v_year);
  IF v_verifiers < 2 THEN
    RETURN jsonb_build_object('reverification_id', v_id, 'verifiers', v_verifiers,
      'note', 'Recorded, but a decision needs a second verifier''s name before it can be acted on.');
  END IF;

  -- Update the child's own class if the visit found it had moved on — the
  -- requirement calculation reads current_class directly.
  IF p_current_class IS NOT NULL THEN
    UPDATE kafalat_children SET current_class = p_current_class, updated_at = now() WHERE id = p_child_id;
  END IF;

  IF p_recommendation = 'graduate' THEN
    PERFORM kafalat_end_child(p_child_id, 'graduated', 'Past class 10 at re-verification — referred to Taleemi Wazifa.');
  ELSIF p_recommendation = 'end' THEN
    PERFORM kafalat_end_child(p_child_id, 'withdrawn', COALESCE(p_recommended_note, 'Ended at annual re-verification.'));
  ELSIF p_recommendation IN ('continue', 'adjust') THEN
    -- Re-run the rate card. 'adjust' matters when the committee has just
    -- hand-edited a package line to reflect what the visit found — this
    -- picks up the new figure rather than silently keeping last year's.
    PERFORM kafalat_generate_requirement(p_child_id, v_year);
  END IF;

  RETURN jsonb_build_object('reverification_id', v_id, 'verifiers', v_verifiers,
                            'recommendation', p_recommendation);
END;
$function$;

create or replace function public.kafalat_reverification_due()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'child_id', c.id, 'code', c.code, 'name', c.first_name, 'guardian', c.guardian_name,
    'guardian_phone', c.guardian_phone, 'current_class', c.current_class, 'joined_on', c.joined_on,
    'last_verified', (SELECT max(r.academic_year) FROM kafalat_reverifications r WHERE r.child_id = c.id)
  ) ORDER BY c.code), '[]'::jsonb)
  FROM kafalat_children c
  WHERE c.status = 'active' AND c.tenant_id = my_tenant_id()
    AND NOT EXISTS (SELECT 1 FROM kafalat_reverifications r
                     WHERE r.child_id = c.id AND r.academic_year = kafalat_current_year());
$function$;

create or replace function public.kafalat_reverification_sheet(p_child_id uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT jsonb_build_object(
    'child', (SELECT to_jsonb(c) FROM kafalat_children c WHERE c.id = p_child_id AND c.tenant_id = my_tenant_id()),
    'academic_year', kafalat_current_year(),
    'history', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'academic_year', r.academic_year, 'visited_on', r.visited_on,
        'verifier', (SELECT full_name FROM admin_users WHERE id = r.admin_user_id),
        'co_verifier_names', r.co_verifier_names,
        'household_matches', r.household_matches, 'household_note', r.household_note,
        'father_employment_changed', r.father_employment_changed,
        'father_employment_note', r.father_employment_note,
        'siblings_employment_changed', r.siblings_employment_changed,
        'siblings_employment_note', r.siblings_employment_note,
        'income_verified', r.income_verified, 'observed_monthly_income_pkr', r.observed_monthly_income_pkr,
        'school_continuing', r.school_continuing, 'current_class', r.current_class,
        'recommendation', r.recommendation, 'recommended_note', r.recommended_note,
        'overall_note', r.overall_note
      ) ORDER BY r.academic_year DESC)
        FROM kafalat_reverifications r WHERE r.child_id = p_child_id AND r.tenant_id = my_tenant_id()
    ), '[]'::jsonb)
  );
$function$;

create or replace function public.kafalat_schedule_uniforms(p_child_id uuid, p_academic_year character varying)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  c kafalat_children%ROWTYPE; v_amount decimal; v_start date;
BEGIN
  SELECT * INTO c FROM kafalat_children WHERE id = p_child_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(SUM(annual_amount_pkr), 0) / 2 INTO v_amount
    FROM kafalat_package_lines
   WHERE child_id = p_child_id AND academic_year = p_academic_year AND category = 'uniform';
  IF v_amount <= 0 THEN RETURN; END IF;

  v_start := GREATEST(COALESCE(c.joined_on, kafalat_year_starts(p_academic_year)),
                      kafalat_year_starts(p_academic_year));

  -- Regenerating must not lose a uniform that has already gone out — only the
  -- still-scheduled ones are replaced.
  DELETE FROM kafalat_uniform_issues
   WHERE child_id = p_child_id AND academic_year = p_academic_year AND status = 'scheduled';

  IF c.uniform_mode = 'both' THEN
    INSERT INTO kafalat_uniform_issues (child_id, academic_year, issue_no, scheduled_on, amount_pkr)
    VALUES (p_child_id, p_academic_year, 1, v_start, v_amount),
           (p_child_id, p_academic_year, 2, v_start, v_amount)
    ON CONFLICT (child_id, academic_year, issue_no) DO NOTHING;
  ELSE
    -- 'staggered' and 'cash' both run on the same six-month rhythm; 'cash'
    -- only changes how the second half of this function pays it out.
    INSERT INTO kafalat_uniform_issues (child_id, academic_year, issue_no, scheduled_on, amount_pkr)
    VALUES (p_child_id, p_academic_year, 1, v_start, v_amount),
           (p_child_id, p_academic_year, 2, (v_start + interval '6 months')::date, v_amount)
    ON CONFLICT (child_id, academic_year, issue_no) DO NOTHING;
  END IF;
END;
$function$;

create or replace function public.kafalat_skip_disbursement(p_disbursement_id uuid, p_reason text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  UPDATE kafalat_disbursements SET status = 'skipped', skipped_reason = p_reason
   WHERE id = p_disbursement_id AND status = 'scheduled' AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found or already resolved.' USING ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

create or replace function public.kafalat_skip_uniform(p_issue_id uuid, p_reason text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  UPDATE kafalat_uniform_issues SET status = 'skipped', skipped_reason = p_reason
   WHERE id = p_issue_id AND status = 'scheduled' AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found or already resolved.' USING ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

create or replace function public.kafalat_sponsor_breakdown()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_object_agg(child_id, sponsors), '{}'::jsonb)
  FROM (
    SELECT child_id, jsonb_agg(jsonb_build_object(
             'name', CASE WHEN is_anonymous THEN NULL ELSE donor_name END,
             'is_anonymous', is_anonymous, 'recurring', is_recurring, 'total_given', total_given
           ) ORDER BY total_given DESC) AS sponsors
    FROM (
      -- One row per distinct giver per child: a recurring giver groups by
      -- their commitment, a one-time giver with no commitment groups by
      -- whoever announced it, so the same person's several months collapse
      -- into one line instead of repeating.
      SELECT pp.kafalat_child_id AS child_id,
             COALESCE(pc.is_anonymous, false) AS is_anonymous,
             pc.id IS NOT NULL AS is_recurring,
             COALESCE(pc.donor_name, pu.full_name, 'Donor') AS donor_name,
             SUM(pp.amount_pkr) AS total_given
        FROM pool_payments pp
        LEFT JOIN pool_commitments pc ON pc.id = pp.commitment_id
        LEFT JOIN portal_users pu ON pu.id = pp.announced_by_portal_user_id
       WHERE pp.kafalat_child_id IS NOT NULL AND pp.status = 'confirmed'
         AND pp.for_month >= kafalat_year_starts(kafalat_current_year())
         AND pp.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
       GROUP BY pp.kafalat_child_id, pc.id, pc.is_anonymous, pc.donor_name, pu.full_name
    ) g
    GROUP BY child_id
  ) x;
$function$;

create or replace function public.kafalat_total_spent(p_academic_year character varying DEFAULT NULL::character varying)
 returns numeric
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE((
    SELECT SUM(amount_pkr) FROM kafalat_fee_payments
     WHERE paid_on BETWEEN kafalat_year_starts(COALESCE(p_academic_year, kafalat_current_year()))
                        AND kafalat_year_ends(COALESCE(p_academic_year, kafalat_current_year()))
       AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
  ), 0) + COALESCE((
    SELECT SUM(amount_pkr) FROM kafalat_uniform_issues
     WHERE status = 'issued' AND academic_year = COALESCE(p_academic_year, kafalat_current_year())
       AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
  ), 0) + COALESCE((
    SELECT SUM(amount_pkr) FROM kafalat_disbursements
     WHERE status = 'paid' AND month BETWEEN kafalat_year_starts(COALESCE(p_academic_year, kafalat_current_year()))
                                          AND kafalat_year_ends(COALESCE(p_academic_year, kafalat_current_year()))
       AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
  ), 0);
$function$;

create or replace function public.payment_batch_items(p_batch_id uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(item ORDER BY item->>'kind'), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('kind', 'donor', 'id', id, 'amount', amount_pkr,
      'label', 'General giving' || COALESCE(' — ' || notes, '')) AS item
    FROM donors WHERE payment_batch_id = p_batch_id AND payment_status = 'paid' AND NOT is_verified
      AND tenant_id = my_tenant_id()
    UNION ALL
    SELECT jsonb_build_object('kind', 'pool', 'id', p.id, 'amount', p.amount_pkr,
      'label', pl.name || COALESCE(
        (SELECT ' — ' || first_name FROM kafalat_children WHERE id = p.kafalat_child_id),
        (SELECT ' — ' || full_name FROM wazifa_students WHERE id = p.wazifa_student_id),
        (SELECT ' — ' || item_name FROM sadqa_objects WHERE id = p.sadqa_object_id), '')) AS item
    FROM pool_payments p JOIN support_pools pl ON pl.id = p.pool_id
    WHERE p.payment_batch_id = p_batch_id AND p.status = 'announced' AND p.tenant_id = my_tenant_id()
  ) x;
$function$;

create or replace function public.payment_batch_summary(p_batch_ids uuid[])
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_object_agg(batch_id, jsonb_build_object('count', cnt, 'total', total)), '{}'::jsonb)
  FROM (
    SELECT payment_batch_id AS batch_id, count(*) AS cnt, sum(amount_pkr) AS total
      FROM (
        SELECT payment_batch_id, amount_pkr FROM donors
         WHERE payment_batch_id = ANY(p_batch_ids) AND NOT is_verified AND tenant_id = my_tenant_id()
        UNION ALL
        SELECT payment_batch_id, amount_pkr FROM pool_payments
         WHERE payment_batch_id = ANY(p_batch_ids) AND status = 'announced' AND tenant_id = my_tenant_id()
      ) x
     GROUP BY payment_batch_id
  ) grouped;
$function$;

create or replace function public.pending_payment_batches()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'batch_id', batch_id, 'donor_name', donor_name, 'proof_url', proof_url,
    'method', method, 'total', total, 'count', cnt, 'earliest', earliest
  ) ORDER BY earliest DESC), '[]'::jsonb)
  FROM (
    SELECT payment_batch_id AS batch_id,
           (array_agg(donor_name ORDER BY at))[1] AS donor_name,
           (array_agg(proof_url ORDER BY at))[1] AS proof_url,
           (array_agg(method ORDER BY at))[1] AS method,
           sum(amount) AS total, count(*) AS cnt, min(at) AS earliest
    FROM (
      SELECT payment_batch_id, name AS donor_name, payment_proof_url AS proof_url,
             payment_method AS method, amount_pkr AS amount, created_at AS at
        FROM donors WHERE payment_batch_id IS NOT NULL AND payment_status = 'paid' AND NOT is_verified
          AND tenant_id = my_tenant_id()
      UNION ALL
      SELECT p.payment_batch_id,
             COALESCE((SELECT full_name FROM portal_users WHERE id = p.announced_by_portal_user_id),
                       (SELECT donor_name FROM pool_commitments WHERE id = p.commitment_id)),
             p.proof_url, p.method, p.amount_pkr, p.announced_at
        FROM pool_payments p WHERE p.payment_batch_id IS NOT NULL AND p.status = 'announced'
          AND p.tenant_id = my_tenant_id()
    ) rows
    GROUP BY payment_batch_id
  ) grouped
  WHERE cnt > 1;
$function$;
