-- Migration 055: Recurring bills/donations/expenses were never actually generated
-- on their own — the only thing that ever called run_due_recurring_schedules() was
-- someone manually opening the Recurring page. The pg_cron job registered in
-- migration 015 does exist and is active, but only fires once a day at 6am UTC,
-- which can never satisfy "every_minute" testing and misses the intended
-- 00:01 Pakistan-time trigger point for daily/weekly/monthly schedules by hours.
--
-- Fixes:
-- 1. Reschedule the cron job to run every minute, so any due schedule (of any
--    frequency) is picked up within a minute of becoming due.
-- 2. run_due_recurring_schedules() now loops until nothing is left due, instead of
--    firing each due schedule once per invocation — a schedule that's been stuck
--    for two months catches all the way up in one pass instead of one period per
--    cron tick (which would otherwise take two months' worth of ticks to resolve).
-- 3. next_run_date is now anchored to 00:01 Asia/Karachi time server-side whenever
--    it's set (insert or update), instead of trusting whatever timezone the
--    admin's own browser happened to compute it in.
-- 4. reset_recurring_schedule(): reinitializes a schedule's next_run_date to the
--    correct upcoming occurrence (Karachi-anchored) and reactivates it — the
--    "Reset" action for the new Recurring management screen.

SELECT cron.unschedule('run-recurring-schedules');
SELECT cron.schedule('run-recurring-schedules', '* * * * *', $$SELECT run_due_recurring_schedules()$$);

CREATE OR REPLACE FUNCTION run_due_recurring_schedules() RETURNS void AS $$
DECLARE
  v_id uuid;
  v_iterations int := 0;
BEGIN
  LOOP
    v_iterations := v_iterations + 1;
    EXIT WHEN v_iterations > 5000; -- safety valve, should never realistically be hit
    SELECT id INTO v_id FROM recurring_schedules WHERE is_active = true AND next_run_date <= now() LIMIT 1;
    EXIT WHEN v_id IS NULL;
    PERFORM run_recurring_schedule(v_id);
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Whatever timezone the browser computed next_run_date in, re-anchor it to exactly
-- 00:01 Pakistan Standard Time (UTC+5, no DST) on the same calendar date — the
-- testing-only every_minute frequency is left alone since it's relative-to-now by
-- design, not meant to land on a clock boundary.
CREATE OR REPLACE FUNCTION trg_recurring_schedule_anchor_pkt() RETURNS trigger AS $$
BEGIN
  IF NEW.frequency != 'every_minute' THEN
    NEW.next_run_date := ((NEW.next_run_date AT TIME ZONE 'Asia/Karachi')::date::timestamp + INTERVAL '1 minute') AT TIME ZONE 'Asia/Karachi';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS recurring_schedule_anchor_pkt_trigger ON recurring_schedules;
CREATE TRIGGER recurring_schedule_anchor_pkt_trigger BEFORE INSERT OR UPDATE OF next_run_date ON recurring_schedules
  FOR EACH ROW EXECUTE FUNCTION trg_recurring_schedule_anchor_pkt();

CREATE OR REPLACE FUNCTION reset_recurring_schedule(p_schedule_id uuid) RETURNS void AS $$
DECLARE
  s recurring_schedules%ROWTYPE;
  v_base date;
  v_next_date date;
  v_next timestamptz;
BEGIN
  SELECT * INTO s FROM recurring_schedules WHERE id = p_schedule_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF s.frequency = 'every_minute' THEN
    v_next := now() + INTERVAL '1 minute';
  ELSE
    v_base := (now() AT TIME ZONE 'Asia/Karachi')::date;
    v_next_date := CASE s.frequency
      WHEN 'daily' THEN v_base + 1
      WHEN 'weekly' THEN v_base + 7
      WHEN 'monthly' THEN (v_base + INTERVAL '1 month')::date
      WHEN 'semi_annual' THEN (v_base + INTERVAL '6 months')::date
      WHEN 'yearly' THEN (v_base + INTERVAL '1 year')::date
      ELSE v_base + 1
    END;
    v_next := (v_next_date::timestamp + INTERVAL '1 minute') AT TIME ZONE 'Asia/Karachi';
  END IF;

  UPDATE recurring_schedules SET next_run_date = v_next, is_active = true WHERE id = p_schedule_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
