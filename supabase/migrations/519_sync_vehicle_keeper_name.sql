-- Migration 519: keep a linked portal account's own name in step with the
-- vehicle it's the keeper of.
--
-- Real report, 2026-09-28: a vehicle's owner_name is typed on its own
-- registration form (e.g. "Iltaf Hussain") -- a name that's independent of
-- whatever the driver typed as their portal_users.full_name when they first
-- signed up (often a nickname/family name, e.g. "kaka_hadi"). Once an admin
-- links that portal account to this vehicle as its keeper, the two names
-- disagree everywhere full_name is shown (the admin Vehicles page's own
-- "keeper" label, any place that looks up the linked account by name)
-- even though they're now understood to be the same person. Sync full_name
-- to the vehicle's owner_name at that moment, since owner_name is the one
-- typed specifically for this vehicle/driver relationship.
--
-- SECURITY DEFINER + manage_parties (the same permission vehicles' own
-- RLS already requires) rather than a raw client-side portal_users update --
-- portal_users' own UPDATE policy (migration 320) only admits role
-- super_admin/admin, narrower than manage_parties, which anyone editing
-- vehicles already holds.
CREATE OR REPLACE FUNCTION sync_vehicle_keeper_name(p_vehicle_id uuid) RETURNS void AS $$
DECLARE
  v_owner_name varchar;
  v_portal_user_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT owner_name, portal_user_id INTO v_owner_name, v_portal_user_id
    FROM vehicles WHERE id = p_vehicle_id;
  IF v_portal_user_id IS NULL OR v_owner_name IS NULL OR trim(v_owner_name) = '' THEN
    RETURN;
  END IF;

  UPDATE portal_users SET full_name = v_owner_name
   WHERE id = v_portal_user_id AND full_name IS DISTINCT FROM v_owner_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION sync_vehicle_keeper_name(uuid) TO authenticated;

-- One-time backfill: every vehicle already linked to a portal account gets
-- its keeper's full_name corrected right now, same as it will from here on.
UPDATE portal_users pu SET full_name = v.owner_name
  FROM vehicles v
 WHERE v.portal_user_id = pu.id
   AND v.owner_name IS NOT NULL AND trim(v.owner_name) <> ''
   AND pu.full_name IS DISTINCT FROM v.owner_name;

-- The driver self-registration path (migration 491) also creates a vehicle
-- already linked to a portal account in one step -- same sync, so a driver
-- who registers their own vehicle gets their verified name reflected on
-- their own account immediately, not just when an admin manually links one.
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

  UPDATE portal_users SET full_name = r.owner_name
   WHERE id = r.portal_user_id AND full_name IS DISTINCT FROM r.owner_name;

  UPDATE vehicle_registration_requests SET
    status = 'approved', is_village_resident = p_is_village_resident, reviewed_by = current_admin_user_id(), reviewed_at = now(), vehicle_id = v_vehicle_id
  WHERE id = p_request_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (r.portal_user_id, 'vehicle_registration_approved', 'Vehicle approved', r.owner_name || ' — ' || r.vehicle_type, '/portal/my-vehicle');

  RETURN v_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
