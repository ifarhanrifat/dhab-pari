-- Migration 874: real spec given live — a proper bus-ticketing flow for
-- the booking officer. Phase 1 (this migration): ticket number + a real
-- passenger manifest with gender and a confirmed fare policy for free
-- children, and a boarding check-in path usable by both the counter
-- officer and the driver on the road. Explicitly deferred to a later
-- round (flagged, not silently dropped): one-tap WhatsApp send, a
-- map-click stop picker (the existing dropdown stays for now), expense
-- receipt uploads, and a registration-number-first driver roster.
--
-- Fare policy confirmed directly: a booking of 2+ paid seats may carry
-- any number of free accompanying children (no seat_number, lap-held);
-- a booking of exactly 1 paid seat may only carry a free INFANT
-- (age <= 2) — an older child needs their own paid seat.

-- ═════════════════════════════════════════════════════════════════════
-- 1. Ticket number — a dedicated sequence, not reused from any existing
--    voucher/receipt numbering (those are 4-digit, per-system; this is
--    a flat 10-digit customer-facing reference with no prefix).
-- ═════════════════════════════════════════════════════════════════════
CREATE SEQUENCE IF NOT EXISTS ticket_no_seq START 1000000001;

CREATE OR REPLACE FUNCTION generate_ticket_no() RETURNS varchar
LANGUAGE sql AS $$
  SELECT lpad(nextval('ticket_no_seq')::text, 10, '0');
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 2. Schema — ticket fields + boarding timestamps (manual_ride_bookings
--    had neither at all) + a real per-passenger manifest row.
-- ═════════════════════════════════════════════════════════════════════
ALTER TABLE manual_ride_bookings ADD COLUMN IF NOT EXISTS ticket_no varchar UNIQUE;
ALTER TABLE manual_ride_bookings ADD COLUMN IF NOT EXISTS emergency_contact_phone varchar;
ALTER TABLE manual_ride_bookings ADD COLUMN IF NOT EXISTS boarded_at timestamptz;
ALTER TABLE manual_ride_bookings ADD COLUMN IF NOT EXISTS dropped_off_at timestamptz;

CREATE TABLE IF NOT EXISTS manual_ride_booking_passengers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manual_ride_booking_id uuid NOT NULL REFERENCES manual_ride_bookings(id) ON DELETE CASCADE,
  full_name varchar NOT NULL,
  gender varchar CHECK (gender IN ('male', 'female', 'other')),
  age int CHECK (age IS NULL OR (age >= 0 AND age <= 120)),
  is_free_child boolean NOT NULL DEFAULT false,
  seat_number int
);
CREATE INDEX IF NOT EXISTS manual_ride_booking_passengers_booking_idx ON manual_ride_booking_passengers(manual_ride_booking_id);
ALTER TABLE manual_ride_booking_passengers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "manual_ride_booking_passengers_manager_read" ON manual_ride_booking_passengers FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM manual_ride_bookings mb JOIN vehicle_routes vr ON vr.id = mb.route_id WHERE mb.id = manual_ride_booking_id AND can_manage_vehicle(vr.vehicle_id))
    OR current_admin_permission('manage_parties'));
-- No INSERT/UPDATE/DELETE policy — SECURITY DEFINER RPC only.

-- ═════════════════════════════════════════════════════════════════════
-- 3. record_manual_booking — widened with ticket generation, emergency
--    contact, and the real passenger manifest + fare policy. New
--    trailing params + a changed return type (jsonb instead of uuid,
--    now returning the ticket number too) both change the signature —
--    the old version is dropped explicitly first.
-- ═════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.record_manual_booking(uuid, date, int, varchar, decimal, uuid, varchar, varchar, uuid, uuid, int[]);

