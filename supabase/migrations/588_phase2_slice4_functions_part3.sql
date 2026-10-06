-- Phase 2, slice 4 (functions, part 3): pool admin/public functions, Sadqa
-- catalogue/admin functions, and public summary dashboards. Same bug
-- classes as migration 586's header explains.

create or replace function public.pool_alerts()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'donors_needed')::int DESC), '[]'::jsonb)
  FROM (SELECT pool_position(id) AS x FROM support_pools WHERE is_active AND tenant_id = my_tenant_id()) y
  WHERE (x->>'is_short')::boolean;
$function$;

create or replace function public.pool_announcement_queue()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', p.id, 'pool_id', pl.id, 'pool_code', pl.code, 'pool', pl.name, 'donor_name',
    COALESCE((SELECT full_name FROM portal_users WHERE id = p.announced_by_portal_user_id),
             (SELECT donor_name FROM pool_commitments WHERE id = p.commitment_id)),
    'donor_phone',
    COALESCE((SELECT mobile FROM portal_users WHERE id = p.announced_by_portal_user_id),
             (SELECT donor_phone FROM pool_commitments WHERE id = p.commitment_id)),
    'amount', p.amount_pkr, 'is_one_time', p.is_one_time, 'month', p.for_month,
    'proof_url', p.proof_url, 'announced_at', p.announced_at, 'payment_batch_id', p.payment_batch_id
  ) ORDER BY p.announced_at), '[]'::jsonb)
  FROM pool_payments p JOIN support_pools pl ON pl.id = p.pool_id
  WHERE p.status = 'announced' AND p.tenant_id = my_tenant_id();
$function$;

create or replace function public.pool_confirm_payment(p_payment_id uuid, p_method character varying DEFAULT NULL::character varying)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  p pool_payments%ROWTYPE; pl support_pools%ROWTYPE;
  c pool_commitments%ROWTYPE; v_donor_name varchar; v_donor_name_ur varchar; v_donor_phone varchar;
  v_anon boolean; v_portal_user_id uuid; v_posted jsonb;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO p FROM pool_payments WHERE id = p_payment_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF p.status <> 'announced' THEN
    RAISE EXCEPTION 'This is already %.', p.status USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO pl FROM support_pools WHERE id = p.pool_id;

  IF p.commitment_id IS NOT NULL THEN
    SELECT * INTO c FROM pool_commitments WHERE id = p.commitment_id;
    v_donor_name := c.donor_name; v_donor_name_ur := c.donor_name_ur; v_donor_phone := c.donor_phone;
    v_anon := c.is_anonymous; v_portal_user_id := c.portal_user_id;
  ELSE
    SELECT full_name, name_ur, mobile INTO v_donor_name, v_donor_name_ur, v_donor_phone
      FROM portal_users WHERE id = p.announced_by_portal_user_id;
    v_anon := false; v_portal_user_id := p.announced_by_portal_user_id;
  END IF;

  v_posted := pool_post_confirmed_payment(p.pool_id, p.commitment_id, v_donor_name, v_donor_name_ur,
    v_donor_phone, v_anon, p.amount_pkr, COALESCE(p_method, p.method, 'bank'), v_portal_user_id,
    p.for_month, NULL, p.kafalat_child_id, p.wazifa_student_id, p.sadqa_object_id);

  UPDATE pool_payments
     SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
         donor_id = (v_posted->>'donor_id')::uuid,
         method = COALESCE(p_method, method, 'bank')
   WHERE id = p_payment_id;

  RETURN jsonb_build_object('donor_id', v_posted->>'donor_id', 'amount', p.amount_pkr);
END;
$function$;

