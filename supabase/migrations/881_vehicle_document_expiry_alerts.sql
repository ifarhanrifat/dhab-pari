-- Migration 881: real gap confirmed directly — vehicle_registration_
-- requests captures CNIC/licence/vehicle-doc/photo as a ONE-TIME upload
-- at registration (4 plain URLs, no expiry date anywhere), and nothing
-- in the system has ever tracked an ongoing renewal date for a route
-- permit, fitness certificate or insurance policy. Once approved, a
-- vehicle's compliance documents are never watched again.
--
-- Alerting only, deliberately — this does NOT block dispatch/bookings
-- when a document lapses. Auto-blocking live operations off a date a
-- fleet owner might have mistyped is a real operational risk; this
-- round just makes the gap visible (dashboard alert + an in-form
-- warning), matching exactly what was scoped as "document-expiry
-- alerts", not an enforcement mechanism.

CREATE TABLE IF NOT EXISTS vehicle_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  document_type varchar NOT NULL CHECK (document_type IN ('route_permit', 'fitness_certificate', 'insurance')),
  expiry_date date NOT NULL,
  file_url text,
  updated_by_portal_user_id uuid REFERENCES portal_users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, document_type)
);
CREATE INDEX IF NOT EXISTS vehicle_documents_expiry_idx ON vehicle_documents(expiry_date);
ALTER TABLE vehicle_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vehicle_documents_read" ON vehicle_documents FOR SELECT TO authenticated
  USING (can_manage_vehicle(vehicle_id) OR current_admin_permission('manage_parties'));
-- No INSERT/UPDATE/DELETE policy — SECURITY DEFINER RPC only.

-- Storage for the actual renewed certificate/policy file, same private-
-- bucket shape as every other proof upload in this app.
INSERT INTO storage.buckets (id, name, public) VALUES ('vehicle_compliance_documents', 'vehicle_compliance_documents', false)
ON CONFLICT (id) DO NOTHING;
CREATE POLICY "Portal users can upload vehicle compliance documents" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'vehicle_compliance_documents');
CREATE POLICY "Fleet managers can read vehicle compliance documents" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'vehicle_compliance_documents' AND (
    EXISTS (SELECT 1 FROM fleets WHERE owning_portal_user_id = current_portal_user_id())
    OR EXISTS (SELECT 1 FROM fleet_staff WHERE portal_user_id = current_portal_user_id())
    OR EXISTS (SELECT 1 FROM vehicles WHERE portal_user_id = current_portal_user_id())
    OR current_admin_permission('manage_parties')
  ));

CREATE OR REPLACE FUNCTION set_vehicle_document(p_vehicle_id uuid, p_document_type varchar, p_expiry_date date, p_file_url text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(p_vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF p_document_type NOT IN ('route_permit', 'fitness_certificate', 'insurance') THEN
    RAISE EXCEPTION 'Unknown document type.' USING ERRCODE = 'P0001';
  END IF;
  IF p_expiry_date IS NULL THEN RAISE EXCEPTION 'Enter the expiry date.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicle_documents (vehicle_id, document_type, expiry_date, file_url, updated_by_portal_user_id)
  VALUES (p_vehicle_id, p_document_type, p_expiry_date, nullif(trim(coalesce(p_file_url, '')), ''), v_portal_user_id)
  ON CONFLICT (vehicle_id, document_type) DO UPDATE SET
    expiry_date = EXCLUDED.expiry_date,
    file_url = COALESCE(EXCLUDED.file_url, vehicle_documents.file_url),
    updated_by_portal_user_id = EXCLUDED.updated_by_portal_user_id,
    updated_at = now();
END;
$$;
REVOKE ALL ON FUNCTION set_vehicle_document(uuid, varchar, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_vehicle_document(uuid, varchar, date, text) TO authenticated;

-- One vehicle's own document status — used by the catalog form (both
-- the solo-driver page and the fleet "Settings" sheet already share
-- VehicleCatalogForm, so this covers both contexts with one call).
CREATE OR REPLACE FUNCTION vehicle_document_status(p_vehicle_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT can_manage_vehicle(p_vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'document_type', document_type, 'expiry_date', expiry_date, 'file_url', file_url,
      'days_remaining', (expiry_date - (now() AT TIME ZONE 'Asia/Karachi')::date),
      'status', CASE
        WHEN expiry_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN 'expired'
        WHEN expiry_date <= (now() AT TIME ZONE 'Asia/Karachi')::date + 30 THEN 'expiring_soon'
        ELSE 'valid' END
    ))
    FROM vehicle_documents WHERE vehicle_id = p_vehicle_id
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION vehicle_document_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_document_status(uuid) TO authenticated;

-- Fleet-wide alert feed — only documents expiring within 30 days or
-- already expired, ranked soonest-first, for the Fleet Dashboard.
CREATE OR REPLACE FUNCTION fleet_document_alerts(p_fleet_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'days_remaining')::int), '[]'::jsonb) INTO v_result FROM (
    SELECT jsonb_build_object(
      'vehicle_id', v.id, 'owner_name', v.owner_name, 'vehicle_number', v.vehicle_number,
      'document_type', vd.document_type, 'expiry_date', vd.expiry_date,
      'days_remaining', (vd.expiry_date - (now() AT TIME ZONE 'Asia/Karachi')::date),
      'status', CASE WHEN vd.expiry_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN 'expired' ELSE 'expiring_soon' END
    ) AS row
    FROM vehicle_documents vd JOIN vehicles v ON v.id = vd.vehicle_id
    WHERE v.fleet_id = p_fleet_id AND vd.expiry_date <= (now() AT TIME ZONE 'Asia/Karachi')::date + 30
  ) rows;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION fleet_document_alerts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_document_alerts(uuid) TO authenticated;
