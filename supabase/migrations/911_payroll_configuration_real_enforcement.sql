-- Migration 911: Staff screen rebuild, Part A — Payroll configuration
-- that actually changes computed behavior (plan: proud-tickling-
-- glacier.md). The mockup's own panel is tagged "Illustrative" and
-- the user explicitly asked to go further than that here.

CREATE TABLE IF NOT EXISTS fleet_payroll_settings (
  fleet_id uuid PRIMARY KEY REFERENCES fleets(id) ON DELETE CASCADE,
  pay_frequency varchar NOT NULL DEFAULT 'monthly' CHECK (pay_frequency IN ('monthly', 'weekly', 'per_trip')),
  overtime_calculation varchar NOT NULL DEFAULT 'manual' CHECK (overtime_calculation IN ('hourly_rate', 'fixed_shift', 'manual')),
  overtime_hourly_rate_pkr decimal CHECK (overtime_hourly_rate_pkr IS NULL OR overtime_hourly_rate_pkr >= 0),
  overtime_fixed_shift_pkr decimal CHECK (overtime_fixed_shift_pkr IS NULL OR overtime_fixed_shift_pkr >= 0),
  commission_eligibility varchar NOT NULL DEFAULT 'confirmed_paid' CHECK (commission_eligibility IN ('confirmed_paid', 'completed_journey')),
  default_commission_per_seat_pkr decimal CHECK (default_commission_per_seat_pkr IS NULL OR default_commission_per_seat_pkr >= 0),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE fleet_payroll_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_payroll_settings_manager_read" ON fleet_payroll_settings FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM fleets f WHERE f.id = fleet_id AND f.owning_portal_user_id = current_portal_user_id())
    OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = fleet_payroll_settings.fleet_id AND fs.portal_user_id = current_portal_user_id()));
-- No INSERT/UPDATE/DELETE policy — SECURITY DEFINER RPC only.

CREATE TABLE IF NOT EXISTS fleet_staff_overtime_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_staff_id uuid NOT NULL REFERENCES fleet_staff(id) ON DELETE CASCADE,
  work_date date NOT NULL,
  hours decimal CHECK (hours IS NULL OR hours > 0),
  amount_pkr decimal NOT NULL CHECK (amount_pkr >= 0),
  note text,
  recorded_by uuid REFERENCES portal_users(id),
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fleet_staff_overtime_entries_staff_idx ON fleet_staff_overtime_entries(fleet_staff_id, work_date DESC);
ALTER TABLE fleet_staff_overtime_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_staff_overtime_manager_read" ON fleet_staff_overtime_entries FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM fleet_staff fs JOIN fleets f ON f.id = fs.fleet_id WHERE fs.id = fleet_staff_id AND f.owning_portal_user_id = current_portal_user_id()));

CREATE OR REPLACE FUNCTION my_fleet_payroll_settings(p_fleet_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row fleet_payroll_settings%ROWTYPE;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_row FROM fleet_payroll_settings WHERE fleet_id = p_fleet_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'pay_frequency', 'monthly', 'overtime_calculation', 'manual', 'overtime_hourly_rate_pkr', null,
      'overtime_fixed_shift_pkr', null, 'commission_eligibility', 'confirmed_paid', 'default_commission_per_seat_pkr', null
    );
  END IF;
  RETURN jsonb_build_object(
    'pay_frequency', v_row.pay_frequency, 'overtime_calculation', v_row.overtime_calculation,
    'overtime_hourly_rate_pkr', v_row.overtime_hourly_rate_pkr, 'overtime_fixed_shift_pkr', v_row.overtime_fixed_shift_pkr,
    'commission_eligibility', v_row.commission_eligibility, 'default_commission_per_seat_pkr', v_row.default_commission_per_seat_pkr
  );
