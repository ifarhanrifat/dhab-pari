-- Migration 827: real question raised during the 2026-11-07 deep audit
-- — "what if a rider will cancel the ride in the mid month for the
-- monthly fix... how will then driver refund him."
--
-- leave_monthly_seat never had any money logic at all, because until
-- this session's own upfront-deposit feature (822/823), nothing was
-- EVER pre-collected for days that hadn't happened yet — billing was
-- always purely reactive (take_attendance, day by day). The deposit
-- changed that: a rider who just applied now has every remaining
-- scheduled day of the month pre-seeded as "present" (so the advance
-- equals what daily billing would have charged for a fully-attended
-- rest of the month). A mid-month cancellation now needs to undo
-- exactly that pre-seeding, using the SAME per-day accrual math
-- take_attendance's own present→absent branch already uses — not a new
-- policy, just completing the existing "pay only for days you actually
-- use" principle at its one boundary case that was missing.
--
-- Two real cases, handled differently on purpose:
--  - This month's charge is still 'due' (driver hasn't marked it paid
--    yet): every future day's pre-seeded share is removed from it —
--    the rider now owes only for days already passed.
--  - This month's charge is already 'paid' (cash already changed hands
--    directly between rider and driver — this app never holds it):
--    there is nothing left for software to reverse. The WHERE
--    status = 'due' clause below expresses this on its own — the
--    update simply matches nothing, and any refund for the unused days
--    is a real-world conversation between rider and driver, same as
--    every other driver-direct payment in this app already is.

CREATE OR REPLACE FUNCTION leave_monthly_seat(p_subscription_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sub route_subscriptions%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_month int := extract(month FROM v_today)::int;
  v_year int := extract(year FROM v_today)::int;
  v_daily_share numeric;
  v_unused_days int;
BEGIN
  SELECT * INTO v_sub FROM route_subscriptions WHERE id = p_subscription_id AND portal_user_id = current_portal_user_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Subscription not found.' USING ERRCODE = 'P0001'; END IF;

  SELECT count(*) INTO v_unused_days FROM route_run_attendance
    WHERE subscription_id = p_subscription_id AND run_date >= v_today AND present = true;

  IF v_unused_days > 0 THEN
    UPDATE route_run_attendance SET present = false, marked_at = now(), marked_by = current_portal_user_id()
      WHERE subscription_id = p_subscription_id AND run_date >= v_today AND present = true;

    v_daily_share := round(v_sub.monthly_fee_pkr / scheduled_days_in_month(v_sub.route_id, v_month, v_year));
    UPDATE route_subscription_charges
      SET amount_pkr = greatest(0, amount_pkr - (v_daily_share * v_unused_days))
      WHERE subscription_id = p_subscription_id AND month = v_month AND year = v_year AND status = 'due';
  END IF;

  UPDATE route_subscriptions SET status = 'cancelled' WHERE id = p_subscription_id;
  IF v_sub.status = 'active' THEN PERFORM promote_next_waitlisted(v_sub.route_id); END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION leave_monthly_seat(uuid) TO authenticated;