create or replace function public.pool_confirm_payment(p_payment_id uuid, p_method character varying DEFAULT NULL::character varying, p_confirmed_amount numeric DEFAULT NULL::numeric)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  p pool_payments%ROWTYPE; pl support_pools%ROWTYPE;
  c pool_commitments%ROWTYPE; v_donor_name varchar; v_donor_name_ur varchar; v_donor_phone varchar;
  v_anon boolean; v_portal_user_id uuid; v_posted jsonb; v_amount decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO p FROM pool_payments WHERE id = p_payment_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF p.status <> 'announced' THEN
    RAISE EXCEPTION 'This is already %.', p.status USING ERRCODE = 'P0001';
  END IF;
  IF p_confirmed_amount IS NOT NULL AND p_confirmed_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be more than zero.' USING ERRCODE = 'P0001';
  END IF;
  v_amount := COALESCE(p_confirmed_amount, p.amount_pkr);
  SELECT * INTO pl FROM support_pools WHERE id = p.pool_id;

  IF p.commitment_id IS NOT NULL THEN
    SELECT * INTO c FROM pool_commitments WHERE id = p.commitment_id;
    v_donor_name := c.donor_name; v_donor_name_ur := c.donor_name_ur; v_donor_phone := c.donor_phone;
    v_anon := c.is_anonymous; v_portal_user_id := c.portal_user_id;
  ELSE
    SELECT full_name, name_ur, mobile INTO v_donor_name, v_donor_name_ur, v_donor_phone
      FROM portal_users WHERE id = p.announced_by_portal_user_id;
    v_anon := false; v_portal_user_id := p.announced_by_portal_user_id;
  END IF;

  v_posted := pool_post_confirmed_payment(p.pool_id, p.commitment_id, v_donor_name, v_donor_name_ur,
    v_donor_phone, v_anon, v_amount, COALESCE(p_method, p.method, 'bank'), v_portal_user_id,
    p.for_month, NULL, p.kafalat_child_id, p.wazifa_student_id, p.sadqa_object_id);

  UPDATE pool_payments
     SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
         donor_id = (v_posted->>'donor_id')::uuid,
         method = COALESCE(p_method, method, 'bank'),
         amount_pkr = v_amount
   WHERE id = p_payment_id;

  RETURN jsonb_build_object('donor_id', v_posted->>'donor_id', 'amount', v_amount, 'announced_amount', p.announced_amount_pkr);
END;
$function$;

