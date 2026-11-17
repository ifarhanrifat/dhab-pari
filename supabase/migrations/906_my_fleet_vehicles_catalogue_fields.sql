-- Migration 906: Vehicles screen rebuild (design-first plan, screen 3)
-- from safar_admin_dashboard-1.html's "Vehicles & service catalogue"
-- view. Its fleet-register table shows body type, seat/berth layout,
-- documents and availability per bus — my_fleet_vehicles (896) only
-- had owner_name/vehicle_type/vehicle_number/portal_user_id, nowhere
-- near enough to match that density honestly. Widened with real,
-- already-stored columns only: category name + vehicle_kind (body
-- type), total_seats + is_sleeper (seat/berth layout), model/model_year
-- (shown instead of a fabricated "default service" — dhab-pari has no
-- named-service concept like the mockup's "QA Executive"). Document
-- status and maintenance-hold state are fetched separately per-vehicle/
-- fleet-wide (vehicle_document_status, fleet_maintenance_orders,
-- fleet_vehicle_schedule — all already exist), not folded into this
-- function, to keep it a single real table scan.
DROP FUNCTION IF EXISTS my_fleet_vehicles();
CREATE OR REPLACE FUNCTION my_fleet_vehicles() RETURNS TABLE(
  id uuid, owner_name varchar, vehicle_type varchar, vehicle_number varchar, portal_user_id uuid,
  category_name varchar, vehicle_kind varchar, total_seats int, is_sleeper boolean, model varchar, model_year int, has_ac boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.id, v.owner_name, v.vehicle_type, v.vehicle_number, v.portal_user_id,
    vc.name, vc.vehicle_kind, v.total_seats, v.is_sleeper, v.model, v.model_year, v.has_ac
  FROM vehicles v JOIN fleets f ON f.id = v.fleet_id
  LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
  WHERE v.is_active AND (
    f.owning_portal_user_id = current_portal_user_id()
    OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = f.id AND fs.portal_user_id = current_portal_user_id())
  );
$$;
REVOKE ALL ON FUNCTION my_fleet_vehicles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_fleet_vehicles() TO authenticated;
