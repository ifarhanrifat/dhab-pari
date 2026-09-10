-- Two real gaps found while rebuilding the driver dashboard to match
-- the v2 design's own hero (today/month stat tiles + a ledger list):
--
-- 1. complete_dispatch_call (423) never posted anything to the ledger
--    at all — every other income flow this app has (routes 410,
--    one-off trips 400, hourly 475, shop delivery 432) draws a
--    per_order driver's commission via a voucher the moment a job
--    completes; dispatch alone had no such step. A per_order driver
--    could run unlimited city-dispatch deliveries and never owe the
--    committee anything for them. Fixed the same way as the others:
--    commission on the FEE portion only (total_pkr - goods_budget_pkr
--    — the goods_budget is money the driver fronted buying things for
--    the customer and gets reimbursed for, not income), gated to
--    commission_mode = 'per_order' exactly like every sibling flow.
--
-- 2. vehicle_dashboard_summary (397) only ever summed ride_bookings —
--    the only income source that existed when it was written. Every
--    flow built since (trip-share, hourly, shadi, dispatch, shop
--    delivery) posts real money through the general ledger (the
--    wallet BALANCE figure was always correct, since that reads the
--    account directly), but a driver's own "today/this month" earnings
--    convenience figures silently excluded five of six income sources.
--    Rewritten to aggregate all six; new vehicle_today_ledger() gives
--    the driver the itemized list the new dashboard hero shows.

CREATE OR REPLACE FUNCTION complete_dispatch_call(p_call_id uuid) RETURNS void AS $$
DECLARE
  c dispatch_calls%ROWTYPE; v vehicles%ROWTYPE;
  v_vehicle_account uuid; v_commission_account uuid; v_commission_pct decimal; v_fee_portion decimal; v_commission_amount decimal := 0;
  v_commission_voucher_id uuid;
BEGIN
  SELECT * INTO c FROM dispatch_calls WHERE id = p_call_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Call not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = c.accepted_vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this delivery.' USING ERRCODE = 'P0001';
  END IF;
  IF c.status <> 'approved' THEN RAISE EXCEPTION 'This call is not awaiting completion.' USING ERRCODE = 'P0001'; END IF;
  UPDATE dispatch_calls SET status = 'completed', completed_at = now() WHERE id = p_call_id;

  IF v.commission_mode = 'per_order' THEN
    v_fee_portion := GREATEST(0, COALESCE(c.total_pkr, 0) - COALESCE(c.goods_budget_pkr, 0));
    IF v_fee_portion > 0 THEN
      v_vehicle_account := ensure_vehicle_account(v.id);
      SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050';
      v_commission_pct := COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_dispatch_commission_pct'), 0);
      v_commission_amount := round(v_fee_portion * v_commission_pct / 100, 2);
      IF v_commission_amount > 0 THEN
        INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
        VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
          'Marketplace commission — city dispatch: ' || c.item || ' (paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
        RETURNING id INTO v_commission_voucher_id;
        UPDATE dispatch_calls SET commission_voucher_id = v_commission_voucher_id WHERE id = p_call_id;
      END IF;
      PERFORM check_seller_balance_notify('vehicle', v.id);
    END IF;
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (c.initiator_portal_user_id, 'dispatch_completed', 'Delivered', c.item, '/portal/marketplace/dispatch/' || p_call_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION complete_dispatch_call(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION complete_dispatch_call(uuid) TO authenticated;

ALTER TABLE dispatch_calls ADD COLUMN IF NOT EXISTS commission_voucher_id uuid REFERENCES vouchers(id);

INSERT INTO site_settings (key, value, description) VALUES
  ('marketplace_dispatch_commission_pct', '10', 'Committee''s commission on a completed city-dispatch delivery (per_order vehicles), as a percentage of the fee portion only (total minus goods reimbursement)')
ON CONFLICT (key) DO NOTHING;

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
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in required.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;

  v_balance := seller_account_balance(ensure_vehicle_account(p_vehicle_id));

  -- Every real income source, unioned — matches exactly what actually
  -- posts a voucher crediting this vehicle's account (the balance
  -- above), so "today/month earnings" and "balance" never disagree
  -- about what counts as a completed job.
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

  RETURN jsonb_build_object(
    'balance_pkr', v_balance, 'commission_mode', v_vehicle.commission_mode, 'lumpsum_fee_pkr', v_vehicle.lumpsum_fee_pkr,
    'today_earnings_pkr', v_today_earnings, 'month_earnings_pkr', v_month_earnings,
    'today_jobs_count', v_today_jobs, 'month_jobs_count', v_month_jobs,
    'pending_bookings_count', v_pending_bookings,
    'last_settlement_date', v_last_settle.settled_date, 'last_settlement_amount', v_last_settle.amount_pkr
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_dashboard_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_dashboard_summary(uuid) TO authenticated;

-- Itemized "today" list — the design's own TODAY'S LEDGER. Same six
-- sources as the summary above, one row per job, most recent first.
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
  ) rows;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE;
REVOKE ALL ON FUNCTION vehicle_today_ledger(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_today_ledger(uuid) TO authenticated;
