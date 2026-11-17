-- Migration 902: real gap confirmed from the SAFAR mockup's dashboard
-- directly, shown at phone width too (the user's own screenshots) —
-- "Today's collection channels" (online vs. terminal vs. driver cash,
-- with progress bars) has no fleet-wide equivalent anywhere in
-- dhab-pari. Per-route online/manual split already existed (899's
-- by_source on route_departure_chalan) but nothing aggregates it
-- across the whole fleet for a given day. One small, additive RPC,
-- same fleet-scoping pattern as fleet_departure_stats (864): online =
-- ride_bookings (app), terminal = manual_ride_bookings with a
-- counter_id, driver = manual_ride_bookings with none (walk-up).
CREATE OR REPLACE FUNCTION fleet_collection_channels(p_fleet_id uuid, p_date date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_date date := COALESCE(p_date, (now() AT TIME ZONE 'Asia/Karachi')::date);
  v_online numeric; v_terminal numeric; v_driver numeric;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  SELECT
    COALESCE((SELECT SUM(rb.total_amount_pkr) FROM ride_bookings rb JOIN vehicle_routes vr ON vr.id = rb.route_id JOIN vehicles v ON v.id = vr.vehicle_id
       WHERE v.fleet_id = p_fleet_id AND rb.travel_date = v_date AND rb.status IN ('announced', 'confirmed')), 0),
    COALESCE((SELECT SUM(mb.total_amount_pkr) FROM manual_ride_bookings mb JOIN vehicle_routes vr ON vr.id = mb.route_id JOIN vehicles v ON v.id = vr.vehicle_id
       WHERE v.fleet_id = p_fleet_id AND mb.travel_date = v_date AND mb.status = 'confirmed' AND mb.counter_id IS NOT NULL), 0),
    COALESCE((SELECT SUM(mb.total_amount_pkr) FROM manual_ride_bookings mb JOIN vehicle_routes vr ON vr.id = mb.route_id JOIN vehicles v ON v.id = vr.vehicle_id
       WHERE v.fleet_id = p_fleet_id AND mb.travel_date = v_date AND mb.status = 'confirmed' AND mb.counter_id IS NULL), 0)
  INTO v_online, v_terminal, v_driver;

  RETURN jsonb_build_object('online_pkr', v_online, 'terminal_pkr', v_terminal, 'driver_pkr', v_driver, 'total_pkr', v_online + v_terminal + v_driver);
END;
$$;
REVOKE ALL ON FUNCTION fleet_collection_channels(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_collection_channels(uuid, date) TO authenticated;
