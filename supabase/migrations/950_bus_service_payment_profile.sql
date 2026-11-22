-- Migration 950: real gap named directly by the user, 2026-11-22 —
-- "there will be button for the payment confirmation procedure... he
-- will pay the amount on the bus service easypaisa or bank account,
-- but now we dont have account numbers and bus service name and their
-- logo yet so we will create this now too."
--
-- A rider has always been told to "pay the driver directly" but the
-- platform never actually stored WHERE to send that payment, or any
-- brand identity to show alongside it. Attached at the FLEET level for
-- any vehicle that belongs to one (fleets.name is already the real
-- "bus service name" — a company runs several buses on one shared
-- account, not one account per bus) and at the VEHICLE level as a
-- fallback for a standalone, non-fleet owner-driver (owner_name
-- already serves as their own "service name").

ALTER TABLE fleets ADD COLUMN IF NOT EXISTS bank_account_title varchar;
ALTER TABLE fleets ADD COLUMN IF NOT EXISTS bank_name varchar;
ALTER TABLE fleets ADD COLUMN IF NOT EXISTS bank_account_number varchar;
ALTER TABLE fleets ADD COLUMN IF NOT EXISTS easypaisa_number varchar;
ALTER TABLE fleets ADD COLUMN IF NOT EXISTS easypaisa_account_title varchar;
ALTER TABLE fleets ADD COLUMN IF NOT EXISTS logo_url text;

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS bank_account_title varchar;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS bank_name varchar;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS bank_account_number varchar;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS easypaisa_number varchar;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS easypaisa_account_title varchar;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS logo_url text;

-- Owner-only, same discipline as 885's header comment: identity/brand
-- edits stay owner-only, not delegated through the 'cash' module —
-- that module is about day-to-day cash operations (remittances,
-- handovers), not changing where the company's money actually lands.
CREATE OR REPLACE FUNCTION set_fleet_payment_info(
  p_fleet_id uuid, p_bank_account_title varchar DEFAULT NULL, p_bank_name varchar DEFAULT NULL, p_bank_account_number varchar DEFAULT NULL,
  p_easypaisa_number varchar DEFAULT NULL, p_easypaisa_account_title varchar DEFAULT NULL, p_logo_url text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id AND owning_portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE fleets SET
    bank_account_title = nullif(trim(coalesce(p_bank_account_title, '')), ''),
    bank_name = nullif(trim(coalesce(p_bank_name, '')), ''),
    bank_account_number = nullif(trim(coalesce(p_bank_account_number, '')), ''),
    easypaisa_number = nullif(trim(coalesce(p_easypaisa_number, '')), ''),
    easypaisa_account_title = nullif(trim(coalesce(p_easypaisa_account_title, '')), ''),
    logo_url = nullif(trim(coalesce(p_logo_url, '')), '')
  WHERE id = p_fleet_id;
  PERFORM log_fleet_action(p_fleet_id, 'payment_info_updated', NULL);
END;
$$;
REVOKE ALL ON FUNCTION set_fleet_payment_info(uuid, varchar, varchar, varchar, varchar, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_fleet_payment_info(uuid, varchar, varchar, varchar, varchar, varchar, text) TO authenticated;

-- Standalone vehicle only (fleet_id IS NULL) — a fleet vehicle's
-- payment info lives on the fleet, not per-bus, so this deliberately
-- refuses to touch a fleet-owned vehicle's row rather than silently
-- writing columns route_payment_info() will never read for it.
CREATE OR REPLACE FUNCTION set_vehicle_payment_info(
  p_vehicle_id uuid, p_bank_account_title varchar DEFAULT NULL, p_bank_name varchar DEFAULT NULL, p_bank_account_number varchar DEFAULT NULL,
  p_easypaisa_number varchar DEFAULT NULL, p_easypaisa_account_title varchar DEFAULT NULL, p_logo_url text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fleet_id uuid; v_portal_user_id uuid := current_portal_user_id();
BEGIN
  SELECT fleet_id INTO v_fleet_id FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'You do not own this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF v_fleet_id IS NOT NULL THEN RAISE EXCEPTION 'This vehicle belongs to a fleet — set payment details from the fleet''s Cash & Accounts page instead.' USING ERRCODE = 'P0001'; END IF;
  UPDATE vehicles SET
    bank_account_title = nullif(trim(coalesce(p_bank_account_title, '')), ''),
    bank_name = nullif(trim(coalesce(p_bank_name, '')), ''),
    bank_account_number = nullif(trim(coalesce(p_bank_account_number, '')), ''),
    easypaisa_number = nullif(trim(coalesce(p_easypaisa_number, '')), ''),
    easypaisa_account_title = nullif(trim(coalesce(p_easypaisa_account_title, '')), ''),
    logo_url = nullif(trim(coalesce(p_logo_url, '')), '')
  WHERE id = p_vehicle_id;
END;
$$;
REVOKE ALL ON FUNCTION set_vehicle_payment_info(uuid, varchar, varchar, varchar, varchar, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_vehicle_payment_info(uuid, varchar, varchar, varchar, varchar, varchar, text) TO authenticated;

-- Rider-facing read — deliberately no ownership check at all, same as
-- any other vehicle/route display info a rider already sees before
-- paying. Resolves the fleet's info first (shared bus-service
-- account), falling back to the vehicle's own fields for a standalone
-- owner-driver.
CREATE OR REPLACE FUNCTION vehicle_payment_info(p_vehicle_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'service_name', COALESCE(f.name, v.owner_name),
    'logo_url', COALESCE(f.logo_url, v.logo_url),
    'bank_account_title', COALESCE(f.bank_account_title, v.bank_account_title),
    'bank_name', COALESCE(f.bank_name, v.bank_name),
    'bank_account_number', COALESCE(f.bank_account_number, v.bank_account_number),
    'easypaisa_number', COALESCE(f.easypaisa_number, v.easypaisa_number),
    'easypaisa_account_title', COALESCE(f.easypaisa_account_title, v.easypaisa_account_title),
    'has_payment_info', COALESCE(f.bank_account_number, v.bank_account_number, f.easypaisa_number, v.easypaisa_number) IS NOT NULL
  )
  FROM vehicles v LEFT JOIN fleets f ON f.id = v.fleet_id
  WHERE v.id = p_vehicle_id;
$$;
REVOKE ALL ON FUNCTION vehicle_payment_info(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_payment_info(uuid) TO authenticated;
