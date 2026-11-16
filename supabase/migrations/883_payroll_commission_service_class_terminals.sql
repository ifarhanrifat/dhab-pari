-- Migration 883: real gaps confirmed against code before building —
-- fleet_staff_salaries/fleet_staff_salary_payments (860) already give a
-- real flat monthly salary system; what's missing is (a) a per-seat
-- booking-officer commission tied to actual sales, reversed on
-- cancellation, matching the reference dashboard's own "Maria Aslam ·
-- ₨30 per confirmed seat" example, (b) a driver licence number/expiry
-- — reused from vehicle_documents (881) as a 4th document type rather
-- than a new table, since a licence is exactly the same "renewable,
-- alerted on expiry" shape, (c) a named service class so a route can
-- present itself as "Economy"/"Executive"/"Sleeper" the way Daewoo
-- Express does (grounded via real research, not guessed), and (d)
-- fleet_counters (city+name only, confirmed) widened into a real
-- managed entity (GPS, cash-office code, today's departures) — the
-- counter-to-staff link (assign_staff_to_counter, 855) already exists,
-- reused as-is.

-- ═════════════════════════════════════════════════════════════════════
-- 1. Staff role (a visible label for organizing/filtering staff —
--    deliberately NOT a permission matrix; every fleet_staff member
--    keeps the exact same access they already have today regardless of
--    role, since retrofitting real permission checks across dozens of
--    existing RPCs risks breaking live staff workflows for a cosmetic
--    win) and a per-seat commission rate.
-- ═════════════════════════════════════════════════════════════════════
ALTER TABLE fleet_staff ADD COLUMN IF NOT EXISTS role varchar NOT NULL DEFAULT 'staff'
  CHECK (role IN ('staff', 'booking_officer', 'terminal_manager', 'accountant', 'other'));
ALTER TABLE fleet_staff ADD COLUMN IF NOT EXISTS commission_amount_pkr decimal CHECK (commission_amount_pkr IS NULL OR commission_amount_pkr >= 0);

CREATE OR REPLACE FUNCTION set_fleet_staff_role(p_fleet_staff_id uuid, p_role varchar) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleet_staff fs JOIN fleets f ON f.id = fs.fleet_id WHERE fs.id = p_fleet_staff_id AND f.owning_portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_role NOT IN ('staff', 'booking_officer', 'terminal_manager', 'accountant', 'other') THEN
    RAISE EXCEPTION 'Unknown role.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE fleet_staff SET role = p_role WHERE id = p_fleet_staff_id;
END;
$$;
REVOKE ALL ON FUNCTION set_fleet_staff_role(uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_fleet_staff_role(uuid, varchar) TO authenticated;

CREATE OR REPLACE FUNCTION set_fleet_staff_commission(p_fleet_staff_id uuid, p_commission_amount_pkr decimal) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleet_staff fs JOIN fleets f ON f.id = fs.fleet_id WHERE fs.id = p_fleet_staff_id AND f.owning_portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_commission_amount_pkr IS NOT NULL AND p_commission_amount_pkr < 0 THEN RAISE EXCEPTION 'Enter a real commission amount.' USING ERRCODE = 'P0001'; END IF;
  UPDATE fleet_staff SET commission_amount_pkr = p_commission_amount_pkr WHERE id = p_fleet_staff_id;
END;
$$;
REVOKE ALL ON FUNCTION set_fleet_staff_commission(uuid, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_fleet_staff_commission(uuid, decimal) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 2. Commission ledger — one row per manual sale a staff member earns
--    on, reversed (not deleted) on cancellation so the audit trail
--    stays real, matching the reference dashboard's own rule:
--    "Reversals for cancellations/refunds must reverse or adjust
--    commission."
-- ═════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS fleet_staff_commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_staff_id uuid NOT NULL REFERENCES fleet_staff(id) ON DELETE CASCADE,
  manual_ride_booking_id uuid NOT NULL REFERENCES manual_ride_bookings(id) ON DELETE CASCADE,
  seats int NOT NULL,
  amount_pkr decimal NOT NULL,
  status varchar NOT NULL DEFAULT 'earned' CHECK (status IN ('earned', 'reversed')),
  created_at timestamptz DEFAULT now(),
  reversed_at timestamptz,
  UNIQUE (manual_ride_booking_id)
);
CREATE INDEX IF NOT EXISTS fleet_staff_commissions_staff_idx ON fleet_staff_commissions(fleet_staff_id, created_at DESC);
ALTER TABLE fleet_staff_commissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_staff_commissions_manager_read" ON fleet_staff_commissions FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM fleet_staff fs JOIN fleets f ON f.id = fs.fleet_id
    WHERE fs.id = fleet_staff_id AND (f.owning_portal_user_id = current_portal_user_id() OR fs.portal_user_id = current_portal_user_id())
  ) OR current_admin_permission('manage_parties'));
