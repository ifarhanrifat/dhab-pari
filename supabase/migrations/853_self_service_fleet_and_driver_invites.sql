-- Migration 853: real ask, clarified after 852 — the user wasn't
-- asking for machinery to be substitute-aware (that's a route-only
-- concept); they want self-service fleet management for BOTH buses
-- and machinery: "one owner is having many machineries so they will
-- just add their machinery and add their own drivers and we will just
-- set the fare and commission of our own" — confirmed via two
-- clarifying questions: fleet creation is fully self-service (no admin
-- step at all), and every unit keeps its own driver login (same
-- per-vehicle model buses already use) rather than one shared login.
--
-- Investigated first: can_manage_vehicle()/fleets (844) already gives
-- one owner account authority over many vehicles' bookings/routes/
-- equipment jobs — that machinery was retrofitted onto in 852. What's
-- actually admin-only today, confirmed by reading the real migrations:
-- (a) creating/naming a fleets row, (b) setting vehicles.fleet_id.
-- Crucially, (b) is set exactly once, at vehicle-creation time, inside
-- admin_approve_vehicle_registration — there's no other write site.
-- submit_vehicle_registration's hard "one vehicle per portal account"
-- rule stays completely untouched: a fleet owner doesn't register a
-- second vehicle under their OWN account, they invite a DIFFERENT
-- person (the driver), who registers under their OWN account exactly
-- as any solo driver always has (same documents, same admin review,
-- same fare/commission resolved from vehicle_categories — "we will
-- just set the fare and commission" stays true, untouched) — the only
-- new thing is that driver's resulting vehicle is automatically tagged
-- into the inviting fleet, with no separate admin fleet-assignment
-- step needed afterward.
--
-- Invite mechanism modeled on the two closest existing patterns in
-- this codebase, not invented from scratch: shop_customer_link_codes'
-- "generate a short code, hand it over out-of-band, redeem it from
-- whatever session is signed in" shape (463/466) — explicitly NOT the
-- donor auto-match-by-phone shape, which 491's own header comment
-- already flagged as the wrong (phone-trusting) template for anything
-- higher-stakes than a donation-history view. Pattern A (admin invites,
-- 565) confirms the "pre-create nothing permission-bearing, let the
-- code itself be the authorization" discipline.

-- ═════════════════════════════════════════════════════════════════════
-- 1. Self-service fleet creation. INSERT/UPDATE stay available to
--    admins too (existing admin UI untouched), self-service is added
--    alongside, not instead of.
-- ═════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "fleets_admin_write" ON fleets;
CREATE POLICY "fleets_self_or_admin_write" ON fleets FOR INSERT TO authenticated
  WITH CHECK (owning_portal_user_id = current_portal_user_id() OR current_admin_permission('manage_parties'));

CREATE OR REPLACE FUNCTION create_my_fleet(p_name varchar) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF trim(coalesce(p_name, '')) = '' THEN RAISE EXCEPTION 'Enter a name for your fleet.' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO fleets (owning_portal_user_id, name) VALUES (v_portal_user_id, trim(p_name)) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION create_my_fleet(varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_my_fleet(varchar) TO authenticated;

CREATE OR REPLACE FUNCTION my_fleets() RETURNS TABLE(id uuid, name varchar)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT f.id, f.name FROM fleets f WHERE f.owning_portal_user_id = current_portal_user_id() ORDER BY f.created_at;
$$;
REVOKE ALL ON FUNCTION my_fleets() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_fleets() TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 2. Driver invites — a short code, not a phone match, same discipline
--    as shop_customer_link_codes. The code is the authorization; who
--    redeems it is whoever the fleet owner actually hands it to.
-- ═════════════════════════════════════════════════════════════════════
ALTER TABLE vehicle_registration_requests ADD COLUMN IF NOT EXISTS fleet_id uuid REFERENCES fleets(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS fleet_driver_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id uuid NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,
  invited_phone varchar NOT NULL, -- display/reference only, never matched against at redeem time
  code varchar NOT NULL,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_by_portal_user_id uuid REFERENCES portal_users(id),
  redeemed_at timestamptz,
  request_id uuid REFERENCES vehicle_registration_requests(id), -- which registration attempt this invite fed, re-pointed on resubmission
  vehicle_id uuid REFERENCES vehicles(id) -- filled in once that request is approved
);
CREATE INDEX IF NOT EXISTS fleet_driver_invites_fleet_idx ON fleet_driver_invites(fleet_id);
ALTER TABLE fleet_driver_invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_driver_invites_owner_read" ON fleet_driver_invites FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM fleets f WHERE f.id = fleet_id AND f.owning_portal_user_id = current_portal_user_id())
    OR current_admin_permission('manage_parties'));
-- No INSERT/UPDATE/DELETE policy — SECURITY DEFINER RPCs only.

CREATE OR REPLACE FUNCTION invite_fleet_driver(p_fleet_id uuid, p_phone varchar) RETURNS varchar
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_code varchar;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id AND owning_portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF trim(coalesce(p_phone, '')) = '' THEN RAISE EXCEPTION 'Enter the driver''s phone number.' USING ERRCODE = 'P0001'; END IF;

  -- One live invite per (fleet, phone) — regenerating replaces the old
  -- one, same "old code dies the instant a new one is issued" rule
  -- generate_customer_link_code (463) already uses.
  DELETE FROM fleet_driver_invites WHERE fleet_id = p_fleet_id AND invited_phone = trim(p_phone) AND redeemed_at IS NULL;

  v_code := lpad(floor(random() * 1000000)::text, 6, '0');
  INSERT INTO fleet_driver_invites (fleet_id, invited_phone, code, expires_at)
  VALUES (p_fleet_id, trim(p_phone), v_code, now() + interval '7 days');
  RETURN v_code;
END;
$$;
REVOKE ALL ON FUNCTION invite_fleet_driver(uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION invite_fleet_driver(uuid, varchar) TO authenticated;

CREATE OR REPLACE FUNCTION redeem_fleet_driver_invite(p_code varchar) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); inv fleet_driver_invites%ROWTYPE; v_fleet_name varchar;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO inv FROM fleet_driver_invites WHERE code = trim(coalesce(p_code, '')) AND redeemed_at IS NULL AND expires_at > now() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'That code is invalid or has expired.' USING ERRCODE = 'P0001'; END IF;

  UPDATE fleet_driver_invites SET redeemed_by_portal_user_id = v_portal_user_id, redeemed_at = now() WHERE id = inv.id;
  SELECT name INTO v_fleet_name FROM fleets WHERE id = inv.fleet_id;
  RETURN jsonb_build_object('fleet_id', inv.fleet_id, 'fleet_name', v_fleet_name);
END;
$$;
REVOKE ALL ON FUNCTION redeem_fleet_driver_invite(varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION redeem_fleet_driver_invite(varchar) TO authenticated;

CREATE OR REPLACE FUNCTION my_fleet_invites(p_fleet_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', i.id, 'invited_phone', i.invited_phone, 'created_at', i.created_at, 'expires_at', i.expires_at,
    'redeemed_at', i.redeemed_at, 'vehicle_id', i.vehicle_id
  ) ORDER BY i.created_at DESC), '[]'::jsonb)
  FROM fleet_driver_invites i
  WHERE i.fleet_id = p_fleet_id AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = i.fleet_id AND f.owning_portal_user_id = current_portal_user_id());
