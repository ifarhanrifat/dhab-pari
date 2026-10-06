-- Phase 1, function pass 2/2: everything else from the 113-function
-- review that needs a change. Four more groups, same reasoning as 569's
-- header throughout — SECURITY DEFINER bypasses RLS, so each of these had
-- to be checked and fixed individually rather than trusting the table
-- policies to cover them.
--
-- Deliberately NOT touched, and why: any function keyed purely by
-- auth.uid() (current_admin_*, current_portal_user_id, can_access_system,
-- my_language's own admin/portal branches, set_my_language,
-- ack_publisher_guidelines, request_mentor_status, portal_confirm_donor_link,
-- submit_pledge_payment) already can't cross tenants — it only ever
-- matches the caller's own row. Functions keyed by consumer_id
-- (ensure_consumer_account, admin_link_portal_account,
-- admin_unlink_portal_account, admin_portal_user_for_consumer,
-- public_bill_lookup, set_consumer_contact_number) are safe as written —
-- consumer_id is deliberately still globally unique (see migration 566's
-- own note on why re-keying it was deferred to phase 2), so a lookup by
-- consumer_id can only ever match one real row regardless of tenant.

-- Group A: site_settings is keyed (tenant_id, key) as of migration 566 —
-- a bare `WHERE key = 'x'` now returns MULTIPLE rows once a second tenant
-- has the same setting, which breaks these outright (not just a security
-- gap — "more than one row returned by a subquery" is a hard error).
create or replace function public.period_is_locked(p_date date)
 returns boolean
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  v_enabled boolean;
  v_grace int;
  v_today date;
  v_cutoff date;
  v_tenant uuid := coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
BEGIN
  SELECT COALESCE((SELECT value FROM site_settings WHERE tenant_id = v_tenant AND key = 'period_lock_enabled'), 'true') = 'true'
    INTO v_enabled;
  IF NOT v_enabled OR p_date IS NULL THEN RETURN false; END IF;

  SELECT COALESCE((SELECT value FROM site_settings WHERE tenant_id = v_tenant AND key = 'period_lock_grace_days'), '10')::int
    INTO v_grace;

  v_today := (now() AT TIME ZONE 'Asia/Karachi')::date;

  v_cutoff := date_trunc('month', v_today)::date;
  IF EXTRACT(DAY FROM v_today)::int <= v_grace THEN
    v_cutoff := (date_trunc('month', v_today) - interval '1 month')::date;
  END IF;

  RETURN p_date < v_cutoff;
END;
$function$;

create or replace function public.committee_contact_number()
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(
    nullif(trim((SELECT value FROM site_settings WHERE tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND key = 'whatsapp_number')), ''),
    nullif(trim((SELECT value FROM site_settings WHERE tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND key = 'footer_whatsapp_chat')), '')
  );
$function$;

create or replace function public.setting_text(p_key character varying, p_fallback text default ''::text)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(nullif(trim((SELECT value FROM site_settings WHERE tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND key = p_key)), ''), p_fallback);
$function$;

create or replace function public.my_language()
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(
    (SELECT preferred_language FROM admin_users
      WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1),
    (SELECT preferred_language FROM portal_users
      WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1),
    (SELECT value FROM site_settings WHERE tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND key = 'display_language'),
    'en'
  );
$function$;

-- Group B: audit trail — these fire on DELETE/UPDATE of a row that
-- already carries the correct tenant_id (OLD/NEW), which is more robust
-- here than my_tenant_id() regardless (an audit entry for a row a cron
-- job or service-role script touched should still be tagged with that
-- row's own tenant, not whoever's — or nobody's — session happened to be
-- active).
create or replace function public.trg_audit_capture_account()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  INSERT INTO audit_log (table_name, record_id, action, record_data, system, summary, actor_id, actor_name, tenant_id)
  VALUES ('accounts', OLD.id, 'delete', to_jsonb(OLD), OLD.system, 'Account ' || OLD.code || ' — ' || OLD.name, current_admin_user_id(), current_admin_name(), OLD.tenant_id);
  RETURN OLD;
END;
$function$;

create or replace function public.trg_audit_capture_bill()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_payment_count int;
  v_consumer_name varchar;
BEGIN
  SELECT count(*) INTO v_payment_count FROM payments WHERE bill_id = OLD.id;
  IF v_payment_count > 0 THEN
    RAISE EXCEPTION 'Cannot delete Bill #% — % payment(s) are recorded against it. Delete the payment(s) first.', OLD.bill_number, v_payment_count;
  END IF;

  SELECT name INTO v_consumer_name FROM consumers WHERE consumer_id = OLD.consumer_id;

  INSERT INTO audit_log (table_name, record_id, action, record_data, related_data, system, summary, actor_id, actor_name, tenant_id)
  VALUES (
    'bills', OLD.id, 'delete', to_jsonb(OLD),
    jsonb_build_object('ledger_entries', (SELECT jsonb_agg(to_jsonb(le)) FROM ledger_entries le WHERE le.reference_type = 'bill' AND le.reference_id = OLD.id)),
    'water_supply',
    'Bill #' || OLD.bill_number || ' — ' || COALESCE(v_consumer_name, OLD.consumer_id) || ' — Rs. ' || OLD.amount_pkr || ' (' || to_char(make_date(OLD.year, OLD.month, 1), 'FMMonth YYYY') || ')',
    current_admin_user_id(), current_admin_name(), OLD.tenant_id
  );
  RETURN OLD;
