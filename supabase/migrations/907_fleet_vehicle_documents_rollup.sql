-- Migration 907: Vehicles screen rebuild (screen 3) — the mockup's
-- fleet-register table shows a per-bus Documents status pill
-- (Valid/Fitness due/etc). fleet_document_alerts (881) only returns
-- documents already expiring within 30 days, which is right for a
-- dashboard alert feed but wrong here: a vehicle with no alert would
-- wrongly look identical to one with no documents on file at all.
-- This returns every vehicle_documents row in the fleet so the
-- frontend can show each vehicle's real worst status, or "not set"
-- when a vehicle genuinely has none — never fabricated as "Valid".
CREATE OR REPLACE FUNCTION fleet_vehicle_documents(p_fleet_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'vehicle_id', vd.vehicle_id, 'document_type', vd.document_type, 'expiry_date', vd.expiry_date,
      'status', CASE
        WHEN vd.expiry_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN 'expired'
        WHEN vd.expiry_date <= (now() AT TIME ZONE 'Asia/Karachi')::date + 30 THEN 'expiring_soon'
        ELSE 'valid' END
    ))
    FROM vehicle_documents vd JOIN vehicles v ON v.id = vd.vehicle_id
    WHERE v.fleet_id = p_fleet_id
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION fleet_vehicle_documents(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_vehicle_documents(uuid) TO authenticated;
