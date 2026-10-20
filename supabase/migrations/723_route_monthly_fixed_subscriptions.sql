-- Migration 723: "Teacher Van" — a monthly-fixed subscription model for
-- a recurring Route, alongside the existing per-date open-booking
-- model. Riders pay a flat monthly fee (proportional to their own
-- boarding distance, not one number for everyone) instead of a
-- per-ride fare, and hold the seat whether they ride that day or not.
--
-- Reuses this app's own existing patterns rather than inventing a
-- parallel system (confirmed live before writing this):
-- - Monthly idempotent charge generation: same UNIQUE(entity, period)
--   + ON CONFLICT DO NOTHING shape as `bills` (001) and
--   `vehicle_lumpsum_charges` (396).
-- - Collection: this app has NO portal_user/rider wallet anywhere —
--   every payment is manual (cash/JazzCash/bank + a slip, or paid
--   directly to a per_order driver and marked fulfilled). This mirrors
--   `confirm_ride_booking`'s own per_order branch exactly: the driver
--   marks a charge paid, which posts a REAL voucher crediting
--   ensure_vehicle_account() and deducting the usual commission — the
--   same accounting path, not a flag.
-- - FIFO waitlist promotion: same shape as `adda_promote_next()` (409).
-- - Voucher direction, confirmed from the actual trigger (009,
--   trg_voucher_ledger): from_account_id is CREDITED, to_account_id is
--   DEBITED. Matched exactly to confirm_ride_booking's own two
--   branches (fare credits the vehicle; commission then debits it back).

ALTER TABLE vehicle_routes ADD COLUMN IF NOT EXISTS is_monthly_fixed boolean NOT NULL DEFAULT false;
ALTER TABLE vehicle_routes ADD COLUMN IF NOT EXISTS monthly_reference_fee_pkr numeric;

CREATE TABLE IF NOT EXISTS route_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES vehicle_routes(id) ON DELETE CASCADE,
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  board_stop_id uuid REFERENCES route_stops(id),
  status varchar NOT NULL CHECK (status IN ('active', 'waitlisted', 'pending_cancellation', 'cancelled')),
  monthly_fee_pkr numeric NOT NULL CHECK (monthly_fee_pkr >= 0),
  queue_position int,
  applied_at timestamptz NOT NULL DEFAULT now(),
  scheduled_cancellation_at timestamptz,
  cancellation_reason text
);
CREATE INDEX IF NOT EXISTS route_subscriptions_route_id_idx ON route_subscriptions(route_id);
-- A rider can re-apply after leaving, but never holds two live rows at once.
CREATE UNIQUE INDEX IF NOT EXISTS route_subscriptions_one_live_per_rider
  ON route_subscriptions(route_id, portal_user_id) WHERE status != 'cancelled';

CREATE TABLE IF NOT EXISTS route_subscription_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES route_subscriptions(id) ON DELETE CASCADE,
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  year int NOT NULL,
  amount_pkr numeric NOT NULL,
  status varchar NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'paid')),
  paid_at timestamptz,
  marked_paid_by uuid,
  voucher_id uuid,
  UNIQUE (subscription_id, month, year)
);
CREATE INDEX IF NOT EXISTS route_subscription_charges_subscription_id_idx ON route_subscription_charges(subscription_id);

ALTER TABLE route_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "route_subscriptions_self_read" ON route_subscriptions FOR SELECT TO authenticated
  USING (portal_user_id = current_portal_user_id() OR is_route_owner(route_id));

ALTER TABLE route_subscription_charges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "route_subscription_charges_self_read" ON route_subscription_charges FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM route_subscriptions rs WHERE rs.id = subscription_id AND (rs.portal_user_id = current_portal_user_id() OR is_route_owner(rs.route_id))));

-- ═════════════════════════════════════════════════════════════════════
-- create_vehicle_route_self gains the monthly-fixed toggle + reference
-- fee — reproduced verbatim from the live body (confirmed via
-- pg_get_functiondef), only the two new params + two new INSERT
-- columns added.
-- ═════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.create_vehicle_route_self(uuid, character varying, character varying, character varying, character varying, numeric, time without time zone, integer[], character varying, character varying, numeric, numeric, numeric, numeric, numeric, jsonb, numeric, time without time zone);

