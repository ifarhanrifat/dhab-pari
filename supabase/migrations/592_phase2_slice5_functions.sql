-- Phase 2, slice 5 (functions, part 1): cron jobs and business-key
-- (notification_preferences/accounts/site_settings) lookups that were
-- deferred from slices 2-4 because they touched portal_notifications or
-- notifications. Every function below is reproduced from its real,
-- current body (pulled live via pg_get_functiondef) with only the minimal
-- tenant-scoping fix applied -- no other logic changed.
--
-- Cron jobs with real bugs:
--   pool_daily_appeal: blasted every tenant's portal_users about one
--     tenant's specific pool shortfall. Fixed to carry p.tenant_id through
--     the loop and filter both the "already appealed" check and the
--     portal_users notify-all by it.
--   post_shop_lumpsum_charges / post_vehicle_lumpsum_charges: fetched the
--     DP-4050 commission account ONCE outside the per-shop/vehicle loop
--     with no tenant filter -- every tenant's lumpsum voucher would have
--     credited whichever one tenant's account that lookup happened to
--     match. Fixed by moving the lookup inside the loop, scoped to each
--     row's own tenant, and adding tenant_id to the charges insert (same
--     no-auth-context DEFAULT bug as every other cron job this phase).
--   sweep_due_shadi_advances: same "account fetched once outside the loop"
--     bug -- fixed by selecting the vehicle's own tenant_id in the cursor
--     and looking up DP-5004 per-row.
--   run_complaint_daily_reminders / run_nonpayment_flag_sweep: both read
--     notification_preferences ONCE outside their loop -- now a
--     correctness bug, not just a leak, since notification_preferences is
--     keyed (tenant_id, event_type): a bare `WHERE event_type = ...`
--     throws "more than one row returned by a subquery" the moment a
--     second tenant sets the same key. Fixed by moving the check inside
--     the loop, keyed by each row's own tenant_id.
--   shop_product_expiry_reminders: notified every admin across every
--     tenant about one tenant's expiring product -- fixed with a tenant
--     filter on both the product loop and the admin loop.
--   wazifa_disbursement_run / wazifa_installment_run / sadqa_upkeep_run:
--     inserted charge rows without an explicit tenant_id, relying on the
--     auth-context DEFAULT (NULL under cron) -- same bug class fixed for
--     kafalat_disbursement_run etc. in migration 586.
--   run_reminder_sweep: the most extensive instance -- five
--     message_templates/site_settings reads as bare globals (same
--     "more than one row" bug as above) and five scans of
--     bills/consumers/recurring_schedules/donors/wazifa_students with no
--     tenant filter at all, writing into reminder_queue with no tenant_id.
--     Restructured to loop over every active tenant and run the whole
--     sweep once per tenant, with every lookup and insert scoped to it.
--
-- Business-key lookups with no tenant filter inside directly-callable
-- functions: mark_complaint_resolved, reopen_complaint -- fixed using the
-- already-loaded complaint's own tenant_id.
--
-- Row-level triggers with the same notification_preferences bug:
-- trg_complaint_after_insert_notify, trg_complaint_assigned_log,
-- trg_connection_request_incharge_notify, trg_payment_collector_notify,
-- trg_suggestion_notify_staff -- all fixed using NEW.tenant_id.
--
-- broadcast_portal_notification (admin RPC, not a trigger) sent to every
-- portal_user across every tenant -- fixed with a tenant filter.

create or replace function public.pool_daily_appeal()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  r record; v_sent int := 0; v_total int := 0; v_pools int := 0; v_today date;
  v_body text; v_title text;
BEGIN
  v_today := (now() AT TIME ZONE 'Asia/Karachi')::date;

  FOR r IN
    SELECT p.id, p.name, p.name_ur, p.tenant_id,
           -- The most recent cover still awaiting its day-after appeal.
           (SELECT m.id FROM pool_months m
             WHERE m.pool_id = p.id AND m.covered_at IS NOT NULL
               AND m.reappealed_at IS NULL
               AND (m.covered_at AT TIME ZONE 'Asia/Karachi')::date < v_today
             ORDER BY m.covered_at DESC LIMIT 1) AS cover_month_id
      FROM support_pools p
     WHERE p.is_active
       AND (pool_position(p.id)->>'is_short')::boolean
  LOOP
    -- Either the day after a cover, or the periodic reminder — never both, and
    -- never more than once every four weeks otherwise.
    IF r.cover_month_id IS NULL
       AND EXISTS (SELECT 1 FROM portal_notifications
                    WHERE event_type = 'pool_appeal'
                      AND link LIKE '%' || r.id::text || '%'
                      AND tenant_id = r.tenant_id
                      AND created_at > now() - interval '28 days') THEN
      CONTINUE;
    END IF;

    v_title := CASE WHEN r.cover_month_id IS NOT NULL
                    THEN 'The committee covered last month — we still need you'
                    ELSE 'Still short: ' || r.name END;

    v_body := COALESCE(pool_appeal_text(r.id, true), '') || E'\n\n'
           || COALESCE(pool_appeal_text(r.id, false), '')
           || CASE WHEN r.cover_month_id IS NOT NULL
                   THEN E'\n\nLast month''s gap was paid out of the committee''s own funds so that no child was stopped. That was a one-off for that month alone and cannot be repeated.'
                   ELSE '' END;

    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
    SELECT pu.id, 'pool_appeal', v_title, v_body, '/portal/support?pool=' || r.id::text, r.tenant_id
      FROM portal_users pu WHERE pu.is_active AND pu.tenant_id = r.tenant_id;
    GET DIAGNOSTICS v_sent = ROW_COUNT;
    v_total := v_total + v_sent;

    IF r.cover_month_id IS NOT NULL THEN
      UPDATE pool_months SET reappealed_at = now() WHERE id = r.cover_month_id;
    END IF;
    v_pools := v_pools + 1;
  END LOOP;

  RETURN jsonb_build_object('pools_appealed', v_pools, 'notifications_sent', v_total);
