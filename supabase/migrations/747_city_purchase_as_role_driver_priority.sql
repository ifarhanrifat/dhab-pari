-- Real bug found live, 2026-10-27: a City Purchase request from BEFORE
-- migration 710's self-invite fix (a villager who also owns a vehicle
-- could get their own vehicle invited to their own request) has
-- 'as_role' computed by checking "is this the initiator" FIRST — so a
-- driver who is ALSO the initiator (only possible for this exact kind
-- of pre-710 stale data) always gets as_role='user', never 'driver',
-- even though their vehicle really is the accepted one. my-vehicle/
-- jobs' own driver list filters strictly on `as_role === 'driver'`
-- (2026-10-26's own fix for "accepted job vanished from Jobs"), so
-- this exact case silently disappears from the driver's Jobs screen
-- with nowhere to find it again — exactly the report: "I can't find
-- this on the driver side at all."
--
-- 710 already stops this from happening to any NEW request. This is
-- the matching defense-in-depth fix for the read side: being the
-- accepted driver takes priority over being the initiator when
-- computing which role to show someone, since "I accepted this with my
-- vehicle" is the more operationally relevant fact than "I happened to
-- also post it" for the Jobs-list use case this field actually drives.

CREATE OR REPLACE FUNCTION my_city_purchase_requests() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'item', r.item, 'status', r.status, 'urgency', r.urgency, 'total_fare_pkr', r.total_fare_pkr, 'estimated_fee_pkr', r.estimated_fee_pkr, 'created_at', r.created_at,
    'city_name', ci.name, 'city_name_ur', ci.name_ur,
    'pickup_label', r.pickup_label, 'pickup_lat', r.pickup_lat, 'pickup_lng', r.pickup_lng,
    'delivery_label', r.delivery_label, 'delivery_lat', r.delivery_lat, 'delivery_lng', r.delivery_lng,
    'area', r.area, 'ride_type', r.ride_type, 'scheduled_date', r.scheduled_date, 'scheduled_time', r.scheduled_time,
    'tip_pkr', r.tip_pkr, 'payment_method', r.payment_method, 'goods_budget_pkr', r.goods_budget_pkr,
    'as_role', CASE WHEN EXISTS (SELECT 1 FROM vehicles v WHERE v.id = r.accepted_vehicle_id AND v.portal_user_id = current_portal_user_id()) THEN 'driver' ELSE 'user' END
  ) ORDER BY r.created_at DESC), '[]'::jsonb)
  FROM city_purchase_requests r JOIN cities ci ON ci.id = r.city_id
  WHERE r.initiator_portal_user_id = current_portal_user_id()
     OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = r.accepted_vehicle_id AND v.portal_user_id = current_portal_user_id());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_city_purchase_requests() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_city_purchase_requests() TO authenticated;
