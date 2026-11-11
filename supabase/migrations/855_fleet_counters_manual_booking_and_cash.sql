-- Migration 855: fleet accounting, Phase 2a — real ask: a 20-vehicle
-- intercity fleet (Peshawar<->Karachi) has booking counters in both
-- cities (and possibly several per city), each staffed separately; the
-- owner needs to know which staff works which city's counter, and see
-- each counter's cash position cleanly. Confirmed via web research this
-- session: loose multi-counter cash handling with no tight
-- reconciliation is a REAL documented failure mode in Pakistani
-- transport (Islamabad terminal corruption case, Auditor-General's
-- railway cash-remittance findings) — this is worth building properly,
-- not glossing over.
--
-- The `addas` table (409) is NOT reused here — it's a turn-based local
-- van-stand queue (one physical stand, vehicles taking numbered turns),
-- a different concept from an intercity ticket-counter network.
-- "Fleet counters" is new, city-labeled, scoped to a fleet.
--
-- Manual/walk-up booking was the real missing piece for this scenario:
-- every counter must sell against the SAME shared seat pool (route_
-- seats_available) to avoid the double-booking failure mode above —
-- achieved by extending that one function, not inventing a parallel
-- inventory system per counter.

-- ═════════════════════════════════════════════════════════════════════
-- 1. fleet_counters — city-labeled booking location, scoped to a
--    fleet. Owner-only to create; any fleet manager (owner or staff,
--    via can_manage_vehicle's underlying fleet check) can read.
-- ═════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS fleet_counters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id uuid NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,
  city varchar NOT NULL,
  name varchar, -- optional, for when a city has more than one counter
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fleet_counters_fleet_id_idx ON fleet_counters(fleet_id);
ALTER TABLE fleet_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_counters_manager_read" ON fleet_counters FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM fleets f WHERE f.id = fleet_id AND f.owning_portal_user_id = current_portal_user_id())
    OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = fleet_counters.fleet_id AND fs.portal_user_id = current_portal_user_id())
    OR current_admin_permission('manage_parties')
  );
-- No INSERT/UPDATE/DELETE policy — owner-only SECURITY DEFINER RPCs.