create or replace function public.pool_cover_shortfall(p_pool_month_id uuid, p_amount numeric DEFAULT NULL::numeric, p_note text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  m pool_months%ROWTYPE; p support_pools%ROWTYPE;
  v_amount decimal; v_remaining decimal; v_general uuid; v_fund uuid;
  v_voucher_id uuid; v_voucher_no varchar; v_available decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO m FROM pool_months WHERE id = p_pool_month_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO p FROM support_pools WHERE id = m.pool_id;

  IF m.month > date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date THEN
    RAISE EXCEPTION 'A future month cannot be covered in advance. Each month is settled on its own.'
      USING ERRCODE = 'P0001';
  END IF;

  v_remaining := m.shortfall_pkr - m.committee_covered_pkr;
  v_amount := COALESCE(p_amount, v_remaining);

  IF v_remaining <= 0 THEN
    RAISE EXCEPTION 'This month is already settled — there is nothing left to cover.'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Enter an amount greater than zero.' USING ERRCODE = 'P0001';
  END IF;
  IF v_amount > v_remaining THEN
    RAISE EXCEPTION 'The shortfall for % is Rs % — the committee cannot cover more than that.',
      to_char(m.month, 'Mon YYYY'),
      trim(to_char(v_remaining, 'FM999,999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  v_general := fund_account_id('general');
  v_fund := fund_account_id(p.fund_type);
  IF v_general IS NULL OR v_fund IS NULL THEN
    RAISE EXCEPTION 'The general or restricted fund account is missing.' USING ERRCODE = 'P0001';
  END IF;

  -- Refuse to promise money the committee does not have. Measured against cash
  -- and bank less what is already spoken for, not against a fund account that
  -- nothing ever credits.
  v_available := unrestricted_balance();
  IF v_amount > v_available THEN
    RAISE EXCEPTION
      'The committee has Rs % of unrestricted money — it cannot cover Rs %. Raise the money first, or cover part of it.',
      trim(to_char(v_available, 'FM999,999,999,990')),
      trim(to_char(v_amount, 'FM999,999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, pool_id, pool_month_id, fund_type, project_id)
  VALUES ('donors_projects', 'pool_shortfall_cover',
    (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Committee covering the ' || to_char(m.month, 'Mon YYYY') || ' shortfall for ' || p.name
      || ' — one month only, from committee funds, no donor attached'
      || COALESCE(' · ' || p_note, ''),
    v_amount, v_general, v_fund, 'Dhab Pari Committee', p.id, m.id, p.fund_type, p.project_id)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE pool_months
     SET committee_covered_pkr = committee_covered_pkr + v_amount,
         status = CASE WHEN committee_covered_pkr + v_amount >= shortfall_pkr
                       THEN 'covered_by_committee' ELSE 'short' END,
         covered_voucher_id = v_voucher_id, covered_at = now(),
         covered_by = current_admin_user_id(), cover_note = p_note,
         -- Cleared so the day-after appeal fires again for this cover.
         reappealed_at = NULL,
         closed_at = now()
   WHERE id = p_pool_month_id;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', v_amount,
                            'month', m.month, 'pool', p.name);
END;
$function$;

create or replace function public.pool_decline_announcement(p_payment_id uuid, p_reason text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  UPDATE pool_payments SET status = 'cancelled', cancelled_at = now(), note = COALESCE(note || ' · ', '') || p_reason
   WHERE id = p_payment_id AND status = 'announced' AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found or already resolved.' USING ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

create or replace function public.pool_position(p_pool_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  p support_pools%ROWTYPE;
  v_target decimal; v_committed decimal; v_donors int;
  v_month date; v_received decimal; v_announced decimal; v_reserve decimal; v_gap decimal;
  v_covered decimal;
BEGIN
  SELECT * INTO p FROM support_pools WHERE id = p_pool_id AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;
  v_target := pool_monthly_target(p_pool_id);

  SELECT COALESCE(SUM(monthly_amount_pkr), 0), count(*)
    INTO v_committed, v_donors
    FROM pool_commitments WHERE pool_id = p_pool_id AND status = 'active';

  -- Real money only. An announcement is a promise, not a receipt.
  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_received
    FROM pool_payments WHERE pool_id = p_pool_id AND for_month = v_month AND status = 'confirmed';

  -- Reported alongside it rather than folded in, so the accountant's own
  -- dashboard can see "5,000 announced, 0 confirmed" instead of one number
  -- that quietly means either.
  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_announced
    FROM pool_payments WHERE pool_id = p_pool_id AND for_month = v_month AND status = 'announced';

  SELECT COALESCE(SUM(committee_covered_pkr), 0) INTO v_covered
    FROM pool_months WHERE pool_id = p_pool_id AND month = v_month;

  -- The gap that matters for recruitment is measured against standing
  -- commitments, never against what happened to arrive this month. A month the
  -- committee paid for out of its own pocket is still a month with too few
  -- donors, and the ask has to keep saying so.
  v_gap := GREATEST(v_target - v_committed, 0);

  v_reserve := CASE WHEN v_target > 0 THEN fund_balance(p.fund_type) / v_target ELSE 0 END;

  RETURN jsonb_build_object(
    'pool_id', p.id, 'code', p.code, 'name', p.name, 'name_ur', p.name_ur, 'kind', p.kind,
    'fund_type', p.fund_type,
    'month', v_month,
    'required', v_target,
    'committed', v_committed,
    'received_this_month', v_received,
    'announced_this_month', v_announced,
    'committee_covered_this_month', v_covered,
    'donors', v_donors,
    'coverage_percent', CASE WHEN v_target > 0
                             THEN LEAST(round(v_committed / v_target * 100, 1), 100) ELSE 100 END,
    'gap', v_gap,
    -- What the next person is asked for, and how many more like them close it.
    'suggested_share', p.suggested_share_pkr,
    'min_share', p.min_share_pkr,
    'donors_needed', CASE WHEN v_gap > 0 THEN ceil(v_gap / GREATEST(p.suggested_share_pkr, 1))::int ELSE 0 END,
    -- Only a real figure once somebody is actually giving.
    'share_if_all_split', CASE WHEN v_donors > 0 AND v_target > 0
                               THEN round(v_target / v_donors) ELSE p.suggested_share_pkr END,
    'reserve_months', round(v_reserve, 1),
    'reserve_target_months', p.reserve_months,
    'is_short', v_gap > 0
  );
END;
$function$;

create or replace function public.pool_public_board(p_pool_id uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT jsonb_build_object(
    'position', pool_position(p_pool_id),
    'recent_paid', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', x.name, 'amount', x.amount_pkr, 'month', x.for_month)
                       ORDER BY x.confirmed_at DESC)
        FROM (
          SELECT COALESCE((SELECT full_name FROM portal_users WHERE id = p.announced_by_portal_user_id),
                          (SELECT donor_name FROM pool_commitments WHERE id = p.commitment_id)) AS name,
                 p.amount_pkr, p.for_month, p.confirmed_at
            FROM pool_payments p
           WHERE p.pool_id = p_pool_id AND p.status = 'confirmed' AND p.show_name_publicly
             AND p.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
           ORDER BY p.confirmed_at DESC LIMIT 50
        ) x
    ), '[]'::jsonb)
  );
$function$;

create or replace function public.pool_shortfall_queue()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT jsonb_build_object(
    'unrestricted_available', unrestricted_balance(),
    'months', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'pool_month_id', m.id, 'pool_id', p.id, 'pool_code', p.code, 'pool', p.name, 'pool_ur', p.name_ur,
        'month', m.month, 'required', m.required_pkr, 'received', m.received_pkr,
        'shortfall', m.shortfall_pkr, 'covered', m.committee_covered_pkr,
        'remaining', m.shortfall_pkr - m.committee_covered_pkr,
        'donors_active', m.donors_active, 'donors_needed', m.donors_needed,
        'status', m.status
      ) ORDER BY m.month DESC)
        FROM pool_months m JOIN support_pools p ON p.id = m.pool_id
       WHERE m.status = 'short' AND m.shortfall_pkr > m.committee_covered_pkr AND m.tenant_id = my_tenant_id()
    ), '[]'::jsonb),
    'lapsed', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'commitment_id', c.id, 'pool_id', p.id, 'pool_code', p.code, 'pool', p.name, 'name', c.donor_name,
        'phone', c.donor_phone, 'amount', c.monthly_amount_pkr, 'since', c.lapsed_at
      ) ORDER BY c.lapsed_at DESC)
        FROM pool_commitments c JOIN support_pools p ON p.id = c.pool_id
       WHERE c.status = 'lapsed' AND c.tenant_id = my_tenant_id()
    ), '[]'::jsonb),
    'covers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'month', m.month, 'pool_id', p.id, 'pool_code', p.code, 'pool', p.name, 'amount', m.committee_covered_pkr,
        'voucher_no', v.voucher_no, 'at', m.covered_at,
        'by', (SELECT full_name FROM admin_users WHERE id = m.covered_by)
      ) ORDER BY m.covered_at DESC)
        FROM pool_months m JOIN support_pools p ON p.id = m.pool_id
        LEFT JOIN vouchers v ON v.id = m.covered_voucher_id
       WHERE m.committee_covered_pkr > 0 AND m.tenant_id = my_tenant_id()
    ), '[]'::jsonb)
  );
