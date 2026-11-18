-- Migration 917: Bookings screen real gap found by the 2026-11-18
-- button-by-button audit — fleet_search_bookings (875) hard-filters
-- manual bookings to status='confirmed' and app bookings to
-- status IN ('announced','confirmed'), so a cancelled or rejected
-- booking can never be found or reviewed on this screen at all. Also
-- adds counter_id to the manual row so the frontend can tell a real
-- terminal-counter sale apart from a counter-less (driver/roadside)
-- one, for the kpi-row the mockup shows but dhab-pari never surfaced.
--
-- p_status is additive and defaults to NULL, which reproduces 875's
-- exact old query — no existing caller's behavior changes unless it
-- opts into the new param.
CREATE OR REPLACE FUNCTION fleet_search_bookings(p_fleet_id uuid, p_query text DEFAULT NULL, p_travel_date date DEFAULT NULL, p_status text DEFAULT NULL) RETURNS jsonb
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
      'status', mb.status, 'payment_method', mb.payment_method, 'counter_id', mb.counter_id,
      'vehicle_id', v.id, 'is_van_kind', vc.vehicle_kind = 'van', 'total_seats', v.total_seats, 'is_sleeper', v.is_sleeper,
      'seat_numbers', (SELECT array_agg(sn.seat_number ORDER BY sn.seat_number) FROM ride_booking_seat_numbers sn WHERE sn.manual_ride_booking_id = mb.id),
      'ticket_no', mb.ticket_no, 'boarded_at', mb.boarded_at, 'vehicle_number', v.vehicle_number, 'service_code', vr.service_code,
      'emergency_contact_phone', mb.emergency_contact_phone, 'luggage_note', mb.luggage_note
    ) AS row
    FROM manual_ride_bookings mb JOIN vehicle_routes vr ON vr.id = mb.route_id JOIN vehicles v ON v.id = vr.vehicle_id
    LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
    WHERE v.fleet_id = p_fleet_id
      AND (p_travel_date IS NULL OR mb.travel_date = p_travel_date)
      AND (v_q IS NULL OR mb.passenger_name ILIKE '%' || v_q || '%' OR mb.passenger_mobile ILIKE '%' || v_q || '%' OR mb.ticket_no ILIKE '%' || v_q || '%')
      AND (
        (p_status IS NULL AND mb.status = 'confirmed')
        OR p_status = 'all'
        OR (p_status = 'confirmed' AND mb.status = 'confirmed')
        OR (p_status = 'cancelled' AND mb.status = 'cancelled')
        -- manual bookings have no "pending" state of their own (855's
        -- record_manual_booking confirms atomically), so the Pending
        -- filter correctly returns none of them.
      )

    UNION ALL

    SELECT jsonb_build_object(
      'id', rb.id, 'source', 'app', 'passenger_name', pu.full_name, 'passenger_mobile', pu.mobile,
      'route_id', rb.route_id, 'origin', vr.origin, 'destination', vr.destination, 'owner_name', v.owner_name,
      'travel_date', rb.travel_date, 'seats', rb.seats, 'amount_pkr', rb.total_amount_pkr,
      'status', rb.status, 'payment_method', rb.announced_method, 'counter_id', NULL,
      'vehicle_id', v.id, 'is_van_kind', vc.vehicle_kind = 'van', 'total_seats', v.total_seats, 'is_sleeper', v.is_sleeper,
      'seat_numbers', (SELECT array_agg(sn.seat_number ORDER BY sn.seat_number) FROM ride_booking_seat_numbers sn WHERE sn.ride_booking_id = rb.id),
      'ticket_no', NULL, 'boarded_at', rb.boarded_at, 'vehicle_number', v.vehicle_number, 'service_code', vr.service_code,
      'emergency_contact_phone', NULL, 'luggage_note', rb.luggage_note
    ) AS row
    FROM ride_bookings rb JOIN vehicle_routes vr ON vr.id = rb.route_id JOIN vehicles v ON v.id = vr.vehicle_id
    LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
    JOIN portal_users pu ON pu.id = rb.portal_user_id
    WHERE v.fleet_id = p_fleet_id
      AND (p_travel_date IS NULL OR rb.travel_date = p_travel_date)
      AND (v_q IS NULL OR pu.full_name ILIKE '%' || v_q || '%' OR pu.mobile ILIKE '%' || v_q || '%')
      AND (
        (p_status IS NULL AND rb.status IN ('announced', 'confirmed'))
        OR p_status = 'all'
        OR (p_status = 'confirmed' AND rb.status = 'confirmed')
        OR (p_status = 'pending' AND rb.status = 'announced')
        OR (p_status = 'cancelled' AND rb.status IN ('cancelled', 'rejected'))
      )
  ) rows;
  RETURN v_result;
END;
$$;
