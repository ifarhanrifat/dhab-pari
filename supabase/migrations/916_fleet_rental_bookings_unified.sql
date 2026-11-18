-- Migration 916: Rentals & charters screen (design-first plan,
-- remaining batch) — from safar_admin_dashboard-1.html's "Rentals &
-- private charters" view. dhab-pari already has three real, separate
-- rental systems (hourly_bookings/475, rental_bookings/653,
-- shadi_vehicle_requests+shadi_events/478) each with its own real
-- backend, just never surfaced on one fleet-wide admin view — exactly
-- "no dedicated page yet" from this plan's own inventory. This is a
-- real union of three real tables, not an invented 4th concept.
CREATE OR REPLACE FUNCTION fleet_rental_bookings(p_fleet_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(row ORDER BY (row->>'created_at')::timestamptz DESC) FROM (
      SELECT jsonb_build_object(
        'kind', 'hourly', 'id', hb.id, 'vehicle_id', hb.vehicle_id, 'vehicle_number', v.vehicle_number, 'vehicle_type', v.vehicle_type,
        'customer_name', pu.full_name, 'status', hb.status, 'amount_pkr', COALESCE(hb.total_amount_pkr, hb.base_amount_pkr),
        'detail', hb.pickup_address || ' · ' || hb.hours || 'h', 'created_at', hb.requested_at
      ) AS row
      FROM hourly_bookings hb JOIN vehicles v ON v.id = hb.vehicle_id JOIN portal_users pu ON pu.id = hb.portal_user_id
      WHERE v.fleet_id = p_fleet_id

      UNION ALL

      SELECT jsonb_build_object(
        'kind', 'point_to_point', 'id', rb.id, 'vehicle_id', rb.vehicle_id, 'vehicle_number', v.vehicle_number, 'vehicle_type', v.vehicle_type,
        'customer_name', pu.full_name, 'status', rb.status, 'amount_pkr', rb.total_amount_pkr,
        'detail', rb.from_address || ' → ' || rb.to_address || (CASE WHEN rb.trip_type = 'return' THEN ' (return)' ELSE '' END), 'created_at', rb.requested_at
      ) AS row
      FROM rental_bookings rb JOIN vehicles v ON v.id = rb.vehicle_id JOIN portal_users pu ON pu.id = rb.portal_user_id
      WHERE v.fleet_id = p_fleet_id

      UNION ALL

      SELECT jsonb_build_object(
        'kind', 'shadi', 'id', svr.id, 'vehicle_id', svr.vehicle_id, 'vehicle_number', v.vehicle_number, 'vehicle_type', v.vehicle_type,
        'customer_name', pu.full_name, 'status', svr.status, 'amount_pkr', svr.full_day_rate_pkr,
        'detail', se.venue_address || ' · ' || se.event_date, 'created_at', svr.created_at
      ) AS row
      FROM shadi_vehicle_requests svr JOIN shadi_events se ON se.id = svr.event_id
        JOIN vehicles v ON v.id = svr.vehicle_id JOIN portal_users pu ON pu.id = se.portal_user_id
      WHERE v.fleet_id = p_fleet_id
    ) all_rows
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION fleet_rental_bookings(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_rental_bookings(uuid) TO authenticated;