$function$;

create or replace function public.pool_update(p_pool_id uuid, p_name character varying DEFAULT NULL::character varying, p_name_ur character varying DEFAULT NULL::character varying, p_suggested_share numeric DEFAULT NULL::numeric, p_min_share numeric DEFAULT NULL::numeric, p_reserve_months numeric DEFAULT NULL::numeric, p_manual_monthly_target numeric DEFAULT NULL::numeric, p_clear_manual_target boolean DEFAULT false, p_is_active boolean DEFAULT NULL::boolean, p_description text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE p support_pools%ROWTYPE;
BEGIN
  IF current_admin_role() NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO p FROM support_pools WHERE id = p_pool_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Pool not found' USING ERRCODE = 'P0001'; END IF;

  IF p_suggested_share IS NOT NULL AND p_suggested_share <= 0 THEN
    RAISE EXCEPTION 'The suggested share has to be more than zero.' USING ERRCODE = 'P0001';
  END IF;
  IF p_manual_monthly_target IS NOT NULL AND p_manual_monthly_target < 0 THEN
    RAISE EXCEPTION 'A monthly target cannot be negative.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE support_pools SET
    name = COALESCE(p_name, name),
    name_ur = COALESCE(p_name_ur, name_ur),
    suggested_share_pkr = COALESCE(p_suggested_share, suggested_share_pkr),
    min_share_pkr = COALESCE(p_min_share, min_share_pkr),
    reserve_months = COALESCE(p_reserve_months, reserve_months),
    manual_monthly_target_pkr = CASE WHEN p_clear_manual_target THEN NULL
                                     ELSE COALESCE(p_manual_monthly_target, manual_monthly_target_pkr) END,
    is_active = COALESCE(p_is_active, is_active),
    description = COALESCE(p_description, description),
    updated_at = now()
  WHERE id = p_pool_id;

  RETURN pool_position(p_pool_id);
END;
$function$;

create or replace function public.public_kafalat_summary()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT jsonb_build_object(
    'active_children', count(*) FILTER (WHERE status = 'active'),
    'fully_sponsored', count(*) FILTER (WHERE status = 'active' AND kafalat_committed_percent(id) >= 100),
    'partly_sponsored', count(*) FILTER (WHERE status = 'active'
                                          AND kafalat_committed_percent(id) > 0
                                          AND kafalat_committed_percent(id) < 100),
    'awaiting_sponsor', count(*) FILTER (WHERE status = 'active' AND kafalat_committed_percent(id) = 0),
    'graduated', count(*) FILTER (WHERE status = 'graduated'),
    'girls', count(*) FILTER (WHERE status = 'active' AND gender = 'female'),
    'boys', count(*) FILTER (WHERE status = 'active' AND gender = 'male'),
    'orphans', count(*) FILTER (WHERE status = 'active' AND is_orphan),
    'annual_need_pkr', COALESCE(SUM(kafalat_package_total(id, NULL::varchar)) FILTER (WHERE status = 'active'), 0)
  ) FROM kafalat_children WHERE tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
$function$;

create or replace function public.public_sadqa_board()
 returns TABLE(object_no character varying, item_name character varying, item_name_ur character varying, dedicated_to character varying, dedicated_to_ur character varying, relationship character varying, plaque_text character varying, plaque_text_ur character varying, donor_name character varying, donor_name_ur character varying, location character varying, installed_on date, status character varying, photo_url text, plaque_photo_url text)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT
    o.object_no, o.item_name, o.item_name_ur,
    o.dedicated_to, o.dedicated_to_ur, o.relationship,
    o.plaque_text, o.plaque_text_ur,
    -- The dedication is always shown; the donor's own name only if they
    -- want it. Many people give in a parent's name precisely so that the
    -- parent's name is the one that is read.
    CASE WHEN o.donor_is_anonymous THEN NULL ELSE o.donor_name END,
    CASE WHEN o.donor_is_anonymous THEN NULL ELSE o.donor_name_ur END,
    o.approved_location, o.installed_on, o.status,
    o.installed_photo_url, o.plaque_photo_url
  FROM sadqa_objects o
  WHERE o.status IN ('installed', 'in_service', 'needs_repair', 'retired')
    AND o.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
  ORDER BY o.installed_on DESC NULLS LAST, o.created_at DESC;
$function$;

create or replace function public.public_wazifa_summary()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT jsonb_build_object(
    'students_supported', (SELECT count(*) FROM wazifa_students WHERE status IN ('awarded', 'studying') AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)),
    'graduated', (SELECT count(*) FROM wazifa_students WHERE status = 'graduated' AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)),
    'girls', (SELECT count(*) FROM wazifa_students WHERE status IN ('awarded', 'studying') AND gender = 'female' AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)),
    'boys', (SELECT count(*) FROM wazifa_students WHERE status IN ('awarded', 'studying') AND gender = 'male' AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)),
    'applications_open', (SELECT count(*) FROM wazifa_applications WHERE status IN ('submitted', 'screening', 'verified', 'interview') AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)),
    'awarded_this_year', (SELECT COALESCE(SUM(awarded_amount_pkr), 0) FROM wazifa_awards
                           WHERE created_at >= date_trunc('year', now()) AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)),
    'by_level', (SELECT COALESCE(jsonb_object_agg(level, c), '{}'::jsonb) FROM
                  (SELECT a.level, count(*) c FROM wazifa_applications a
                    JOIN wazifa_awards w ON w.application_id = a.id
                   WHERE w.status = 'active' AND a.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
                   GROUP BY a.level) x)
  );