END;
$function$;

create or replace function public.post_shop_lumpsum_charges()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  r RECORD;
  v_commission_account uuid;
  v_shop_account uuid;
  v_period varchar := to_char((now() AT TIME ZONE 'Asia/Karachi')::date, 'YYYY-MM');
  v_voucher_id uuid;
BEGIN
  FOR r IN
    SELECT * FROM shops WHERE commission_mode = 'monthly_lumpsum' AND COALESCE(lumpsum_fee_pkr, 0) > 0 AND status = 'active'
  LOOP
    IF EXISTS (SELECT 1 FROM shop_lumpsum_charges WHERE shop_id = r.id AND period = v_period) THEN
      CONTINUE; -- already charged this period (re-run safety)
    END IF;

    SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050' AND tenant_id = r.tenant_id;
    v_shop_account := ensure_shop_account(r.id);
    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
    VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
      'Monthly marketplace subscription — ' || r.name || ' (' || v_period || ')', r.lumpsum_fee_pkr, v_commission_account, v_shop_account, r.name)
    RETURNING id INTO v_voucher_id;

    INSERT INTO shop_lumpsum_charges (shop_id, period, amount_pkr, voucher_id, tenant_id) VALUES (r.id, v_period, r.lumpsum_fee_pkr, v_voucher_id, r.tenant_id);

    IF r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
      VALUES (r.portal_user_id, 'shop_lumpsum_charged', 'Monthly fee charged',
        'This month''s marketplace subscription fee has been charged to your account.', '/portal/my-shop/reports', r.tenant_id);
    END IF;
  END LOOP;
END;
$function$;

create or replace function public.post_vehicle_lumpsum_charges()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  r RECORD;
  v_commission_account uuid;
  v_vehicle_account uuid;
  v_period varchar := to_char((now() AT TIME ZONE 'Asia/Karachi')::date, 'YYYY-MM');
  v_voucher_id uuid;
BEGIN
  FOR r IN
    SELECT * FROM vehicles WHERE commission_mode = 'monthly_lumpsum' AND COALESCE(lumpsum_fee_pkr, 0) > 0 AND is_active = true
  LOOP
    IF EXISTS (SELECT 1 FROM vehicle_lumpsum_charges WHERE vehicle_id = r.id AND period = v_period) THEN CONTINUE; END IF;

    SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050' AND tenant_id = r.tenant_id;
    v_vehicle_account := ensure_vehicle_account(r.id);
    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
    VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
      'Monthly marketplace subscription — ' || r.owner_name || ' (' || v_period || ')', r.lumpsum_fee_pkr, v_commission_account, v_vehicle_account, r.owner_name)
    RETURNING id INTO v_voucher_id;

    INSERT INTO vehicle_lumpsum_charges (vehicle_id, period, amount_pkr, voucher_id, tenant_id) VALUES (r.id, v_period, r.lumpsum_fee_pkr, v_voucher_id, r.tenant_id);

    IF r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
      VALUES (r.portal_user_id, 'shop_lumpsum_charged', 'Monthly fee charged',
        'This month''s marketplace subscription fee has been charged to your account.', '/portal/my-vehicle', r.tenant_id);
    END IF;
  END LOOP;
END;
$function$;

create or replace function public.sweep_due_shadi_advances()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_liability_account uuid;
  r RECORD;
  v_vehicle_account uuid;
  v_voucher_id uuid;
  v_count int := 0;
BEGIN
  FOR r IN
    SELECT sr.id AS request_id, sr.vehicle_id, sr.advance_share_pkr, se.event_date, v.owner_name, v.portal_user_id, v.tenant_id
    FROM shadi_vehicle_requests sr
    JOIN shadi_events se ON se.id = sr.event_id
    JOIN vehicles v ON v.id = sr.vehicle_id
    WHERE sr.status = 'accepted' AND se.status = 'confirmed' AND se.event_date < (now() AT TIME ZONE 'Asia/Karachi')::date
      AND sr.payout_voucher_id IS NULL AND sr.advance_share_pkr IS NOT NULL AND sr.advance_share_pkr > 0
    FOR UPDATE OF sr SKIP LOCKED
  LOOP
    SELECT id INTO v_liability_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-5004' AND tenant_id = r.tenant_id;
    v_vehicle_account := ensure_vehicle_account(r.vehicle_id);

    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
    VALUES ('donors_projects', 'contra', (now() AT TIME ZONE 'Asia/Karachi')::date,
      'Shadi advance released — ' || r.owner_name || ' (' || to_char(r.event_date, 'DD Mon YYYY') || ')', r.advance_share_pkr, v_vehicle_account, v_liability_account, r.owner_name)
    RETURNING id INTO v_voucher_id;

    UPDATE shadi_vehicle_requests SET payout_voucher_id = v_voucher_id, paid_out_at = now() WHERE id = r.request_id;
    v_count := v_count + 1;

    IF r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
      VALUES (r.portal_user_id, 'shadi_advance_released', 'Advance released',
        'Rs ' || round(r.advance_share_pkr) || ' advance for the ' || to_char(r.event_date, 'DD Mon YYYY') || ' wedding has been released to your account.', '/portal/my-vehicle/shadi', r.tenant_id);
    END IF;
  END LOOP;

  RETURN v_count;
