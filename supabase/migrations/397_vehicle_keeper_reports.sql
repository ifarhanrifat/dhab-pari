-- Migration 397: a driver's own bookings weren't readable by them at all
-- (ride_bookings only had admin-read and the RIDER's own read — missed
-- when 393 gave shop_orders its keeper-read policy), plus the vehicle
-- equivalent of shop_dashboard_summary/shop_daily_earnings so
-- /portal/my-vehicle has real numbers to show, same shape as
-- /portal/my-shop/reports.
CREATE POLICY "ride_bookings_keeper_read" ON ride_bookings FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM vehicle_routes r JOIN vehicles v ON v.id = r.vehicle_id WHERE r.id = route_id AND v.portal_user_id = current_portal_user_id()));

CREATE OR REPLACE FUNCTION vehicle_dashboard_summary(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_vehicle vehicles%ROWTYPE;
  v_balance decimal := 0;
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_today_earnings decimal; v_month_earnings decimal;
  v_pending_bookings int;
  v_last_settle RECORD;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in required.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;

  v_balance := seller_account_balance(ensure_vehicle_account(p_vehicle_id));

  SELECT COALESCE(SUM(b.total_amount_pkr), 0) INTO v_today_earnings FROM ride_bookings b JOIN vehicle_routes r ON r.id = b.route_id
    WHERE r.vehicle_id = p_vehicle_id AND b.status = 'confirmed' AND (b.confirmed_at AT TIME ZONE 'Asia/Karachi')::date = v_today;
  SELECT COALESCE(SUM(b.total_amount_pkr), 0) INTO v_month_earnings FROM ride_bookings b JOIN vehicle_routes r ON r.id = b.route_id
    WHERE r.vehicle_id = p_vehicle_id AND b.status = 'confirmed' AND date_trunc('month', b.confirmed_at AT TIME ZONE 'Asia/Karachi') = date_trunc('month', v_today::timestamp);

  SELECT count(*) INTO v_pending_bookings FROM ride_bookings b JOIN vehicle_routes r ON r.id = b.route_id
    WHERE r.vehicle_id = p_vehicle_id AND b.status = 'announced';

  SELECT settled_date, amount_pkr INTO v_last_settle FROM collector_settlements WHERE vehicle_id = p_vehicle_id ORDER BY settled_date DESC LIMIT 1;

  RETURN jsonb_build_object(
    'balance_pkr', v_balance, 'commission_mode', v_vehicle.commission_mode, 'lumpsum_fee_pkr', v_vehicle.lumpsum_fee_pkr,
    'today_earnings_pkr', v_today_earnings, 'month_earnings_pkr', v_month_earnings, 'pending_bookings_count', v_pending_bookings,
    'last_settlement_date', v_last_settle.settled_date, 'last_settlement_amount', v_last_settle.amount_pkr
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_dashboard_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_dashboard_summary(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION vehicle_daily_earnings(p_vehicle_id uuid, p_days int DEFAULT 14) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_result jsonb;
BEGIN
  IF v_portal_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('date', d.day, 'total_pkr', COALESCE(e.total, 0)) ORDER BY d.day), '[]'::jsonb)
  INTO v_result
  FROM generate_series((now() AT TIME ZONE 'Asia/Karachi')::date - (p_days - 1), (now() AT TIME ZONE 'Asia/Karachi')::date, '1 day') d(day)
  LEFT JOIN (
    SELECT (b.confirmed_at AT TIME ZONE 'Asia/Karachi')::date AS day, SUM(b.total_amount_pkr) AS total
    FROM ride_bookings b JOIN vehicle_routes r ON r.id = b.route_id
    WHERE r.vehicle_id = p_vehicle_id AND b.status = 'confirmed' GROUP BY 1
  ) e ON e.day = d.day;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_daily_earnings(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_daily_earnings(uuid, int) TO authenticated;