CREATE OR REPLACE FUNCTION public.create_vehicle_route_self(p_vehicle_id uuid, p_origin character varying, p_destination character varying, p_classification character varying, p_fare_mode character varying, p_total_fare_pkr numeric DEFAULT NULL::numeric, p_departure_time time without time zone DEFAULT NULL::time without time zone, p_days_of_week integer[] DEFAULT '{}'::integer[], p_origin_ur character varying DEFAULT NULL::character varying, p_destination_ur character varying DEFAULT NULL::character varying, p_origin_lat numeric DEFAULT NULL::numeric, p_origin_lng numeric DEFAULT NULL::numeric, p_destination_lat numeric DEFAULT NULL::numeric, p_destination_lng numeric DEFAULT NULL::numeric, p_distance_km numeric DEFAULT NULL::numeric, p_route_path jsonb DEFAULT NULL::jsonb, p_route_duration_min numeric DEFAULT NULL::numeric, p_return_departure_time time without time zone DEFAULT NULL::time without time zone, p_is_monthly_fixed boolean DEFAULT false, p_monthly_reference_fee_pkr numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_tenant_id uuid;
  v_seats int;
  v_per_seat decimal;
  v_id uuid;
  v_fair_per_seat decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required';
  END IF;

  SELECT tenant_id, total_seats INTO v_tenant_id, v_seats
    FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id AND is_active = true;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'You can only post a route for your own vehicle';
  END IF;

  IF EXISTS (SELECT 1 FROM vehicle_routes WHERE vehicle_id = p_vehicle_id AND is_active = true) THEN
    RAISE EXCEPTION 'You already have an active route posted — close it before posting a new one.' USING ERRCODE = 'P0001';
  END IF;

  IF coalesce(trim(p_origin), '') = '' OR coalesce(trim(p_destination), '') = '' THEN
    RAISE EXCEPTION 'Origin and destination are required';
  END IF;
  IF p_days_of_week IS NULL OR array_length(p_days_of_week, 1) IS NULL THEN
    RAISE EXCEPTION 'Pick at least one day';
  END IF;

  IF p_is_monthly_fixed THEN
    IF p_monthly_reference_fee_pkr IS NULL OR p_monthly_reference_fee_pkr <= 0 THEN
      RAISE EXCEPTION 'Enter the monthly reference fee';
    END IF;
    -- A monthly-fixed route doesn't sell per-trip seats at all — these
    -- columns stay NOT NULL-satisfying placeholders, never read for
    -- this route.
    p_total_fare_pkr := 0;
    v_per_seat := 0;
  ELSE
    IF p_distance_km IS NOT NULL THEN
      v_fair_per_seat := (fare_band_for('route', p_distance_km)->>'fair')::decimal;
      IF v_fair_per_seat IS NOT NULL THEN
        IF p_total_fare_pkr IS NULL THEN
          p_total_fare_pkr := round(v_fair_per_seat * greatest(1, coalesce(v_seats, 1)));
        ELSIF round(p_total_fare_pkr / greatest(1, coalesce(v_seats, 1))) > round(v_fair_per_seat) THEN
          RAISE EXCEPTION 'The fair fare per seat for this distance is ₨% (₨% total across % seats) — you can list that or less, not more.', round(v_fair_per_seat), round(v_fair_per_seat * greatest(1, coalesce(v_seats, 1))), greatest(1, coalesce(v_seats, 1)) USING ERRCODE = 'P0001';
        END IF;
      END IF;
    END IF;

    IF p_total_fare_pkr IS NULL OR p_total_fare_pkr <= 0 THEN
      RAISE EXCEPTION 'Enter the total fare';
    END IF;

    v_per_seat := round(p_total_fare_pkr / greatest(1, coalesce(v_seats, 1)));
  END IF;

  INSERT INTO vehicle_routes (
    vehicle_id, tenant_id, origin, origin_ur, destination, destination_ur,
    classification, fare_mode, total_fare_pkr, fare_per_seat_pkr,
    departure_time, days_of_week, is_active,
    origin_lat, origin_lng, destination_lat, destination_lng, distance_km,
    route_path, route_duration_min, return_departure_time,
    is_monthly_fixed, monthly_reference_fee_pkr
  ) VALUES (
    p_vehicle_id, v_tenant_id, trim(p_origin), nullif(trim(coalesce(p_origin_ur, '')), ''), trim(p_destination), nullif(trim(coalesce(p_destination_ur, '')), ''),
    p_classification, p_fare_mode, p_total_fare_pkr, v_per_seat,
    p_departure_time, p_days_of_week, true,
    p_origin_lat, p_origin_lng, p_destination_lat, p_destination_lng, p_distance_km,
    p_route_path, p_route_duration_min, p_return_departure_time,
    p_is_monthly_fixed, p_monthly_reference_fee_pkr
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION set_route_monthly_pricing(p_route_id uuid, p_is_monthly_fixed boolean, p_monthly_reference_fee_pkr numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only edit your own route.' USING ERRCODE = 'P0001'; END IF;
  IF p_is_monthly_fixed AND (p_monthly_reference_fee_pkr IS NULL OR p_monthly_reference_fee_pkr <= 0) THEN
    RAISE EXCEPTION 'Enter the monthly reference fee' USING ERRCODE = 'P0001';
  END IF;
  UPDATE vehicle_routes SET is_monthly_fixed = p_is_monthly_fixed, monthly_reference_fee_pkr = p_monthly_reference_fee_pkr WHERE id = p_route_id;
END;
$$;
GRANT EXECUTE ON FUNCTION set_route_monthly_pricing(uuid, boolean, numeric) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- Per-rider distance-proportional pricing — same point-to-path loop
-- style as villages_near_path (717) / the client's estimateArrivalTime.
-- Computed server-side since it directly sets what a rider is charged.
-- ═════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS route_fraction_remaining(uuid, numeric, numeric);

CREATE OR REPLACE FUNCTION route_fraction_remaining(p_route_id uuid, p_lat double precision, p_lng double precision)
RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_path jsonb;
  v_point record;
  v_prev record;
  v_cum numeric[] := ARRAY[0];
  v_total numeric;
  v_best_idx int := 0;
  v_best_dist numeric := 999999;
  v_idx int := 0;
  v_dist numeric;
BEGIN
  SELECT route_path INTO v_path FROM vehicle_routes WHERE id = p_route_id;
  IF v_path IS NULL OR jsonb_array_length(v_path) < 2 THEN RETURN 1; END IF;

  v_prev := NULL;
  FOR v_point IN SELECT (p->>'lat')::decimal AS lat, (p->>'lng')::decimal AS lng FROM jsonb_array_elements(v_path) p LOOP
    IF v_prev IS NOT NULL THEN
      v_cum := array_append(v_cum, v_cum[array_length(v_cum, 1)] + haversine_km(v_prev.lat, v_prev.lng, v_point.lat, v_point.lng));
    END IF;
    v_dist := haversine_km(p_lat::decimal, p_lng::decimal, v_point.lat, v_point.lng);
    IF v_dist < v_best_dist THEN v_best_dist := v_dist; v_best_idx := v_idx; END IF;
    v_prev := v_point;
    v_idx := v_idx + 1;
  END LOOP;

  v_total := v_cum[array_length(v_cum, 1)];
  IF v_total <= 0 THEN RETURN 1; END IF;
  RETURN greatest(0, least(1, (v_total - v_cum[v_best_idx + 1]) / v_total));
END;
$$;
GRANT EXECUTE ON FUNCTION route_fraction_remaining(uuid, double precision, double precision) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- Apply / leave / waitlist promotion.
-- ═════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION apply_for_monthly_seat(p_route_id uuid, p_board_stop_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE;
  v_stop route_stops%ROWTYPE;
  v_seats int;
  v_active_count int;
  v_fraction numeric;
  v_fee numeric;
  v_status varchar;
  v_queue_position int;
  v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND is_active = true;
  IF NOT FOUND OR NOT v_route.is_monthly_fixed THEN RAISE EXCEPTION 'This route is not a monthly-fixed service.' USING ERRCODE = 'P0001'; END IF;

  IF EXISTS (SELECT 1 FROM route_subscriptions WHERE route_id = p_route_id AND portal_user_id = v_portal_user_id AND status != 'cancelled') THEN
    RAISE EXCEPTION 'You already have a subscription on this route.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_stop FROM route_stops WHERE id = p_board_stop_id AND route_id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pick a real stop on this route.' USING ERRCODE = 'P0001'; END IF;

  v_fraction := route_fraction_remaining(p_route_id, v_stop.lat, v_stop.lng);
  v_fee := round(v_route.monthly_reference_fee_pkr * v_fraction);

  SELECT total_seats INTO v_seats FROM vehicles WHERE id = v_route.vehicle_id;
  SELECT count(*) INTO v_active_count FROM route_subscriptions WHERE route_id = p_route_id AND status = 'active';

  IF v_active_count < v_seats THEN
    v_status := 'active'; v_queue_position := NULL;
  ELSE
    v_status := 'waitlisted';
    SELECT coalesce(max(queue_position), 0) + 1 INTO v_queue_position FROM route_subscriptions WHERE route_id = p_route_id AND status = 'waitlisted';
  END IF;

  INSERT INTO route_subscriptions (route_id, portal_user_id, board_stop_id, status, monthly_fee_pkr, queue_position)
  VALUES (p_route_id, v_portal_user_id, p_board_stop_id, v_status, v_fee, v_queue_position)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('subscription_id', v_id, 'status', v_status, 'monthly_fee_pkr', v_fee, 'queue_position', v_queue_position);
END;
$$;
GRANT EXECUTE ON FUNCTION apply_for_monthly_seat(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION promote_next_waitlisted(p_route_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_next route_subscriptions%ROWTYPE;
BEGIN
  SELECT * INTO v_next FROM route_subscriptions WHERE route_id = p_route_id AND status = 'waitlisted' ORDER BY queue_position ASC LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE route_subscriptions SET status = 'active', queue_position = NULL WHERE id = v_next.id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_next.portal_user_id, 'route_seat_promoted', 'A seat opened up',
    'A monthly seat is now free — you''re in.', '/portal/marketplace/route/' || p_route_id);
END;
$$;
GRANT EXECUTE ON FUNCTION promote_next_waitlisted(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION leave_monthly_seat(p_subscription_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sub route_subscriptions%ROWTYPE;
BEGIN
  SELECT * INTO v_sub FROM route_subscriptions WHERE id = p_subscription_id AND portal_user_id = current_portal_user_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Subscription not found.' USING ERRCODE = 'P0001'; END IF;

  UPDATE route_subscriptions SET status = 'cancelled' WHERE id = p_subscription_id;
  IF v_sub.status = 'active' THEN PERFORM promote_next_waitlisted(v_sub.route_id); END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION leave_monthly_seat(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- Driver-initiated removal — a real month's notice, not immediate. The
-- seat stays occupied (and billed) through that final month, which is
-- itself the notice period.
-- ═════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION driver_revoke_monthly_seat(p_subscription_id uuid, p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sub route_subscriptions%ROWTYPE; v_effective timestamptz;
BEGIN
  SELECT * INTO v_sub FROM route_subscriptions WHERE id = p_subscription_id;
  IF NOT FOUND OR NOT is_route_owner(v_sub.route_id) THEN RAISE EXCEPTION 'You can only manage your own route''s riders.' USING ERRCODE = 'P0001'; END IF;
  IF v_sub.status NOT IN ('active', 'waitlisted') THEN RAISE EXCEPTION 'This subscription is not active.' USING ERRCODE = 'P0001'; END IF;

  v_effective := now() + interval '1 month';
  UPDATE route_subscriptions SET status = 'pending_cancellation', scheduled_cancellation_at = v_effective, cancellation_reason = p_reason WHERE id = p_subscription_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (v_sub.portal_user_id, 'route_seat_revoked', 'Your monthly seat is ending',
    'Your driver has ended your monthly seat, effective ' || to_char(v_effective, 'DD Mon YYYY') || '.' || CASE WHEN p_reason IS NOT NULL AND trim(p_reason) != '' THEN ' Reason: ' || p_reason ELSE '' END,
    '/portal/marketplace/route/' || v_sub.route_id);
END;
$$;
GRANT EXECUTE ON FUNCTION driver_revoke_monthly_seat(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION cancel_pending_monthly_revocation(p_subscription_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sub route_subscriptions%ROWTYPE;
BEGIN
  SELECT * INTO v_sub FROM route_subscriptions WHERE id = p_subscription_id;
  IF NOT FOUND OR NOT is_route_owner(v_sub.route_id) THEN RAISE EXCEPTION 'You can only manage your own route''s riders.' USING ERRCODE = 'P0001'; END IF;
  IF v_sub.status != 'pending_cancellation' THEN RAISE EXCEPTION 'This subscription has no pending cancellation.' USING ERRCODE = 'P0001'; END IF;

  UPDATE route_subscriptions SET status = 'active', scheduled_cancellation_at = NULL, cancellation_reason = NULL WHERE id = p_subscription_id;
END;
$$;
GRANT EXECUTE ON FUNCTION cancel_pending_monthly_revocation(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- Driver marks this month's cash collected — the real accounting path,
-- same voucher shape confirm_ride_booking's per_order branch already
-- uses (fare credits the vehicle, commission then debits it back).
-- ═════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION mark_monthly_charge_paid(p_charge_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_charge route_subscription_charges%ROWTYPE;
  v_sub route_subscriptions%ROWTYPE;
  v_route vehicle_routes%ROWTYPE;
  v vehicles%ROWTYPE;
  v_vehicle_account uuid; v_cash_account uuid; v_commission_account uuid;
  v_commission_pct decimal; v_commission_amount decimal;
  v_fare_voucher_id uuid;
BEGIN
  SELECT * INTO v_charge FROM route_subscription_charges WHERE id = p_charge_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Charge not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_sub FROM route_subscriptions WHERE id = v_charge.subscription_id;
  IF NOT is_route_owner(v_sub.route_id) THEN RAISE EXCEPTION 'You can only manage your own route''s charges.' USING ERRCODE = 'P0001'; END IF;
  IF v_charge.status = 'paid' THEN RAISE EXCEPTION 'Already marked paid.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = v_sub.route_id;
  SELECT * INTO v FROM vehicles WHERE id = v_route.vehicle_id;

  v_vehicle_account := ensure_vehicle_account(v.id);
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-1001' AND tenant_id = v_route.tenant_id;

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    v_route.origin || ' → ' || v_route.destination || ' — monthly seat, ' || v_charge.month || '/' || v_charge.year || ' · paid directly, confirmed',
    v_charge.amount_pkr, v_vehicle_account, v_cash_account, v.owner_name)
  RETURNING id INTO v_fare_voucher_id;

  IF v.commission_mode = 'per_order' THEN
    v_commission_pct := vehicle_commission_pct(v.vehicle_type, v_route.classification);
    v_commission_amount := round(v_charge.amount_pkr * v_commission_pct / 100, 2);
    IF v_commission_amount > 0 THEN
      SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050' AND tenant_id = v_route.tenant_id;
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — ' || v_route.origin || ' → ' || v_route.destination || ' monthly seat', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name);
    END IF;
  END IF;

  UPDATE route_subscription_charges SET status = 'paid', paid_at = now(), marked_paid_by = current_portal_user_id(), voucher_id = v_fare_voucher_id WHERE id = p_charge_id;
END;
$$;
GRANT EXECUTE ON FUNCTION mark_monthly_charge_paid(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- Monthly sweep: expire due revocations (promoting the next waitlisted
-- rider) + generate this month's charges — same idempotent
-- ON CONFLICT DO NOTHING shape as bills/vehicle_lumpsum_charges.
-- ═════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION run_route_subscription_sweep() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r RECORD; v_now_karachi date := (now() AT TIME ZONE 'Asia/Karachi')::date;
BEGIN
  FOR r IN SELECT * FROM route_subscriptions WHERE status = 'pending_cancellation' AND scheduled_cancellation_at <= now() LOOP
    UPDATE route_subscriptions SET status = 'cancelled' WHERE id = r.id;
    PERFORM promote_next_waitlisted(r.route_id);
  END LOOP;

  FOR r IN SELECT * FROM route_subscriptions WHERE status = 'active' LOOP
    INSERT INTO route_subscription_charges (subscription_id, month, year, amount_pkr)
    VALUES (r.id, extract(month FROM v_now_karachi)::int, extract(year FROM v_now_karachi)::int, r.monthly_fee_pkr)
    ON CONFLICT (subscription_id, month, year) DO NOTHING;
  END LOOP;
END;
$$;

DO $$
BEGIN
  PERFORM cron.schedule('route-subscription-monthly-sweep', '0 5 1 * *', $sql$SELECT run_route_subscription_sweep()$sql$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available — route-subscription-monthly-sweep not scheduled: %', SQLERRM;
END $$;

-- ═════════════════════════════════════════════════════════════════════
-- One consolidated read RPC, same house style as route_group_detail.
-- ═════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION route_monthly_detail(p_route_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_is_owner boolean := is_route_owner(p_route_id);
  v_route vehicle_routes%ROWTYPE;
  v_seats int;
  v_active_count int;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  SELECT total_seats INTO v_seats FROM vehicles WHERE id = v_route.vehicle_id;
  SELECT count(*) INTO v_active_count FROM route_subscriptions WHERE route_id = p_route_id AND status = 'active';

  RETURN jsonb_build_object(
    'is_monthly_fixed', v_route.is_monthly_fixed,
    'monthly_reference_fee_pkr', v_route.monthly_reference_fee_pkr,
    'seats_total', v_seats,
    'active_count', v_active_count,
    'my_subscription', (
      SELECT jsonb_build_object('id', rs.id, 'status', rs.status, 'monthly_fee_pkr', rs.monthly_fee_pkr, 'queue_position', rs.queue_position, 'scheduled_cancellation_at', rs.scheduled_cancellation_at)
      FROM route_subscriptions rs WHERE rs.route_id = p_route_id AND rs.portal_user_id = v_portal_user_id AND rs.status != 'cancelled'
    ),
    'subscribers', CASE WHEN v_is_owner THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', rs.id, 'name', pu.full_name, 'stop_label', rst.label, 'monthly_fee_pkr', rs.monthly_fee_pkr,
        'status', rs.status, 'scheduled_cancellation_at', rs.scheduled_cancellation_at
      ) ORDER BY rs.applied_at), '[]'::jsonb)
      FROM route_subscriptions rs JOIN portal_users pu ON pu.id = rs.portal_user_id LEFT JOIN route_stops rst ON rst.id = rs.board_stop_id
      WHERE rs.route_id = p_route_id AND rs.status IN ('active', 'pending_cancellation')
    ) ELSE '[]'::jsonb END,
    'waitlist', CASE WHEN v_is_owner THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', rs.id, 'name', pu.full_name, 'queue_position', rs.queue_position, 'monthly_fee_pkr', rs.monthly_fee_pkr) ORDER BY rs.queue_position), '[]'::jsonb)
      FROM route_subscriptions rs JOIN portal_users pu ON pu.id = rs.portal_user_id
      WHERE rs.route_id = p_route_id AND rs.status = 'waitlisted'
    ) ELSE '[]'::jsonb END,
    'due_charges', CASE WHEN v_is_owner THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', rsc.id, 'rider_name', pu.full_name, 'month', rsc.month, 'year', rsc.year, 'amount_pkr', rsc.amount_pkr) ORDER BY rsc.year, rsc.month), '[]'::jsonb)
      FROM route_subscription_charges rsc JOIN route_subscriptions rs ON rs.id = rsc.subscription_id JOIN portal_users pu ON pu.id = rs.portal_user_id
      WHERE rs.route_id = p_route_id AND rsc.status = 'due'
    ) ELSE '[]'::jsonb END,
    'my_charges', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('month', rsc.month, 'year', rsc.year, 'amount_pkr', rsc.amount_pkr, 'status', rsc.status) ORDER BY rsc.year, rsc.month), '[]'::jsonb)
      FROM route_subscription_charges rsc JOIN route_subscriptions rs ON rs.id = rsc.subscription_id
      WHERE rs.route_id = p_route_id AND rs.portal_user_id = v_portal_user_id
    )
  );
END;
$$;
GRANT EXECUTE ON FUNCTION route_monthly_detail(uuid) TO authenticated;
