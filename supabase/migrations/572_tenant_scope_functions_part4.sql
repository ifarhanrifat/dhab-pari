-- Phase 1, final function pass: broad scans and aggregate reports — no
-- per-row id from the caller, so each gets the tenant filter added
-- directly to its WHERE/FROM clause. Same reasoning throughout as 569-571.

create or replace function public.academy_trainer_candidates()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(can_access_system('donors_projects'), false) AND COALESCE(current_admin_permission('manage_parties'), false)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', au.id, 'full_name', au.full_name, 'assigned_training_program_ids', au.assigned_training_program_ids
  ) ORDER BY au.full_name), '[]'::jsonb) INTO v_result
  FROM admin_users au WHERE au.is_active = true AND au.tenant_id = my_tenant_id();

  RETURN v_result;
END;
$function$;

create or replace function public.academy_trainers_public()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'project_id', pid,
    'trainer_name', au.full_name,
    'trainer_bio', au.trainer_bio,
    'trainer_bio_ur', au.trainer_bio_ur,
    'trainer_photo_url', au.trainer_photo_url
  )), '[]'::jsonb)
  FROM admin_users au, unnest(au.assigned_training_program_ids) AS pid
  WHERE au.is_active = true AND au.can_collect_payments = true
    AND au.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
    AND au.assigned_training_program_ids IS NOT NULL
    AND (au.trainer_bio IS NOT NULL OR au.trainer_bio_ur IS NOT NULL OR au.trainer_photo_url IS NOT NULL);
$function$;

create or replace function public.check_donor_duplicate(p_name character varying, p_father_husband_name character varying, p_whatsapp_number character varying, p_phone character varying)
 returns text
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  v_name varchar := lower(trim(p_name));
  v_father varchar := lower(trim(COALESCE(p_father_husband_name, '')));
  v_whatsapp varchar := lower(trim(COALESCE(p_whatsapp_number, '')));
  v_phone varchar := lower(trim(COALESCE(p_phone, '')));
  v_tenant uuid := coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
  r RECORD;
BEGIN
  FOR r IN SELECT name, phone, whatsapp_number, father_husband_name FROM donors WHERE tenant_id = v_tenant LOOP
    IF v_phone <> '' AND lower(trim(r.phone)) = v_phone THEN
      RETURN 'A donor with this phone number is already registered (' || r.name || ').';
    END IF;
    IF v_whatsapp <> '' AND lower(trim(r.whatsapp_number)) = v_whatsapp THEN
      RETURN 'A donor with this WhatsApp number is already registered (' || r.name || ').';
    END IF;
    IF v_name <> '' AND v_father <> '' AND lower(trim(r.name)) = v_name AND lower(trim(r.father_husband_name)) = v_father THEN
      RETURN 'A donor named "' || p_name || '" son/daughter of "' || p_father_husband_name || '" is already registered. If this is genuinely a different person, adjust the name slightly.';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$function$;

create or replace function public.admin_search_donor_accounts(p_query character varying)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'full_name', full_name, 'mobile', mobile,
    'father_husband_name', father_husband_name, 'whatsapp_number', whatsapp_number,
    'has_login', auth_user_id IS NOT NULL
  ) ORDER BY full_name), '[]'::jsonb)
  FROM portal_users
  WHERE is_active AND tenant_id = my_tenant_id()
    AND (full_name ILIKE '%' || p_query || '%' OR mobile ILIKE '%' || p_query || '%')
  LIMIT 15;
$function$;

create or replace function public.admin_search_portal_users(p_query character varying)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(can_access_system('water_supply'), false) OR COALESCE(can_access_system('donors_projects'), false)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF length(trim(p_query)) < 3 THEN RETURN '[]'::jsonb; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'full_name', full_name, 'mobile', mobile, 'whatsapp_number', whatsapp_number,
    'consumer_id', consumer_id
  ) ORDER BY full_name), '[]'::jsonb) INTO v_result
  FROM portal_users
  WHERE is_active AND tenant_id = my_tenant_id()
    AND (full_name ILIKE '%' || p_query || '%' OR mobile ILIKE '%' || p_query || '%' OR whatsapp_number ILIKE '%' || p_query || '%')
  LIMIT 15;

  RETURN v_result;
END;
$function$;

