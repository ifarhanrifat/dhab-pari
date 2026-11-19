-- Migration 924: real terminal-wise boarding + stop/master trip challan.
--
-- Real spec given directly (a bus running Peshawar->Karachi outbound
-- with 5+ terminal stops, a different stop sequence on the return leg,
-- each terminal needing its own boarding count + cash/advance
-- closeout, all rolling into one master trip challan with a net
-- result). dhab-pari already has most of the real foundation for this
-- (route_stops.counter_id/arrival_time/departure_time from 918 already
-- ties a stop to a real terminal; manual_ride_bookings already has
-- board_stop_id/alight_stop_id/counter_id/boarded_at and a real
-- passenger manifest; route_departure_chalan (899) already computes
-- onboard-now/next-stops/by-counter breakdowns). What's missing,
-- confirmed by reading the real bodies, not assumed: a persisted
-- stop-closeout record (chalan today is a pure live read, never a
-- workflow event), a driver cash-handover ledger, an "alighted" and
-- "no-show" status for a counter-sold ticket (dropped_off_at exists on
-- manual_ride_bookings but nothing ever sets it; only cancel exists,
-- no no-show), and any terminal-level staff scoping at all
-- (fleet_staff.counter_id is purely cosmetic today — only used to
-- pre-fill "my terminal" as a form default, never enforced).
--
-- Nothing here changes route_departure_chalan, record_manual_booking,
-- cancel_manual_booking, or board_manual_ticket's existing bodies or
-- gating — every fleet-wide view/booking behavior that works today
-- keeps working exactly as today. All of this is additive.

-- ═════════════════════════════════════════════════════════════════════
-- 1. manual_ride_bookings: a real no-show status, distinct from
-- cancelled for audit purposes (a passenger who paid and simply didn't
-- show up is not the same event as a booking someone actively voided).
-- dropped_off_at already exists (874) and is reused as-is for
-- "alighted" — no new column needed.
-- ═════════════════════════════════════════════════════════════════════
ALTER TABLE manual_ride_bookings DROP CONSTRAINT IF EXISTS manual_ride_bookings_status_check;
ALTER TABLE manual_ride_bookings ADD CONSTRAINT manual_ride_bookings_status_check
  CHECK (status IN ('confirmed', 'cancelled', 'no_show'));

-- ═════════════════════════════════════════════════════════════════════
-- 1b. route_departure_chalan (899) — additive widen only: each
-- passenger row gains boarded_at/dropped_off_at/status, strictly new
-- keys on the same jsonb return shape (jsonb hides structure from
-- Postgres' type system, so this needs no DROP/true-replace the way a
-- RETURNS TABLE widen would). The Terminal Stop Desk needs this to
-- know which action (Board/No-show/Alighted) to show per passenger —
-- data that already existed (boarded_at has been written by
-- board_manual_ticket since 874) but was never read back here. No
-- existing key changes, no existing behavior/gating changes.
--
-- Also gains a new trailing p_direction varchar DEFAULT NULL — NULL
-- preserves today's exact query (every existing caller, unchanged,
-- keeps seeing both directions mixed together exactly as today); the
-- new Chalan page passes 'outbound'/'return' explicitly so its two
-- direction tabs each show only that leg's own passengers. A new
-- parameter changes the argument-type list, which Postgres treats as
-- a DIFFERENT overload, not a replace (confirmed the hard way twice
-- already this session, migrations 913/914) — so the old 2-arg
-- signature is dropped explicitly first, or every existing caller
-- (Dashboard/Bookings/Dispatch/Driver, all passing just the 2 args)
-- would start hitting a PGRST203 ambiguous-overload error.
-- ═════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS route_departure_chalan(uuid, date);

