-- Heavy machinery hire, tractor/farm equipment, and loader/material
-- delivery — the three services confirmed missing from the real system
-- (a read-only admin "tractor directory" listing existed, no booking).
-- Imported from the new "Dhab Pari Mobility" design, confirmed directly
-- with the user: rates stay committee/admin-set (not owner self-service,
-- matching every other vehicle type's policy), and commission reuses the
-- existing per-vehicle commission_mode/commission_pct/lumpsum_fee_pkr
-- infra rather than the design's own flat-5%-plus-escrow idea.
--
-- Modeled directly on 475_hourly_rental_booking.sql's create → respond →
-- start → end → confirm shape, with one real simplification: these are
-- stationary/on-site jobs (dig a foundation, plough a field, haul a
-- load), not moving trips, so billing is by elapsed wall-clock hours
-- (machinery/tractor) or a flat per-trip rate (loader) — no GPS-tracked
-- overage distance, no hourly_booking_locations equivalent needed here.

-- ═════════════════════════════════════════════════════════════════════════
-- 1. vehicles — new nullable rate/offer columns, same convention as
--    474_vehicle_catalog_hourly_shadi.sql. Loader is one row per physical
--    vehicle (pickup / mazda_loader / tractor_trolley), each with its own
--    flat per-trip rate — no separate catalog table needed, unlike tractor.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS offers_machinery boolean NOT NULL DEFAULT false;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS machinery_hourly_rate_pkr decimal CHECK (machinery_hourly_rate_pkr IS NULL OR machinery_hourly_rate_pkr >= 0);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS machinery_min_hours int CHECK (machinery_min_hours IS NULL OR machinery_min_hours > 0);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS machinery_mobilization_fee_pkr decimal CHECK (machinery_mobilization_fee_pkr IS NULL OR machinery_mobilization_fee_pkr >= 0);

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS offers_tractor boolean NOT NULL DEFAULT false;

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS offers_loader boolean NOT NULL DEFAULT false;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS loader_trip_rate_pkr decimal CHECK (loader_trip_rate_pkr IS NULL OR loader_trip_rate_pkr >= 0);

-- ═════════════════════════════════════════════════════════════════════════
-- 2. tractor_services — a tractor offers several priced implements
--    (haulage/rotavator/cultivator/seed-drill/thresher), not one flat
--    rate, mirroring the design's D.forms.tractor.opts. Admin-write only,
--    same permission as vehicles_update (388).
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tractor_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  service_key varchar NOT NULL,
  name_en varchar NOT NULL,
  name_ur varchar NOT NULL,
  rate_pkr decimal NOT NULL CHECK (rate_pkr >= 0),
  unit varchar NOT NULL DEFAULT 'hour',
  created_at timestamptz DEFAULT now(),
  UNIQUE (vehicle_id, service_key)
);
CREATE INDEX IF NOT EXISTS tractor_services_vehicle_idx ON tractor_services(vehicle_id);

ALTER TABLE tractor_services ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tractor_services_read" ON tractor_services FOR SELECT USING (true);
CREATE POLICY "tractor_services_write" ON tractor_services FOR INSERT TO authenticated
  WITH CHECK (can_access_system('donors_projects') AND current_admin_permission('manage_parties'));
CREATE POLICY "tractor_services_update" ON tractor_services FOR UPDATE TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects') AND current_admin_permission('manage_parties'));
CREATE POLICY "tractor_services_delete" ON tractor_services FOR DELETE TO authenticated
  USING (can_access_system('donors_projects') AND current_admin_permission('manage_parties'));

-- ═════════════════════════════════════════════════════════════════════════
-- 3. equipment_bookings — one shared table for all three verticals; they
--    share the same lifecycle and settlement, differing only in how the
--    total is computed (elapsed hours vs a flat trip rate).
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS equipment_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  kind varchar NOT NULL CHECK (kind IN ('machinery', 'tractor', 'loader')),
  service_key varchar,
  site_address text NOT NULL,
  material varchar,
  -- Locked in at request time — a later committee rate change never
  -- retroactively changes an existing booking's price (same reasoning as
  -- hourly_bookings.hourly_rate_pkr, 475).
  requested_hours int CHECK (requested_hours IS NULL OR requested_hours > 0),
  rate_pkr decimal NOT NULL CHECK (rate_pkr >= 0),
  mobilization_fee_pkr decimal NOT NULL DEFAULT 0 CHECK (mobilization_fee_pkr >= 0),
  status varchar NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'accepted', 'declined', 'in_progress', 'completed', 'cancelled')),
  requested_at timestamptz DEFAULT now(),
  responded_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  actual_hours decimal,
  total_amount_pkr decimal,
  status_confirmed boolean NOT NULL DEFAULT false,
  commission_voucher_id uuid REFERENCES vouchers(id),
  gross_voucher_id uuid REFERENCES vouchers(id)
);
CREATE INDEX IF NOT EXISTS equipment_bookings_portal_user_idx ON equipment_bookings(portal_user_id);
CREATE INDEX IF NOT EXISTS equipment_bookings_vehicle_idx ON equipment_bookings(vehicle_id);