END;
$function$;

create or replace function public.run_complaint_daily_reminders()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_popup_enabled boolean;
  r record;
BEGIN
  FOR r IN SELECT * FROM complaints WHERE status = 'open' AND assigned_to IS NOT NULL LOOP
    SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'complaint_daily_reminder' AND tenant_id = r.tenant_id;
    IF v_popup_enabled IS DISTINCT FROM false THEN
      INSERT INTO notifications (recipient_id, event_type, title, body, link, tenant_id)
      VALUES (r.assigned_to, 'complaint_daily_reminder', 'Daily reminder — ' || r.complaint_number, 'Please post a status update for this open complaint.', '/admin/complaints/' || r.id, r.tenant_id);
    END IF;
  END LOOP;
END;
$function$;

create or replace function public.run_nonpayment_flag_sweep()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_popup_enabled boolean;
  r record;
  h record;
BEGIN
  DROP TABLE IF EXISTS _np_current;
  CREATE TEMP TABLE _np_current AS
  WITH bill_calc AS (
    SELECT
      b.consumer_id,
      c.tenant_id,
      GREATEST(b.amount_pkr - COALESCE(b.discount_amount, 0) - COALESCE(b.paid_amount, 0), 0) AS outstanding,
      ROW_NUMBER() OVER (PARTITION BY b.consumer_id ORDER BY b.year DESC, b.month DESC) AS rn,
      (b.year * 12 + b.month) AS ym
    FROM bills b
    JOIN consumers c ON c.consumer_id = b.consumer_id
    WHERE c.status = 'active'
  ),
  latest_two AS (
    SELECT consumer_id,
      COUNT(*) AS cnt,
      MAX(ym) FILTER (WHERE rn = 1) AS ym1,
      MAX(ym) FILTER (WHERE rn = 2) AS ym2,
      BOOL_AND(outstanding > 0) FILTER (WHERE rn <= 2) AS both_unpaid
    FROM bill_calc
    WHERE rn <= 2
    GROUP BY consumer_id
  ),
  flagged AS (
    SELECT lt.consumer_id
    FROM latest_two lt
    WHERE lt.cnt = 2 AND lt.both_unpaid AND (lt.ym1 - lt.ym2) = 1
  )
  SELECT bc.consumer_id, c.sector, c.tenant_id, SUM(bc.outstanding) AS total_outstanding
  FROM bill_calc bc
  JOIN consumers c ON c.consumer_id = bc.consumer_id
  WHERE bc.outstanding > 0 AND bc.consumer_id IN (SELECT consumer_id FROM flagged)
  GROUP BY bc.consumer_id, c.sector, c.tenant_id;

  FOR r IN SELECT * FROM _np_current WHERE consumer_id NOT IN (SELECT consumer_id FROM consumer_nonpayment_flags) LOOP
    INSERT INTO consumer_nonpayment_flags (consumer_id, sector, total_outstanding, tenant_id)
    VALUES (r.consumer_id, r.sector, r.total_outstanding, r.tenant_id);

    SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'consumer_flagged_nonpayment' AND tenant_id = r.tenant_id;
    IF v_popup_enabled IS DISTINCT FROM false AND r.sector IS NOT NULL THEN
      FOR h IN
        SELECT id FROM admin_users
        WHERE is_active = true AND can_collect_payments = true AND r.sector = ANY(assigned_sectors) AND tenant_id = r.tenant_id
      LOOP
        INSERT INTO notifications (recipient_id, event_type, title, body, link, tenant_id)
        VALUES (h.id, 'consumer_flagged_nonpayment', 'Non-payment: ' || r.consumer_id,
          'Rs. ' || to_char(r.total_outstanding, 'FM999999990.00') || ' outstanding in ' || r.sector, '/admin/reports/non-payment', r.tenant_id);
      END LOOP;
    END IF;
  END LOOP;

  UPDATE consumer_nonpayment_flags f
  SET total_outstanding = c.total_outstanding, last_checked_at = now()
  FROM _np_current c
  WHERE f.consumer_id = c.consumer_id;

  DELETE FROM consumer_nonpayment_flags
  WHERE consumer_id NOT IN (SELECT consumer_id FROM _np_current);

  DROP TABLE _np_current;
END;
$function$;

create or replace function public.shop_product_expiry_reminders()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  r RECORD;
  v_admin RECORD;
