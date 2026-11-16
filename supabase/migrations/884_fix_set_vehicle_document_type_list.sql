-- Migration 884: HOTFIX — 883 widened vehicle_documents' table CHECK
-- constraint to allow 'driver_licence' but missed that
-- set_vehicle_document has its OWN separate hardcoded validation list
-- inside the function body, never touched. Confirmed live via curl:
-- setting a driver_licence document was rejected with "Unknown
-- document type" even though the table itself now accepts it. Same
-- signature as 881's live version, true replace.

CREATE OR REPLACE FUNCTION set_vehicle_document(p_vehicle_id uuid, p_document_type varchar, p_expiry_date date, p_file_url text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(p_vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF p_document_type NOT IN ('route_permit', 'fitness_certificate', 'insurance', 'driver_licence') THEN
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
