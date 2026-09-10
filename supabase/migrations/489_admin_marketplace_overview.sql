-- Admin "Overview & Fleet Map" (489), per the v2 design handoff's
-- Admin-12 list item #1 (خلاصہ اور نقشہ). The committee had per-screen
-- queues (wallet topups, shadi advance, disputes) but no single home
-- screen tying them together with today's activity and a fleet view —
-- confirmed missing by checking the prototype directly, not guessed.
--
-- Scoped honestly against what's real: the prototype's own six tiles
-- included an "avg accept time" figure this app has no instrumentation
-- for (no timestamp is stored for when an invitation/offer was first
-- shown vs accepted, only when it was created and when it was
-- responded to — accept time already means "time since offered", not
-- "time since a driver could plausibly have seen it", so a real number
-- here would be fake precision). Left out rather than invented.
CREATE OR REPLACE FUNCTION admin_marketplace_overview() RETURNS jsonb AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_jobs_today int; v_cash_today decimal;
  v_vehicles_live int;
  v_wallets_negative_count int; v_wallets_negative_total decimal;
  v_advance_held decimal;
  v_pending_topups int; v_pending_shadi_advance int; v_open_disputes int;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;

  -- Same six income sources vehicle_dashboard_summary (488) sums per
  -- vehicle, here summed across all of them for "today's activity."
  WITH jobs AS (
    SELECT b.total_amount_pkr AS amount, b.confirmed_at AT TIME ZONE 'Asia/Karachi' AS at
    FROM ride_bookings b WHERE b.status = 'confirmed'
    UNION ALL
    SELECT b.total_amount_pkr, b.completed_at AT TIME ZONE 'Asia/Karachi' FROM vehicle_trip_bookings b WHERE b.status = 'completed' AND b.completed_at IS NOT NULL
    UNION ALL
    SELECT coalesce(b.total_amount_pkr, b.base_amount_pkr), b.ended_at AT TIME ZONE 'Asia/Karachi' FROM hourly_bookings b WHERE b.status_confirmed AND b.ended_at IS NOT NULL
    UNION ALL
    SELECT sr.advance_share_pkr, sr.paid_out_at AT TIME ZONE 'Asia/Karachi' FROM shadi_vehicle_requests sr WHERE sr.payout_voucher_id IS NOT NULL AND sr.paid_out_at IS NOT NULL
    UNION ALL
    SELECT o.delivery_fee_pkr, o.delivered_at AT TIME ZONE 'Asia/Karachi' FROM shop_orders o WHERE o.fulfillment_status = 'delivered' AND o.delivered_at IS NOT NULL
    UNION ALL
    SELECT GREATEST(0, coalesce(c.total_pkr, 0) - coalesce(c.goods_budget_pkr, 0)), c.completed_at AT TIME ZONE 'Asia/Karachi' FROM dispatch_calls c WHERE c.status = 'completed' AND c.completed_at IS NOT NULL
  )
  SELECT COUNT(*) FILTER (WHERE at::date = v_today), COALESCE(SUM(amount) FILTER (WHERE at::date = v_today), 0)
  INTO v_jobs_today, v_cash_today FROM jobs;

  SELECT jsonb_array_length(admin_fleet_locations()) INTO v_vehicles_live;

  SELECT count(*), COALESCE(SUM(-bal), 0) INTO v_wallets_negative_count, v_wallets_negative_total FROM (
    SELECT seller_account_balance(a.id) AS bal FROM accounts a WHERE a.vehicle_id IS NOT NULL
  ) x WHERE bal < 0;

  SELECT COALESCE(SUM(sr.advance_share_pkr), 0) INTO v_advance_held
  FROM shadi_vehicle_requests sr JOIN shadi_events se ON se.id = sr.event_id
  WHERE sr.status = 'accepted' AND se.status = 'confirmed' AND sr.payout_voucher_id IS NULL AND sr.advance_share_pkr IS NOT NULL;

  SELECT count(*) INTO v_pending_topups FROM (
    SELECT id FROM vehicle_wallet_topups WHERE status = 'announced'
    UNION ALL SELECT id FROM shop_wallet_topups WHERE status = 'announced'
  ) x;

  SELECT count(*) INTO v_pending_shadi_advance FROM shadi_events WHERE status = 'advance_announced';
  SELECT count(*) INTO v_open_disputes FROM disputes WHERE status = 'open';

  RETURN jsonb_build_object(
    'jobs_today', v_jobs_today, 'cash_today_pkr', v_cash_today, 'vehicles_live', v_vehicles_live,
    'wallets_negative_count', v_wallets_negative_count, 'wallets_negative_total_pkr', v_wallets_negative_total,
    'advance_held_pkr', v_advance_held,
    'needs_action', jsonb_build_object(
      'pending_wallet_topups', v_pending_topups, 'pending_shadi_advance', v_pending_shadi_advance, 'open_disputes', v_open_disputes
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION admin_marketplace_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_marketplace_overview() TO authenticated;
