-- Migration 897: two fixes found while verifying 893/896 end to end.
--
-- 1. CRITICAL HOTFIX, caught before it could bite anyone in production:
-- is_fleet_employee_driver (893) never excluded the fleet OWNER. The
-- existing my-vehicle/layout.tsx redirect logic already anticipates a
-- real scenario this app supports — "a fleet owner/staff member who
-- ALSO personally drives one of its vehicles" — and for exactly that
-- owner, the old body would have returned true (they ARE that
-- vehicle's portal_user_id), making can_administer_vehicle false and
-- locking the owner out of administering their own fleet's routes.
-- Confirmed this scenario doesn't exist in today's QA data (the test
-- owner drives no vehicle directly) but the bug is real and would hit
-- the very first real owner who does. Fixed by excluding the fleet
-- owner explicitly.
--
-- 2. Confirmed live while testing /portal/drive: fleet_vehicle_cash_
-- positions (864, gated on fleet_staff membership or ownership)
-- rejects a real driver outright, because 893's fleet_staff upsert
-- only fires going forward inside admin_approve_vehicle_registration
-- — every fleet vehicle's driver approved BEFORE 893 has no fleet_
-- staff row at all. One-time backfill, purely additive (ON CONFLICT
-- DO NOTHING, so anyone who already has a fleet_staff row in that
-- fleet — any role, including an owner who drives their own bus — is
-- left exactly as they are).

CREATE OR REPLACE FUNCTION is_fleet_employee_driver(p_vehicle_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (
    EXISTS (
      SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.fleet_id IS NOT NULL AND v.portal_user_id = current_portal_user_id()
    ) OR EXISTS (
      SELECT 1 FROM vehicles v JOIN fleet_staff fs ON fs.fleet_id = v.fleet_id
      WHERE v.id = p_vehicle_id AND fs.role = 'driver' AND fs.portal_user_id = current_portal_user_id()
    )
  ) AND NOT EXISTS (
    SELECT 1 FROM vehicles v JOIN fleets f ON f.id = v.fleet_id WHERE v.id = p_vehicle_id AND f.owning_portal_user_id = current_portal_user_id()
  );
$$;

INSERT INTO fleet_staff (fleet_id, portal_user_id, role)
SELECT v.fleet_id, v.portal_user_id, 'driver'
FROM vehicles v
WHERE v.fleet_id IS NOT NULL AND v.portal_user_id IS NOT NULL
ON CONFLICT (fleet_id, portal_user_id) DO NOTHING;