CREATE FUNCTION route_departure_chalan(p_route_id uuid, p_travel_date date DEFAULT NULL, p_direction varchar DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_date date := COALESCE(p_travel_date, (now() AT TIME ZONE 'Asia/Karachi')::date);
  v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE;
  v_run route_runs%ROWTYPE;
  v_result jsonb;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_run FROM route_runs WHERE route_id = p_route_id AND direction = COALESCE(p_direction, 'outbound') AND (started_at AT TIME ZONE 'Asia/Karachi')::date = v_date ORDER BY started_at DESC LIMIT 1;

  WITH rows AS (
    SELECT
      mb.id, 'manual'::varchar AS source, mb.passenger_name, mb.passenger_mobile, mb.seats, mb.total_amount_pkr AS amount,
      mb.payment_method, mb.status = 'confirmed' AS is_confirmed, mb.board_stop_id, mb.counter_id,
      mb.boarded_at, mb.dropped_off_at, mb.status,
      (SELECT array_agg(sn.seat_number ORDER BY sn.seat_number) FROM ride_booking_seat_numbers sn WHERE sn.manual_ride_booking_id = mb.id) AS seat_numbers
    FROM manual_ride_bookings mb
    WHERE mb.route_id = p_route_id AND mb.travel_date = v_date AND mb.status IN ('confirmed', 'no_show')
      AND (p_direction IS NULL OR mb.direction = p_direction)
    UNION ALL
    SELECT
      rb.id, 'app'::varchar AS source, pu.full_name, pu.mobile, rb.seats, rb.total_amount_pkr AS amount,
      rb.announced_method, rb.status = 'confirmed' AS is_confirmed, rb.board_stop_id, NULL::uuid AS counter_id,
      rb.boarded_at, rb.dropped_off_at, rb.status,
      (SELECT array_agg(sn.seat_number ORDER BY sn.seat_number) FROM ride_booking_seat_numbers sn WHERE sn.ride_booking_id = rb.id) AS seat_numbers
    FROM ride_bookings rb JOIN portal_users pu ON pu.id = rb.portal_user_id
    WHERE rb.route_id = p_route_id AND rb.travel_date = v_date AND rb.status IN ('announced', 'confirmed') AND NOT rb.is_mid_route_catch
      AND (p_direction IS NULL OR rb.direction = p_direction)
  ),
  onboard AS (
    SELECT jsonb_build_object('id', id, 'source', source, 'passenger_name', passenger_name, 'passenger_mobile', passenger_mobile,
      'seats', seats, 'seat_numbers', seat_numbers, 'amount', amount, 'payment_method', payment_method, 'is_confirmed', is_confirmed,
      'boarded_at', boarded_at, 'dropped_off_at', dropped_off_at, 'status', status) AS row
    FROM rows WHERE board_stop_id IS NULL
  ),
  next_stop AS (
    SELECT rs.label, rs.stop_order, jsonb_build_object('id', rows.id, 'source', rows.source, 'passenger_name', rows.passenger_name, 'passenger_mobile', rows.passenger_mobile,
      'seats', rows.seats, 'seat_numbers', rows.seat_numbers, 'amount', rows.amount, 'payment_method', rows.payment_method, 'is_confirmed', rows.is_confirmed,
      'boarded_at', rows.boarded_at, 'dropped_off_at', rows.dropped_off_at, 'status', rows.status) AS row
    FROM rows JOIN route_stops rs ON rs.id = rows.board_stop_id
  )
  SELECT jsonb_build_object(
    'route_id', p_route_id, 'origin', v_route.origin, 'destination', v_route.destination, 'travel_date', v_date,
    'owner_name', v_vehicle.owner_name, 'vehicle_type', v_vehicle.vehicle_type, 'vehicle_number', v_vehicle.vehicle_number,
    'run_started_at', v_run.started_at, 'run_ended_at', v_run.ended_at,
    'onboard_now', (SELECT COALESCE(jsonb_agg(row), '[]'::jsonb) FROM onboard),
    'next_stops', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('label', label, 'passengers', passengers) ORDER BY stop_order), '[]'::jsonb)
      FROM (SELECT label, stop_order, jsonb_agg(row) AS passengers FROM next_stop GROUP BY label, stop_order) g
    ),
    'total_confirmed_count', (SELECT COALESCE(SUM(seats), 0) FROM rows WHERE is_confirmed),
    'total_unconfirmed_count', (SELECT COALESCE(SUM(seats), 0) FROM rows WHERE NOT is_confirmed),
    'cash_collected_pkr', (SELECT COALESCE(SUM(amount), 0) FROM rows WHERE is_confirmed AND payment_method = 'cash'),
    'by_source', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('source', source, 'seats', total_seats) ORDER BY source), '[]'::jsonb)
      FROM (SELECT source, SUM(seats) AS total_seats FROM rows WHERE is_confirmed GROUP BY source) g
    ),
    'by_counter', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'counter_id', counter_id, 'counter_name', counter_name, 'city', city, 'seats', total_seats
      ) ORDER BY total_seats DESC), '[]'::jsonb)
      FROM (
        SELECT r.counter_id, c.name AS counter_name, c.city, SUM(r.seats) AS total_seats
        FROM rows r LEFT JOIN fleet_counters c ON c.id = r.counter_id
        WHERE r.is_confirmed AND r.source = 'manual'
        GROUP BY r.counter_id, c.name, c.city
      ) g
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION route_departure_chalan(uuid, date, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION route_departure_chalan(uuid, date, varchar) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 2. Schema — the two genuinely new records. route_stop_challans is
-- one persisted closeout per terminal per departure (stop_id NULL =
-- the origin, matching the existing board_stop_id IS NULL convention
-- route_departure_chalan already uses for "boards right here, no
-- stop"). route_driver_cash_handovers is the final cash the driver
-- hands back, separate from any one stop (it happens at the
-- destination, after every stop has already closed).
-- ═════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS route_stop_challans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES vehicle_routes(id) ON DELETE CASCADE,
  travel_date date NOT NULL,
  direction varchar NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'return')),
  stop_id uuid REFERENCES route_stops(id),
  expected_count int NOT NULL DEFAULT 0,
  boarded_count int NOT NULL DEFAULT 0,
  no_show_count int NOT NULL DEFAULT 0,
  cash_collected_pkr decimal NOT NULL DEFAULT 0,
  digital_collected_pkr decimal NOT NULL DEFAULT 0,
  driver_advance_pkr decimal NOT NULL DEFAULT 0 CHECK (driver_advance_pkr >= 0),
  other_cash_pkr decimal NOT NULL DEFAULT 0 CHECK (other_cash_pkr >= 0),
  note text,
  closed_by uuid REFERENCES portal_users(id),
  closed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (route_id, travel_date, direction, stop_id)
);
CREATE INDEX IF NOT EXISTS route_stop_challans_route_date_idx ON route_stop_challans(route_id, travel_date, direction);
ALTER TABLE route_stop_challans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "route_stop_challans_manager_read" ON route_stop_challans FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM vehicle_routes vr WHERE vr.id = route_id AND can_manage_vehicle(vr.vehicle_id)) OR current_admin_permission('manage_parties'));
-- No INSERT/UPDATE/DELETE policy — SECURITY DEFINER RPC only (close_route_stop_challan).

