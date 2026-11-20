-- ═════════════════════════════════════════════════════════════════════
-- Real gap raised by the user: the driver app's Terminal Stop Desk
-- listed every stop on the route (including ones already closed today,
-- and ones that have their own dedicated terminal staff), because
-- close_route_stop_challan/board_manual_ticket/etc. only ever checked
-- "does the CALLER own a different terminal" (is_my_counter_or_admin) —
-- never "does this TARGET stop already belong to someone else." That
-- gate is intentionally left alone for roaming staff (counter_id NULL
-- staff legitimately may need to act on any stop — migration 926's own
-- reasoning), but a route's own driver (is_route_operator) should not
-- be able to close a stop that has dedicated staff assigned to it —
-- that's staff-only territory. Scoped narrowly to drivers specifically
-- (not every counter_id-NULL staffer) so roaming staff keep their
-- existing backup access.
--
-- route_staffed_stop_ids is new, read-only, lets the driver page hide
-- staffed stops from its dropdown entirely (not just block the close
-- button) — the UI-decluttering half of the same ask (hide already-
-- closed and not-yet-reached stops) needs no backend change at all,
-- since route_master_trip_challan/route_departure_chalan already
-- expose that.
-- ═════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION route_staffed_stop_ids(p_route_id uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN is_route_owner(p_route_id) OR is_route_operator(p_route_id)
    THEN COALESCE((
      SELECT array_agg(DISTINCT rs.id) FROM route_stops rs
      WHERE rs.route_id = p_route_id AND rs.counter_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.counter_id = rs.counter_id)
    ), ARRAY[]::uuid[])
    ELSE ARRAY[]::uuid[]
  END;
$$;
REVOKE ALL ON FUNCTION route_staffed_stop_ids(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION route_staffed_stop_ids(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION driver_blocked_from_staffed_counter(p_route_id uuid, p_counter_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_counter_id IS NOT NULL
    AND is_route_operator(p_route_id)
    AND NOT is_route_owner(p_route_id)
    AND NOT EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.portal_user_id = current_portal_user_id() AND fs.counter_id = p_counter_id)
    AND EXISTS (SELECT 1 FROM fleet_staff fs2 WHERE fs2.counter_id = p_counter_id);
$$;
REVOKE ALL ON FUNCTION driver_blocked_from_staffed_counter(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION driver_blocked_from_staffed_counter(uuid, uuid) TO authenticated;

-- close_route_stop_challan (final body: 928) — true-replace, current
-- body copied verbatim, only the one new check added right after the
-- existing is_my_counter_or_admin gate.
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
  IF fleet_staff_accountant_blocked(v_route.vehicle_id) THEN RAISE EXCEPTION 'Accountants do not handle bookings on this fleet.' USING ERRCODE = 'P0001'; END IF;
  IF p_direction NOT IN ('outbound', 'return') THEN RAISE EXCEPTION 'Invalid direction.' USING ERRCODE = 'P0001'; END IF;

  IF p_stop_id IS NOT NULL THEN
    SELECT * INTO v_stop FROM route_stops WHERE id = p_stop_id AND route_id = p_route_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'That stop does not belong to this route.' USING ERRCODE = 'P0001'; END IF;
    v_counter_id := v_stop.counter_id;
  ELSE
    v_counter_id := route_origin_counter_id(p_route_id);
  END IF;

  IF NOT is_my_counter_or_admin(v_counter_id) THEN
    RAISE EXCEPTION 'You can only close boarding for your own assigned terminal.' USING ERRCODE = 'P0001';
  END IF;
  IF driver_blocked_from_staffed_counter(p_route_id, v_counter_id) THEN
    RAISE EXCEPTION 'This stop has its own terminal staff — only they can close boarding here.' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM route_stop_challans WHERE route_id = p_route_id AND travel_date = p_travel_date AND direction = p_direction
      AND ((p_stop_id IS NULL AND stop_id IS NULL) OR stop_id = p_stop_id)) THEN
    RAISE EXCEPTION 'This stop has already been closed for this departure.' USING ERRCODE = 'P0001';
  END IF;

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