BEGIN
  FOR r IN
    SELECT p.id, p.name, p.expiry_date, p.tenant_id, s.name AS shop_name
    FROM shop_products p JOIN shops s ON s.id = p.shop_id
    WHERE p.is_active AND p.expiry_date IS NOT NULL
      AND p.expiry_date BETWEEN (now() AT TIME ZONE 'Asia/Karachi')::date AND (now() AT TIME ZONE 'Asia/Karachi')::date + 7
      AND p.expiry_reminded_at IS NULL
  LOOP
    FOR v_admin IN
      SELECT id FROM admin_users WHERE is_active = true AND (role = 'super_admin' OR can_manage_parties) AND access_donors_projects AND tenant_id = r.tenant_id
    LOOP
      INSERT INTO notifications (recipient_id, event_type, title, body, link, tenant_id)
      VALUES (v_admin.id, 'shop_product_expiring', 'Product expiring soon',
        r.name || ' (' || r.shop_name || ') expires ' || to_char(r.expiry_date, 'DD Mon YYYY') || '.', '/admin/shops', r.tenant_id);
    END LOOP;
    UPDATE shop_products SET expiry_reminded_at = now() WHERE id = r.id;
  END LOOP;
END;
$function$;

create or replace function public.wazifa_disbursement_run()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_month date; v_count int := 0; v_next_no int; r record;
BEGIN
  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;

  FOR r IN
    SELECT a.id AS award_id, a.tenant_id, s.portal_user_id, s.full_name,
           a.disbursement_monthly_pkr AS amount, a.disbursement_due_day AS due_day
      FROM wazifa_awards a
      JOIN wazifa_students s ON s.id = a.student_id
     WHERE a.plan_type = 'disburse_then_settle' AND a.disbursement_active AND a.status = 'active'
       AND COALESCE(a.disbursement_monthly_pkr, 0) > 0 AND a.disbursement_due_day IS NOT NULL
       AND (a.disbursement_start_date IS NULL OR v_month >= date_trunc('month', a.disbursement_start_date)::date)
       AND (a.disbursement_end_date IS NULL OR v_month <= date_trunc('month', a.disbursement_end_date)::date)
       AND NOT EXISTS (SELECT 1 FROM wazifa_disbursement_charges dc
                        WHERE dc.award_id = a.id
                          AND dc.due_on >= v_month AND dc.due_on < v_month + interval '1 month')
  LOOP
    SELECT COALESCE(MAX(charge_no), 0) + 1 INTO v_next_no FROM wazifa_disbursement_charges WHERE award_id = r.award_id;

    INSERT INTO wazifa_disbursement_charges (award_id, charge_no, due_on, amount_pkr, tenant_id)
    VALUES (r.award_id, v_next_no, v_month + (r.due_day - 1), r.amount, r.tenant_id);

    IF r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
      VALUES (r.portal_user_id, 'wazifa_disbursement_due', 'Taleemi Wazifa support due this month',
        'Rs ' || trim(to_char(r.amount, 'FM999,999,999,990')) || ' is expected by ' || to_char(v_month + (r.due_day - 1), 'DD Mon'),
        '/portal/wazifa', r.tenant_id);
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('charges_raised', v_count, 'month', v_month);
END;
$function$;

create or replace function public.wazifa_installment_run()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_month date; v_count int := 0; v_next_no int; r record;
BEGIN
  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;

  FOR r IN
    SELECT a.id AS award_id, a.tenant_id, a.student_id, s.portal_user_id, s.full_name,
           a.student_monthly_contribution_pkr AS amount, a.installment_due_day AS due_day
      FROM wazifa_awards a
      JOIN wazifa_students s ON s.id = a.student_id
     WHERE a.installment_active AND a.status = 'active'
       AND COALESCE(a.student_monthly_contribution_pkr, 0) > 0
       AND a.installment_due_day IS NOT NULL
       AND (a.installment_start_date IS NULL OR v_month >= date_trunc('month', a.installment_start_date)::date)
       AND (a.installment_end_date IS NULL OR v_month <= date_trunc('month', a.installment_end_date)::date)
       AND NOT EXISTS (SELECT 1 FROM wazifa_installment_charges ic
                        WHERE ic.award_id = a.id
                          AND ic.due_on >= v_month AND ic.due_on < v_month + interval '1 month')
  LOOP
    SELECT COALESCE(MAX(charge_no), 0) + 1 INTO v_next_no
      FROM wazifa_installment_charges WHERE award_id = r.award_id;

    INSERT INTO wazifa_installment_charges (award_id, charge_no, due_on, amount_pkr, tenant_id)
    VALUES (r.award_id, v_next_no, v_month + (r.due_day - 1), r.amount, r.tenant_id);

    IF r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
      VALUES (r.portal_user_id, 'wazifa_installment_due', 'Taleemi Wazifa instalment due',
        'Rs ' || trim(to_char(r.amount, 'FM999,999,999,990')) || ' is due by ' || to_char(v_month + (r.due_day - 1), 'DD Mon'),
        '/portal/wazifa', r.tenant_id);
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('charges_raised', v_count, 'month', v_month);
END;
$function$;

create or replace function public.sadqa_upkeep_run()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  r record; v_today date; v_next_month date; v_charged int := 0; v_warned int := 0;
  v_amount decimal;