$$;
REVOKE ALL ON FUNCTION my_fleet_invites(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_fleet_invites(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 3. submit_vehicle_registration — same signature/body as 838, plus:
--    if this account redeemed a driver invite and hasn't been approved
--    into a vehicle yet, tag this request with that invite's fleet_id
--    and re-point the invite at this (possibly resubmitted) request.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION submit_vehicle_registration(
  p_owner_name varchar, p_cnic_number varchar, p_father_husband_name varchar, p_address text,
  p_vehicle_type varchar, p_vehicle_number varchar, p_model varchar, p_color varchar, p_total_seats int,
  p_owner_id_card_url text, p_license_url text, p_vehicle_doc_url text, p_driver_photo_url text,
  p_wants_delivers boolean, p_wants_hourly boolean, p_wants_shadi boolean, p_wants_out_of_city boolean, p_wants_night_booking boolean,
  p_wants_service_class_ids uuid[] DEFAULT '{}', p_category_id uuid DEFAULT NULL, p_has_ac boolean DEFAULT false,
  p_vehicle_kind varchar DEFAULT NULL, p_engine_cc int DEFAULT NULL,
  p_is_electric boolean DEFAULT false, p_is_loader boolean DEFAULT false, p_is_luxury_declared boolean DEFAULT false
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_tenant_id uuid := COALESCE(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
  v_kind varchar := NULLIF(trim(coalesce(p_vehicle_kind, '')), '');
  v_request_id uuid;
  v_category_id uuid;
  v_fleet_id uuid;
  v_invite_id uuid;
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

  IF v_kind IS NOT NULL AND v_kind NOT IN ('car', 'rickshaw', 'bike') THEN
    RAISE EXCEPTION 'Unknown vehicle kind.' USING ERRCODE = 'P0001';
  END IF;
  IF v_kind = 'car' AND p_engine_cc IS NULL THEN
    RAISE EXCEPTION 'Engine CC is required for a car.' USING ERRCODE = 'P0001';
  END IF;
  IF p_engine_cc IS NOT NULL AND (p_engine_cc < 50 OR p_engine_cc > 10000) THEN
    RAISE EXCEPTION 'Engine CC looks wrong — enter the real engine size in CC.' USING ERRCODE = 'P0001';
  END IF;

  IF v_kind IS NOT NULL THEN
    v_category_id := resolve_vehicle_category(v_kind, p_engine_cc, p_has_ac, p_is_electric, p_is_loader, p_is_luxury_declared);
    IF v_category_id IS NULL THEN
      RAISE EXCEPTION 'Could not match your vehicle to a category from the details entered — double check the CC and try again.' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF p_category_id IS NULL THEN
      RAISE EXCEPTION 'Pick your vehicle type.' USING ERRCODE = 'P0001';
    END IF;
    SELECT id INTO v_category_id FROM vehicle_categories
    WHERE id = p_category_id AND tenant_id = v_tenant_id AND is_active
      AND COALESCE(vehicle_kind, '') NOT IN ('car', 'rickshaw', 'bike');
    IF v_category_id IS NULL THEN
      RAISE EXCEPTION 'That vehicle type must be registered by its kind and engine CC — pick Car, Rickshaw or Bike and enter the details.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 853: inherit a fleet from a redeemed, not-yet-fulfilled driver
  -- invite, if one exists for this account. "Not yet fulfilled" is
  -- vehicle_id IS NULL, not request_id IS NULL, so a rejected-then-
  -- resubmitted registration still correctly re-inherits the fleet.
  SELECT id, fleet_id INTO v_invite_id, v_fleet_id FROM fleet_driver_invites
    WHERE redeemed_by_portal_user_id = v_portal_user_id AND vehicle_id IS NULL
    ORDER BY redeemed_at DESC LIMIT 1;

  INSERT INTO vehicle_registration_requests (
    portal_user_id, owner_name, cnic_number, father_husband_name, address,
    vehicle_type, vehicle_number, model, color, total_seats,
    owner_id_card_url, license_url, vehicle_doc_url, driver_photo_url,
    wants_delivers, wants_hourly, wants_shadi, wants_out_of_city, wants_night_booking, wants_service_class_ids, category_id, has_ac,
    engine_cc, is_electric, is_loader, is_luxury_declared, fleet_id
  ) VALUES (
    v_portal_user_id, trim(p_owner_name), trim(p_cnic_number), nullif(trim(p_father_husband_name), ''), trim(p_address),
    trim(p_vehicle_type), nullif(trim(p_vehicle_number), ''), nullif(trim(p_model), ''), nullif(trim(p_color), ''), p_total_seats,
    p_owner_id_card_url, p_license_url, p_vehicle_doc_url, p_driver_photo_url,
    p_wants_delivers, p_wants_hourly, p_wants_shadi, p_wants_out_of_city, p_wants_night_booking, coalesce(p_wants_service_class_ids, '{}'), v_category_id, p_has_ac,
    p_engine_cc, coalesce(p_is_electric, false), coalesce(p_is_loader, false), coalesce(p_is_luxury_declared, false), v_fleet_id
  ) RETURNING id INTO v_request_id;

  IF v_invite_id IS NOT NULL THEN
    UPDATE fleet_driver_invites SET request_id = v_request_id WHERE id = v_invite_id;
  END IF;

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════
-- 4. admin_approve_vehicle_registration — same signature/body as 837,
--    plus propagating fleet_id onto the created vehicle and marking
--    the originating invite fulfilled (vehicle_id).
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION admin_approve_vehicle_registration(
  p_request_id uuid, p_is_village_resident boolean, p_category_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE r vehicle_registration_requests%ROWTYPE; vc vehicle_categories%ROWTYPE; v_vehicle_id uuid; v_category_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_registration_requests WHERE id = p_request_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'This request has already been reviewed.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM vehicles WHERE portal_user_id = r.portal_user_id) THEN
    RAISE EXCEPTION 'This driver already has a linked vehicle.' USING ERRCODE = 'P0001';
  END IF;

  v_category_id := COALESCE(p_category_id, r.category_id);
  IF v_category_id IS NULL THEN RAISE EXCEPTION 'This request has no category — reject it and ask the driver to resubmit.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO vc FROM vehicle_categories WHERE id = v_category_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Category not found.' USING ERRCODE = 'P0001'; END IF;

  IF r.wants_delivers AND (vc.per_km_pkr IS NULL OR vc.per_km_pkr <= 0) THEN
    RAISE EXCEPTION 'The % category has no delivery rate set yet — set it in Marketplace Reference before approving this driver for delivery.', vc.name USING ERRCODE = 'P0001';
  END IF;
  IF r.wants_hourly AND (vc.hourly_rate_pkr IS NULL OR vc.hourly_included_km IS NULL OR vc.hourly_overage_per_km_pkr IS NULL) THEN
    RAISE EXCEPTION 'The % category has no hourly rate set yet — set it in Marketplace Reference before approving this driver for hourly rental.', vc.name USING ERRCODE = 'P0001';
  END IF;
  IF r.wants_shadi AND (vc.shadi_full_day_rate_pkr IS NULL OR vc.shadi_full_day_rate_pkr <= 0) THEN
    RAISE EXCEPTION 'The % category has no shadi day-rate set yet — set it in Marketplace Reference before approving this driver for shadi bookings.', vc.name USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO vehicles (
    owner_name, vehicle_type, vehicle_number, model, color, has_ac, total_seats, portal_user_id, is_active,
    delivers, per_km_pkr, offers_hourly, hourly_rate_pkr, hourly_included_km, hourly_overage_per_km_pkr,
    offers_shadi, shadi_full_day_rate_pkr, allows_out_of_city, night_booking_enabled, category_id,
    engine_cc, is_electric, is_loader, is_luxury_declared, rental_tier, fleet_id
  ) VALUES (
    r.owner_name, r.vehicle_type, r.vehicle_number, r.model, r.color, r.has_ac, r.total_seats, r.portal_user_id, true,
    r.wants_delivers, CASE WHEN r.wants_delivers THEN vc.per_km_pkr ELSE NULL END,
    r.wants_hourly, CASE WHEN r.wants_hourly THEN vc.hourly_rate_pkr ELSE NULL END,
    CASE WHEN r.wants_hourly THEN vc.hourly_included_km ELSE NULL END, CASE WHEN r.wants_hourly THEN vc.hourly_overage_per_km_pkr ELSE NULL END,
    r.wants_shadi, CASE WHEN r.wants_shadi THEN vc.shadi_full_day_rate_pkr ELSE NULL END,
    r.wants_out_of_city, r.wants_night_booking, v_category_id,
    r.engine_cc, r.is_electric, r.is_loader, r.is_luxury_declared, vc.rental_tier_key, r.fleet_id
  ) RETURNING id INTO v_vehicle_id;

  UPDATE vehicle_registration_requests SET
    status = 'approved', is_village_resident = p_is_village_resident, reviewed_by = current_admin_user_id(), reviewed_at = now(), vehicle_id = v_vehicle_id
  WHERE id = p_request_id;

  UPDATE fleet_driver_invites SET vehicle_id = v_vehicle_id WHERE request_id = p_request_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
  VALUES (r.portal_user_id, 'vehicle_registration_approved', 'Vehicle approved', r.owner_name || ' — ' || r.vehicle_type, '/portal/my-vehicle', r.tenant_id);

  RETURN v_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
