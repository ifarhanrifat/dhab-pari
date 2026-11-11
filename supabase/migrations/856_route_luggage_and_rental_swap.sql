-- Migration 856: fleet accounting, Phase 2b — route-aware luggage
-- (its own fare, separate from a seat) and full-day rental vehicle
-- swap. Shadi (wedding) swap deliberately NOT built here — see note
-- below, the existing withdraw/invite-replacement flow already covers
-- it correctly and a fleet-initiated override would bypass the
-- customer's legitimate say over which vehicle shows up.
--
-- parcel_deliveries (702) confirmed NOT reused — it's a point-to-point
-- ring-dispatch system with no vehicle_routes FK at all. Luggage here
-- is deliberately its own simple table, scoped to a route, mirroring
-- manual_ride_bookings' (855) shape: staff enters the fare directly
-- (same "cashier physically present, no negotiation RPC needed" logic
-- as a walk-up seat sale).

-- ═════════════════════════════════════════════════════════════════════
-- 1. route_luggage_bookings
-- ═════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS route_luggage_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES vehicle_routes(id) ON DELETE CASCADE,
  counter_id uuid REFERENCES fleet_counters(id),
  recorded_by_portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  travel_date date NOT NULL,
  sender_name varchar NOT NULL,
  sender_mobile varchar,
  receiver_name varchar NOT NULL,
  receiver_mobile varchar NOT NULL,
  description text NOT NULL,
  fare_pkr decimal NOT NULL CHECK (fare_pkr >= 0),
  payment_method varchar NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'jazzcash', 'easypaisa', 'bank')),
  status varchar NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'loaded', 'in_transit', 'delivered', 'cancelled')),
  loaded_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS route_luggage_bookings_route_date_idx ON route_luggage_bookings(route_id, travel_date);
ALTER TABLE route_luggage_bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "route_luggage_bookings_manager_read" ON route_luggage_bookings FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM vehicle_routes vr WHERE vr.id = route_id AND can_manage_vehicle(vr.vehicle_id)) OR current_admin_permission('manage_parties'));
-- No INSERT/UPDATE/DELETE policy — SECURITY DEFINER RPC only.

CREATE OR REPLACE FUNCTION record_luggage_booking(
  p_route_id uuid, p_travel_date date, p_sender_name varchar, p_receiver_name varchar, p_receiver_mobile varchar, p_description text, p_fare_pkr decimal,
  p_counter_id uuid DEFAULT NULL, p_sender_mobile varchar DEFAULT NULL, p_payment_method varchar DEFAULT 'cash'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_route vehicle_routes%ROWTYPE; v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF trim(coalesce(p_sender_name, '')) = '' OR trim(coalesce(p_receiver_name, '')) = '' OR trim(coalesce(p_receiver_mobile, '')) = '' THEN
    RAISE EXCEPTION 'Sender name, receiver name and receiver mobile are required.' USING ERRCODE = 'P0001';
  END IF;
  IF trim(coalesce(p_description, '')) = '' THEN RAISE EXCEPTION 'Describe what''s being sent.' USING ERRCODE = 'P0001'; END IF;
  IF p_fare_pkr IS NULL OR p_fare_pkr < 0 THEN RAISE EXCEPTION 'Enter the fare collected.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO route_luggage_bookings (route_id, counter_id, recorded_by_portal_user_id, travel_date, sender_name, sender_mobile, receiver_name, receiver_mobile, description, fare_pkr, payment_method)
  VALUES (p_route_id, p_counter_id, v_portal_user_id, p_travel_date, trim(p_sender_name), nullif(trim(coalesce(p_sender_mobile, '')), ''), trim(p_receiver_name), trim(p_receiver_mobile), trim(p_description), p_fare_pkr, p_payment_method)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION record_luggage_booking(uuid, date, varchar, varchar, varchar, text, decimal, uuid, varchar, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_luggage_booking(uuid, date, varchar, varchar, varchar, text, decimal, uuid, varchar, varchar) TO authenticated;

CREATE OR REPLACE FUNCTION update_luggage_status(p_id uuid, p_status varchar) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route_id uuid;
BEGIN
  IF p_status NOT IN ('loaded', 'in_transit', 'delivered', 'cancelled') THEN RAISE EXCEPTION 'Invalid status.' USING ERRCODE = 'P0001'; END IF;
  SELECT route_id INTO v_route_id FROM route_luggage_bookings WHERE id = p_id FOR UPDATE;
  IF v_route_id IS NULL THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicle_routes vr WHERE vr.id = v_route_id AND can_manage_vehicle(vr.vehicle_id)) THEN
    RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE route_luggage_bookings SET
    status = p_status,
    loaded_at = CASE WHEN p_status = 'loaded' THEN now() ELSE loaded_at END,
    delivered_at = CASE WHEN p_status = 'delivered' THEN now() ELSE delivered_at END
  WHERE id = p_id;
END;
$$;
REVOKE ALL ON FUNCTION update_luggage_status(uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION update_luggage_status(uuid, varchar) TO authenticated;

CREATE OR REPLACE FUNCTION route_luggage_today(p_route_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', lb.id, 'sender_name', lb.sender_name, 'receiver_name', lb.receiver_name, 'receiver_mobile', lb.receiver_mobile,
    'description', lb.description, 'fare_pkr', lb.fare_pkr, 'status', lb.status, 'created_at', lb.created_at
  ) ORDER BY lb.created_at DESC), '[]'::jsonb)
  FROM route_luggage_bookings lb JOIN vehicle_routes vr ON vr.id = lb.route_id
  WHERE lb.route_id = p_route_id AND lb.travel_date = (now() AT TIME ZONE 'Asia/Karachi')::date AND lb.status != 'cancelled'
    AND can_manage_vehicle(vr.vehicle_id);