BEGIN
  v_today := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_next_month := (date_trunc('month', v_today) + interval '1 month')::date;

  -- ── The warning, in the last five days of the month ──────────────────
  IF v_today >= (v_next_month - interval '5 days')::date THEN
    FOR r IN
      SELECT o.id, o.item_name, o.object_no, o.portal_user_id, o.tenant_id
        FROM sadqa_objects o
       WHERE o.maintenance_mode = 'donor'
         AND o.portal_user_id IS NOT NULL
         AND o.status IN ('installed', 'in_service', 'needs_repair')
         AND sadqa_monthly_cost(o.id) > 0
         AND NOT EXISTS (SELECT 1 FROM sadqa_upkeep_charges c
                          WHERE c.object_id = o.id AND c.month = v_next_month)
    LOOP
      v_amount := sadqa_monthly_cost(r.id);
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
      VALUES (r.portal_user_id, 'sadqa_upkeep_due',
              'Upkeep due on the 1st — ' || r.item_name,
              'اگلے مہینے کی پہلی تاریخ کو ' || trim(to_char(v_amount, 'FM999,999,990'))
                || ' روپے دیکھ بھال کی مد میں واجب الادا ہوں گے۔' || E'\n\n'
                || 'Rs ' || trim(to_char(v_amount, 'FM999,999,990'))
                || ' for the upkeep of ' || r.item_name || ' (' || r.object_no
                || ') falls due on the 1st.',
              '/portal/esal-e-sawab', r.tenant_id);
      v_warned := v_warned + 1;
    END LOOP;
  END IF;

  -- ── The charge, once the month has turned ────────────────────────────
  FOR r IN
    SELECT o.id, o.item_name, o.object_no, o.portal_user_id, o.tenant_id
      FROM sadqa_objects o
     WHERE o.maintenance_mode = 'donor'
       AND o.status IN ('installed', 'in_service', 'needs_repair')
       AND sadqa_monthly_cost(o.id) > 0
       AND COALESCE(o.maintenance_starts_on, o.installed_on, o.created_at::date)
             <= date_trunc('month', v_today)::date
       AND NOT EXISTS (SELECT 1 FROM sadqa_upkeep_charges c
                        WHERE c.object_id = o.id AND c.month = date_trunc('month', v_today)::date)
  LOOP
    v_amount := sadqa_monthly_cost(r.id);
    INSERT INTO sadqa_upkeep_charges (object_id, month, amount_pkr, due_on, status, tenant_id)
    VALUES (r.id, date_trunc('month', v_today)::date, v_amount,
            date_trunc('month', v_today)::date, 'announced', r.tenant_id);
    v_charged := v_charged + 1;
  END LOOP;

  RETURN jsonb_build_object('warned', v_warned, 'charged', v_charged, 'as_at', v_today);
END;
$function$;

-- run_reminder_sweep: restructured to loop over every active tenant and run
-- the whole sweep once per tenant, with every lookup/insert scoped to that
-- tenant -- the message_templates/site_settings reads were a correctness
-- bug (not just a leak) since both are keyed (tenant_id, key) now.
create or replace function public.run_reminder_sweep()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_tenant record;
  v_weekly_body text;
  v_defaulter_body text;
  v_donor_body text;
  v_pledge_body text;
  v_graduate_body text;
  v_restore_fee text;
  r record;