-- No write policies — every mutation goes through the SECURITY DEFINER
-- functions below (same convention as hourly_bookings, 475).
ALTER TABLE equipment_bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "equipment_bookings_parties_read" ON equipment_bookings FOR SELECT TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR portal_user_id = current_portal_user_id()
    OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id())
  );

-- ═════════════════════════════════════════════════════════════════════════
-- 4. RPCs
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION create_equipment_booking(
  p_vehicle_id uuid, p_kind varchar, p_service_key varchar, p_hours int, p_site_address text, p_material varchar
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v vehicles%ROWTYPE;
  v_rate decimal;
  v_mobilization decimal := 0;
  v_booking_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_kind NOT IN ('machinery', 'tractor', 'loader') THEN RAISE EXCEPTION 'Unknown booking kind.' USING ERRCODE = 'P0001'; END IF;
  IF p_site_address IS NULL OR trim(p_site_address) = '' THEN RAISE EXCEPTION 'Enter the site address.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF v.portal_user_id = v_portal_user_id THEN RAISE EXCEPTION 'You cannot book your own vehicle.' USING ERRCODE = 'P0001'; END IF;

  IF p_kind = 'machinery' THEN
    IF NOT v.offers_machinery OR v.machinery_hourly_rate_pkr IS NULL THEN
      RAISE EXCEPTION 'This vehicle is not available for machinery booking.' USING ERRCODE = 'P0001';
    END IF;
    IF p_hours IS NULL OR p_hours <= 0 THEN RAISE EXCEPTION 'Enter how many hours you need.' USING ERRCODE = 'P0001'; END IF;
    IF v.machinery_min_hours IS NOT NULL AND p_hours < v.machinery_min_hours THEN
      RAISE EXCEPTION 'This machine has a minimum of % hours.', v.machinery_min_hours USING ERRCODE = 'P0001';
    END IF;
    v_rate := v.machinery_hourly_rate_pkr;
    v_mobilization := COALESCE(v.machinery_mobilization_fee_pkr, 0);
  ELSIF p_kind = 'tractor' THEN
    IF NOT v.offers_tractor THEN RAISE EXCEPTION 'This vehicle is not available for tractor booking.' USING ERRCODE = 'P0001'; END IF;
    IF p_hours IS NULL OR p_hours <= 0 THEN RAISE EXCEPTION 'Enter how many hours you need.' USING ERRCODE = 'P0001'; END IF;
    SELECT rate_pkr INTO v_rate FROM tractor_services WHERE vehicle_id = p_vehicle_id AND service_key = p_service_key;
    IF v_rate IS NULL THEN RAISE EXCEPTION 'Choose a valid service for this tractor.' USING ERRCODE = 'P0001'; END IF;
  ELSE
    IF NOT v.offers_loader OR v.loader_trip_rate_pkr IS NULL THEN
      RAISE EXCEPTION 'This vehicle is not available for loading.' USING ERRCODE = 'P0001';
    END IF;
    IF p_material IS NULL OR trim(p_material) = '' THEN RAISE EXCEPTION 'Choose the material being moved.' USING ERRCODE = 'P0001'; END IF;
    v_rate := v.loader_trip_rate_pkr;
  END IF;

  INSERT INTO equipment_bookings (portal_user_id, vehicle_id, kind, service_key, site_address, material, requested_hours, rate_pkr, mobilization_fee_pkr)
  VALUES (v_portal_user_id, p_vehicle_id, p_kind, p_service_key, trim(p_site_address), p_material, CASE WHEN p_kind = 'loader' THEN NULL ELSE p_hours END, v_rate, v_mobilization)
  RETURNING id INTO v_booking_id;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'equipment_booking_requested', 'New booking request',
      initcap(p_kind) || ' — ' || trim(p_site_address), '/portal/my-vehicle/requests');
  END IF;

  RETURN v_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_equipment_booking(uuid, varchar, varchar, int, text, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_equipment_booking(uuid, varchar, varchar, int, text, varchar) TO authenticated;

CREATE OR REPLACE FUNCTION respond_equipment_booking(p_booking_id uuid, p_accept boolean) RETURNS void AS $$
DECLARE b equipment_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM equipment_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'requested' THEN RAISE EXCEPTION 'This booking has already been responded to.' USING ERRCODE = 'P0001'; END IF;

  UPDATE equipment_bookings SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END, responded_at = now() WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, CASE WHEN p_accept THEN 'equipment_booking_accepted' ELSE 'equipment_booking_declined' END,
    CASE WHEN p_accept THEN 'Booking accepted' ELSE 'Booking declined' END,
    CASE WHEN p_accept THEN v.owner_name || ' accepted your booking.' ELSE 'This vehicle is not available for your booking.' END,
    '/portal/marketplace');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION respond_equipment_booking(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION respond_equipment_booking(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION start_equipment_job(p_booking_id uuid) RETURNS void AS $$
DECLARE b equipment_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM equipment_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'accepted' THEN RAISE EXCEPTION 'This booking is not ready to start.' USING ERRCODE = 'P0001'; END IF;
  UPDATE equipment_bookings SET status = 'in_progress', started_at = now() WHERE id = p_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION start_equipment_job(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION start_equipment_job(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION complete_equipment_job(p_booking_id uuid) RETURNS jsonb AS $$
DECLARE b equipment_bookings%ROWTYPE; v vehicles%ROWTYPE; v_hours decimal; v_total decimal;
BEGIN
  SELECT * INTO b FROM equipment_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'in_progress' THEN RAISE EXCEPTION 'This job is not in progress.' USING ERRCODE = 'P0001'; END IF;

  IF b.kind = 'loader' THEN
    v_hours := NULL;
    v_total := b.rate_pkr;
  ELSE
    v_hours := round(extract(epoch FROM now() - b.started_at) / 3600, 2);
    v_total := round(v_hours * b.rate_pkr, 2) + b.mobilization_fee_pkr;
  END IF;

  UPDATE equipment_bookings SET status = 'completed', ended_at = now(), actual_hours = v_hours, total_amount_pkr = v_total WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'equipment_booking_completed', 'Job completed',
    'Total: Rs ' || round(v_total), '/portal/marketplace');

  RETURN jsonb_build_object('actual_hours', v_hours, 'total_amount_pkr', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION complete_equipment_job(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION complete_equipment_job(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION cancel_equipment_booking(p_booking_id uuid) RETURNS void AS $$
DECLARE b equipment_bookings%ROWTYPE; v vehicles%ROWTYPE; v_is_customer boolean; v_is_owner boolean; v_notify_id uuid;
BEGIN
  SELECT * INTO b FROM equipment_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  v_is_customer := b.portal_user_id = current_portal_user_id();
  v_is_owner := v.portal_user_id = current_portal_user_id();
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v_is_customer OR v_is_owner) THEN
    RAISE EXCEPTION 'You are not part of this booking.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status IN ('in_progress', 'completed', 'cancelled') THEN
    RAISE EXCEPTION 'This booking can no longer be cancelled.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE equipment_bookings SET status = 'cancelled' WHERE id = p_booking_id;

  v_notify_id := CASE WHEN v_is_customer THEN v.portal_user_id ELSE b.portal_user_id END;
  IF v_notify_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_notify_id, 'equipment_booking_cancelled', 'Booking cancelled', 'An equipment booking was cancelled.', '/portal/marketplace');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION cancel_equipment_booking(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancel_equipment_booking(uuid) TO authenticated;

-- Financial settlement — byte-for-byte the same commission-vs-gross-
-- voucher split confirm_hourly_booking already uses (475), just against
-- a new marketplace_equipment_commission_pct setting.
CREATE OR REPLACE FUNCTION confirm_equipment_booking(p_booking_id uuid) RETURNS jsonb AS $$
DECLARE
  b equipment_bookings%ROWTYPE; v vehicles%ROWTYPE;
  v_vehicle_account uuid; v_cash_account uuid; v_commission_account uuid;
  v_commission_pct decimal; v_commission_amount decimal;
  v_gross_voucher_id uuid; v_gross_voucher_no varchar; v_commission_voucher_id uuid;
  v_is_keeper boolean;
BEGIN
  SELECT * INTO b FROM equipment_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'completed' THEN RAISE EXCEPTION 'This job has not been completed yet.' USING ERRCODE = 'P0001'; END IF;
  IF b.status_confirmed THEN RAISE EXCEPTION 'This booking has already been settled.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;

  v_is_keeper := v.portal_user_id IS NOT NULL AND v.portal_user_id = current_portal_user_id() AND v.commission_mode = 'per_order';
  IF NOT (COALESCE(current_admin_permission('post_transactions'), false) OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  v_vehicle_account := ensure_vehicle_account(v.id);
  SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050';

  IF v.commission_mode = 'per_order' THEN
    v_commission_pct := COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_equipment_commission_pct'), 0);
    v_commission_amount := round(b.total_amount_pkr * v_commission_pct / 100, 2);

    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — ' || b.kind || ' (paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
      RETURNING id INTO v_commission_voucher_id;
    END IF;

    UPDATE equipment_bookings SET status_confirmed = true, commission_voucher_id = v_commission_voucher_id WHERE id = p_booking_id;
    PERFORM check_seller_balance_notify('vehicle', v.id);
    RETURN jsonb_build_object('amount', b.total_amount_pkr, 'commission', v_commission_amount);
  END IF;

  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-1001';

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    initcap(b.kind) || ' booking — confirmed', b.total_amount_pkr, v_vehicle_account, v_cash_account, v.owner_name)
  RETURNING id, voucher_no INTO v_gross_voucher_id, v_gross_voucher_no;

  UPDATE equipment_bookings SET status_confirmed = true, gross_voucher_id = v_gross_voucher_id WHERE id = p_booking_id;
  RETURN jsonb_build_object('voucher_no', v_gross_voucher_no, 'amount', b.total_amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION confirm_equipment_booking(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION confirm_equipment_booking(uuid) TO authenticated;

-- Browse/list, jsonb-shaped (not RETURNS TABLE) — same reason as 475's
-- own comment: RETURNS TABLE's OUT parameters are this app's repeated
-- ambiguous-column bug class, a jsonb return has no such trap.
CREATE OR REPLACE FUNCTION equipment_bookable_vehicles(p_kind varchar) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'color', v.color, 'model', v.model,
    'machinery_hourly_rate_pkr', v.machinery_hourly_rate_pkr, 'machinery_min_hours', v.machinery_min_hours, 'machinery_mobilization_fee_pkr', v.machinery_mobilization_fee_pkr,
    'loader_trip_rate_pkr', v.loader_trip_rate_pkr,
    'cover_url', (SELECT m.url FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.is_cover LIMIT 1),
    'tractor_services', CASE WHEN p_kind = 'tractor' THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('service_key', ts.service_key, 'name_en', ts.name_en, 'name_ur', ts.name_ur, 'rate_pkr', ts.rate_pkr, 'unit', ts.unit) ORDER BY ts.name_en), '[]'::jsonb)
      FROM tractor_services ts WHERE ts.vehicle_id = v.id
    ) ELSE NULL END
  ) ORDER BY v.owner_name), '[]'::jsonb)
  FROM vehicles v
  WHERE v.is_active AND (
    (p_kind = 'machinery' AND v.offers_machinery AND v.machinery_hourly_rate_pkr IS NOT NULL)
    OR (p_kind = 'tractor' AND v.offers_tractor AND EXISTS (SELECT 1 FROM tractor_services ts WHERE ts.vehicle_id = v.id))
    OR (p_kind = 'loader' AND v.offers_loader AND v.loader_trip_rate_pkr IS NOT NULL)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION equipment_bookable_vehicles(varchar) TO authenticated, anon;

CREATE OR REPLACE FUNCTION my_equipment_bookings() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'kind', b.kind, 'service_key', b.service_key, 'site_address', b.site_address, 'material', b.material,
    'requested_hours', b.requested_hours, 'status', b.status, 'rate_pkr', b.rate_pkr, 'mobilization_fee_pkr', b.mobilization_fee_pkr,
    'actual_hours', b.actual_hours, 'total_amount_pkr', b.total_amount_pkr,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color
  ) ORDER BY b.requested_at DESC), '[]'::jsonb)
  FROM equipment_bookings b JOIN vehicles v ON v.id = b.vehicle_id
  WHERE b.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_equipment_bookings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_equipment_bookings() TO authenticated;

CREATE OR REPLACE FUNCTION vehicle_equipment_bookings(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'kind', b.kind, 'service_key', b.service_key, 'site_address', b.site_address, 'material', b.material,
    'requested_hours', b.requested_hours, 'status', b.status, 'rate_pkr', b.rate_pkr, 'mobilization_fee_pkr', b.mobilization_fee_pkr,
    'actual_hours', b.actual_hours, 'total_amount_pkr', b.total_amount_pkr, 'status_confirmed', b.status_confirmed,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'customer_name', pu.full_name, 'customer_mobile', pu.mobile
  ) ORDER BY b.requested_at DESC), '[]'::jsonb) INTO v_result
  FROM equipment_bookings b JOIN portal_users pu ON pu.id = b.portal_user_id
  WHERE b.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_equipment_bookings(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_equipment_bookings(uuid) TO authenticated;

-- Settings + notification-preference rows moved to 647 to isolate a
-- db-push failure the CLI reported without a usable error message.
