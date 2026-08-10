-- Migration 185: run recurring schedules on Pakistan time, and make the
-- scheduler's real state visible.
--
-- ── The date bug ─────────────────────────────────────────────────────────
-- next_run_date became timestamptz in migration 041, and the portal stores it
-- at Pakistan midnight — 2026-09-01 00:01 PKT is 2026-08-31 19:01 UTC. Every
-- date derived from it was then read in the database's timezone (UTC), so it
-- came out one day early.
--
-- On a donation that is cosmetic: the donor sees 09/08 for an instalment they
-- would call the 10th. On a BILL it is not cosmetic at all. Three schedules
-- currently fall due at 2026-08-31 19:01 UTC, which is 1 September in Pakistan.
-- EXTRACT(MONTH ...) in UTC returns 8, so each would be stamped August. Bills
-- carry UNIQUE (consumer_id, month, year) with ON CONFLICT DO NOTHING, and
-- DP-1009 already has an August 2026 bill (WB-00551) — so his September bill
-- would not be created at all, and nothing would report it. A consumer silently
-- skipped for a month is exactly the kind of fault nobody notices until the
-- yearly figures do not add up.
--
-- Fixed by converting to Pakistan wall-clock time once, at the top, and
-- deriving every date from that.
CREATE OR REPLACE FUNCTION run_recurring_schedule(p_schedule_id uuid) RETURNS void AS $$
DECLARE
  s recurring_schedules%ROWTYPE;
  v_new_id uuid;
  v_next timestamptz;
  v_due_date date;
  v_complaint record;
  v_project varchar;
  -- The schedule's due moment as it reads on a calendar in Chakwal.
  v_local timestamp;
BEGIN
  SELECT * INTO s FROM recurring_schedules
  WHERE id = p_schedule_id AND is_active = true AND next_run_date <= now()
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  v_local := s.next_run_date AT TIME ZONE 'Asia/Karachi';
  v_due_date := make_date(EXTRACT(YEAR FROM v_local)::int, EXTRACT(MONTH FROM v_local)::int, 7);

  IF s.schedule_type = 'bill' THEN
    INSERT INTO bills (consumer_id, month, year, amount_pkr, discount_amount, due_date, description, recurring_schedule_id)
    VALUES (s.consumer_id, EXTRACT(MONTH FROM v_local)::int, EXTRACT(YEAR FROM v_local)::int,
            s.amount_pkr, s.discount_amount, v_due_date, s.particular, s.id)
    ON CONFLICT (consumer_id, month, year) DO NOTHING
    RETURNING id INTO v_new_id;

    IF v_new_id IS NOT NULL THEN
      FOR v_complaint IN
        SELECT id FROM complaints WHERE system = 'water_supply' AND consumer_id = s.consumer_id AND status != 'verified' AND waiver_active = true
      LOOP
        PERFORM apply_complaint_waiver_to_bill(v_new_id, v_complaint.id);
      END LOOP;
    END IF;

  ELSIF s.schedule_type = 'donation' THEN
    INSERT INTO donors (
      name, name_ur, phone, donor_type, amount_pkr, date, payment_method, project_id,
      is_verified, is_anonymous, recurring_schedule_id, submitted_via,
      portal_user_id, payment_status
    )
    VALUES (
      s.donor_name, s.donor_name_ur, s.donor_phone, s.donor_type, s.amount_pkr, v_local::date,
      s.payment_method, s.project_id,
      s.created_by_portal_user_id IS NULL, false, s.id,
      CASE WHEN s.created_by_portal_user_id IS NULL THEN 'staff' ELSE 'public' END,
      s.created_by_portal_user_id,
      CASE WHEN s.created_by_portal_user_id IS NULL THEN 'paid' ELSE 'pledged' END
    )
    RETURNING id INTO v_new_id;

    IF v_new_id IS NOT NULL AND s.created_by_portal_user_id IS NULL THEN
      PERFORM assign_donor_numbers_internal(v_new_id);
    END IF;

    IF v_new_id IS NOT NULL AND s.created_by_portal_user_id IS NOT NULL THEN
      SELECT title INTO v_project FROM projects WHERE id = s.project_id;
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (
        s.created_by_portal_user_id, 'recurring_due',
        'Your monthly donation is due',
        'Rs. ' || trim(to_char(s.amount_pkr, 'FM999999999990')) ||
          COALESCE(' for ' || v_project, '') ||
          ' — announced on ' || to_char(v_local, 'DD/MM/YYYY') || '. Open My Giving to pay.',
        '/portal/statement'
      );
    END IF;

  ELSIF s.schedule_type = 'expense' THEN
    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name, recurring_schedule_id)
    VALUES (s.system, 'expense', v_local::date, COALESCE(s.particular, 'Recurring expense'), s.amount_pkr,
            s.from_account_id, s.to_account_id, s.party_name, s.id)
    RETURNING id INTO v_new_id;
  END IF;

  v_next := CASE s.frequency
    WHEN 'every_minute' THEN s.next_run_date + INTERVAL '1 minute'
    WHEN 'daily' THEN s.next_run_date + INTERVAL '1 day'
    WHEN 'weekly' THEN s.next_run_date + INTERVAL '7 days'
    WHEN 'monthly' THEN s.next_run_date + INTERVAL '1 month'
    WHEN 'semi_annual' THEN s.next_run_date + INTERVAL '6 months'
    WHEN 'yearly' THEN s.next_run_date + INTERVAL '1 year'
  END;

  UPDATE recurring_schedules SET
    next_run_date = v_next,
    last_run_at = now(),
    last_generated_type = s.schedule_type,
    last_generated_id = v_new_id
  WHERE id = p_schedule_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- The outer sweep compared a timestamptz against current_date (UTC midnight)