END;
$function$;

create or replace function public.trg_audit_capture_consumer()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  INSERT INTO audit_log (table_name, record_id, action, record_data, system, summary, actor_id, actor_name, tenant_id)
  VALUES ('consumers', gen_random_uuid(), 'delete', to_jsonb(OLD), 'water_supply', 'Consumer ' || OLD.consumer_id || ' — ' || OLD.name, current_admin_user_id(), current_admin_name(), OLD.tenant_id);
  RETURN OLD;
END;
$function$;

create or replace function public.trg_audit_capture_donor()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  INSERT INTO audit_log (table_name, record_id, action, record_data, related_data, system, summary, actor_id, actor_name, tenant_id)
  VALUES (
    'donors', OLD.id, 'delete', to_jsonb(OLD),
    jsonb_build_object('ledger_entries', (SELECT jsonb_agg(to_jsonb(le)) FROM ledger_entries le WHERE le.reference_type = 'donation' AND le.reference_id = OLD.id)),
    'donors_projects',
    'Donation — ' || OLD.name || ' — Rs. ' || OLD.amount_pkr || ' (' || to_char(OLD.date, 'DD Mon YYYY') || ')',
    current_admin_user_id(), current_admin_name(), OLD.tenant_id
  );
  RETURN OLD;
END;
$function$;

create or replace function public.trg_audit_capture_payment()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  INSERT INTO audit_log (table_name, record_id, action, record_data, related_data, system, summary, actor_id, actor_name, tenant_id)
  VALUES (
    'payments', OLD.id, 'delete', to_jsonb(OLD),
    jsonb_build_object('ledger_entries', (SELECT jsonb_agg(to_jsonb(le)) FROM ledger_entries le WHERE le.reference_type = 'payment' AND le.reference_id = OLD.id)),
    'water_supply',
    'Payment — Rs. ' || OLD.amount_pkr || ' (' || OLD.method || ') — receipt ' || COALESCE(OLD.receipt_no, '—'),
    current_admin_user_id(), current_admin_name(), OLD.tenant_id
  );
  RETURN OLD;
END;
$function$;

create or replace function public.trg_audit_capture_voucher()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  INSERT INTO audit_log (table_name, record_id, action, record_data, related_data, system, summary, actor_id, actor_name, tenant_id)
  VALUES (
    'vouchers', OLD.id, 'delete', to_jsonb(OLD),
    jsonb_build_object(
      'ledger_entries', (SELECT jsonb_agg(to_jsonb(le)) FROM ledger_entries le WHERE le.reference_type = 'voucher' AND le.reference_id = OLD.id),
      'voucher_approvals', (SELECT jsonb_agg(to_jsonb(va)) FROM voucher_approvals va WHERE va.voucher_id = OLD.id)
    ),
    OLD.system,
    'Voucher ' || COALESCE(OLD.voucher_no, '(unposted)') || ' — ' || OLD.particular || ' — Rs. ' || OLD.amount_pkr,
    current_admin_user_id(), current_admin_name(), OLD.tenant_id
  );
  RETURN OLD;
END;
$function$;

create or replace function public.trg_audit_log_change()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_action varchar := lower(TG_OP);
  v_system varchar;
  v_summary text;
  v_consumer_name varchar;
  v_record_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'bills' THEN
    v_record_id := NEW.id;
    v_system := 'water_supply';
    SELECT name INTO v_consumer_name FROM consumers WHERE consumer_id = NEW.consumer_id;
    v_summary := 'Bill #' || NEW.bill_number || ' — ' || COALESCE(v_consumer_name, NEW.consumer_id) || ' — Rs. ' || NEW.amount_pkr;
  ELSIF TG_TABLE_NAME = 'payments' THEN
    v_record_id := NEW.id;
    v_system := 'water_supply';
    v_summary := 'Payment — Rs. ' || NEW.amount_pkr || ' (' || NEW.method || ')';
  ELSIF TG_TABLE_NAME = 'donors' THEN
    v_record_id := NEW.id;
    v_system := 'donors_projects';
    v_summary := 'Donation — ' || NEW.name || ' — Rs. ' || NEW.amount_pkr;
  ELSIF TG_TABLE_NAME = 'vouchers' THEN
    v_record_id := NEW.id;
    v_system := NEW.system;
    v_summary := 'Voucher ' || COALESCE(NEW.voucher_no, '(unposted)') || ' — ' || NEW.particular || ' — Rs. ' || NEW.amount_pkr;
  ELSIF TG_TABLE_NAME = 'accounts' THEN
    v_record_id := NEW.id;
    v_system := NEW.system;
    v_summary := 'Account ' || NEW.code || ' — ' || NEW.name;
  ELSIF TG_TABLE_NAME = 'consumers' THEN
    v_record_id := gen_random_uuid();
    v_system := 'water_supply';
    v_summary := 'Consumer ' || NEW.consumer_id || ' — ' || NEW.name;
  END IF;

  INSERT INTO audit_log (table_name, record_id, action, record_data, old_data, system, summary, actor_id, actor_name, tenant_id)
  VALUES (
    TG_TABLE_NAME, v_record_id, v_action, to_jsonb(NEW),
    CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END,
    v_system, v_summary, current_admin_user_id(), current_admin_name(), NEW.tenant_id
  );
  RETURN NEW;
