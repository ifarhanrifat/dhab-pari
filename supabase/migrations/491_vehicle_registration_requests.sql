-- Real driver self-registration, replacing "admin types everything in
-- by hand" — the actual complaint: no CNIC, no documents, no photo, no
-- way for a driver to declare which services they want before the
-- committee ever sees them, and vehicles.portal_user_id being set
-- straight from an admin-typed mobile number auto-matched against
-- portal_users (the exact insecure pattern migration 463's own comment
-- already flagged and fixed for shop customers: "trusting a phone
-- field to auto-link would let whoever currently holds that SIM see
-- someone else's data" — vehicles never got the same fix until now).
--
-- The flow: a driver signs up for a portal account first (existing
-- signup), then submits a registration request from their own
-- authenticated session — so portal_user_id is never guessed from a
-- typed phone number, it's simply who is logged in. The committee
-- reviews documents, marks village-resident vs outsider, sets rates
-- for whichever services were requested, and approves — which is the
-- one moment a real `vehicles` row gets created, already correctly
-- linked. No separate redeem-code step is needed for this path (unlike
-- 463's shop-customer linking) because identity was never ambiguous:
-- the submitter's own session proves it.

INSERT INTO storage.buckets (id, name, public) VALUES ('vehicle_registration_documents', 'vehicle_registration_documents', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Portal users can upload their own vehicle registration documents" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'vehicle_registration_documents' AND auth.role() = 'authenticated');
CREATE POLICY "Committee can read vehicle registration documents" ON storage.objects FOR SELECT
  USING (bucket_id = 'vehicle_registration_documents' AND (can_access_system('donors_projects') OR auth.role() = 'authenticated'));
CREATE POLICY "Committee can delete vehicle registration documents" ON storage.objects FOR DELETE
  USING (bucket_id = 'vehicle_registration_documents' AND can_access_system('donors_projects'));

CREATE TABLE IF NOT EXISTS vehicle_registration_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  owner_name varchar NOT NULL,
  cnic_number varchar NOT NULL,
  father_husband_name varchar,
  address text NOT NULL,
  vehicle_type varchar NOT NULL,
  vehicle_number varchar,
  model varchar,
  color varchar,
  total_seats int NOT NULL CHECK (total_seats > 0),
  owner_id_card_url text NOT NULL,
  license_url text NOT NULL,
  vehicle_doc_url text NOT NULL,
  driver_photo_url text NOT NULL,
  -- Declared interest only — approval doesn't switch these live for
  -- hourly/shadi (both still need a committee-set rate first, same
  -- "locked opt-in" rule the catalog page already enforces, 474/478).
  -- Recorded so the review screen shows what the driver actually
  -- wants without the committee needing to ask.
  wants_delivers boolean NOT NULL DEFAULT false,
  wants_hourly boolean NOT NULL DEFAULT false,
  wants_shadi boolean NOT NULL DEFAULT false,
  wants_out_of_city boolean NOT NULL DEFAULT false,
  wants_night_booking boolean NOT NULL DEFAULT false,
  status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  is_village_resident boolean,
  rejection_reason text,
  reviewed_by uuid REFERENCES admin_users(id),
  reviewed_at timestamptz,
  vehicle_id uuid REFERENCES vehicles(id),
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicle_registration_requests_portal_user_idx ON vehicle_registration_requests(portal_user_id);
CREATE INDEX IF NOT EXISTS vehicle_registration_requests_status_idx ON vehicle_registration_requests(status, created_at DESC);
-- One live (pending) request per portal user — resubmitting while
-- already pending would just create review-queue duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_registration_requests_one_pending_uniq
  ON vehicle_registration_requests(portal_user_id) WHERE status = 'pending';

ALTER TABLE vehicle_registration_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vehicle_registration_requests_own_read" ON vehicle_registration_requests FOR SELECT TO authenticated
  USING (portal_user_id = current_portal_user_id() OR current_admin_permission('manage_parties'));
-- No client INSERT/UPDATE policy — every write goes through the
-- SECURITY DEFINER functions below, so a submitted request can't be
-- quietly edited after the fact (matches bill_payment_claims' own
-- announce-then-immutable shape).

CREATE OR REPLACE FUNCTION submit_vehicle_registration(
  p_owner_name varchar, p_cnic_number varchar, p_father_husband_name varchar, p_address text,
  p_vehicle_type varchar, p_vehicle_number varchar, p_model varchar, p_color varchar, p_total_seats int,
  p_owner_id_card_url text, p_license_url text, p_vehicle_doc_url text, p_driver_photo_url text,
  p_wants_delivers boolean, p_wants_hourly boolean, p_wants_shadi boolean, p_wants_out_of_city boolean, p_wants_night_booking boolean
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_request_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in required.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM vehicles WHERE portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'A vehicle is already linked to your account.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM vehicle_registration_requests WHERE portal_user_id = v_portal_user_id AND status = 'pending') THEN
    RAISE EXCEPTION 'You already have a registration under review.' USING ERRCODE = 'P0001';
  END IF;
  IF trim(coalesce(p_owner_name, '')) = '' OR trim(coalesce(p_cnic_number, '')) = '' OR trim(coalesce(p_address, '')) = '' OR trim(coalesce(p_vehicle_type, '')) = '' THEN
    RAISE EXCEPTION 'Owner name, CNIC, address and vehicle type are required.' USING ERRCODE = 'P0001';
  END IF;
  IF p_owner_id_card_url IS NULL OR p_license_url IS NULL OR p_vehicle_doc_url IS NULL OR p_driver_photo_url IS NULL THEN
    RAISE EXCEPTION 'All four documents are required.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO vehicle_registration_requests (
    portal_user_id, owner_name, cnic_number, father_husband_name, address,
    vehicle_type, vehicle_number, model, color, total_seats,
    owner_id_card_url, license_url, vehicle_doc_url, driver_photo_url,
    wants_delivers, wants_hourly, wants_shadi, wants_out_of_city, wants_night_booking
  ) VALUES (
    v_portal_user_id, trim(p_owner_name), trim(p_cnic_number), nullif(trim(p_father_husband_name), ''), trim(p_address),
    trim(p_vehicle_type), nullif(trim(p_vehicle_number), ''), nullif(trim(p_model), ''), nullif(trim(p_color), ''), p_total_seats,
    p_owner_id_card_url, p_license_url, p_vehicle_doc_url, p_driver_photo_url,
    p_wants_delivers, p_wants_hourly, p_wants_shadi, p_wants_out_of_city, p_wants_night_booking
  ) RETURNING id INTO v_request_id;

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION submit_vehicle_registration(varchar, varchar, varchar, text, varchar, varchar, varchar, varchar, int, text, text, text, text, boolean, boolean, boolean, boolean, boolean) TO authenticated;

-- The driver's own status check — "your registration is pending" /
-- "was rejected: {reason}" — without exposing other people's requests
-- (the table's own RLS already covers this for a direct select, this
-- RPC just gives a stable jsonb shape the frontend can render).
CREATE OR REPLACE FUNCTION my_vehicle_registration_status() RETURNS jsonb AS $$
  SELECT jsonb_build_object('id', r.id, 'status', r.status, 'rejection_reason', r.rejection_reason, 'created_at', r.created_at)
  FROM vehicle_registration_requests r
  WHERE r.portal_user_id = current_portal_user_id()
  ORDER BY r.created_at DESC LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION my_vehicle_registration_status() TO authenticated;

CREATE OR REPLACE FUNCTION admin_list_vehicle_registrations(p_status varchar DEFAULT 'pending') RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'owner_name', r.owner_name, 'cnic_number', r.cnic_number, 'father_husband_name', r.father_husband_name, 'address', r.address,
    'vehicle_type', r.vehicle_type, 'vehicle_number', r.vehicle_number, 'model', r.model, 'color', r.color, 'total_seats', r.total_seats,
    'owner_id_card_url', r.owner_id_card_url, 'license_url', r.license_url, 'vehicle_doc_url', r.vehicle_doc_url, 'driver_photo_url', r.driver_photo_url,
    'wants_delivers', r.wants_delivers, 'wants_hourly', r.wants_hourly, 'wants_shadi', r.wants_shadi,
    'wants_out_of_city', r.wants_out_of_city, 'wants_night_booking', r.wants_night_booking,
    'status', r.status, 'is_village_resident', r.is_village_resident, 'rejection_reason', r.rejection_reason,
    'created_at', r.created_at, 'reviewed_at', r.reviewed_at,
    'submitter_name', pu.full_name, 'submitter_mobile', pu.mobile
  ) ORDER BY r.created_at DESC), '[]'::jsonb)
  FROM vehicle_registration_requests r JOIN portal_users pu ON pu.id = r.portal_user_id
  WHERE current_admin_permission('manage_parties') AND (p_status IS NULL OR r.status = p_status)
  LIMIT 200;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION admin_list_vehicle_registrations(varchar) TO authenticated;