$function$;

create or replace function public.sadqa_catalogue_retire(p_id uuid, p_retire boolean DEFAULT true)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF current_admin_role() NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  UPDATE sadqa_catalogue SET is_active = NOT p_retire WHERE id = p_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

create or replace function public.sadqa_catalogue_update(p_id uuid, p_name character varying DEFAULT NULL::character varying, p_name_ur character varying DEFAULT NULL::character varying, p_capital_cost numeric DEFAULT NULL::numeric, p_annual_running_cost numeric DEFAULT NULL::numeric, p_expected_life_years integer DEFAULT NULL::integer, p_description text DEFAULT NULL::text, p_description_ur text DEFAULT NULL::text, p_image_url text DEFAULT NULL::text, p_display_order integer DEFAULT NULL::integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF current_admin_role() NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_capital_cost IS NOT NULL AND p_capital_cost < 0 THEN
    RAISE EXCEPTION 'Cost cannot be negative.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE sadqa_catalogue SET
    name = COALESCE(p_name, name), name_ur = COALESCE(p_name_ur, name_ur),
    capital_cost_pkr = COALESCE(p_capital_cost, capital_cost_pkr),
    annual_running_cost_pkr = COALESCE(p_annual_running_cost, annual_running_cost_pkr),
    expected_life_years = COALESCE(p_expected_life_years, expected_life_years),
    description = COALESCE(p_description, description),
    description_ur = COALESCE(p_description_ur, description_ur),
    image_url = COALESCE(p_image_url, image_url),
    display_order = COALESCE(p_display_order, display_order)
  WHERE id = p_id AND tenant_id = my_tenant_id();

  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

create or replace function public.sadqa_maintenance_liability()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT jsonb_build_object(
    'committee_annual', COALESCE(SUM(annual_running_cost_pkr) FILTER (
       WHERE maintenance_mode = 'committee' AND status IN ('in_service', 'needs_repair', 'installed')), 0),
    'donor_annual', COALESCE(SUM(annual_running_cost_pkr) FILTER (
       WHERE maintenance_mode = 'donor' AND status IN ('in_service', 'needs_repair', 'installed')), 0),
    'endowed_annual', COALESCE(SUM(annual_running_cost_pkr) FILTER (
       WHERE maintenance_mode = 'endowed' AND status IN ('in_service', 'needs_repair', 'installed')), 0),
    'endowment_held', COALESCE(SUM(endowment_pkr) FILTER (WHERE status <> 'retired'), 0),
    'live_objects', count(*) FILTER (WHERE status IN ('in_service', 'needs_repair', 'installed')),
    'spent_last_12m', COALESCE((SELECT SUM(cost_pkr) FROM sadqa_maintenance_log
                                 WHERE event_date >= current_date - interval '12 months'
                                   AND tenant_id = my_tenant_id()), 0)
  ) FROM sadqa_objects WHERE tenant_id = my_tenant_id();
$function$;

create or replace function public.sadqa_object_link_donation(p_object_id uuid, p_donor_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE d donors%ROWTYPE;
BEGIN
  SELECT * INTO d FROM donors WHERE id = p_donor_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Donation not found' USING ERRCODE = 'P0001'; END IF;
  IF d.fund_type IN ('zakat', 'ushr') THEN
    RAISE EXCEPTION
      'Zakat cannot fund an Esal-e-Sawab object. Zakat must pass into the ownership of a poor person; an object the committee holds does not qualify.'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE sadqa_objects
     SET amount_received_pkr = amount_received_pkr + d.amount_pkr,
         status = CASE WHEN status = 'approved' THEN 'funded' ELSE status END,
         updated_at = now()
   WHERE id = p_object_id AND tenant_id = my_tenant_id();
END;
$function$;

create or replace function public.sadqa_objects_for_naming()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', o.id, 'object_no', o.object_no, 'item_name', o.item_name, 'item_name_ur', o.item_name_ur,
    'dedicated_to', o.dedicated_to, 'monthly_cost', sadqa_monthly_cost(o.id),
    'already_named', COALESCE((
      SELECT SUM(p.amount_pkr) FROM pool_payments p
       WHERE p.sadqa_object_id = o.id AND p.status = 'confirmed'
         AND p.for_month = date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date
    ), 0)
  ) ORDER BY o.object_no), '[]'::jsonb)
  FROM sadqa_objects o
 WHERE o.maintenance_mode = 'committee' AND o.status IN ('installed', 'in_service', 'needs_repair')
   AND o.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