END;
$$;
REVOKE ALL ON FUNCTION my_fleet_payroll_settings(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_fleet_payroll_settings(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION set_fleet_payroll_settings(
  p_fleet_id uuid, p_pay_frequency varchar, p_overtime_calculation varchar,
  p_overtime_hourly_rate_pkr decimal DEFAULT NULL, p_overtime_fixed_shift_pkr decimal DEFAULT NULL,
  p_commission_eligibility varchar DEFAULT 'confirmed_paid', p_default_commission_per_seat_pkr decimal DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id AND owning_portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_pay_frequency NOT IN ('monthly', 'weekly', 'per_trip') THEN RAISE EXCEPTION 'Unknown pay frequency.' USING ERRCODE = 'P0001'; END IF;
  IF p_overtime_calculation NOT IN ('hourly_rate', 'fixed_shift', 'manual') THEN RAISE EXCEPTION 'Unknown overtime calculation.' USING ERRCODE = 'P0001'; END IF;
  IF p_commission_eligibility NOT IN ('confirmed_paid', 'completed_journey') THEN RAISE EXCEPTION 'Unknown commission eligibility rule.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO fleet_payroll_settings (
    fleet_id, pay_frequency, overtime_calculation, overtime_hourly_rate_pkr, overtime_fixed_shift_pkr, commission_eligibility, default_commission_per_seat_pkr, updated_at
  )
  VALUES (p_fleet_id, p_pay_frequency, p_overtime_calculation, p_overtime_hourly_rate_pkr, p_overtime_fixed_shift_pkr, p_commission_eligibility, p_default_commission_per_seat_pkr, now())
  ON CONFLICT (fleet_id) DO UPDATE SET
    pay_frequency = EXCLUDED.pay_frequency, overtime_calculation = EXCLUDED.overtime_calculation,
    overtime_hourly_rate_pkr = EXCLUDED.overtime_hourly_rate_pkr, overtime_fixed_shift_pkr = EXCLUDED.overtime_fixed_shift_pkr,
    commission_eligibility = EXCLUDED.commission_eligibility, default_commission_per_seat_pkr = EXCLUDED.default_commission_per_seat_pkr,
    updated_at = now();
END;
$$;
REVOKE ALL ON FUNCTION set_fleet_payroll_settings(uuid, varchar, varchar, decimal, decimal, varchar, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_fleet_payroll_settings(uuid, varchar, varchar, decimal, decimal, varchar, decimal) TO authenticated;

CREATE OR REPLACE FUNCTION record_staff_overtime(p_fleet_staff_id uuid, p_work_date date, p_hours decimal DEFAULT NULL, p_manual_amount_pkr decimal DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fleet_id uuid; v_settings fleet_payroll_settings%ROWTYPE; v_amount decimal; v_id uuid;
BEGIN
  SELECT fleet_id INTO v_fleet_id FROM fleet_staff WHERE id = p_fleet_staff_id;
  IF v_fleet_id IS NULL THEN RAISE EXCEPTION 'Staff member not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = v_fleet_id AND owning_portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF p_work_date IS NULL THEN RAISE EXCEPTION 'Enter the work date.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_settings FROM fleet_payroll_settings WHERE fleet_id = v_fleet_id;
  IF NOT FOUND OR v_settings.overtime_calculation = 'manual' THEN
    IF p_manual_amount_pkr IS NULL OR p_manual_amount_pkr <= 0 THEN RAISE EXCEPTION 'Enter the overtime amount.' USING ERRCODE = 'P0001'; END IF;
    v_amount := p_manual_amount_pkr;
  ELSIF v_settings.overtime_calculation = 'hourly_rate' THEN
    IF p_hours IS NULL OR p_hours <= 0 THEN RAISE EXCEPTION 'Enter the overtime hours.' USING ERRCODE = 'P0001'; END IF;
    IF v_settings.overtime_hourly_rate_pkr IS NULL THEN RAISE EXCEPTION 'Set an hourly overtime rate in payroll settings first.' USING ERRCODE = 'P0001'; END IF;
    v_amount := p_hours * v_settings.overtime_hourly_rate_pkr;
  ELSE
    IF v_settings.overtime_fixed_shift_pkr IS NULL THEN RAISE EXCEPTION 'Set a fixed shift overtime amount in payroll settings first.' USING ERRCODE = 'P0001'; END IF;
    v_amount := v_settings.overtime_fixed_shift_pkr;
  END IF;

  INSERT INTO fleet_staff_overtime_entries (fleet_staff_id, work_date, hours, amount_pkr, recorded_by)
  VALUES (p_fleet_staff_id, p_work_date, p_hours, v_amount, current_portal_user_id())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION record_staff_overtime(uuid, date, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_staff_overtime(uuid, date, decimal, decimal) TO authenticated;

-- record_manual_booking (905) — true replace. Only the final
-- commission block changes: the fleet's payroll settings now gate
-- WHEN commission is credited (skip here entirely under
-- 'completed_journey' — board_manual_ticket credits it instead) and
-- supply a fleet-wide default rate when the staff member has none of
-- their own. Every other line is byte-identical to 905.
CREATE OR REPLACE FUNCTION record_manual_booking(
  p_route_id uuid, p_travel_date date, p_seats int, p_passenger_name varchar, p_total_amount_pkr decimal,
  p_counter_id uuid DEFAULT NULL, p_passenger_mobile varchar DEFAULT NULL, p_payment_method varchar DEFAULT 'cash',
  p_board_stop_id uuid DEFAULT NULL, p_alight_stop_id uuid DEFAULT NULL, p_seat_numbers int[] DEFAULT NULL,
  p_emergency_contact_phone varchar DEFAULT NULL, p_passengers jsonb DEFAULT NULL,
  p_pickup_lat numeric DEFAULT NULL, p_pickup_lng numeric DEFAULT NULL, p_pickup_point varchar DEFAULT NULL,
  p_return_leg_of uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE; v_vehicle_kind varchar;
  v_available int; v_id uuid; v_ticket_no varchar;
  v_passenger jsonb; v_paid_idx int := 0; v_free_count int := 0;
  v_lo int; v_hi int; v_sn int;
  v_fleet_staff fleet_staff%ROWTYPE;
  v_pickup_approval varchar;
  v_payroll_settings fleet_payroll_settings%ROWTYPE; v_commission_rate decimal;
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

  IF p_pickup_lat IS NOT NULL OR p_pickup_lng IS NOT NULL THEN
    IF p_pickup_lat IS NULL OR p_pickup_lng IS NULL THEN
      RAISE EXCEPTION 'Enter both pickup coordinates, or neither.' USING ERRCODE = 'P0001';
    END IF;
    IF p_pickup_lat < -90 OR p_pickup_lat > 90 OR p_pickup_lng < -180 OR p_pickup_lng > 180 THEN
      RAISE EXCEPTION 'Enter valid GPS coordinates for the pickup pin.' USING ERRCODE = 'P0001';
    END IF;
    v_pickup_approval := 'pending';
  END IF;

  IF p_return_leg_of IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM manual_ride_bookings mb JOIN vehicle_routes vr ON vr.id = mb.route_id
      WHERE mb.id = p_return_leg_of AND mb.return_leg_of IS NULL AND can_manage_vehicle(vr.vehicle_id)
    ) THEN
      RAISE EXCEPTION 'The outbound booking for this return leg was not found.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

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

  INSERT INTO manual_ride_bookings (
    route_id, counter_id, recorded_by_portal_user_id, travel_date, seats, passenger_name, passenger_mobile, board_stop_id, alight_stop_id,
    total_amount_pkr, payment_method, ticket_no, emergency_contact_phone, pickup_lat, pickup_lng, pickup_point, pickup_approval_status, return_leg_of
  )
  VALUES (
    p_route_id, p_counter_id, v_portal_user_id, p_travel_date, p_seats, trim(p_passenger_name), nullif(trim(coalesce(p_passenger_mobile, '')), ''), p_board_stop_id, p_alight_stop_id,
    p_total_amount_pkr, p_payment_method, v_ticket_no, nullif(trim(coalesce(p_emergency_contact_phone, '')), ''), p_pickup_lat, p_pickup_lng, nullif(trim(coalesce(p_pickup_point, '')), ''), v_pickup_approval, p_return_leg_of
  )
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

  -- 911: commission timing and rate now come from the fleet's
  -- payroll settings — default 'confirmed_paid' keeps 883's original
  -- at-sale-time behavior exactly; 'completed_journey' skips crediting
  -- here entirely, board_manual_ticket credits it once boarded instead.
  SELECT * INTO v_fleet_staff FROM fleet_staff WHERE portal_user_id = v_portal_user_id AND fleet_id = v_vehicle.fleet_id;
  IF FOUND THEN
    SELECT * INTO v_payroll_settings FROM fleet_payroll_settings WHERE fleet_id = v_vehicle.fleet_id;
    v_commission_rate := COALESCE(v_fleet_staff.commission_amount_pkr, v_payroll_settings.default_commission_per_seat_pkr);
    IF v_commission_rate IS NOT NULL AND v_commission_rate > 0 AND COALESCE(v_payroll_settings.commission_eligibility, 'confirmed_paid') = 'confirmed_paid' THEN
      INSERT INTO fleet_staff_commissions (fleet_staff_id, manual_ride_booking_id, seats, amount_pkr)
      VALUES (v_fleet_staff.id, v_id, p_seats, v_commission_rate * p_seats);
    END IF;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'ticket_no', v_ticket_no, 'pickup_approval_status', v_pickup_approval);
END;
$$;

-- board_manual_ticket (875) — true replace. Adds deferred commission
-- crediting for the 'completed_journey' eligibility rule only; the
-- existing boarding logic above the new block is byte-identical to 875.
CREATE OR REPLACE FUNCTION board_manual_ticket(p_id uuid, p_luggage_note varchar DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  mb manual_ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v_vehicle vehicles%ROWTYPE;
  v_fleet_staff fleet_staff%ROWTYPE; v_payroll_settings fleet_payroll_settings%ROWTYPE; v_commission_rate decimal;
BEGIN
  SELECT * INTO mb FROM manual_ride_bookings WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ticket not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_routes WHERE id = mb.route_id;
  IF NOT can_manage_vehicle(r.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF mb.status != 'confirmed' THEN RAISE EXCEPTION 'This ticket is not valid for boarding.' USING ERRCODE = 'P0001'; END IF;
  IF mb.boarded_at IS NOT NULL THEN RAISE EXCEPTION 'This ticket has already boarded.' USING ERRCODE = 'P0001'; END IF;
  UPDATE manual_ride_bookings SET boarded_at = now(), luggage_note = COALESCE(nullif(trim(coalesce(p_luggage_note, '')), ''), luggage_note) WHERE id = p_id;

  -- 911: credit commission here when the fleet chose 'completed_journey'
  -- eligibility — record_manual_booking deliberately skipped it at sale
  -- time for that mode. The UNIQUE(manual_ride_booking_id) constraint
  -- on fleet_staff_commissions plus ON CONFLICT DO NOTHING makes this
  -- safe even though boarded_at's own check above already prevents a
  -- double-board.
  SELECT * INTO v_vehicle FROM vehicles WHERE id = r.vehicle_id;
  SELECT * INTO v_payroll_settings FROM fleet_payroll_settings WHERE fleet_id = v_vehicle.fleet_id;
  IF FOUND AND v_payroll_settings.commission_eligibility = 'completed_journey' THEN
    SELECT * INTO v_fleet_staff FROM fleet_staff WHERE portal_user_id = mb.recorded_by_portal_user_id AND fleet_id = v_vehicle.fleet_id;
    IF FOUND THEN
      v_commission_rate := COALESCE(v_fleet_staff.commission_amount_pkr, v_payroll_settings.default_commission_per_seat_pkr);
      IF v_commission_rate IS NOT NULL AND v_commission_rate > 0 THEN
        INSERT INTO fleet_staff_commissions (fleet_staff_id, manual_ride_booking_id, seats, amount_pkr)
        VALUES (v_fleet_staff.id, p_id, mb.seats, v_commission_rate * mb.seats)
        ON CONFLICT (manual_ride_booking_id) DO NOTHING;
      END IF;
    END IF;
  END IF;
END;
$$;

-- my_fleet_staff (909) — true replace, adds this-month overtime total
-- alongside the existing this-month commission total.
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
    ),
    'overtime_this_month_pkr', (
      SELECT COALESCE(SUM(oe.amount_pkr), 0) FROM fleet_staff_overtime_entries oe
      WHERE oe.fleet_staff_id = fs.id
        AND date_trunc('month', oe.work_date) = date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)
    ),
    'current_monthly_salary_pkr', (
      SELECT fss.monthly_salary_pkr FROM fleet_staff_salaries fss
      WHERE fss.fleet_staff_id = fs.id ORDER BY fss.effective_from DESC, fss.created_at DESC LIMIT 1
    ),
    'license_number', fs.license_number, 'license_expiry', fs.license_expiry, 'cnic_number', fs.cnic_number,
    'date_of_birth', fs.date_of_birth, 'blood_group', fs.blood_group, 'medical_report_url', fs.medical_report_url, 'photo_url', fs.photo_url
  ) ORDER BY fs.added_at), '[]'::jsonb)
  FROM fleet_staff fs JOIN portal_users pu ON pu.id = fs.portal_user_id
  LEFT JOIN fleet_counters c ON c.id = fs.counter_id
  WHERE fs.fleet_id = p_fleet_id AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id());
$$;