BEGIN
  FOR v_tenant IN SELECT id FROM tenants WHERE is_active LOOP
    SELECT body INTO v_weekly_body FROM message_templates WHERE key = 'bill_reminder_weekly' AND tenant_id = v_tenant.id;
    SELECT body INTO v_defaulter_body FROM message_templates WHERE key = 'bill_defaulter_warning' AND tenant_id = v_tenant.id;
    SELECT body INTO v_donor_body FROM message_templates WHERE key = 'donor_recurring_reminder' AND tenant_id = v_tenant.id;
    SELECT body INTO v_pledge_body FROM message_templates WHERE key = 'donor_pledge_reminder' AND tenant_id = v_tenant.id;
    SELECT body INTO v_graduate_body FROM message_templates WHERE key = 'wazifa_graduate_repayment_reminder' AND tenant_id = v_tenant.id;
    SELECT value INTO v_restore_fee FROM site_settings WHERE key = 'defaulter_restore_fee' AND tenant_id = v_tenant.id;
    v_weekly_body := COALESCE(v_weekly_body, 'Dear %%name%%, your water bill of Rs. %%outstanding%% (Consumer No: %%consumer_id%%) was due on %%due_date%%. Please pay at your earliest convenience.');
    v_defaulter_body := COALESCE(v_defaulter_body, 'Dear %%name%%, your water bill of Rs. %%outstanding%% is now 2 months overdue. Please pay immediately to avoid disconnection. A reconnection charge of Rs. %%restore_fee%% will apply if your connection is discontinued.');
    v_donor_body := COALESCE(v_donor_body, 'Dear %%name%%, thank you for your continued support. Your next contribution of Rs. %%amount%% is due around %%due_date%%. We truly appreciate your generosity.');
    v_pledge_body := COALESCE(v_pledge_body, 'Dear %%name%%, you announced a pledge of Rs. %%amount%% on %%date%%. We haven''t received your payment yet — please pay at your earliest convenience and submit it from your portal so we can confirm it.');
    v_graduate_body := COALESCE(v_graduate_body, 'Dear %%name%%, congratulations on completing your studies. Your Taleemi Wazifa support for %%academic_year%% still has Rs. %%outstanding%% outstanding — your next instalment of Rs. %%amount%% was due on %%due_date%%. Please arrange repayment when you can so we can support more students.');
    v_restore_fee := COALESCE(v_restore_fee, '5000');

    -- Scoped to exclude meeting_due — migration 111's own sweep owns that tier.
    DELETE FROM reminder_queue WHERE status = 'pending' AND reminder_type != 'meeting_due' AND tenant_id = v_tenant.id;

    FOR r IN
      WITH outstanding_calc AS (
        SELECT b.consumer_id,
          SUM(GREATEST(b.amount_pkr - COALESCE(b.discount_amount, 0) - COALESCE(b.paid_amount, 0), 0)) AS outstanding,
          MAX(b.due_date) AS latest_due_date
        FROM bills b
        JOIN consumers c ON c.consumer_id = b.consumer_id
        WHERE c.status = 'active' AND b.tenant_id = v_tenant.id
        GROUP BY b.consumer_id
        HAVING SUM(GREATEST(b.amount_pkr - COALESCE(b.discount_amount, 0) - COALESCE(b.paid_amount, 0), 0)) > 0
      )
      SELECT c.consumer_id, c.name, COALESCE(NULLIF(c.whatsapp_number, ''), c.mobile) AS phone, oc.outstanding, oc.latest_due_date
      FROM outstanding_calc oc JOIN consumers c ON c.consumer_id = oc.consumer_id
      WHERE oc.consumer_id NOT IN (SELECT consumer_id FROM consumer_nonpayment_flags WHERE tenant_id = v_tenant.id)
    LOOP
      INSERT INTO reminder_queue (reminder_type, target_name, target_phone, message, amount, consumer_id, tenant_id)
      VALUES ('bill_weekly', r.name, r.phone,
        replace(replace(replace(replace(v_weekly_body,
          '%%name%%', r.name), '%%consumer_id%%', r.consumer_id),
          '%%outstanding%%', to_char(r.outstanding, 'FM999999990.00')),
          '%%due_date%%', COALESCE(to_char(r.latest_due_date, 'DD Mon YYYY'), 'N/A')),
        r.outstanding, r.consumer_id, v_tenant.id);
    END LOOP;

    FOR r IN
      SELECT f.consumer_id, c.name, COALESCE(NULLIF(c.whatsapp_number, ''), c.mobile) AS phone, f.total_outstanding
      FROM consumer_nonpayment_flags f JOIN consumers c ON c.consumer_id = f.consumer_id
      WHERE f.tenant_id = v_tenant.id
    LOOP
      INSERT INTO reminder_queue (reminder_type, target_name, target_phone, message, amount, consumer_id, tenant_id)
      VALUES ('bill_defaulter', r.name, r.phone,
        replace(replace(replace(replace(v_defaulter_body,
          '%%name%%', r.name), '%%consumer_id%%', r.consumer_id),
          '%%outstanding%%', to_char(r.total_outstanding, 'FM999999990.00')),
          '%%restore_fee%%', v_restore_fee),
        r.total_outstanding, r.consumer_id, v_tenant.id);
    END LOOP;

    FOR r IN
      SELECT id, COALESCE(donor_name, 'Donor') AS donor_name, donor_phone, amount_pkr, next_run_date
      FROM recurring_schedules
      WHERE is_active = true AND schedule_type = 'donation' AND next_run_date <= now() + interval '7 days' AND tenant_id = v_tenant.id
    LOOP
      INSERT INTO reminder_queue (reminder_type, target_name, target_phone, message, amount, recurring_schedule_id, tenant_id)
      VALUES ('donor_recurring', r.donor_name, r.donor_phone,
        replace(replace(replace(v_donor_body,
          '%%name%%', r.donor_name),
          '%%amount%%', to_char(r.amount_pkr, 'FM999999990.00')),
          '%%due_date%%', to_char(r.next_run_date, 'DD Mon YYYY')),
        r.amount_pkr, r.id, v_tenant.id);
    END LOOP;

    FOR r IN
      SELECT id, name, COALESCE(NULLIF(whatsapp_number, ''), phone) AS phone, amount_pkr, date, portal_user_id
      FROM donors
      WHERE payment_status = 'pledged' AND is_verified = false AND tenant_id = v_tenant.id
    LOOP
      INSERT INTO reminder_queue (reminder_type, target_name, target_phone, message, amount, donor_id, tenant_id)
      VALUES ('donor_pledge_unpaid', r.name, r.phone,
        replace(replace(replace(v_pledge_body,
          '%%name%%', r.name),
          '%%amount%%', to_char(r.amount_pkr, 'FM999999990.00')),
          '%%date%%', to_char(r.date, 'DD Mon YYYY')),
        r.amount_pkr, r.id, v_tenant.id);

      IF r.portal_user_id IS NOT NULL THEN
        INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
        VALUES (r.portal_user_id, 'pledge_reminder', 'Unpaid Pledge Reminder',
          'You pledged Rs. ' || to_char(r.amount_pkr, 'FM999999990.00') || ' — pay it anytime from your portal.',
          '/portal/statement', v_tenant.id);
      END IF;
    END LOOP;

    -- Tier 5: graduated students with a loan/settlement instalment due within
    -- the next 7 days (or already overdue). wazifa_loan_position() already
    -- knows which award type actually owes anything (a plain grant always
    -- comes back 0) — reused rather than re-derived here.
    FOR r IN
      SELECT s.id AS student_id, s.full_name, s.phone,
        a.id AS award_id, a.academic_year, a.installment_active,
        (wazifa_loan_position(a.id) ->> 'outstanding')::decimal AS outstanding,
        (wazifa_loan_position(a.id) ->> 'next_due_on')::date AS next_due_on
      FROM wazifa_students s
      JOIN wazifa_awards a ON a.student_id = s.id
      WHERE s.status = 'graduated' AND a.status <> 'cancelled' AND s.tenant_id = v_tenant.id
    LOOP
      IF r.outstanding IS NULL OR r.outstanding <= 0 OR r.next_due_on IS NULL
         OR r.next_due_on > (now() AT TIME ZONE 'Asia/Karachi')::date + interval '7 days' THEN
        CONTINUE;
      END IF;

      INSERT INTO reminder_queue (reminder_type, target_name, target_phone, message, amount, wazifa_student_id, wazifa_award_id, tenant_id)
      VALUES ('wazifa_repayment_due', r.full_name, r.phone,
        replace(replace(replace(replace(replace(v_graduate_body,
          '%%name%%', r.full_name), '%%academic_year%%', r.academic_year),
          '%%outstanding%%', to_char(r.outstanding, 'FM999999990.00')),
          '%%amount%%', to_char(COALESCE((CASE WHEN r.installment_active
            THEN (SELECT amount_pkr - paid_pkr FROM wazifa_installment_charges WHERE award_id = r.award_id AND status IN ('due', 'part_paid') ORDER BY due_on LIMIT 1)
            ELSE (SELECT amount_pkr FROM wazifa_repayment_schedule WHERE award_id = r.award_id AND status IN ('due', 'part_paid') ORDER BY due_on LIMIT 1) END), r.outstanding), 'FM999999990.00')),
          '%%due_date%%', to_char(r.next_due_on, 'DD Mon YYYY')),
        r.outstanding, r.student_id, r.award_id, v_tenant.id);
    END LOOP;
  END LOOP;