-- while run_recurring_schedule itself compared against now(). The two disagreed
-- by up to a day, so a schedule could be picked up and then refused, or ignored
-- for hours after it was genuinely due. One comparison, used by both.
-- It also only ever caught up by ONE period. run_recurring_schedule advances
-- next_run_date a single step, and the old sweep visited each schedule once —
-- so if nothing ran for six months, opening the Recurring page produced one
-- instalment, not six, and you had to open it six times. Now it repeats until
-- nothing is due.
--
-- The guard is not decoration: an 'every_minute' schedule left alone for a
-- month would otherwise try to generate ~43,000 rows in one transaction. It
-- stops at 500 passes, which covers years of monthly catch-up while refusing to
-- run away.
CREATE OR REPLACE FUNCTION run_due_recurring_schedules() RETURNS void AS $$
DECLARE
  r RECORD;
  v_pass int := 0;
BEGIN
  LOOP
    v_pass := v_pass + 1;
    EXIT WHEN v_pass > 500;

    FOR r IN SELECT id FROM recurring_schedules WHERE is_active = true AND next_run_date <= now() LOOP
      PERFORM run_recurring_schedule(r.id);
    END LOOP;

    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM recurring_schedules WHERE is_active = true AND next_run_date <= now()
    );
  END LOOP;

  IF v_pass > 500 THEN
    RAISE WARNING 'run_due_recurring_schedules stopped at 500 passes — a schedule is still overdue. Check for a very short frequency left unattended.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── Make the scheduler's real state visible ──────────────────────────────
-- Migration 015 tried to enable pg_cron and swallowed any failure, so nobody
-- could tell afterwards whether schedules run on their own or only when a staff
-- member happens to open the Recurring page. This reports the truth.
CREATE OR REPLACE FUNCTION recurring_scheduler_status()
RETURNS TABLE (pg_cron_installed boolean, job_scheduled boolean, job_schedule text) AS $$
DECLARE
  v_installed boolean;
  v_sched text := NULL;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') INTO v_installed;
  IF v_installed THEN
    BEGIN
      EXECUTE 'SELECT schedule FROM cron.job WHERE jobname = ''run-recurring-schedules'' LIMIT 1' INTO v_sched;
    EXCEPTION WHEN OTHERS THEN
      v_sched := NULL;
    END;
  END IF;
  RETURN QUERY SELECT v_installed, v_sched IS NOT NULL, v_sched;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION recurring_scheduler_status() TO authenticated;

-- Best effort again, but this time at 01:00 UTC = 06:00 Pakistan, which is the
-- morning the committee actually meant. Still wrapped: on Supabase pg_cron
-- usually has to be enabled from the dashboard, and that is not something a
-- migration can force.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.unschedule('run-recurring-schedules');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.schedule('run-recurring-schedules', '0 1 * * *', 'SELECT run_due_recurring_schedules()');
  RAISE NOTICE 'pg_cron job scheduled: daily 01:00 UTC (06:00 Pakistan)';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable — schedules will only run when the Recurring page is opened. Enable pg_cron in the Supabase dashboard (Database > Extensions) and re-run this migration. Reason: %', SQLERRM;
END $$;
