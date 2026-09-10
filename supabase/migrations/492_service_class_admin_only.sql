-- Real integrity bug, not a UX nitpick: vehicle_service_offers (420)
-- let a driver self-toggle ANY service_classes row onto their vehicle
-- with zero check against what the vehicle actually is — a registered
-- Toyota Corolla could tick "رکشہ" and would then genuinely appear to
-- a rider requesting a rickshaw for the Pro & Loading Charter flow.
-- The class list was never filtered by vehicle_type because there's
-- no structural link between them (vehicle_type is free text the
-- driver typed at registration; service_classes is committee-managed
-- reference data) — self-service here was never actually safe.
--
-- Fixed the same way every other "this needs verification, not a
-- self-declaration" gap in this system has been fixed (per-km rate,
-- hourly rate, shadi rate, CNIC/village-resident verification): moved
-- to admin-only. The committee can see the real vehicle (and, since
-- 491, its documents) before deciding what class it legitimately
-- belongs to.
DROP POLICY IF EXISTS "vehicle_service_offers_write" ON vehicle_service_offers;
DROP POLICY IF EXISTS "vehicle_service_offers_update" ON vehicle_service_offers;
DROP POLICY IF EXISTS "vehicle_service_offers_delete" ON vehicle_service_offers;

CREATE POLICY "vehicle_service_offers_admin_write" ON vehicle_service_offers FOR INSERT TO authenticated
  WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "vehicle_service_offers_admin_update" ON vehicle_service_offers FOR UPDATE TO authenticated
  USING (true) WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "vehicle_service_offers_admin_delete" ON vehicle_service_offers FOR DELETE TO authenticated
  USING (current_admin_permission('manage_parties'));