END;
$function$;

create or replace function public.mark_complaint_resolved(p_complaint_id uuid, p_note text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_complaint complaints%ROWTYPE;
  v_popup_enabled boolean;
  r record;
BEGIN
  SELECT * INTO v_complaint FROM complaints WHERE id = p_complaint_id AND tenant_id = my_tenant_id();
  IF v_complaint.id IS NULL THEN RAISE EXCEPTION 'Complaint not found.'; END IF;

  UPDATE complaints SET status = 'awaiting_verification', resolved_at = now(), resolved_by = current_admin_user_id() WHERE id = p_complaint_id;
  INSERT INTO complaint_updates (complaint_id, author_id, kind, body)
  VALUES (p_complaint_id, current_admin_user_id(), 'resolved', COALESCE(NULLIF(trim(p_note), ''), 'Marked as resolved — awaiting verification.'));

  SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'complaint_ready_for_verification' AND tenant_id = v_complaint.tenant_id;
  IF v_popup_enabled IS DISTINCT FROM false THEN
    FOR r IN
      SELECT id FROM admin_users
      WHERE is_active = true AND can_verify_complaints = true AND admin_user_can_access_system(id, v_complaint.system) AND tenant_id = v_complaint.tenant_id
    LOOP
      INSERT INTO notifications (recipient_id, event_type, title, body, link, tenant_id)
      VALUES (r.id, 'complaint_ready_for_verification', 'Ready for verification — ' || v_complaint.complaint_number, v_complaint.complaint_text, '/admin/complaints/' || p_complaint_id, v_complaint.tenant_id);
    END LOOP;
  END IF;
END;
$function$;

create or replace function public.reopen_complaint(p_complaint_id uuid, p_note text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_complaint complaints%ROWTYPE;
BEGIN
  IF NOT (current_admin_is_super_admin() OR COALESCE((SELECT can_verify_complaints FROM admin_users WHERE id = current_admin_user_id()), false)) THEN
    RAISE EXCEPTION 'You are not authorized to verify complaints.';
  END IF;
  SELECT * INTO v_complaint FROM complaints WHERE id = p_complaint_id AND tenant_id = my_tenant_id();
  IF v_complaint.id IS NULL THEN RAISE EXCEPTION 'Complaint not found.'; END IF;

  UPDATE complaints SET status = 'open', resolved_at = NULL, resolved_by = NULL WHERE id = p_complaint_id;
  INSERT INTO complaint_updates (complaint_id, author_id, kind, body)
  VALUES (p_complaint_id, current_admin_user_id(), 'reopened', COALESCE(NULLIF(trim(p_note), ''), 'Sent back — not resolved.'));

  IF v_complaint.assigned_to IS NOT NULL THEN
    INSERT INTO notifications (recipient_id, event_type, title, body, link, tenant_id)
    VALUES (v_complaint.assigned_to, 'complaint_submitted', 'Sent back — ' || v_complaint.complaint_number, COALESCE(NULLIF(trim(p_note), ''), 'Not verified, please recheck.'), '/admin/complaints/' || p_complaint_id, v_complaint.tenant_id);
  END IF;
END;
$function$;

create or replace function public.broadcast_portal_notification(p_event_type character varying, p_title character varying, p_body text, p_link character varying)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_count int;
BEGIN
  IF current_admin_role() NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Not authorized to send a broadcast';
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT id, p_event_type, p_title, p_body, p_link FROM portal_users WHERE is_active = true AND tenant_id = my_tenant_id();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

create or replace function public.trg_complaint_after_insert_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_popup_enabled boolean;
  r record;
BEGIN
  SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'complaint_submitted' AND tenant_id = NEW.tenant_id;
  IF v_popup_enabled IS DISTINCT FROM false THEN
    FOR r IN SELECT admin_user_id FROM complaint_handlers WHERE system = NEW.system AND is_active = true AND tenant_id = NEW.tenant_id LOOP
      INSERT INTO notifications (recipient_id, event_type, title, body, link, tenant_id)
      VALUES (r.admin_user_id, 'complaint_submitted', 'New complaint ' || NEW.complaint_number, left(NEW.complaint_text, 140), '/admin/complaints/' || NEW.id, NEW.tenant_id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;

create or replace function public.trg_complaint_assigned_log()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_name varchar;
  v_popup_enabled boolean;
BEGIN
  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to AND NEW.assigned_to IS NOT NULL THEN
    SELECT full_name INTO v_name FROM admin_users WHERE id = NEW.assigned_to;
    INSERT INTO complaint_updates (complaint_id, author_id, kind, body)
    VALUES (NEW.id, current_admin_user_id(), 'assigned', 'Assigned to ' || COALESCE(v_name, 'Unknown'));

    SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'complaint_submitted' AND tenant_id = NEW.tenant_id;
    IF v_popup_enabled IS DISTINCT FROM false THEN
      INSERT INTO notifications (recipient_id, event_type, title, body, link, tenant_id)
      VALUES (NEW.assigned_to, 'complaint_submitted', 'Complaint assigned to you — ' || NEW.complaint_number, left(NEW.complaint_text, 140), '/admin/complaints/' || NEW.id, NEW.tenant_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

create or replace function public.trg_connection_request_incharge_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_popup_enabled boolean;
BEGIN
  IF NEW.incharge_user_id IS DISTINCT FROM OLD.incharge_user_id AND NEW.incharge_user_id IS NOT NULL THEN
    SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'task_incharge_assigned' AND tenant_id = NEW.tenant_id;
    IF v_popup_enabled IS DISTINCT FROM false THEN
      INSERT INTO notifications (recipient_id, event_type, title, body, link, tenant_id)
      VALUES (NEW.incharge_user_id, 'task_incharge_assigned',
        'Installation task assigned to you — ' || COALESCE(NEW.request_number, ''),
        NEW.consumer_name || COALESCE(' · ' || NEW.sector, ''), '/admin/tasks', NEW.tenant_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

create or replace function public.trg_payment_collector_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_popup_enabled boolean;
  v_collector_name varchar;
  v_consumer_name varchar;
  r record;
BEGIN
  IF NEW.collected_by IS NULL THEN RETURN NEW; END IF;
  SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'collector_payment_collected' AND tenant_id = NEW.tenant_id;
  IF v_popup_enabled IS DISTINCT FROM true THEN RETURN NEW; END IF;

  SELECT full_name INTO v_collector_name FROM admin_users WHERE id = NEW.collected_by;
  SELECT name INTO v_consumer_name FROM consumers WHERE consumer_id = NEW.consumer_id;

  FOR r IN
    SELECT id FROM admin_users
    WHERE is_active = true AND id != NEW.collected_by AND tenant_id = NEW.tenant_id AND (
      role IN ('super_admin', 'admin', 'water_accountant')
      OR (role = 'accountant' AND access_water_supply)
    )
  LOOP
    INSERT INTO notifications (recipient_id, event_type, title, body, link, tenant_id)
    VALUES (
      r.id, 'collector_payment_collected',
      'Payment collected by ' || COALESCE(v_collector_name, 'a collector'),
      'Rs. ' || to_char(NEW.amount_pkr, 'FM999999990.00') || ' collected from ' || COALESCE(v_consumer_name, NEW.consumer_id),
      '/admin/collectors', NEW.tenant_id
    );
  END LOOP;
  RETURN NEW;
END;
$function$;

create or replace function public.trg_suggestion_notify_staff()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_enabled boolean;
  v_title varchar;
  r record;
BEGIN
  IF NEW.type NOT IN ('volunteer', 'role_request') THEN RETURN NEW; END IF;

  SELECT popup_enabled INTO v_enabled FROM notification_preferences
   WHERE event_type = CASE NEW.type WHEN 'volunteer' THEN 'volunteer_offer' ELSE 'role_request' END AND tenant_id = NEW.tenant_id;
  IF v_enabled IS DISTINCT FROM false THEN
    v_title := CASE NEW.type
      WHEN 'volunteer' THEN 'Volunteer offer from ' || COALESCE(NEW.name, 'a resident')
      ELSE 'Publisher role request from ' || COALESCE(NEW.name, 'a resident') END;
    FOR r IN SELECT id FROM admin_users WHERE is_active = true AND role IN ('super_admin', 'admin') AND tenant_id = NEW.tenant_id LOOP
      INSERT INTO notifications (recipient_id, event_type, title, body, link, tenant_id)
      VALUES (r.id, CASE NEW.type WHEN 'volunteer' THEN 'volunteer_offer' ELSE 'role_request' END,
              v_title, left(COALESCE(NEW.message, ''), 140), '/admin/suggestions', NEW.tenant_id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;