-- No INSERT/UPDATE/DELETE policy — SECURITY DEFINER RPC only.

-- record_manual_booking — same signature as 878's live version, widened
-- to credit commission to whoever actually recorded the sale.
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
  v_lo int; v_hi int; v_sn int;
  v_fleet_staff fleet_staff%ROWTYPE;
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
    v_lo := seat_stop_order(p_board_stop_id, -1);
    v_hi := seat_stop_order(p_alight_stop_id, 2000000000);
    FOREACH v_sn IN ARRAY (SELECT array_agg(x ORDER BY x) FROM unnest(p_seat_numbers) x) LOOP
      PERFORM assert_seat_segment_free(p_route_id, p_travel_date, 'outbound', v_sn, v_lo, v_hi);
      INSERT INTO ride_booking_seat_numbers (manual_ride_booking_id, route_id, travel_date, direction, seat_number, board_order, alight_order)
      VALUES (v_id, p_route_id, p_travel_date, 'outbound', v_sn, v_lo, v_hi);
    END LOOP;
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

  -- 883: credit the recording staff member's commission, if they have
  -- one set — the fleet owner themselves never has a fleet_staff row
  -- in their own fleet, so this naturally no-ops for owner-recorded sales.
  SELECT * INTO v_fleet_staff FROM fleet_staff WHERE portal_user_id = v_portal_user_id AND fleet_id = v_vehicle.fleet_id;
  IF FOUND AND v_fleet_staff.commission_amount_pkr IS NOT NULL AND v_fleet_staff.commission_amount_pkr > 0 THEN
    INSERT INTO fleet_staff_commissions (fleet_staff_id, manual_ride_booking_id, seats, amount_pkr)
    VALUES (v_fleet_staff.id, v_id, p_seats, v_fleet_staff.commission_amount_pkr * p_seats);
  END IF;

  RETURN jsonb_build_object('id', v_id, 'ticket_no', v_ticket_no);
END;
$$;

-- cancel_manual_booking — same signature as 855's live version, widened
-- to reverse any commission earned on this sale.
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
  UPDATE fleet_staff_commissions SET status = 'reversed', reversed_at = now() WHERE manual_ride_booking_id = p_id AND status = 'earned';
END;
$$;

-- my_fleet_staff — same signature as 855's live version, widened with
-- role/commission rate and this-month commission earned.
CREATE OR REPLACE FUNCTION my_fleet_staff(p_fleet_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', fs.id, 'portal_user_id', fs.portal_user_id, 'full_name', pu.full_name, 'added_at', fs.added_at,
    'counter_id', fs.counter_id, 'counter_city', c.city, 'counter_name', c.name,
    'role', fs.role, 'commission_amount_pkr', fs.commission_amount_pkr,
    'commission_this_month_pkr', (
      SELECT COALESCE(SUM(fc.amount_pkr), 0) FROM fleet_staff_commissions fc
      WHERE fc.fleet_staff_id = fs.id AND fc.status = 'earned'
        AND date_trunc('month', fc.created_at AT TIME ZONE 'Asia/Karachi') = date_trunc('month', now() AT TIME ZONE 'Asia/Karachi')
    )
  ) ORDER BY fs.added_at), '[]'::jsonb)
  FROM fleet_staff fs JOIN portal_users pu ON pu.id = fs.portal_user_id
  LEFT JOIN fleet_counters c ON c.id = fs.counter_id
  WHERE fs.fleet_id = p_fleet_id AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id());
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 3. Driver licence — reused from vehicle_documents (881) as a 4th
--    document type rather than a new table; it's exactly the same
--    "renewable, alerted on expiry" shape, and the vehicle_document_
--    status/fleet_document_alerts RPCs already report whatever's in
--    the table with no type filter, so they need no change at all.
-- ═════════════════════════════════════════════════════════════════════
-- Never hand-type a Postgres-generated constraint name (this session's
-- own earlier overload-ambiguity incident was exactly this class of
-- mistake) — dynamic lookup by column instead.
DO $$
DECLARE v_conname text;
BEGIN
  SELECT con.conname INTO v_conname
  FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'vehicle_documents' AND con.contype = 'c' AND pg_get_constraintdef(con.oid) LIKE '%document_type%';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE vehicle_documents DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;