CREATE OR REPLACE FUNCTION record_manual_booking(
  p_route_id uuid, p_travel_date date, p_seats int, p_passenger_name varchar, p_total_amount_pkr decimal,
  p_counter_id uuid DEFAULT NULL, p_passenger_mobile varchar DEFAULT NULL, p_payment_method varchar DEFAULT 'cash',
  p_board_stop_id uuid DEFAULT NULL, p_alight_stop_id uuid DEFAULT NULL, p_seat_numbers int[] DEFAULT NULL,
  p_emergency_contact_phone varchar DEFAULT NULL, p_passengers jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE; v_vehicle_kind varchar;
  v_available int; v_id uuid; v_ticket_no varchar;
  v_passenger jsonb; v_paid_idx int := 0; v_free_count int := 0;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  IF p_board_stop_id IS NULL
     AND p_travel_date = (now() AT TIME ZONE 'Asia/Karachi')::date
     AND EXISTS (SELECT 1 FROM route_runs WHERE route_id = p_route_id AND direction = 'outbound' AND ended_at IS NULL AND (started_at AT TIME ZONE 'Asia/Karachi')::date = p_travel_date)
  THEN
    RAISE EXCEPTION 'This bus has already left % today — sell a seat for a stop further along the route, or a different date.', v_route.origin USING ERRCODE = 'P0001';
  END IF;

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

  -- Fare policy for any free (accompanying child) passengers in
  -- p_passengers: 2+ paid seats carries any under-10 child free; a
  -- single paid seat only carries a free infant (age <= 2).
  IF p_passengers IS NOT NULL THEN
    FOR v_passenger IN SELECT * FROM jsonb_array_elements(p_passengers) LOOP
      IF COALESCE((v_passenger->>'is_free_child')::boolean, false) THEN
        v_free_count := v_free_count + 1;
        IF p_seats = 1 AND COALESCE((v_passenger->>'age')::int, 99) > 2 THEN
          RAISE EXCEPTION 'With a single paid seat, only an infant (2 years or younger) can travel free — this child needs their own seat.' USING ERRCODE = 'P0001';
        END IF;
      END IF;
    END LOOP;
  END IF;

  v_ticket_no := generate_ticket_no();

  INSERT INTO manual_ride_bookings (route_id, counter_id, recorded_by_portal_user_id, travel_date, seats, passenger_name, passenger_mobile, board_stop_id, alight_stop_id, total_amount_pkr, payment_method, ticket_no, emergency_contact_phone)
  VALUES (p_route_id, p_counter_id, v_portal_user_id, p_travel_date, p_seats, trim(p_passenger_name), nullif(trim(coalesce(p_passenger_mobile, '')), ''), p_board_stop_id, p_alight_stop_id, p_total_amount_pkr, p_payment_method, v_ticket_no, nullif(trim(coalesce(p_emergency_contact_phone, '')), ''))
  RETURNING id INTO v_id;

  IF p_seat_numbers IS NOT NULL THEN
    BEGIN
      INSERT INTO ride_booking_seat_numbers (manual_ride_booking_id, route_id, travel_date, direction, seat_number)
      SELECT v_id, p_route_id, p_travel_date, 'outbound', sn FROM unnest(p_seat_numbers) sn;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'One of those seats was just taken by someone else — pick again.' USING ERRCODE = 'P0001';
    END;
  END IF;

  IF p_passengers IS NOT NULL THEN
    FOR v_passenger IN SELECT * FROM jsonb_array_elements(p_passengers) LOOP
      IF COALESCE((v_passenger->>'is_free_child')::boolean, false) THEN
        INSERT INTO manual_ride_booking_passengers (manual_ride_booking_id, full_name, gender, age, is_free_child, seat_number)
        VALUES (v_id, v_passenger->>'full_name', nullif(v_passenger->>'gender', ''), (v_passenger->>'age')::int, true, NULL);
      ELSE
        v_paid_idx := v_paid_idx + 1;
        INSERT INTO manual_ride_booking_passengers (manual_ride_booking_id, full_name, gender, age, is_free_child, seat_number)
        VALUES (v_id, v_passenger->>'full_name', nullif(v_passenger->>'gender', ''), (v_passenger->>'age')::int, false,
          CASE WHEN p_seat_numbers IS NOT NULL AND array_length(p_seat_numbers, 1) >= v_paid_idx THEN p_seat_numbers[v_paid_idx] ELSE NULL END);
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'ticket_no', v_ticket_no);
END;
$$;
REVOKE ALL ON FUNCTION record_manual_booking(uuid, date, int, varchar, decimal, uuid, varchar, varchar, uuid, uuid, int[], varchar, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_manual_booking(uuid, date, int, varchar, decimal, uuid, varchar, varchar, uuid, uuid, int[], varchar, jsonb) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 4. board_manual_ticket — same gate as everything else that touches a
--    manual booking (can_manage_vehicle), callable by the counter
--    officer AND the driver on the road alike.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION board_manual_ticket(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE mb manual_ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO mb FROM manual_ride_bookings WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ticket not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_routes WHERE id = mb.route_id;
  IF NOT can_manage_vehicle(r.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF mb.status != 'confirmed' THEN RAISE EXCEPTION 'This ticket is not valid for boarding.' USING ERRCODE = 'P0001'; END IF;
  IF mb.boarded_at IS NOT NULL THEN RAISE EXCEPTION 'This ticket has already boarded.' USING ERRCODE = 'P0001'; END IF;
  UPDATE manual_ride_bookings SET boarded_at = now() WHERE id = p_id;
END;
$$;
REVOKE ALL ON FUNCTION board_manual_ticket(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION board_manual_ticket(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 5. fleet_search_bookings — gains ticket_no/boarded_at so the same
--    search box works as a ticket/boarding-pass lookup (by ticket
--    number, name, or phone), not just a reschedule/cancel finder.
--    Same signature, true replace.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fleet_search_bookings(p_fleet_id uuid, p_query text DEFAULT NULL, p_travel_date date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result jsonb; v_q text := nullif(trim(coalesce(p_query, '')), '');
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'travel_date' DESC), '[]'::jsonb) INTO v_result FROM (
    SELECT jsonb_build_object(
      'id', mb.id, 'source', 'manual', 'passenger_name', mb.passenger_name, 'passenger_mobile', mb.passenger_mobile,
      'route_id', mb.route_id, 'origin', vr.origin, 'destination', vr.destination, 'owner_name', v.owner_name,
      'travel_date', mb.travel_date, 'seats', mb.seats, 'amount_pkr', mb.total_amount_pkr,
      'status', mb.status, 'payment_method', mb.payment_method,
      'vehicle_id', v.id, 'is_van_kind', vc.vehicle_kind = 'van', 'total_seats', v.total_seats, 'is_sleeper', v.is_sleeper,
      'seat_numbers', (SELECT array_agg(sn.seat_number ORDER BY sn.seat_number) FROM ride_booking_seat_numbers sn WHERE sn.manual_ride_booking_id = mb.id),
      'ticket_no', mb.ticket_no, 'boarded_at', mb.boarded_at, 'vehicle_number', v.vehicle_number, 'service_code', vr.service_code,
      'emergency_contact_phone', mb.emergency_contact_phone
    ) AS row
    FROM manual_ride_bookings mb JOIN vehicle_routes vr ON vr.id = mb.route_id JOIN vehicles v ON v.id = vr.vehicle_id
    LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
    WHERE v.fleet_id = p_fleet_id AND mb.status = 'confirmed'
      AND (p_travel_date IS NULL OR mb.travel_date = p_travel_date)
      AND (v_q IS NULL OR mb.passenger_name ILIKE '%' || v_q || '%' OR mb.passenger_mobile ILIKE '%' || v_q || '%' OR mb.ticket_no ILIKE '%' || v_q || '%')

    UNION ALL

    SELECT jsonb_build_object(
      'id', rb.id, 'source', 'app', 'passenger_name', pu.full_name, 'passenger_mobile', pu.mobile,
      'route_id', rb.route_id, 'origin', vr.origin, 'destination', vr.destination, 'owner_name', v.owner_name,
      'travel_date', rb.travel_date, 'seats', rb.seats, 'amount_pkr', rb.total_amount_pkr,
      'status', rb.status, 'payment_method', rb.announced_method,
      'vehicle_id', v.id, 'is_van_kind', vc.vehicle_kind = 'van', 'total_seats', v.total_seats, 'is_sleeper', v.is_sleeper,
      'seat_numbers', (SELECT array_agg(sn.seat_number ORDER BY sn.seat_number) FROM ride_booking_seat_numbers sn WHERE sn.ride_booking_id = rb.id),
      'ticket_no', NULL, 'boarded_at', rb.boarded_at, 'vehicle_number', v.vehicle_number, 'service_code', vr.service_code,
      'emergency_contact_phone', NULL
    ) AS row
    FROM ride_bookings rb JOIN vehicle_routes vr ON vr.id = rb.route_id JOIN vehicles v ON v.id = vr.vehicle_id
    LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
    JOIN portal_users pu ON pu.id = rb.portal_user_id
    WHERE v.fleet_id = p_fleet_id AND rb.status IN ('announced', 'confirmed')
      AND (p_travel_date IS NULL OR rb.travel_date = p_travel_date)
      AND (v_q IS NULL OR pu.full_name ILIKE '%' || v_q || '%' OR pu.mobile ILIKE '%' || v_q || '%')
  ) rows;
  RETURN v_result;
END;
$$;