create or replace function public.admin_portal_users_with_trust(p_query text default null::text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE v_result jsonb;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', pu.id, 'full_name', pu.full_name, 'mobile', pu.mobile,
    'cnic_verified', pu.cnic_verified, 'phone_verified', pu.phone_verified, 'is_village_resident', pu.is_village_resident,
    'trust', portal_user_trust(pu.id)
  )), '[]'::jsonb) INTO v_result
  FROM (
    SELECT * FROM portal_users pu
    WHERE pu.tenant_id = my_tenant_id()
      AND (p_query IS NULL OR trim(p_query) = '' OR pu.full_name ILIKE '%' || p_query || '%' OR pu.mobile ILIKE '%' || p_query || '%')
    ORDER BY pu.full_name LIMIT 100
  ) pu;
  RETURN v_result;
END;
$function$;

create or replace function public.get_approvers_roster(p_system character varying)
 returns table(id uuid, full_name character varying)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT id, full_name FROM admin_users au
  WHERE is_active = true AND tenant_id = my_tenant_id() AND can_access_system(p_system) AND admin_user_can_access_system(au.id, p_system);
$function$;

create or replace function public.get_consumer_advance_balances()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE v_result jsonb;
BEGIN
  IF NOT COALESCE(can_access_system('water_supply'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_object_agg(t.consumer_id, t.advance), '{}'::jsonb) INTO v_result
  FROM (
    SELECT
      a.consumer_id,
      -(a.opening_balance + COALESCE(SUM(le.debit), 0) - COALESCE(SUM(le.credit), 0)) AS advance
    FROM accounts a
    LEFT JOIN ledger_entries le ON le.account_id = a.id
    WHERE a.type = 'consumer' AND a.consumer_id IS NOT NULL AND a.tenant_id = my_tenant_id()
    GROUP BY a.id, a.consumer_id, a.opening_balance
    HAVING (a.opening_balance + COALESCE(SUM(le.debit), 0) - COALESCE(SUM(le.credit), 0)) < 0
  ) t;

  RETURN v_result;
END;
$function$;

create or replace function public.get_field_collectors()
 returns table(id uuid, full_name character varying, mobile character varying, assigned_sectors text[])
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT id, full_name, mobile, assigned_sectors FROM admin_users
  WHERE can_collect_payments = true AND is_active = true AND tenant_id = my_tenant_id() AND can_access_system('water_supply');
$function$;

create or replace function public.get_field_collectors_by_system(p_system character varying)
 returns table(id uuid, full_name character varying, mobile character varying, assigned_sectors text[])
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT id, full_name, mobile, assigned_sectors FROM admin_users
  WHERE can_collect_payments = true AND is_active = true AND tenant_id = my_tenant_id() AND can_access_system(p_system);
$function$;

create or replace function public.get_water_supply_notify_targets()
 returns table(id uuid, full_name character varying, mobile character varying)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT id, full_name, mobile FROM admin_users
  WHERE is_active = true AND tenant_id = my_tenant_id() AND can_access_system('water_supply') AND (
    role IN ('super_admin', 'admin', 'water_accountant')
    OR (role = 'accountant' AND access_water_supply)
  );
$function$;

create or replace function public.list_incharge_candidates()
 returns table(id uuid, full_name character varying)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT a.id, a.full_name FROM admin_users a
  WHERE a.is_active = true AND a.tenant_id = my_tenant_id() AND (a.role = 'viewer' OR a.secondary_role = 'viewer')
    AND can_access_system('water_supply')
  ORDER BY a.full_name;
$function$;

create or replace function public.fund_movement_report(p_from date default null::date, p_to date default null::date)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'fund'), '[]'::jsonb) FROM (
    SELECT jsonb_build_object(
      'fund', a.fund_type,
      'account', a.code,
      'name', a.name,
      'name_ur', a.name_ur,
      'opening', COALESCE((SELECT SUM(l.credit - l.debit) FROM ledger_entries l
                            WHERE l.account_id = a.id
                              AND (p_from IS NULL OR l.entry_date < p_from)), 0),
      'received', COALESCE((SELECT SUM(l.credit) FROM ledger_entries l
                             WHERE l.account_id = a.id
                               AND (p_from IS NULL OR l.entry_date >= p_from)
                               AND (p_to IS NULL OR l.entry_date <= p_to)), 0),
      'spent', COALESCE((SELECT SUM(l.debit) FROM ledger_entries l
                          WHERE l.account_id = a.id
                            AND (p_from IS NULL OR l.entry_date >= p_from)
                            AND (p_to IS NULL OR l.entry_date <= p_to)), 0),
      'closing', COALESCE((SELECT SUM(l.credit - l.debit) FROM ledger_entries l
                            WHERE l.account_id = a.id
                              AND (p_to IS NULL OR l.entry_date <= p_to)), 0)
    ) AS x
    FROM accounts a
    WHERE a.system = 'donors_projects' AND a.type = 'restricted_fund' AND a.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
  ) y;