END;
$function$;

-- Group C: measuring accounts (Kafalat/Wazifa requirement registers) and
-- the functions that post against them — these only touch the phase-1
-- `accounts`/`ledger_entries` tables (which is why they were in the pure
-- phase-1 list despite the Kafalat/Wazifa naming), and the code lookup
-- needs the same tenant filter as any other chart-of-accounts lookup.
create or replace function public.ensure_kafalat_measuring_account(p_academic_year character varying)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_id uuid; v_code varchar; v_tenant uuid := coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
BEGIN
  v_code := 'KFL-MEASURE-' || split_part(p_academic_year, '-', 1);
  SELECT id INTO v_id FROM accounts WHERE tenant_id = v_tenant AND code = v_code AND system = 'donors_projects';
  IF v_id IS NULL THEN
    INSERT INTO accounts (code, name, name_ur, type, system, fund_type, description, is_protected, tenant_id)
    VALUES (v_code, 'Mushtarka Kafalat — Measuring ' || p_academic_year,
            'مشترکہ کفالت — پیمائش ' || p_academic_year,
            'restricted_fund', 'donors_projects', NULL,
            'What every registered child needs for ' || p_academic_year
              || ', against what has been confirmed so far. A requirement register, '
              || 'not a fund — it holds no money and never appears in a trial balance.',
            true, v_tenant)
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$function$;

create or replace function public.ensure_wazifa_measuring_account(p_academic_year character varying)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_id uuid; v_code varchar; v_tenant uuid := coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
BEGIN
  v_code := 'WZF-MEASURE-' || split_part(p_academic_year, '-', 1);
  SELECT id INTO v_id FROM accounts WHERE tenant_id = v_tenant AND code = v_code AND system = 'donors_projects';
  IF v_id IS NULL THEN
    INSERT INTO accounts (code, name, name_ur, type, system, fund_type, description, is_protected, tenant_id)
    VALUES (v_code, 'Mushtarka Taleemi Wazifa — Measuring ' || p_academic_year,
            'مشترکہ تعلیمی وظیفہ — پیمائش ' || p_academic_year,
            'restricted_fund', 'donors_projects', NULL,
            'What every awarded Wazifa student needs for ' || p_academic_year
              || ', against what has been confirmed so far. A requirement register, '
              || 'not a fund — it holds no money and never appears in a trial balance.',
            true, v_tenant)
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$function$;

create or replace function public.kafalat_post_requirement_delta(p_academic_year character varying, p_delta numeric, p_particular text, p_child_id uuid default null::uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_account uuid; v_child_account uuid; v_tenant uuid := coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
BEGIN
  IF p_delta = 0 THEN RETURN; END IF;
  v_account := ensure_kafalat_measuring_account(p_academic_year);

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, tenant_id)
  VALUES (v_account, (now() AT TIME ZONE 'Asia/Karachi')::date, p_particular,
          GREATEST(p_delta, 0), GREATEST(-p_delta, 0), v_tenant);

  IF p_child_id IS NOT NULL THEN
    SELECT id INTO v_child_account FROM accounts WHERE kafalat_child_id = p_child_id AND tenant_id = v_tenant;
    IF v_child_account IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, tenant_id)
      VALUES (v_child_account, (now() AT TIME ZONE 'Asia/Karachi')::date, p_particular,
              GREATEST(p_delta, 0), GREATEST(-p_delta, 0), v_tenant);
    END IF;
  END IF;
END;
$function$;

create or replace function public.wazifa_post_requirement_delta(p_academic_year character varying, p_delta numeric, p_particular text, p_student_id uuid default null::uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_account uuid; v_student_account uuid; v_tenant uuid := coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
BEGIN
  IF p_delta = 0 THEN RETURN; END IF;
  v_account := ensure_wazifa_measuring_account(p_academic_year);

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, tenant_id)
  VALUES (v_account, (now() AT TIME ZONE 'Asia/Karachi')::date, p_particular,
          GREATEST(p_delta, 0), GREATEST(-p_delta, 0), v_tenant);

  IF p_student_id IS NOT NULL THEN
    SELECT id INTO v_student_account FROM accounts WHERE wazifa_student_id = p_student_id AND tenant_id = v_tenant;
    IF v_student_account IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, tenant_id)
      VALUES (v_student_account, (now() AT TIME ZONE 'Asia/Karachi')::date, p_particular,
              GREATEST(p_delta, 0), GREATEST(-p_delta, 0), v_tenant);
    END IF;
  END IF;
END;
$function$;