ALTER TABLE vehicle_documents ADD CONSTRAINT vehicle_documents_document_type_check
  CHECK (document_type IN ('route_permit', 'fitness_certificate', 'insurance', 'driver_licence'));

-- ═════════════════════════════════════════════════════════════════════
-- 4. Service class — a named label a route presents itself as, the
--    way Daewoo Express shows "Luxury" vs "Sleeper" (confirmed via
--    real research, not guessed). Deliberately NOT a fare multiplier
--    — fare_per_seat_pkr is already owner-set directly per route with
--    its own fair-fare-ceiling check; layering a multiplier on top
--    would have to interact with that existing validation in a way
--    that risks the exact class of regression already hit once this
--    session when shared pricing/booking code was touched carelessly.
-- ═════════════════════════════════════════════════════════════════════
ALTER TABLE vehicle_routes ADD COLUMN IF NOT EXISTS service_class varchar
  CHECK (service_class IS NULL OR service_class IN ('economy', 'business', 'executive', 'sleeper', 'luxury'));

CREATE OR REPLACE FUNCTION set_route_service_class(p_route_id uuid, p_service_class varchar DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(v_route.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF p_service_class IS NOT NULL AND p_service_class NOT IN ('economy', 'business', 'executive', 'sleeper', 'luxury') THEN
    RAISE EXCEPTION 'Unknown service class.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE vehicle_routes SET service_class = p_service_class WHERE id = p_route_id;
END;
$$;
REVOKE ALL ON FUNCTION set_route_service_class(uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_route_service_class(uuid, varchar) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 5. Terminal as a real managed entity — fleet_counters was city+name
--    only (confirmed directly). The counter-to-staff link (assign_
--    staff_to_counter, 855) already exists and is reused as-is for
--    "who manages this counter" rather than duplicating it with a new
--    column.
-- ═════════════════════════════════════════════════════════════════════
ALTER TABLE fleet_counters ADD COLUMN IF NOT EXISTS lat decimal;
ALTER TABLE fleet_counters ADD COLUMN IF NOT EXISTS lng decimal;
ALTER TABLE fleet_counters ADD COLUMN IF NOT EXISTS cash_office_code varchar;

CREATE OR REPLACE FUNCTION create_fleet_counter(p_fleet_id uuid, p_city varchar, p_name varchar DEFAULT NULL, p_lat decimal DEFAULT NULL, p_lng decimal DEFAULT NULL, p_cash_office_code varchar DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id AND owning_portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF trim(coalesce(p_city, '')) = '' THEN RAISE EXCEPTION 'Enter the counter''s city.' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO fleet_counters (fleet_id, city, name, lat, lng, cash_office_code)
  VALUES (p_fleet_id, trim(p_city), nullif(trim(coalesce(p_name, '')), ''), p_lat, p_lng, nullif(trim(coalesce(p_cash_office_code, '')), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION create_fleet_counter(uuid, varchar, varchar, decimal, decimal, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_fleet_counter(uuid, varchar, varchar, decimal, decimal, varchar) TO authenticated;

-- my_fleet_counters widened with GPS/cash-office code, the assigned
-- manager's name (any fleet_staff whose counter_id points here), and
-- today's departure count (manual bookings sold from this counter for
-- today's date — the real "today's departures" metric the reference
-- dashboard's terminal directory shows).
CREATE OR REPLACE FUNCTION my_fleet_counters(p_fleet_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'city', c.city, 'name', c.name, 'lat', c.lat, 'lng', c.lng, 'cash_office_code', c.cash_office_code,
    'manager_name', (SELECT pu.full_name FROM fleet_staff fs JOIN portal_users pu ON pu.id = fs.portal_user_id WHERE fs.counter_id = c.id LIMIT 1),
    'today_bookings_count', (
      SELECT COUNT(*) FROM manual_ride_bookings mb WHERE mb.counter_id = c.id AND mb.status = 'confirmed'
        AND mb.travel_date = (now() AT TIME ZONE 'Asia/Karachi')::date
    )
  ) ORDER BY c.city), '[]'::jsonb)
  FROM fleet_counters c WHERE c.fleet_id = p_fleet_id
    AND (EXISTS (SELECT 1 FROM fleets f WHERE f.id = c.fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = c.fleet_id AND fs.portal_user_id = current_portal_user_id()));
$$;
