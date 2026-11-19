-- Migration 925: real bug caught during 924's own curl verification —
-- mark_manual_ticket_no_show had no boarded_at guard, so calling it on
-- a passenger who had already boarded silently flipped them to
-- 'no_show' AND released their seat for resale while they were
-- literally on the bus. Confirmed live: QA ticket a7445eac (boarded at
-- Multan) was marked no_show by this bug, status/boarded_at left in a
-- contradictory state. True-replace with the exact 924 body plus one
-- added guard; seat/commission-release logic is unchanged.

CREATE OR REPLACE FUNCTION mark_manual_ticket_no_show(p_id uuid, p_reason text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route_id uuid; v_fleet_id uuid;
BEGIN
  SELECT route_id INTO v_route_id FROM manual_ride_bookings WHERE id = p_id AND status = 'confirmed' AND boarded_at IS NULL FOR UPDATE;
  IF v_route_id IS NULL THEN RAISE EXCEPTION 'Booking not found, already boarded, or not eligible for no-show.' USING ERRCODE = 'P0001'; END IF;
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
