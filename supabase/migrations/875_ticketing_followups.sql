-- Migration 875: Phase 2 of the ticketing system — the pieces explicitly
-- deferred when 874 shipped: driver expense receipt uploads, luggage
-- recorded at boarding (by either the counter or the driver), a
-- registration-number-first driver roster (on-trip vs free, read-only —
-- no new shuffle/dispatch mechanics, per the standing instruction to leave
-- driver-handover alone), and ticket search/boarding for a solo driver
-- with no fleet at all (874's fleet_search_bookings was fleet-scoped only).

-- ═════════════════════════════════════════════════════════════════════
-- 1. Expense receipts — a photo of the fuel/toll/maintenance receipt,
--    same privacy shape as every other proof-upload bucket in this app.
-- ═════════════════════════════════════════════════════════════════════
INSERT INTO storage.buckets (id, name, public) VALUES ('vehicle_expense_receipts', 'vehicle_expense_receipts', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Portal users can upload vehicle expense receipts" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'vehicle_expense_receipts');
CREATE POLICY "Fleet managers can read vehicle expense receipts" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'vehicle_expense_receipts' AND (
    EXISTS (SELECT 1 FROM fleets WHERE owning_portal_user_id = current_portal_user_id())
    OR EXISTS (SELECT 1 FROM fleet_staff WHERE portal_user_id = current_portal_user_id())
    OR EXISTS (SELECT 1 FROM vehicles WHERE portal_user_id = current_portal_user_id())
    OR current_admin_permission('manage_parties')
  ));

ALTER TABLE vehicle_expenses ADD COLUMN IF NOT EXISTS receipt_url text;

CREATE OR REPLACE FUNCTION record_vehicle_expense(
  p_vehicle_id uuid, p_category varchar, p_amount_pkr decimal, p_note text DEFAULT NULL, p_expense_date date DEFAULT NULL,
  p_route_run_id uuid DEFAULT NULL, p_station_name varchar DEFAULT NULL, p_lat double precision DEFAULT NULL, p_lng double precision DEFAULT NULL,
  p_receipt_url text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(p_vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF p_category NOT IN ('fuel', 'maintenance', 'toll', 'other') THEN RAISE EXCEPTION 'Invalid expense category.' USING ERRCODE = 'P0001'; END IF;
  IF p_amount_pkr IS NULL OR p_amount_pkr <= 0 THEN RAISE EXCEPTION 'Enter a real amount.' USING ERRCODE = 'P0001'; END IF;
  IF p_route_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM route_runs rr JOIN vehicle_routes vr ON vr.id = rr.route_id WHERE rr.id = p_route_run_id AND vr.vehicle_id = p_vehicle_id
  ) THEN
    RAISE EXCEPTION 'That trip does not belong to this vehicle.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO vehicle_expenses (vehicle_id, category, amount_pkr, note, expense_date, recorded_by_portal_user_id, route_run_id, station_name, lat, lng, receipt_url)
  VALUES (p_vehicle_id, p_category, p_amount_pkr, nullif(trim(coalesce(p_note, '')), ''), coalesce(p_expense_date, (now() AT TIME ZONE 'Asia/Karachi')::date), v_portal_user_id,
    p_route_run_id, nullif(trim(coalesce(p_station_name, '')), ''), p_lat, p_lng, nullif(trim(coalesce(p_receipt_url, '')), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 2. Luggage noted at boarding — a free-text note on the ticket itself
--    ("2 bags, 1 suitcase"), not the separate parcel-shipping product
--    (route_luggage_bookings, its own sender/receiver/fare flow). Either
--    the counter (recording it on the ticket before departure) or the
--    driver (recording it as the rider actually boards) can set it.
-- ═════════════════════════════════════════════════════════════════════
ALTER TABLE manual_ride_bookings ADD COLUMN IF NOT EXISTS luggage_note varchar;
ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS luggage_note varchar;

CREATE OR REPLACE FUNCTION board_manual_ticket(p_id uuid, p_luggage_note varchar DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE mb manual_ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE;
BEGIN
  SELECT * INTO mb FROM manual_ride_bookings WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ticket not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_routes WHERE id = mb.route_id;
  IF NOT can_manage_vehicle(r.vehicle_id) THEN RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001'; END IF;
  IF mb.status != 'confirmed' THEN RAISE EXCEPTION 'This ticket is not valid for boarding.' USING ERRCODE = 'P0001'; END IF;
  IF mb.boarded_at IS NOT NULL THEN RAISE EXCEPTION 'This ticket has already boarded.' USING ERRCODE = 'P0001'; END IF;
  UPDATE manual_ride_bookings SET boarded_at = now(), luggage_note = COALESCE(nullif(trim(coalesce(p_luggage_note, '')), ''), luggage_note) WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION board_ride_bookings(p_booking_ids uuid[], p_luggage_note varchar DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; b ride_bookings%ROWTYPE; v_owner_ok boolean;
BEGIN
  FOREACH v_id IN ARRAY p_booking_ids LOOP
    SELECT * INTO b FROM ride_bookings WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF b.status NOT IN ('announced', 'confirmed') OR b.boarded_at IS NOT NULL THEN CONTINUE; END IF;

    IF b.route_id IS NOT NULL THEN
      v_owner_ok := is_route_owner(b.route_id);
    ELSE
      SELECT EXISTS (SELECT 1 FROM adda_queue_entries e JOIN vehicles v ON v.id = e.vehicle_id WHERE e.id = b.adda_queue_entry_id AND v.portal_user_id = current_portal_user_id()) INTO v_owner_ok;
    END IF;
    IF NOT v_owner_ok THEN RAISE EXCEPTION 'You do not manage this booking''s vehicle.' USING ERRCODE = 'P0001'; END IF;

    UPDATE ride_bookings SET boarded_at = now(), luggage_note = COALESCE(nullif(trim(coalesce(p_luggage_note, '')), ''), luggage_note) WHERE id = v_id;
    DELETE FROM ride_booking_catch_locations WHERE ride_booking_id = v_id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (b.portal_user_id, 'rider_boarded', 'You''re on board', 'The driver has marked you as boarded.',
      CASE WHEN b.route_id IS NOT NULL THEN '/portal/marketplace/route/' || b.route_id ELSE '/portal/marketplace/buses' END);
  END LOOP;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 3. Driver roster — registration-number-first list with each vehicle's
--    on-trip/free status, and (when free) the city it was last seen at.
--    Read-only: no allotment/dispatch write action, deliberately, since
--    the standing instruction is to leave driver-handover/assignment
--    exactly as it already works.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fleet_driver_roster(p_fleet_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'vehicle_number'), '[]'::jsonb) INTO v_result FROM (
    SELECT jsonb_build_object(
      'vehicle_id', v.id, 'vehicle_number', v.vehicle_number, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type,
      'status', CASE WHEN active.id IS NOT NULL THEN 'on_trip' ELSE 'free' END,
      'active_route', CASE WHEN active.id IS NOT NULL THEN jsonb_build_object('origin', avr.origin, 'destination', avr.destination, 'started_at', active.started_at) ELSE NULL END,
      'free_at_station', CASE WHEN active.id IS NULL THEN COALESCE(last_run.city, home.origin) ELSE NULL END
    ) AS row
    FROM vehicles v
    LEFT JOIN LATERAL (
      SELECT rr.id, rr.started_at, rr.route_id FROM route_runs rr JOIN vehicle_routes vr2 ON vr2.id = rr.route_id
      WHERE vr2.vehicle_id = v.id AND rr.ended_at IS NULL ORDER BY rr.started_at DESC LIMIT 1
    ) active ON true
    LEFT JOIN vehicle_routes avr ON avr.id = active.route_id
    LEFT JOIN LATERAL (
      SELECT CASE WHEN rr.direction = 'outbound' THEN vr3.destination ELSE vr3.origin END AS city
      FROM route_runs rr JOIN vehicle_routes vr3 ON vr3.id = rr.route_id
      WHERE vr3.vehicle_id = v.id AND rr.ended_at IS NOT NULL ORDER BY rr.ended_at DESC LIMIT 1
    ) last_run ON true
    LEFT JOIN LATERAL (
      SELECT origin FROM vehicle_routes WHERE vehicle_id = v.id AND is_active ORDER BY created_at LIMIT 1
    ) home ON true
    WHERE v.fleet_id = p_fleet_id
  ) rows;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION fleet_driver_roster(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_driver_roster(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 4. Ticket search/boarding for a solo driver (no fleet at all) — mirrors
--    fleet_search_bookings but scoped to one vehicle, so my-vehicle/routes
--    gets the same "find and board a ticket" workflow the fleet pages have.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION vehicle_search_bookings(p_vehicle_id uuid, p_query text DEFAULT NULL, p_travel_date date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result jsonb; v_q text := nullif(trim(coalesce(p_query, '')), '');
BEGIN
  IF NOT can_manage_vehicle(p_vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;

  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'travel_date' DESC), '[]'::jsonb) INTO v_result FROM (
    SELECT jsonb_build_object(
      'id', mb.id, 'source', 'manual', 'passenger_name', mb.passenger_name, 'passenger_mobile', mb.passenger_mobile,
      'route_id', mb.route_id, 'origin', vr.origin, 'destination', vr.destination, 'owner_name', v.owner_name,
      'travel_date', mb.travel_date, 'seats', mb.seats, 'amount_pkr', mb.total_amount_pkr,
      'status', mb.status, 'payment_method', mb.payment_method,
      'vehicle_id', v.id, 'is_van_kind', vc.vehicle_kind = 'van', 'total_seats', v.total_seats, 'is_sleeper', v.is_sleeper,
      'seat_numbers', (SELECT array_agg(sn.seat_number ORDER BY sn.seat_number) FROM ride_booking_seat_numbers sn WHERE sn.manual_ride_booking_id = mb.id),
      'ticket_no', mb.ticket_no, 'boarded_at', mb.boarded_at, 'vehicle_number', v.vehicle_number, 'service_code', vr.service_code,
      'emergency_contact_phone', mb.emergency_contact_phone, 'luggage_note', mb.luggage_note
    ) AS row
    FROM manual_ride_bookings mb JOIN vehicle_routes vr ON vr.id = mb.route_id JOIN vehicles v ON v.id = vr.vehicle_id
    LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
    WHERE v.id = p_vehicle_id AND mb.status = 'confirmed'
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
      'emergency_contact_phone', NULL, 'luggage_note', rb.luggage_note
    ) AS row
    FROM ride_bookings rb JOIN vehicle_routes vr ON vr.id = rb.route_id JOIN vehicles v ON v.id = vr.vehicle_id
    LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
    JOIN portal_users pu ON pu.id = rb.portal_user_id
    WHERE v.id = p_vehicle_id AND rb.status IN ('announced', 'confirmed')
      AND (p_travel_date IS NULL OR rb.travel_date = p_travel_date)
      AND (v_q IS NULL OR pu.full_name ILIKE '%' || v_q || '%' OR pu.mobile ILIKE '%' || v_q || '%')
  ) rows;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION vehicle_search_bookings(uuid, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_search_bookings(uuid, text, date) TO authenticated;

-- fleet_search_bookings also gains luggage_note for parity.
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
      'emergency_contact_phone', mb.emergency_contact_phone, 'luggage_note', mb.luggage_note
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
      'emergency_contact_phone', NULL, 'luggage_note', rb.luggage_note
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
