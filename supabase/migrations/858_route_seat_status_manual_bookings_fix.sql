-- Migration 858: real bug caught during end-to-end QA testing of
-- fleet accounting Phase 2 (855) — route_seat_status (845) INNER JOINs
-- ride_booking_seat_numbers to ride_bookings, so a manual counter sale
-- (ride_booking_id IS NULL by design, manual_ride_booking_id set
-- instead) never appears as "taken" to this function. The actual
-- booking-time collision prevention is unaffected (the UNIQUE
-- constraint on ride_booking_seat_numbers already spans both sources
-- correctly, confirmed live: a second counter attempting to resell an
-- already-sold seat is correctly rejected) — this bug is purely
-- display-side: every rider-facing SeatPicker (RouteDetailPanel) reads
-- this function to grey out taken seats, so a counter-sold seat was
-- shown as free right up until someone actually tried to book it.

CREATE OR REPLACE FUNCTION route_seat_status(p_route_id uuid, p_travel_date date, p_direction varchar DEFAULT 'outbound')
RETURNS int[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(DISTINCT seat_number), '{}'::int[]) FROM (
    SELECT sn.seat_number FROM ride_booking_seat_numbers sn JOIN ride_bookings rb ON rb.id = sn.ride_booking_id
    WHERE sn.route_id = p_route_id AND sn.travel_date = p_travel_date AND sn.direction = p_direction
      AND rb.status IN ('announced', 'confirmed')
    UNION ALL
    SELECT sn.seat_number FROM ride_booking_seat_numbers sn JOIN manual_ride_bookings mb ON mb.id = sn.manual_ride_booking_id
    WHERE sn.route_id = p_route_id AND sn.travel_date = p_travel_date AND sn.direction = p_direction
      AND mb.status = 'confirmed'
    UNION ALL
    SELECT rs.seat_number FROM route_subscriptions rs
    WHERE rs.route_id = p_route_id AND rs.status IN ('active', 'pending') AND rs.seat_number IS NOT NULL
  ) taken;
$$;
GRANT EXECUTE ON FUNCTION route_seat_status(uuid, date, varchar) TO authenticated, anon;