-- One action: verify + set whichever rates apply to what was requested
-- + create the real vehicle row, already correctly linked. Rate
-- params are only required for the corresponding wants_* flag — the
-- function checks this itself rather than trusting the client to only
-- send what's relevant.
CREATE OR REPLACE FUNCTION admin_approve_vehicle_registration(
  p_request_id uuid, p_is_village_resident boolean,
  p_per_km_pkr decimal DEFAULT NULL,
  p_hourly_rate_pkr decimal DEFAULT NULL, p_hourly_included_km decimal DEFAULT NULL, p_hourly_overage_per_km_pkr decimal DEFAULT NULL,
  p_shadi_full_day_rate_pkr decimal DEFAULT NULL
) RETURNS uuid AS $$
DECLARE r vehicle_registration_requests%ROWTYPE; v_vehicle_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_registration_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'This request has already been reviewed.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM vehicles WHERE portal_user_id = r.portal_user_id) THEN
    RAISE EXCEPTION 'This driver already has a linked vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF r.wants_delivers AND p_per_km_pkr IS NULL THEN RAISE EXCEPTION 'Per-km rate is required — this driver requested delivery.' USING ERRCODE = 'P0001'; END IF;
  IF r.wants_hourly AND (p_hourly_rate_pkr IS NULL OR p_hourly_included_km IS NULL OR p_hourly_overage_per_km_pkr IS NULL) THEN
    RAISE EXCEPTION 'Hourly rate, included km and overage rate are required — this driver requested hourly rental.' USING ERRCODE = 'P0001';
  END IF;
  IF r.wants_shadi AND p_shadi_full_day_rate_pkr IS NULL THEN RAISE EXCEPTION 'Shadi day-rate is required — this driver requested shadi bookings.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicles (
    owner_name, vehicle_type, vehicle_number, model, color, total_seats, portal_user_id, is_active,
    delivers, per_km_pkr, offers_hourly, hourly_rate_pkr, hourly_included_km, hourly_overage_per_km_pkr,
    offers_shadi, shadi_full_day_rate_pkr, allows_out_of_city, night_booking_enabled
  ) VALUES (
    r.owner_name, r.vehicle_type, r.vehicle_number, r.model, r.color, r.total_seats, r.portal_user_id, true,
    r.wants_delivers, p_per_km_pkr, r.wants_hourly, p_hourly_rate_pkr, p_hourly_included_km, p_hourly_overage_per_km_pkr,
    r.wants_shadi, p_shadi_full_day_rate_pkr, r.wants_out_of_city, r.wants_night_booking
  ) RETURNING id INTO v_vehicle_id;

  UPDATE vehicle_registration_requests SET
    status = 'approved', is_village_resident = p_is_village_resident, reviewed_by = current_admin_user_id(), reviewed_at = now(), vehicle_id = v_vehicle_id
  WHERE id = p_request_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (r.portal_user_id, 'vehicle_registration_approved', 'Vehicle approved', r.owner_name || ' — ' || r.vehicle_type, '/portal/my-vehicle');

  RETURN v_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION admin_approve_vehicle_registration(uuid, boolean, decimal, decimal, decimal, decimal, decimal) TO authenticated;