$function$;

create or replace function public.match_donor_account_by_phone(p_phone character varying)
 returns table(account_id uuid, donor_account_no character varying, name character varying, name_ur character varying, total_contributed numeric, already_claimed boolean)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  v_core text := phone_core_digits(p_phone);
BEGIN
  IF v_core = '' OR length(v_core) < 7 THEN RETURN; END IF;

  RETURN QUERY
  SELECT a.id, a.donor_account_no, a.name, a.name_ur,
    COALESCE((SELECT SUM(le.credit) - SUM(le.debit) FROM ledger_entries le WHERE le.account_id = a.id), 0)::numeric,
    EXISTS (SELECT 1 FROM portal_users pu WHERE pu.donor_account_id = a.id AND pu.auth_user_id IS NOT NULL)
  FROM accounts a
  WHERE a.system = 'donors_projects' AND a.type = 'donor'
    AND a.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
    AND phone_core_digits(a.donor_key) = v_core
  ORDER BY (a.donor_account_no IS NOT NULL) DESC
  LIMIT 1;
END;
$function$;

create or replace function public.appeal_audience_users(p_audience character varying, p_countries text[])
 returns table(portal_user_id uuid)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT u.id
    FROM portal_users u
   WHERE u.is_active = true
     AND u.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
     AND CASE p_audience
       WHEN 'everyone'  THEN true
       WHEN 'consumers' THEN u.consumer_id IS NOT NULL
       WHEN 'donors'    THEN u.donor_account_id IS NOT NULL
       WHEN 'villagers' THEN COALESCE(u.donor_type, 'villager') = 'villager'
       WHEN 'overseas'  THEN u.donor_type = 'overseas'
                             AND (cardinality(COALESCE(p_countries, '{}')) = 0
                                  OR u.country = ANY (COALESCE(p_countries, '{}')))
       ELSE false
     END;
$function$;

-- Reports/aggregates that read ledger_entries/accounts/donors broadly.
create or replace function public.trial_balance(p_system character varying, p_to date default null::date)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT jsonb_build_object(
    'as_at', COALESCE(p_to, (now() AT TIME ZONE 'Asia/Karachi')::date),
    'total_debits', COALESCE(SUM(l.debit), 0),
    'total_credits', COALESCE(SUM(l.credit), 0),
    'difference', COALESCE(SUM(l.debit) - SUM(l.credit), 0),
    'balanced', COALESCE(ABS(SUM(l.debit) - SUM(l.credit)) < 0.01, true),
    'accounts', (SELECT COALESCE(jsonb_agg(x ORDER BY x->>'code'), '[]'::jsonb) FROM (
        SELECT jsonb_build_object(
          'code', a2.code, 'name', a2.name, 'type', a2.type,
          'debit', SUM(l2.debit), 'credit', SUM(l2.credit),
          'balance', SUM(l2.debit) - SUM(l2.credit)
        ) AS x
        FROM ledger_entries l2 JOIN accounts a2 ON a2.id = l2.account_id
        WHERE a2.system = p_system AND NOT l2.is_memo AND a2.tenant_id = my_tenant_id()
          AND (p_to IS NULL OR l2.entry_date <= p_to)
        GROUP BY a2.code, a2.name, a2.type
        HAVING SUM(l2.debit) + SUM(l2.credit) > 0
      ) y)
  )
  FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
  WHERE a.system = p_system AND NOT l.is_memo AND a.tenant_id = my_tenant_id()
    AND (p_to IS NULL OR l.entry_date <= p_to);
$function$;

create or replace function public.unrestricted_balance()
 returns numeric
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE((
    SELECT SUM(l.debit - l.credit) FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
     WHERE a.system = 'donors_projects' AND a.type IN ('cash', 'bank') AND a.tenant_id = my_tenant_id()
  ), 0) - COALESCE((
    SELECT SUM(l.credit - l.debit) FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
     WHERE a.system = 'donors_projects' AND a.type = 'restricted_fund' AND a.fund_type <> 'general' AND a.tenant_id = my_tenant_id()
  ), 0);
$function$;

create or replace function public.donor_receipt_totals(p_donor_id uuid)
 returns table(total_contributed numeric, announced_remaining numeric, is_confirmed boolean)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  v_key varchar;
  v_confirmed boolean;
  v_account_key varchar;
  v_tenant uuid := coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