-- Which counter a staff member works from — informational, nullable
-- (the owner themselves, or a roving staffer, needn't be tied to one).
ALTER TABLE fleet_staff ADD COLUMN IF NOT EXISTS counter_id uuid REFERENCES fleet_counters(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION create_fleet_counter(p_fleet_id uuid, p_city varchar, p_name varchar DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id AND owning_portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF trim(coalesce(p_city, '')) = '' THEN RAISE EXCEPTION 'Enter the counter''s city.' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO fleet_counters (fleet_id, city, name) VALUES (p_fleet_id, trim(p_city), nullif(trim(coalesce(p_name, '')), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION create_fleet_counter(uuid, varchar, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_fleet_counter(uuid, varchar, varchar) TO authenticated;

CREATE OR REPLACE FUNCTION my_fleet_counters(p_fleet_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c.id, 'city', c.city, 'name', c.name) ORDER BY c.city), '[]'::jsonb)
  FROM fleet_counters c WHERE c.fleet_id = p_fleet_id
    AND (EXISTS (SELECT 1 FROM fleets f WHERE f.id = c.fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = c.fleet_id AND fs.portal_user_id = current_portal_user_id()));
$$;
REVOKE ALL ON FUNCTION my_fleet_counters(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_fleet_counters(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION assign_staff_to_counter(p_fleet_id uuid, p_portal_user_id uuid, p_counter_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id AND owning_portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_counter_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_counters WHERE id = p_counter_id AND fleet_id = p_fleet_id) THEN
    RAISE EXCEPTION 'That counter is not part of this fleet.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE fleet_staff SET counter_id = p_counter_id WHERE fleet_id = p_fleet_id AND portal_user_id = p_portal_user_id;
END;
$$;
REVOKE ALL ON FUNCTION assign_staff_to_counter(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION assign_staff_to_counter(uuid, uuid, uuid) TO authenticated;

-- my_fleet_staff (854) gains counter_id/counter_city so the owner can
-- see who works which city at a glance.
CREATE OR REPLACE FUNCTION my_fleet_staff(p_fleet_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', fs.id, 'portal_user_id', fs.portal_user_id, 'full_name', pu.full_name, 'added_at', fs.added_at,
    'counter_id', fs.counter_id, 'counter_city', c.city, 'counter_name', c.name
  ) ORDER BY fs.added_at), '[]'::jsonb)
  FROM fleet_staff fs JOIN portal_users pu ON pu.id = fs.portal_user_id
  LEFT JOIN fleet_counters c ON c.id = fs.counter_id
  WHERE fs.fleet_id = p_fleet_id AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id());
$$;
REVOKE ALL ON FUNCTION my_fleet_staff(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_fleet_staff(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 2. manual_ride_bookings — a counter cashier's walk-up cash sale.
--    ride_bookings.portal_user_id is NOT NULL (always a real app rider)
--    so this is deliberately its own table rather than a hack around
--    that constraint. counter_id is nullable so a solo (non-fleet)
--    driver can also log a walk-up sale with no counter set up at all.
-- ═════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS manual_ride_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES vehicle_routes(id) ON DELETE CASCADE,
  counter_id uuid REFERENCES fleet_counters(id),
  recorded_by_portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  travel_date date NOT NULL,
  seats int NOT NULL CHECK (seats > 0),
  passenger_name varchar NOT NULL,
  passenger_mobile varchar,
  board_stop_id uuid REFERENCES route_stops(id),
  alight_stop_id uuid REFERENCES route_stops(id),
  total_amount_pkr decimal NOT NULL CHECK (total_amount_pkr >= 0),
  payment_method varchar NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'jazzcash', 'easypaisa', 'bank')),
  status varchar NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS manual_ride_bookings_route_date_idx ON manual_ride_bookings(route_id, travel_date);
ALTER TABLE manual_ride_bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "manual_ride_bookings_manager_read" ON manual_ride_bookings FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM vehicle_routes vr WHERE vr.id = route_id AND can_manage_vehicle(vr.vehicle_id)) OR current_admin_permission('manage_parties'));
-- No INSERT/UPDATE/DELETE policy — SECURITY DEFINER RPC only.

-- ride_booking_seat_numbers (845) FK'd only to ride_bookings — a manual
-- booking needs the exact same seat slot, enforced by the exact same
-- UNIQUE(route_id, travel_date, direction, seat_number) so an app
-- booking and a counter sale can never collide on the same seat. Made
-- ride_booking_id nullable + added manual_ride_booking_id, with a CHECK
-- that exactly one source is set — the unique constraint already spans
-- both regardless of which FK is populated, so no separate dedup logic
-- is needed anywhere.
ALTER TABLE ride_booking_seat_numbers ALTER COLUMN ride_booking_id DROP NOT NULL;
ALTER TABLE ride_booking_seat_numbers ADD COLUMN IF NOT EXISTS manual_ride_booking_id uuid REFERENCES manual_ride_bookings(id) ON DELETE CASCADE;
ALTER TABLE ride_booking_seat_numbers DROP CONSTRAINT IF EXISTS ride_booking_seat_numbers_one_source_chk;
ALTER TABLE ride_booking_seat_numbers ADD CONSTRAINT ride_booking_seat_numbers_one_source_chk
  CHECK ((ride_booking_id IS NOT NULL) != (manual_ride_booking_id IS NOT NULL));

-- route_seats_available (851) — now also subtracts manual counter
-- sales for the same date, so no counter (or the app) can ever oversell
-- past what the vehicle actually has. Same technique 851 already used
-- to make this function monthly-subscriber-aware.
CREATE OR REPLACE FUNCTION route_seats_available(p_route_id uuid, p_travel_date date) RETURNS int
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_seats int; v_booked int; v_manual int; v_monthly_riding int; v_is_monthly boolean;
BEGIN
  SELECT is_monthly_fixed INTO v_is_monthly FROM vehicle_routes WHERE id = p_route_id;
  v_seats := route_effective_seats_for_date(p_route_id, p_travel_date);

  SELECT COALESCE(SUM(rb.seats)::int, 0) INTO v_booked FROM ride_bookings rb
    WHERE rb.route_id = p_route_id AND rb.travel_date = p_travel_date AND rb.status IN ('announced', 'confirmed');

  SELECT COALESCE(SUM(mb.seats)::int, 0) INTO v_manual FROM manual_ride_bookings mb
    WHERE mb.route_id = p_route_id AND mb.travel_date = p_travel_date AND mb.status = 'confirmed';

  IF v_is_monthly THEN
    SELECT count(*) INTO v_monthly_riding FROM route_subscriptions rs
      WHERE rs.route_id = p_route_id AND rs.status IN ('active', 'pending')
        AND NOT EXISTS (SELECT 1 FROM route_subscription_leave_days ld WHERE ld.subscription_id = rs.id AND ld.leave_date = p_travel_date);
  ELSE
    v_monthly_riding := 0;
  END IF;

  RETURN v_seats - v_booked - v_manual - v_monthly_riding;
END;
$$;
GRANT EXECUTE ON FUNCTION route_seats_available(uuid, date) TO authenticated, anon;

CREATE OR REPLACE FUNCTION record_manual_booking(
  p_route_id uuid, p_travel_date date, p_seats int, p_passenger_name varchar, p_total_amount_pkr decimal,
  p_counter_id uuid DEFAULT NULL, p_passenger_mobile varchar DEFAULT NULL, p_payment_method varchar DEFAULT 'cash',
  p_board_stop_id uuid DEFAULT NULL, p_alight_stop_id uuid DEFAULT NULL, p_seat_numbers int[] DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE; v_vehicle_kind varchar;
  v_available int; v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  IF p_counter_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_counters WHERE id = p_counter_id AND fleet_id = v_vehicle.fleet_id) THEN
    RAISE EXCEPTION 'That counter is not part of this vehicle''s fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_seats IS NULL OR p_seats <= 0 THEN RAISE EXCEPTION 'Enter at least one seat.' USING ERRCODE = 'P0001'; END IF;
  IF trim(coalesce(p_passenger_name, '')) = '' THEN RAISE EXCEPTION 'Enter the passenger''s name.' USING ERRCODE = 'P0001'; END IF;
  IF p_total_amount_pkr IS NULL OR p_total_amount_pkr < 0 THEN RAISE EXCEPTION 'Enter the fare collected.' USING ERRCODE = 'P0001'; END IF;

  v_available := route_seats_available(p_route_id, p_travel_date);
  IF p_seats > v_available THEN RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001'; END IF;

  SELECT vc.vehicle_kind INTO v_vehicle_kind FROM vehicle_categories vc WHERE vc.id = v_vehicle.category_id;
  IF v_vehicle_kind = 'van' THEN
    IF p_seat_numbers IS NULL OR array_length(p_seat_numbers, 1) IS DISTINCT FROM p_seats THEN
      RAISE EXCEPTION 'Pick exactly % seat(s).', p_seats USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_seat_numbers) sn WHERE sn < 1 OR sn > route_effective_seats_for_date(p_route_id, p_travel_date)) THEN
      RAISE EXCEPTION 'That seat doesn''t exist on this vehicle.' USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_seat_numbers IS NOT NULL THEN
    RAISE EXCEPTION 'This vehicle doesn''t use seat numbers.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO manual_ride_bookings (route_id, counter_id, recorded_by_portal_user_id, travel_date, seats, passenger_name, passenger_mobile, board_stop_id, alight_stop_id, total_amount_pkr, payment_method)
  VALUES (p_route_id, p_counter_id, v_portal_user_id, p_travel_date, p_seats, trim(p_passenger_name), nullif(trim(coalesce(p_passenger_mobile, '')), ''), p_board_stop_id, p_alight_stop_id, p_total_amount_pkr, p_payment_method)
  RETURNING id INTO v_id;

  IF p_seat_numbers IS NOT NULL THEN
    BEGIN
      INSERT INTO ride_booking_seat_numbers (manual_ride_booking_id, route_id, travel_date, direction, seat_number)
      SELECT v_id, p_route_id, p_travel_date, 'outbound', sn FROM unnest(p_seat_numbers) sn;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'One of those seats was just taken by someone else — pick again.' USING ERRCODE = 'P0001';
    END;
  END IF;

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION record_manual_booking(uuid, date, int, varchar, decimal, uuid, varchar, varchar, uuid, uuid, int[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_manual_booking(uuid, date, int, varchar, decimal, uuid, varchar, varchar, uuid, uuid, int[]) TO authenticated;

CREATE OR REPLACE FUNCTION cancel_manual_booking(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route_id uuid;
BEGIN
  SELECT route_id INTO v_route_id FROM manual_ride_bookings WHERE id = p_id FOR UPDATE;
  IF v_route_id IS NULL THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicle_routes vr WHERE vr.id = v_route_id AND can_manage_vehicle(vr.vehicle_id)) THEN
    RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE manual_ride_bookings SET status = 'cancelled' WHERE id = p_id;
  DELETE FROM ride_booking_seat_numbers WHERE manual_ride_booking_id = p_id;
END;
$$;
REVOKE ALL ON FUNCTION cancel_manual_booking(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancel_manual_booking(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION route_manual_bookings_today(p_route_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', mb.id, 'passenger_name', mb.passenger_name, 'seats', mb.seats, 'total_amount_pkr', mb.total_amount_pkr,
    'payment_method', mb.payment_method, 'counter_id', mb.counter_id, 'created_at', mb.created_at
  ) ORDER BY mb.created_at DESC), '[]'::jsonb)
  FROM manual_ride_bookings mb JOIN vehicle_routes vr ON vr.id = mb.route_id
  WHERE mb.route_id = p_route_id AND mb.travel_date = (now() AT TIME ZONE 'Asia/Karachi')::date AND mb.status = 'confirmed'
    AND can_manage_vehicle(vr.vehicle_id);
$$;
REVOKE ALL ON FUNCTION route_manual_bookings_today(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION route_manual_bookings_today(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 3. vehicle_dashboard_summary (854) — manual counter sales now count
--    toward gross earnings too, same as any other booking type.
-- ═════════════════════════════════════════════════════════════════════
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
-- 4. Counter cash position — derived, never posted to the ledger
--    (same discipline as vehicle_expenses, 854): cash collected at a
--    counter (manual bookings paid in cash) minus what's been handed
--    over to the owner (remittances the owner logs on receipt).
-- ═════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS fleet_counter_remittances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  counter_id uuid NOT NULL REFERENCES fleet_counters(id) ON DELETE CASCADE,
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  note text,
  recorded_by_portal_user_id uuid REFERENCES portal_users(id),
  created_at timestamptz DEFAULT now()
);
ALTER TABLE fleet_counter_remittances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_counter_remittances_owner_read" ON fleet_counter_remittances FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM fleet_counters c JOIN fleets f ON f.id = c.fleet_id WHERE c.id = counter_id AND f.owning_portal_user_id = current_portal_user_id())
    OR current_admin_permission('manage_parties'));

CREATE OR REPLACE FUNCTION record_counter_remittance(p_counter_id uuid, p_amount_pkr decimal, p_note text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleet_counters c JOIN fleets f ON f.id = c.fleet_id WHERE c.id = p_counter_id AND f.owning_portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not own this counter''s fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount_pkr IS NULL OR p_amount_pkr <= 0 THEN RAISE EXCEPTION 'Enter a real amount.' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO fleet_counter_remittances (counter_id, amount_pkr, note, recorded_by_portal_user_id)
  VALUES (p_counter_id, p_amount_pkr, nullif(trim(coalesce(p_note, '')), ''), v_portal_user_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION record_counter_remittance(uuid, decimal, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_counter_remittance(uuid, decimal, text) TO authenticated;

CREATE OR REPLACE FUNCTION fleet_counter_cash_positions(p_fleet_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'counter_id', c.id, 'city', c.city, 'name', c.name,
    'total_collected_pkr', COALESCE(collected.amt, 0), 'total_remitted_pkr', COALESCE(remitted.amt, 0),
    'cash_in_hand_pkr', COALESCE(collected.amt, 0) - COALESCE(remitted.amt, 0)
  ) ORDER BY c.city), '[]'::jsonb)
  FROM fleet_counters c
  LEFT JOIN LATERAL (
    SELECT SUM(mb.total_amount_pkr) AS amt FROM manual_ride_bookings mb
    WHERE mb.counter_id = c.id AND mb.payment_method = 'cash' AND mb.status = 'confirmed'
  ) collected ON true
  LEFT JOIN LATERAL (SELECT SUM(r.amount_pkr) AS amt FROM fleet_counter_remittances r WHERE r.counter_id = c.id) remitted ON true
  WHERE c.fleet_id = p_fleet_id
    AND (EXISTS (SELECT 1 FROM fleets f WHERE f.id = c.fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR current_admin_permission('manage_parties'));
$$;
REVOKE ALL ON FUNCTION fleet_counter_cash_positions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_counter_cash_positions(uuid) TO authenticated;