$function$;

create or replace function public.sadqa_pay_upkeep(p_charge_id uuid, p_method character varying, p_proof_url text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE c sadqa_upkeep_charges%ROWTYPE; o sadqa_objects%ROWTYPE; v_donor_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM sadqa_upkeep_charges WHERE id = p_charge_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF c.status <> 'announced' THEN
    RAISE EXCEPTION 'This charge is already %.', c.status USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO o FROM sadqa_objects WHERE id = c.object_id;

  INSERT INTO donors (name, name_ur, phone, amount_pkr, date, is_verified, payment_method,
                      is_anonymous, fund_type, portal_user_id, payment_status,
                      payment_proof_url, notes, submitted_via)
  VALUES (o.donor_name, o.donor_name_ur, o.donor_phone, c.amount_pkr,
          (now() AT TIME ZONE 'Asia/Karachi')::date, true, p_method,
          o.donor_is_anonymous, 'esal_e_sawab', o.portal_user_id, 'paid', p_proof_url,
          'Sadqa-e-Jariya upkeep — ' || o.item_name || ' (' || o.object_no || ') · '
            || to_char(c.month, 'Mon YYYY') || COALESCE(' · ' || p_note, ''),
          'staff')
  RETURNING id INTO v_donor_id;

  -- Same label as every other line on their statement.
  UPDATE ledger_entries
     SET particular = 'Sadqa-e-Jariya upkeep — ' || o.item_name || ' (' || o.object_no || ') · '
                      || to_char(c.month, 'Mon YYYY')
   WHERE reference_type = 'donation' AND reference_id = v_donor_id;

  UPDATE sadqa_upkeep_charges
     SET status = 'paid', paid_on = (now() AT TIME ZONE 'Asia/Karachi')::date, donor_id = v_donor_id
   WHERE id = p_charge_id;

  RETURN jsonb_build_object('paid', c.amount_pkr, 'month', c.month, 'donor_id', v_donor_id);
END;
$function$;

create or replace function public.sadqa_propose_bill(p_object_id uuid, p_vendor character varying, p_amount numeric, p_bill_no character varying DEFAULT NULL::character varying, p_bill_date date DEFAULT NULL::date, p_invoice_url text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE o sadqa_objects%ROWTYPE; v_id uuid; v_diff decimal; v_msg text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO o FROM sadqa_objects WHERE id = p_object_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF o.settled_at IS NOT NULL THEN
    RAISE EXCEPTION 'This object has already been settled.' USING ERRCODE = 'P0001';
  END IF;

  -- An earlier offer stops being live the moment a new one is made.
  UPDATE sadqa_bills SET status = 'superseded'
   WHERE object_id = p_object_id AND status = 'proposed';

  INSERT INTO sadqa_bills (object_id, vendor_name, bill_no, bill_date, amount_pkr,
                           invoice_url, note, proposed_by)
  VALUES (p_object_id, p_vendor, p_bill_no, p_bill_date, p_amount, p_invoice_url, p_note,
          current_admin_user_id())
  RETURNING id INTO v_id;

  v_diff := p_amount - o.capital_cost_pkr;
  v_msg := 'Bill from ' || p_vendor || ': Rs ' || trim(to_char(p_amount, 'FM999,999,990')) || '. '
    || CASE
         WHEN v_diff > 0 THEN 'That is Rs ' || trim(to_char(v_diff, 'FM999,999,990'))
              || ' more than the estimate, so that much will show as due on your account.'
         WHEN v_diff < 0 THEN 'That is Rs ' || trim(to_char(-v_diff, 'FM999,999,990'))
              || ' less than the estimate, so that much stays to your credit.'
         ELSE 'Exactly the estimate.' END;

  PERFORM sadqa_system_message(p_object_id, v_msg, v_id);
  RETURN jsonb_build_object('bill_id', v_id, 'amount', p_amount, 'difference', v_diff);
END;
$function$;

create or replace function public.sadqa_publish_upkeep_pool(p_object_id uuid, p_share_pkr numeric DEFAULT 500)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE o sadqa_objects%ROWTYPE; v_pool uuid;
BEGIN
  IF current_admin_role() NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO o FROM sadqa_objects WHERE id = p_object_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF o.maintenance_mode <> 'committee' THEN
    RAISE EXCEPTION 'Only an object the committee has taken on can be shared out this way.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_pool FROM support_pools WHERE code = 'POOL-SDQ' AND tenant_id = my_tenant_id();
  UPDATE sadqa_objects SET maintenance_pool_id = v_pool, updated_at = now() WHERE id = p_object_id;
  RETURN jsonb_build_object('pool_id', v_pool, 'monthly', sadqa_monthly_cost(p_object_id));
END;
$function$;

create or replace function public.sadqa_record_receipt(p_object_id uuid, p_amount numeric, p_method character varying, p_proof_url text DEFAULT NULL::text, p_cash_witness character varying DEFAULT NULL::character varying, p_received_on date DEFAULT NULL::date, p_note text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  o sadqa_objects%ROWTYPE; v_donor_id uuid; v_account_id uuid; v_total decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO o FROM sadqa_objects WHERE id = p_object_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF o.status IN ('proposed', 'declined') THEN
    RAISE EXCEPTION 'Approve this offer before recording money against it.' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Enter the amount actually received.' USING ERRCODE = 'P0001';
  END IF;
  IF p_proof_url IS NULL AND NOT (p_method = 'cash' AND COALESCE(trim(p_cash_witness), '') <> '') THEN
    RAISE EXCEPTION
      'Attach the transfer screenshot or slip. For cash handed over in person, name the person who witnessed it.'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO donors (name, name_ur, phone, amount_pkr, date, is_verified, payment_method,
                      is_anonymous, fund_type, portal_user_id, payment_status,
                      payment_proof_url, notes, submitted_via)
  VALUES (o.donor_name, o.donor_name_ur, o.donor_phone, p_amount,
          COALESCE(p_received_on, (now() AT TIME ZONE 'Asia/Karachi')::date), true, p_method,
          o.donor_is_anonymous, 'esal_e_sawab', o.portal_user_id, 'paid', p_proof_url,
          'Sadqa-e-Jariya — ' || o.item_name || ' (' || o.object_no || ')'
            || COALESCE(' · ' || p_note, ''),
          'staff')
  RETURNING id INTO v_donor_id;

  INSERT INTO sadqa_receipts (object_id, amount_pkr, method, received_on, proof_url,
                              cash_witness, donor_id, note, recorded_by)
  VALUES (p_object_id, p_amount, p_method,
          COALESCE(p_received_on, (now() AT TIME ZONE 'Asia/Karachi')::date),
          p_proof_url, p_cash_witness, v_donor_id, p_note, current_admin_user_id());

  -- The generic donation trigger labels every restricted gift "Donation
  -- (ESAL_E_SAWAB)", which tells the donor nothing about which object it was
  -- for. Their statement should name the thing they paid for, in the same
  -- words as the settlement line that follows it.
  UPDATE ledger_entries
     SET particular = 'Sadqa-e-Jariya — ' || o.item_name || ' (' || o.object_no || ') · received'
   WHERE reference_type = 'donation' AND reference_id = v_donor_id;

  v_account_id := ensure_donor_account(o.donor_name, o.donor_phone);
  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_total FROM sadqa_receipts WHERE object_id = p_object_id;

  UPDATE sadqa_objects
     SET amount_received_pkr = v_total,
         donor_account_id = COALESCE(donor_account_id, v_account_id),
         -- Only the money changes the status, and only once enough of it has
         -- arrived to buy the thing.
         status = CASE WHEN status = 'approved' AND v_total >= capital_cost_pkr
                       THEN 'funded' ELSE status END,
         updated_at = now()
   WHERE id = p_object_id;

  PERFORM sadqa_system_message(p_object_id,
    'Received Rs ' || trim(to_char(p_amount, 'FM999,999,990')) || ' — thank you.');

  RETURN jsonb_build_object('received', p_amount, 'total_received', v_total,
                            'donor_id', v_donor_id, 'donor_account_id', v_account_id);
END;
$function$;

create or replace function public.sadqa_upkeep_total_required()
 returns numeric
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(SUM(sadqa_monthly_cost(id)), 0)
    FROM sadqa_objects
   WHERE maintenance_mode = 'committee' AND status IN ('installed', 'in_service', 'needs_repair')
     AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
$function$;