BEGIN
  IF NOT can_access_system('donors_projects') THEN
    RAISE EXCEPTION 'Not authorized to read donor totals';
  END IF;

  SELECT donor_key_for(d.name, d.phone), d.is_verified
    INTO v_key, v_confirmed
  FROM donors d WHERE d.id = p_donor_id AND d.tenant_id = v_tenant;

  IF v_key IS NULL THEN
    RETURN QUERY SELECT 0::numeric, 0::numeric, false;
    RETURN;
  END IF;

  SELECT a.donor_key INTO v_account_key
  FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
  WHERE le.reference_type = 'donation' AND le.reference_id = p_donor_id AND a.type = 'donor'
  LIMIT 1;

  v_key := COALESCE(v_account_key, v_key);

  RETURN QUERY
  SELECT
    COALESCE(SUM(d.amount_pkr) FILTER (WHERE d.is_verified), 0)::numeric,
    COALESCE(SUM(d.amount_pkr) FILTER (WHERE NOT d.is_verified AND d.payment_status = 'pledged'), 0)::numeric,
    COALESCE(v_confirmed, false)
  FROM donors d
  WHERE d.tenant_id = v_tenant
    AND COALESCE(
    (SELECT a2.donor_key FROM ledger_entries le2 JOIN accounts a2 ON a2.id = le2.account_id
     WHERE le2.reference_type = 'donation' AND le2.reference_id = d.id AND a2.type = 'donor'
     LIMIT 1),
    donor_key_for(d.name, d.phone)
  ) = v_key;
END;
$function$;

create or replace function public.donor_badge_tier(p_portal_user_id uuid)
 returns character varying
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  v_manual varchar;
  v_account_id uuid;
  v_total decimal;
  v_t1 decimal; v_t2 decimal; v_t3 decimal; v_t4 decimal;
  v_tenant uuid := coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
BEGIN
  SELECT manual_badge_tier, donor_account_id INTO v_manual, v_account_id
  FROM portal_users WHERE id = p_portal_user_id AND tenant_id = v_tenant;
  IF v_manual IS NOT NULL THEN RETURN v_manual; END IF;
  IF v_account_id IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(credit) - SUM(debit), 0) INTO v_total FROM ledger_entries WHERE account_id = v_account_id;

  SELECT value::decimal INTO v_t1 FROM site_settings WHERE tenant_id = v_tenant AND key = 'badge_tier1_amount';
  SELECT value::decimal INTO v_t2 FROM site_settings WHERE tenant_id = v_tenant AND key = 'badge_tier2_amount';
  SELECT value::decimal INTO v_t3 FROM site_settings WHERE tenant_id = v_tenant AND key = 'badge_tier3_amount';
  SELECT value::decimal INTO v_t4 FROM site_settings WHERE tenant_id = v_tenant AND key = 'badge_tier4_amount';

  RETURN CASE
    WHEN v_total >= COALESCE(v_t4, 1000000) THEN 'ocean'
    WHEN v_total >= COALESCE(v_t3, 500000) THEN 'river'
    WHEN v_total >= COALESCE(v_t2, 150000) THEN 'stream'
    WHEN v_total >= COALESCE(v_t1, 25000) THEN 'spring'
    ELSE NULL
  END;
END;
$function$;

create or replace function public.project_donation_channels_pkr(p_project_id uuid)
 returns table(payment_method character varying, total_pkr numeric)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT d.payment_method, SUM(d.amount_pkr)
  FROM donors d
  WHERE d.project_id = p_project_id AND d.is_verified = true AND d.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
  GROUP BY d.payment_method;
$function$;

create or replace function public.project_monthly_sponsorship_pkr(p_project_id uuid)
 returns numeric
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(SUM(amount_pkr), 0) FROM recurring_schedules
  WHERE project_id = p_project_id AND is_active = true AND schedule_type = 'donation' AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
$function$;

create or replace function public.talent_showcase_raised(p_id uuid)
 returns numeric
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(SUM(amount_pkr), 0) FROM donors WHERE talent_showcase_id = p_id AND is_verified = true AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
$function$;

create or replace function public.wazifa_disbursed(p_award_id uuid)
 returns numeric
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(SUM(amount_pkr), 0) FROM vouchers
   WHERE wazifa_award_id = p_award_id
     AND voucher_type = 'wazifa_payment'
     AND reverses_voucher_id IS NULL
     AND reversed_by_voucher_id IS NULL
     AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
$function$;