CREATE OR REPLACE FUNCTION admin_reject_vehicle_registration(p_request_id uuid, p_reason text) RETURNS void AS $$
DECLARE r vehicle_registration_requests%ROWTYPE;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_registration_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'This request has already been reviewed.' USING ERRCODE = 'P0001'; END IF;
  IF trim(coalesce(p_reason, '')) = '' THEN RAISE EXCEPTION 'A reason is required.' USING ERRCODE = 'P0001'; END IF;

  UPDATE vehicle_registration_requests SET
    status = 'rejected', rejection_reason = trim(p_reason), reviewed_by = current_admin_user_id(), reviewed_at = now()
  WHERE id = p_request_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (r.portal_user_id, 'vehicle_registration_rejected', 'Vehicle registration declined', trim(p_reason), '/portal/my-vehicle');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION admin_reject_vehicle_registration(uuid, text) TO authenticated;

-- Signed-URL reader for the four private documents — same shape the
-- donor-receipt admin screens already use for private-bucket proofs,
-- just parameterized over which of the four columns to sign.
CREATE OR REPLACE FUNCTION admin_vehicle_registration_document_path(p_request_id uuid, p_which varchar) RETURNS text AS $$
  SELECT CASE p_which
    WHEN 'owner_id_card' THEN owner_id_card_url
    WHEN 'license' THEN license_url
    WHEN 'vehicle_doc' THEN vehicle_doc_url
    WHEN 'driver_photo' THEN driver_photo_url
    ELSE NULL
  END
  FROM vehicle_registration_requests
  WHERE id = p_request_id AND current_admin_permission('manage_parties');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION admin_vehicle_registration_document_path(uuid, varchar) TO authenticated;
