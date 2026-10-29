-- Migration 768: real gap found live, 2026-10-29 — "how the rider will
-- verify if this car driver picture is the one which driver have in
-- his profile? i think we have also build this too in the past?"
-- Correct again: driver_photo_url has been captured at registration
-- time since 491 and reviewed by admins at approval time, but it was
-- NEVER read by anyone except the driver's own profile page and the
-- admin review queue — a rider has never had any way to see it, which
-- is the one case this photo actually exists for (a real safety check:
-- "is the person who showed up the same one registered on this
-- vehicle"). vehicle_registration_requests itself is RLS-locked to the
-- owning driver + admins (it also carries ID card/license scans, which
-- must never reach a rider) — this is a narrow, single-field read, only
-- once the caller is genuinely paired with that vehicle on a real
-- booking, never a blind lookup by vehicle_id alone.

CREATE OR REPLACE FUNCTION driver_photo_for_vehicle(p_vehicle_id uuid) RETURNS text AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_photo text;
BEGIN
  IF v_portal_user_id IS NULL THEN RETURN NULL; END IF;
  IF NOT (
    EXISTS (SELECT 1 FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id)
    OR EXISTS (SELECT 1 FROM vehicle_trip_bookings WHERE vehicle_id = p_vehicle_id AND portal_user_id = v_portal_user_id)
    OR EXISTS (SELECT 1 FROM hourly_bookings WHERE vehicle_id = p_vehicle_id AND portal_user_id = v_portal_user_id)
    OR EXISTS (SELECT 1 FROM equipment_bookings WHERE vehicle_id = p_vehicle_id AND portal_user_id = v_portal_user_id)
    OR EXISTS (SELECT 1 FROM rental_bookings WHERE vehicle_id = p_vehicle_id AND portal_user_id = v_portal_user_id)
    OR COALESCE(current_admin_permission('manage_parties'), false)
  ) THEN RETURN NULL; END IF;

  SELECT driver_photo_url INTO v_photo FROM vehicle_registration_requests
  WHERE vehicle_id = p_vehicle_id AND driver_photo_url IS NOT NULL
  ORDER BY created_at DESC LIMIT 1;
  RETURN v_photo;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION driver_photo_for_vehicle(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION driver_photo_for_vehicle(uuid) TO authenticated;
