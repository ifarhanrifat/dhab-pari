-- Two real gaps found auditing the driver home card against the design:
-- 1. vehicle_dashboard_summary/vehicle_today_ledger (488) predate the
--    equipment_bookings (646) and rental_bookings (653) verticals added
--    this session, so a driver's "today's earnings"/"jobs today" silently
--    undercounted any completed machinery/tractor/loader/rental job.
-- 2. The driver home card has always shown a hardcoded "—" for rating
--    instead of the real vehicle average (ratings table, same
--    target_party_type='vehicle' aggregate as 655 and vehicle_trust_score
--    in 497).

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

CREATE OR REPLACE FUNCTION vehicle_today_ledger(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_result jsonb;
BEGIN
  IF v_portal_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'at') DESC), '[]'::jsonb) INTO v_result FROM (
    SELECT jsonb_build_object('kind', 'route', 'label', r.origin || ' → ' || r.destination, 'amount', b.total_amount_pkr, 'at', b.confirmed_at) AS row
    FROM ride_bookings b JOIN vehicle_routes r ON r.id = b.route_id
    WHERE r.vehicle_id = p_vehicle_id AND b.status = 'confirmed' AND (b.confirmed_at AT TIME ZONE 'Asia/Karachi')::date = v_today
    UNION ALL
    SELECT jsonb_build_object('kind', 'trip', 'label', o.origin || ' → ' || o.destination, 'amount', b.total_amount_pkr, 'at', b.completed_at)
    FROM vehicle_trip_bookings b JOIN vehicle_trip_offers o ON o.id = b.trip_offer_id
    WHERE b.vehicle_id = p_vehicle_id AND b.status = 'completed' AND (b.completed_at AT TIME ZONE 'Asia/Karachi')::date = v_today
    UNION ALL
    SELECT jsonb_build_object('kind', 'hourly', 'label', b.hours || 'h — ' || b.pickup_address, 'amount', coalesce(b.total_amount_pkr, b.base_amount_pkr), 'at', b.ended_at)
    FROM hourly_bookings b
    WHERE b.vehicle_id = p_vehicle_id AND b.status_confirmed AND (b.ended_at AT TIME ZONE 'Asia/Karachi')::date = v_today
    UNION ALL
    SELECT jsonb_build_object('kind', 'shadi', 'label', to_char(se.event_date, 'DD Mon'), 'amount', sr.advance_share_pkr, 'at', sr.paid_out_at)
    FROM shadi_vehicle_requests sr JOIN shadi_events se ON se.id = sr.event_id
    WHERE sr.vehicle_id = p_vehicle_id AND sr.payout_voucher_id IS NOT NULL AND (sr.paid_out_at AT TIME ZONE 'Asia/Karachi')::date = v_today
    UNION ALL
    SELECT jsonb_build_object('kind', 'delivery', 'label', s.name, 'amount', o.delivery_fee_pkr, 'at', o.delivered_at)
    FROM shop_orders o JOIN shops s ON s.id = o.shop_id
    WHERE o.delivery_vehicle_id = p_vehicle_id AND o.fulfillment_status = 'delivered' AND (o.delivered_at AT TIME ZONE 'Asia/Karachi')::date = v_today
    UNION ALL
    SELECT jsonb_build_object('kind', 'dispatch', 'label', c.item, 'amount', GREATEST(0, coalesce(c.total_pkr, 0) - coalesce(c.goods_budget_pkr, 0)), 'at', c.completed_at)
    FROM dispatch_calls c
    WHERE c.accepted_vehicle_id = p_vehicle_id AND c.status = 'completed' AND (c.completed_at AT TIME ZONE 'Asia/Karachi')::date = v_today
    UNION ALL
    SELECT jsonb_build_object('kind', 'equipment', 'label', b.kind || ' — ' || b.site_address, 'amount', b.total_amount_pkr, 'at', b.ended_at)
    FROM equipment_bookings b
    WHERE b.vehicle_id = p_vehicle_id AND b.status_confirmed AND (b.ended_at AT TIME ZONE 'Asia/Karachi')::date = v_today
    UNION ALL
    SELECT jsonb_build_object('kind', 'rental', 'label', b.from_address || ' → ' || b.to_address, 'amount', b.total_amount_pkr, 'at', b.ended_at)
    FROM rental_bookings b
    WHERE b.vehicle_id = p_vehicle_id AND b.status_confirmed AND (b.ended_at AT TIME ZONE 'Asia/Karachi')::date = v_today
  ) rows;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE;
REVOKE ALL ON FUNCTION vehicle_today_ledger(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_today_ledger(uuid) TO authenticated;
