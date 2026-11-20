-- 2026-11-20: real bug caught live during a device walkthrough —
-- fleet_vehicle_cash_positions (864/891), the "cash in hand" figure
-- shown on both the driver's own Cash tab and the owner's fleet/cash
-- dashboard, only ever summed ride_bookings (online app riders who
-- chose pay-cash-on-boarding). It never counted manual_ride_bookings
-- (counter sales, driver walk-up sales) at all — the majority of a
-- real driver's actual cash collection. A driver who just sold a
-- ₨3,100 walk-up seat in cash saw their "cash in hand" stay at ₨0.
-- True-replace, widened to sum both sources (same no_show-counts-as-
-- collected convention route_master_trip_challan already uses, since
-- a no-show's fare was already collected before the bus left).
CREATE OR REPLACE FUNCTION fleet_vehicle_cash_positions(p_fleet_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'vehicle_id', v.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
    'total_collected_pkr', COALESCE(collected.amt, 0), 'total_remitted_pkr', COALESCE(remitted.amt, 0),
    'cash_in_hand_pkr', COALESCE(collected.amt, 0) - COALESCE(remitted.amt, 0)
  ) ORDER BY v.owner_name), '[]'::jsonb) INTO v_result
  FROM vehicles v
  LEFT JOIN LATERAL (
    SELECT
      COALESCE((SELECT SUM(rb.total_amount_pkr) FROM ride_bookings rb JOIN vehicle_routes vr ON vr.id = rb.route_id
        WHERE vr.vehicle_id = v.id AND rb.announced_method = 'cash' AND rb.status = 'confirmed'), 0)
      + COALESCE((SELECT SUM(mb.total_amount_pkr) FROM manual_ride_bookings mb JOIN vehicle_routes vr ON vr.id = mb.route_id
        WHERE vr.vehicle_id = v.id AND mb.payment_method = 'cash' AND mb.status IN ('confirmed', 'no_show')), 0)
    AS amt
  ) collected ON true
  LEFT JOIN LATERAL (SELECT SUM(r.amount_pkr) AS amt FROM vehicle_cash_remittances r WHERE r.vehicle_id = v.id) remitted ON true
  WHERE v.fleet_id = p_fleet_id AND v.is_active;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION fleet_vehicle_cash_positions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_vehicle_cash_positions(uuid) TO authenticated;