CREATE TABLE IF NOT EXISTS route_driver_cash_handovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES vehicle_routes(id) ON DELETE CASCADE,
  travel_date date NOT NULL,
  direction varchar NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'return')),
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  received_by_counter_id uuid REFERENCES fleet_counters(id),
  note text,
  recorded_by uuid REFERENCES portal_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS route_driver_cash_handovers_route_date_idx ON route_driver_cash_handovers(route_id, travel_date, direction);
ALTER TABLE route_driver_cash_handovers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "route_driver_cash_handovers_manager_read" ON route_driver_cash_handovers FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM vehicle_routes vr WHERE vr.id = route_id AND can_manage_vehicle(vr.vehicle_id)) OR current_admin_permission('manage_parties'));
-- No INSERT/UPDATE/DELETE policy — SECURITY DEFINER RPC only (record_route_driver_handover).

-- ═════════════════════════════════════════════════════════════════════
-- 3. is_my_counter_or_admin — the real terminal-scoping gate, applied
-- ONLY to the new close-stop/handover actions below. A staff member
-- who hasn't been assigned a counter_id yet is treated exactly like
-- today (no restriction) — this only narrows things for a fleet that
-- has actually assigned terminals to its staff, never for one that
-- hasn't adopted that yet. p_counter_id NULL (an origin stop with no
-- terminal link) is always open to anyone who already passes
-- can_manage_vehicle — scoping only applies to a real, named terminal.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION is_my_counter_or_admin(p_counter_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_counter_id IS NULL
    OR EXISTS (SELECT 1 FROM fleet_counters fc JOIN fleets f ON f.id = fc.fleet_id WHERE fc.id = p_counter_id AND f.owning_portal_user_id = current_portal_user_id())
    OR EXISTS (
      SELECT 1 FROM fleet_counters fc JOIN fleet_staff fs ON fs.fleet_id = fc.fleet_id
      WHERE fc.id = p_counter_id AND fs.portal_user_id = current_portal_user_id()
        AND (fs.counter_id IS NULL OR fs.counter_id = p_counter_id)
    );
$$;
REVOKE ALL ON FUNCTION is_my_counter_or_admin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_my_counter_or_admin(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 4. mark_manual_ticket_alighted — the missing "got off the bus" event
-- for a counter-sold ticket. Not terminal-scoped (alighting can happen
-- anywhere along the route, same breadth as board_manual_ticket).
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION mark_manual_ticket_alighted(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE mb manual_ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO mb FROM manual_ride_bookings WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ticket not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_routes WHERE id = mb.route_id;
  IF NOT can_manage_vehicle(r.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF mb.status != 'confirmed' THEN RAISE EXCEPTION 'This ticket is not valid for alighting.' USING ERRCODE = 'P0001'; END IF;
  IF mb.boarded_at IS NULL THEN RAISE EXCEPTION 'This passenger has not boarded yet.' USING ERRCODE = 'P0001'; END IF;
  IF mb.dropped_off_at IS NOT NULL THEN RAISE EXCEPTION 'This passenger has already alighted.' USING ERRCODE = 'P0001'; END IF;
  UPDATE manual_ride_bookings SET dropped_off_at = now() WHERE id = p_id;
END;
$$;
REVOKE ALL ON FUNCTION mark_manual_ticket_alighted(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mark_manual_ticket_alighted(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 5. mark_manual_ticket_no_show — a real audit-distinct status from
-- cancel. Releases the seat exactly like cancel_manual_booking (885)
-- does: free the seat-number row, reverse any earned commission, log
-- the action — copied verbatim from that RPC's own release logic.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION mark_manual_ticket_no_show(p_id uuid, p_reason text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route_id uuid; v_fleet_id uuid;
BEGIN
  SELECT route_id INTO v_route_id FROM manual_ride_bookings WHERE id = p_id AND status = 'confirmed' FOR UPDATE;
  IF v_route_id IS NULL THEN RAISE EXCEPTION 'Booking not found or not eligible for no-show.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicle_routes vr WHERE vr.id = v_route_id AND can_manage_vehicle(vr.vehicle_id)) THEN
    RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE manual_ride_bookings SET status = 'no_show' WHERE id = p_id;
  DELETE FROM ride_booking_seat_numbers WHERE manual_ride_booking_id = p_id;
  UPDATE fleet_staff_commissions SET status = 'reversed', reversed_at = now() WHERE manual_ride_booking_id = p_id AND status = 'earned';

  SELECT v.fleet_id INTO v_fleet_id FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id WHERE vr.id = v_route_id;
  IF v_fleet_id IS NOT NULL THEN
    PERFORM log_fleet_action(v_fleet_id, 'manual_booking_no_show', jsonb_build_object('manual_ride_booking_id', p_id, 'reason', p_reason));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION mark_manual_ticket_no_show(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mark_manual_ticket_no_show(uuid, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 6. close_route_stop_challan — the real workflow event the whole
-- spec was missing: a terminal closes boarding and submits one
-- persisted report for this stop, this departure. Cash/digital
-- figures are SALES-channel based (counter_id = this stop's own
-- terminal, same dimension route_departure_chalan's by_counter already
-- uses) — a terminal's cash office handles what IT sold, not what
-- happens to board there. Expected/boarded/no-show counts are
-- BOARDING-based (board_stop_id = this stop) — the real physical queue
-- at that terminal, regardless of where the ticket was bought. These
-- are deliberately two different dimensions, matching the sold-vs-
-- boards distinction confirmed real in this schema (board_stop_id vs.
-- counter_id are already two separate columns on manual_ride_bookings).
-- Auto no-shows anyone still confirmed-not-boarded at this stop when
-- it closes, mirroring the real "bus left, one passenger was late"
-- scenario described directly.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION close_route_stop_challan(
  p_route_id uuid, p_travel_date date, p_direction varchar, p_stop_id uuid DEFAULT NULL,
  p_driver_advance_pkr decimal DEFAULT 0, p_other_cash_pkr decimal DEFAULT 0, p_note text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_route vehicle_routes%ROWTYPE; v_stop route_stops%ROWTYPE; v_counter_id uuid;
  v_expected int; v_boarded int; v_no_show int; v_cash decimal; v_digital decimal;
  v_id uuid; v_board_filter_null boolean := p_stop_id IS NULL;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF p_direction NOT IN ('outbound', 'return') THEN RAISE EXCEPTION 'Invalid direction.' USING ERRCODE = 'P0001'; END IF;

  IF p_stop_id IS NOT NULL THEN
    SELECT * INTO v_stop FROM route_stops WHERE id = p_stop_id AND route_id = p_route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'That stop does not belong to this route.' USING ERRCODE = 'P0001'; END IF;
    v_counter_id := v_stop.counter_id;
  END IF;

  IF NOT is_my_counter_or_admin(v_counter_id) THEN
    RAISE EXCEPTION 'You can only close boarding for your own assigned terminal.' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM route_stop_challans WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction
      AND ((p_stop_id IS NULL AND stop_id IS NULL) OR stop_id = p_stop_id)) THEN
    RAISE EXCEPTION 'This stop has already been closed for this departure.' USING ERRCODE = 'P0001';
  END IF;

  -- Auto no-show anyone still confirmed, not boarded, boarding at this stop.
  UPDATE manual_ride_bookings mb SET status = 'no_show'
  WHERE mb.route_id = p_route_id AND mb.travel_date = p_travel_date AND mb.direction = p_direction
    AND mb.status = 'confirmed' AND mb.boarded_at IS NULL
    AND ((v_board_filter_null AND mb.board_stop_id IS NULL) OR mb.board_stop_id = p_stop_id);
  UPDATE fleet_staff_commissions fsc SET status = 'reversed', reversed_at = now()
  WHERE fsc.status = 'earned' AND fsc.manual_ride_booking_id IN (
    SELECT id FROM manual_ride_bookings WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction AND status = 'no_show'
      AND ((v_board_filter_null AND board_stop_id IS NULL) OR board_stop_id = p_stop_id)
  );
  DELETE FROM ride_booking_seat_numbers sn WHERE sn.manual_ride_booking_id IN (
    SELECT id FROM manual_ride_bookings WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction AND status = 'no_show'
      AND ((v_board_filter_null AND board_stop_id IS NULL) OR board_stop_id = p_stop_id)
  );

  -- Boarding-based counts (this stop's real physical queue) — unions
  -- manual/counter sales with online app bookings, same two sources
  -- route_departure_chalan's own "rows" CTE already combines, so a
  -- terminal's expected count isn't silently missing online riders.
  SELECT
    COUNT(*) FILTER (WHERE boarded_at IS NOT NULL) AS boarded,
    COUNT(*) FILTER (WHERE status = 'no_show') AS no_show,
    COUNT(*) AS expected
  INTO v_boarded, v_no_show, v_expected
  FROM (
    SELECT boarded_at, status FROM manual_ride_bookings
    WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction
      AND ((v_board_filter_null AND board_stop_id IS NULL) OR board_stop_id = p_stop_id)
      AND status != 'cancelled'
    UNION ALL
    SELECT boarded_at, CASE WHEN status = 'announced' THEN 'confirmed' ELSE status END FROM ride_bookings
    WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction AND NOT is_mid_route_catch
      AND ((v_board_filter_null AND board_stop_id IS NULL) OR board_stop_id = p_stop_id)
      AND status IN ('announced', 'confirmed')
  ) combined;

  -- Sales-channel-based cash (this terminal's own counter_id, if any).
  SELECT
    COALESCE(SUM(total_amount_pkr) FILTER (WHERE payment_method = 'cash'), 0),
    COALESCE(SUM(total_amount_pkr) FILTER (WHERE payment_method != 'cash'), 0)
  INTO v_cash, v_digital
  FROM manual_ride_bookings
  WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction
    AND status IN ('confirmed', 'no_show') AND counter_id IS NOT DISTINCT FROM v_counter_id;

  INSERT INTO route_stop_challans (
    route_id, travel_date, direction, stop_id, expected_count, boarded_count, no_show_count,
    cash_collected_pkr, digital_collected_pkr, driver_advance_pkr, other_cash_pkr, note, closed_by
  ) VALUES (
    p_route_id, p_travel_date, p_direction, p_stop_id, v_expected, v_boarded, v_no_show,
    v_cash, v_digital, COALESCE(p_driver_advance_pkr, 0), COALESCE(p_other_cash_pkr, 0), nullif(trim(coalesce(p_note, '')), ''), current_portal_user_id()
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION close_route_stop_challan(uuid, date, varchar, uuid, decimal, decimal, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION close_route_stop_challan(uuid, date, varchar, uuid, decimal, decimal, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 7. record_route_driver_handover — owner/admin-gated only, same
-- breadth as the existing counter-remittance gate (record_counter_
-- remittance, 855) since this is the same kind of "physically verified
-- cash received" event, not a terminal-desk action.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION record_route_driver_handover(
  p_route_id uuid, p_travel_date date, p_direction varchar, p_amount_pkr decimal,
  p_received_by_counter_id uuid DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id JOIN fleets f ON f.id = v.fleet_id
    WHERE vr.id = p_route_id AND f.owning_portal_user_id = current_portal_user_id()
  ) THEN
    RAISE EXCEPTION 'You do not own this route''s fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_direction NOT IN ('outbound', 'return') THEN RAISE EXCEPTION 'Invalid direction.' USING ERRCODE = 'P0001'; END IF;
  IF p_amount_pkr IS NULL OR p_amount_pkr <= 0 THEN RAISE EXCEPTION 'Enter a real amount.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO route_driver_cash_handovers (route_id, travel_date, direction, amount_pkr, received_by_counter_id, note, recorded_by)
  VALUES (p_route_id, p_travel_date, p_direction, p_amount_pkr, p_received_by_counter_id, nullif(trim(coalesce(p_note, '')), ''), current_portal_user_id())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION record_route_driver_handover(uuid, date, varchar, decimal, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_route_driver_handover(uuid, date, varchar, decimal, uuid, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 8. route_master_trip_challan — pure computed read, same "derived,
-- never a stored ledger" pattern route_departure_chalan and
-- fleet_counter_cash_positions already use. Assembles every stop
-- challan for this exact departure plus revenue/expenses/handovers.
-- The route_runs lookup (for vehicle_expenses.route_run_id) copies
-- route_departure_chalan's own exact lookup shape. "driver_cash_float"
-- is explicitly informational (advances issued minus handovers
-- received) — vehicle_expenses has no "paid from advance" flag and
-- this does not invent one; it reports the float honestly rather than
-- fabricating a tied-out reconciliation.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION route_master_trip_challan(p_route_id uuid, p_travel_date date, p_direction varchar DEFAULT 'outbound') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_route vehicle_routes%ROWTYPE; v_run route_runs%ROWTYPE;
  v_revenue decimal; v_expenses decimal; v_advances decimal; v_handovers decimal;
  v_result jsonb;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_run FROM route_runs WHERE route_id = p_route_id AND direction = p_direction
    AND (started_at AT TIME ZONE 'Asia/Karachi')::date = p_travel_date ORDER BY started_at DESC LIMIT 1;

  SELECT
    COALESCE((SELECT SUM(total_amount_pkr) FROM manual_ride_bookings
      WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction AND status IN ('confirmed', 'no_show')), 0)
    + COALESCE((SELECT SUM(total_amount_pkr) FROM ride_bookings
      WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction AND status IN ('announced', 'confirmed') AND NOT is_mid_route_catch), 0)
  INTO v_revenue;

  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_expenses FROM vehicle_expenses WHERE route_run_id = v_run.id;
  SELECT COALESCE(SUM(driver_advance_pkr), 0) INTO v_advances FROM route_stop_challans WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction;
  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_handovers FROM route_driver_cash_handovers WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction;

  SELECT jsonb_build_object(
    'route_id', p_route_id, 'travel_date', p_travel_date, 'direction', p_direction,
    'origin', v_route.origin, 'destination', v_route.destination,
    'run_started_at', v_run.started_at, 'run_ended_at', v_run.ended_at,
    'stop_challans', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', sc.id, 'stop_id', sc.stop_id, 'stop_label', rs.label, 'terminal_city', fc.city, 'terminal_name', fc.name,
        'expected_count', sc.expected_count, 'boarded_count', sc.boarded_count, 'no_show_count', sc.no_show_count,
        'cash_collected_pkr', sc.cash_collected_pkr, 'digital_collected_pkr', sc.digital_collected_pkr,
        'driver_advance_pkr', sc.driver_advance_pkr, 'other_cash_pkr', sc.other_cash_pkr, 'note', sc.note, 'closed_at', sc.closed_at
      ) ORDER BY COALESCE(rs.stop_order, -1)), '[]'::jsonb)
      FROM route_stop_challans sc
      LEFT JOIN route_stops rs ON rs.id = sc.stop_id
      LEFT JOIN fleet_counters fc ON fc.id = rs.counter_id
      WHERE sc.route_id = p_route_id AND sc.travel_date = p_travel_date AND sc.direction = p_direction
    ),
    'total_stops', (SELECT COUNT(*) + 1 FROM route_stops WHERE route_id = p_route_id),
    'closed_stops', (SELECT COUNT(*) FROM route_stop_challans WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction),
    'revenue_pkr', v_revenue,
    'expenses_pkr', v_expenses,
    'driver_advances_pkr', v_advances,
    'driver_handovers_pkr', v_handovers,
    'driver_cash_float_pkr', v_advances - v_handovers,
    'net_result_pkr', v_revenue - v_expenses,
    'handovers', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', h.id, 'amount_pkr', h.amount_pkr, 'received_by_counter_id', h.received_by_counter_id,
        'counter_city', fc.city, 'note', h.note, 'created_at', h.created_at) ORDER BY h.created_at), '[]'::jsonb)
      FROM route_driver_cash_handovers h LEFT JOIN fleet_counters fc ON fc.id = h.received_by_counter_id
      WHERE h.route_id = p_route_id AND h.travel_date = p_travel_date AND h.direction = p_direction
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION route_master_trip_challan(uuid, date, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION route_master_trip_challan(uuid, date, varchar) TO authenticated;
