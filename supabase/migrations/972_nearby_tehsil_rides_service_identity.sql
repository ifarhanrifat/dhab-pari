-- Migration 972: real gap reported live — the buses browse page showed
-- a vehicle's own portal account name ("QA Driver Bus One") where a
-- real bus service's brand name/logo belongs. vehicle_payment_info
-- (950) already resolves this correctly (fleet name+logo, falling back
-- to the vehicle's own owner_name/logo_url for a standalone owner-
-- driver) for same-tenant vehicles — nearby_tehsil_rides (816), the
-- cross-tenant counterpart this same page also reads, never carried
-- either field at all. True-replace, additive fields only, same
-- query shape otherwise.
CREATE OR REPLACE FUNCTION nearby_tehsil_rides() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_my_tenant_id uuid := my_tenant_id();
  v_tehsil_id uuid;
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
BEGIN
  IF v_my_tenant_id IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT tehsil_id INTO v_tehsil_id FROM tenants WHERE id = v_my_tenant_id;
  IF v_tehsil_id IS NULL THEN RETURN '[]'::jsonb; END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(merged.row), '[]'::jsonb) FROM (
      SELECT jsonb_build_object(
        'kind', 'route', 'id', r.id, 'origin', r.origin, 'origin_ur', r.origin_ur,
        'destination', r.destination, 'destination_ur', r.destination_ur,
        'fare_per_seat_pkr', r.fare_per_seat_pkr, 'departure_time', r.departure_time,
        'return_departure_time', r.return_departure_time, 'days_of_week', r.days_of_week,
        'is_two_way', r.is_two_way, 'distance_km', r.distance_km, 'route_duration_min', r.route_duration_min,
        'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color,
        'total_seats', v.total_seats, 'has_ac', v.has_ac, 'vehicle_number', v.vehicle_number,
        'fleet_name', f.name, 'logo_url', COALESCE(f.logo_url, v.logo_url),
        'source_tenant_id', v.tenant_id, 'source_tenant_name', t.name
      ) AS row
      FROM vehicle_routes r
      JOIN vehicles v ON v.id = r.vehicle_id
      JOIN tenants t ON t.id = v.tenant_id
      LEFT JOIN fleets f ON f.id = v.fleet_id
      WHERE r.is_active AND NOT r.is_monthly_fixed AND v.tenant_id != v_my_tenant_id
        AND t.tehsil_id = v_tehsil_id
        AND has_share_agreement(v.tenant_id, v_my_tenant_id, 'route')

      UNION ALL

      SELECT jsonb_build_object(
        'kind', 'trip', 'id', o.id, 'origin', o.origin, 'origin_ur', o.origin_ur,
        'destination', o.destination, 'destination_ur', o.destination_ur,
        'fare_per_seat_pkr', o.listed_fare_per_seat_pkr, 'travel_date', o.travel_date,
        'departure_time_estimate', o.departure_time_estimate, 'seats_available', o.seats_available,
        'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color,
        'total_seats', v.total_seats, 'has_ac', v.has_ac, 'vehicle_number', v.vehicle_number,
        'fleet_name', f.name, 'logo_url', COALESCE(f.logo_url, v.logo_url),
        'source_tenant_id', v.tenant_id, 'source_tenant_name', t.name
      ) AS row
      FROM vehicle_trip_offers o
      JOIN vehicles v ON v.id = o.vehicle_id
      JOIN tenants t ON t.id = v.tenant_id
      LEFT JOIN fleets f ON f.id = v.fleet_id
      WHERE o.status = 'open' AND o.travel_date >= v_today AND v.tenant_id != v_my_tenant_id
        AND t.tehsil_id = v_tehsil_id
        AND has_share_agreement(v.tenant_id, v_my_tenant_id, 'trip_share')
    ) merged
  );
END;
$$;
GRANT EXECUTE ON FUNCTION nearby_tehsil_rides() TO authenticated;
