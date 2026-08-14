-- Migration 234: actually schedule the month close I said was scheduled.
--
-- ═════════════════════════════════════════════════════════════════════════
-- The gap
-- ═════════════════════════════════════════════════════════════════════════
-- Migration 229 scheduled pool_daily_appeal() and sadqa_upkeep_run(). 231
-- scheduled pool_announce_recurring_month(). Neither ever scheduled
-- pool_close_all_months() — it was built idempotent specifically so it could
-- be scheduled, documented as "meant for a month-end scheduled run", and then
-- never actually handed to cron. The only way it ran was the "Close the
-- month" button on /admin/pools, which is exactly the manual step the whole
-- redesign was supposed to remove.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Why this needs its own date, not the default
-- ═════════════════════════════════════════════════════════════════════════
-- pool_close_month() defaults to closing THIS month when no date is passed.
-- Scheduling `SELECT pool_close_all_months()` to run "on the 1st" would call
-- it with today's date already inside the new month, so it would close the
-- month that has just started — one day old, nobody's had a chance to pay
-- yet — and mark every donor lapsed for a month that barely exists. The job
-- below passes the previous month explicitly.
--
-- Run on the 3rd rather than the 1st, deliberately: a donor who transferred
-- on the 30th and an accountant who hasn't reconciled it yet both deserve a
-- couple of days before the system decides they never paid.
DO $$
BEGIN
  PERFORM cron.schedule('pool-close-month', '0 5 3 * *',
    $cron$SELECT pool_close_all_months((date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')) - interval '1 day')::date)$cron$);
  RAISE NOTICE 'pg_cron: pools closed for the previous month on the 3rd at 10:00 PKT';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable — the Close the month button on /admin/pools is the only way this runs. %', SQLERRM;
END $$;
