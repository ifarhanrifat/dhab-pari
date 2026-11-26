-- Migration 961: fleet_search_bookings (final body: 917) — true-
-- replace. Three changes, both needed for the new no-show/reassign UI
-- (960) on the fleet bookings page:
--   1. Adds seat_accepted_at and dropped_off_at for the 'app' row so
--      the UI can tell apart "never confirmed" / "confirmed, on the
--      bus" / "confirmed, trip over," same as boarded_at already did.
--   2. Real bug found reading this function closely: the 'app' row
--      hardcoded 'ticket_no', NULL — ride_bookings has had a real
--      ticket_no since migration 948, this function just never read
--      it, so a fleet searching for a rider by their own ticket number
--      silently never matched (p_query already ILIKEs ticket_no for
--      the manual side only).
--   3. p_status = 'no_show' now matches the new status value (960);
--      'all' already included it with no change needed.
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
      'emergency_contact_phone', mb.emergency_contact_phone, 'luggage_note', mb.luggage_note,
      -- manual_ride_bookings has no separate "confirmed" timestamp — it
      -- confirms atomically on sale — so this is only ever read for an
      -- 'app' row by the frontend; kept null here rather than invented.
      'seat_accepted_at', NULL::timestamptz, 'dropped_off_at', mb.dropped_off_at
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
        OR (p_status = 'no_show' AND mb.status = 'no_show')
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
      'ticket_no', rb.ticket_no, 'boarded_at', rb.boarded_at, 'vehicle_number', v.vehicle_number, 'service_code', vr.service_code,
      'emergency_contact_phone', NULL, 'luggage_note', rb.luggage_note,
      'seat_accepted_at', rb.seat_accepted_at, 'dropped_off_at', rb.dropped_off_at
    ) AS row
    FROM ride_bookings rb JOIN vehicle_routes vr ON vr.id = rb.route_id JOIN vehicles v ON v.id = vr.vehicle_id
    LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
    JOIN portal_users pu ON pu.id = rb.portal_user_id
    WHERE v.fleet_id = p_fleet_id
      AND (p_travel_date IS NULL OR rb.travel_date = p_travel_date)
      AND (v_q IS NULL OR pu.full_name ILIKE '%' || v_q || '%' OR pu.mobile ILIKE '%' || v_q || '%' OR rb.ticket_no ILIKE '%' || v_q || '%')
      AND (
        (p_status IS NULL AND rb.status IN ('announced', 'confirmed'))
        OR p_status = 'all'
        OR (p_status = 'confirmed' AND rb.status = 'confirmed')
        OR (p_status = 'pending' AND rb.status = 'announced')
        OR (p_status = 'cancelled' AND rb.status IN ('cancelled', 'rejected'))
        OR (p_status = 'no_show' AND rb.status = 'no_show')
      )
  ) rows;
  RETURN v_result;
END;
$$;