$$;
REVOKE ALL ON FUNCTION route_luggage_today(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION route_luggage_today(uuid) TO authenticated;

-- vehicle_dashboard_summary (855) — luggage fares now count toward
-- gross earnings too, same UNION pattern as every other job type.
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
  IF NOT can_manage_vehicle(p_vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = p_vehicle_id;

  v_balance := seller_account_balance(ensure_vehicle_account(p_vehicle_id));

  WITH jobs AS (
    SELECT b.total_amount_pkr AS amount, b.confirmed_at AT TIME ZONE 'Asia/Karachi' AS at
    FROM ride_bookings b JOIN vehicle_routes r ON r.id = b.route_id
    WHERE r.vehicle_id = p_vehicle_id AND b.status = 'confirmed'
    UNION ALL
    SELECT mb.total_amount_pkr, mb.created_at AT TIME ZONE 'Asia/Karachi'
    FROM manual_ride_bookings mb JOIN vehicle_routes r ON r.id = mb.route_id
    WHERE r.vehicle_id = p_vehicle_id AND mb.status = 'confirmed'
    UNION ALL
    SELECT lb.fare_pkr, lb.created_at AT TIME ZONE 'Asia/Karachi'
    FROM route_luggage_bookings lb JOIN vehicle_routes r ON r.id = lb.route_id
    WHERE r.vehicle_id = p_vehicle_id AND lb.status != 'cancelled'
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
    'commission_pct', vehicle_commission_pct(v_vehicle.vehicle_type, 'intercity'),
    'today_earnings_pkr', v_today_earnings, 'month_earnings_pkr', v_month_earnings,
    'today_jobs_count', v_today_jobs, 'month_jobs_count', v_month_jobs,
    'pending_bookings_count', v_pending_bookings,
    'last_settlement_date', v_last_settle.settled_date, 'last_settlement_amount', v_last_settle.amount_pkr,
    'avg_rating', v_avg_rating
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════
-- 2. Full-day rental vehicle swap — same category required, both the
--    old and new vehicle must be manageable by the caller (i.e. same
--    fleet). Confirmed deliberately NOT building a shadi equivalent:
--    invite_shadi_replacement (481) requires the CUSTOMER (not the
--    vehicle owner) to invite a replacement — correct, since the
--    customer chose which specific vehicles would be at their wedding.
--    A fleet silently substituting one of their own without the
--    customer's say would bypass that, so the existing two-step flow
--    (driver withdraws, customer invites any replacement — already
--    works for another vehicle in the same fleet with zero new code)
--    is left exactly as it is.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fleet_swap_rental_vehicle(p_booking_id uuid, p_new_vehicle_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b rental_bookings%ROWTYPE; v_old_category uuid; v_new_category uuid; v_new_owner varchar;
BEGIN
  SELECT * INTO b FROM rental_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF b.status NOT IN ('accepted', 'in_progress') THEN RAISE EXCEPTION 'This booking can no longer be swapped.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(b.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this booking''s vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(p_new_vehicle_id) THEN RAISE EXCEPTION 'You do not manage the replacement vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF p_new_vehicle_id = b.vehicle_id THEN RAISE EXCEPTION 'That is already this booking''s vehicle.' USING ERRCODE = 'P0001'; END IF;

  SELECT category_id INTO v_old_category FROM vehicles WHERE id = b.vehicle_id;
  SELECT category_id, owner_name INTO v_new_category, v_new_owner FROM vehicles WHERE id = p_new_vehicle_id AND is_active;
  IF v_new_owner IS NULL THEN RAISE EXCEPTION 'Pick an active vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF v_old_category IS DISTINCT FROM v_new_category THEN RAISE EXCEPTION 'Pick a vehicle in the same category.' USING ERRCODE = 'P0001'; END IF;

  UPDATE rental_bookings SET vehicle_id = p_new_vehicle_id WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'rental_vehicle_swapped', 'Your rental vehicle was replaced',
    'A different vehicle (' || v_new_owner || ') of the same category will now fulfil your booking.', '/portal/marketplace/trips');
END;
$$;
REVOKE ALL ON FUNCTION fleet_swap_rental_vehicle(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_swap_rental_vehicle(uuid, uuid) TO authenticated;
