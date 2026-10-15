-- Adds the real per-order commission percentage (vehicle_commission_pct,
-- 394) to vehicle_dashboard_summary's return, so the driver home card's
-- wallet-summary row can show the real rate instead of a hardcoded guess.
CREATE OR REPLACE FUNCTION vehicle_dashboard_summary(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_vehicle vehicles%ROWTYPE;
  v_balance decimal := 0;
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_today_earnings decimal := 0; v_month_earnings decimal := 0;
  v_today_jobs int := 0; v_month_jobs int := 0;
  v_pending_bookings int;
  v_last_settle RECORD;
  v_avg_rating decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in required.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;

  v_balance := seller_account_balance(ensure_vehicle_account(p_vehicle_id));

  WITH jobs AS (
    SELECT b.total_amount_pkr AS amount, b.confirmed_at AT TIME ZONE 'Asia/Karachi' AS at
    FROM ride_bookings b JOIN vehicle_routes r ON r.id = b.route_id
    WHERE r.vehicle_id = p_vehicle_id AND b.status = 'confirmed'
    UNION ALL
    SELECT b.total_amount_pkr, b.completed_at AT TIME ZONE 'Asia/Karachi'
    FROM vehicle_trip_bookings b
    WHERE b.vehicle_id = p_vehicle_id AND b.status = 'completed' AND b.completed_at IS NOT NULL
    UNION ALL
    SELECT coalesce(b.total_amount_pkr, b.base_amount_pkr), b.ended_at AT TIME ZONE 'Asia/Karachi'
    FROM hourly_bookings b
    WHERE b.vehicle_id = p_vehicle_id AND b.status_confirmed AND b.ended_at IS NOT NULL
    UNION ALL
    SELECT sr.advance_share_pkr, sr.paid_out_at AT TIME ZONE 'Asia/Karachi'
    FROM shadi_vehicle_requests sr
    WHERE sr.vehicle_id = p_vehicle_id AND sr.payout_voucher_id IS NOT NULL AND sr.paid_out_at IS NOT NULL
    UNION ALL
    SELECT o.delivery_fee_pkr, o.delivered_at AT TIME ZONE 'Asia/Karachi'
    FROM shop_orders o
    WHERE o.delivery_vehicle_id = p_vehicle_id AND o.fulfillment_status = 'delivered' AND o.delivered_at IS NOT NULL
    UNION ALL
    SELECT GREATEST(0, coalesce(c.total_pkr, 0) - coalesce(c.goods_budget_pkr, 0)), c.completed_at AT TIME ZONE 'Asia/Karachi'
    FROM dispatch_calls c
    WHERE c.accepted_vehicle_id = p_vehicle_id AND c.status = 'completed' AND c.completed_at IS NOT NULL
    UNION ALL
    SELECT b.total_amount_pkr, b.ended_at AT TIME ZONE 'Asia/Karachi'
    FROM equipment_bookings b
    WHERE b.vehicle_id = p_vehicle_id AND b.status_confirmed AND b.ended_at IS NOT NULL
    UNION ALL
    SELECT b.total_amount_pkr, b.ended_at AT TIME ZONE 'Asia/Karachi'
    FROM rental_bookings b
    WHERE b.vehicle_id = p_vehicle_id AND b.status_confirmed AND b.ended_at IS NOT NULL
  )
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE at::date = v_today), 0),
    COALESCE(SUM(amount) FILTER (WHERE date_trunc('month', at) = date_trunc('month', v_today::timestamp)), 0),
    COUNT(*) FILTER (WHERE at::date = v_today),
    COUNT(*) FILTER (WHERE date_trunc('month', at) = date_trunc('month', v_today::timestamp))
  INTO v_today_earnings, v_month_earnings, v_today_jobs, v_month_jobs
  FROM jobs;

  SELECT count(*) INTO v_pending_bookings FROM ride_bookings b JOIN vehicle_routes r ON r.id = b.route_id
    WHERE r.vehicle_id = p_vehicle_id AND b.status = 'announced';

  SELECT settled_date, amount_pkr INTO v_last_settle FROM collector_settlements WHERE vehicle_id = p_vehicle_id ORDER BY settled_date DESC LIMIT 1;

  SELECT round(avg(r.stars)::numeric, 1) INTO v_avg_rating FROM ratings r WHERE r.target_party_type = 'vehicle' AND r.target_party_id = p_vehicle_id;

  RETURN jsonb_build_object(
    'balance_pkr', v_balance, 'commission_mode', v_vehicle.commission_mode, 'lumpsum_fee_pkr', v_vehicle.lumpsum_fee_pkr,
    'commission_pct', vehicle_commission_pct(v_vehicle.vehicle_type, v_vehicle.classification),
    'today_earnings_pkr', v_today_earnings, 'month_earnings_pkr', v_month_earnings,
    'today_jobs_count', v_today_jobs, 'month_jobs_count', v_month_jobs,
    'pending_bookings_count', v_pending_bookings,
    'last_settlement_date', v_last_settle.settled_date, 'last_settlement_amount', v_last_settle.amount_pkr,
    'avg_rating', v_avg_rating
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_dashboard_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_dashboard_summary(uuid) TO authenticated;
