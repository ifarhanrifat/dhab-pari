-- The delivery-invite notification pointed at a per-order detail route
-- (/portal/my-vehicle/deliveries/{orderId}) that was never actually
-- built — my-vehicle has no sub-routes at all today. Points at the flat
-- list page instead (built alongside this migration), which already
-- shows every one of a vehicle's ringing invitations at once via
-- my_shop_delivery_invitations — no per-order deep link needed.
CREATE OR REPLACE FUNCTION start_shop_delivery_ring(p_order_id uuid) RETURNS void AS $$
DECLARE
  o shop_orders%ROWTYPE;
  v_is_home boolean;
  v_count int;
BEGIN
  SELECT * INTO o FROM shop_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR user_manages_shop(o.shop_id)) THEN
    RAISE EXCEPTION 'You do not manage this shop.' USING ERRCODE = 'P0001';
  END IF;
  IF o.fulfillment_mode <> 'delivery' THEN RETURN; END IF;

  SELECT v.is_home_village INTO v_is_home FROM villages v WHERE v.id = o.village_id;

  INSERT INTO shop_delivery_invitations (order_id, vehicle_id)
  SELECT p_order_id, veh.id FROM vehicles veh
  WHERE veh.is_active AND veh.delivers
    AND NOT EXISTS (SELECT 1 FROM shop_delivery_invitations i WHERE i.order_id = p_order_id AND i.vehicle_id = veh.id)
    AND (COALESCE(v_is_home, true) OR veh.allows_out_of_city);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count = 0 THEN
    UPDATE shop_orders SET delivery_ring_status = 'no_answer' WHERE id = p_order_id;
    RETURN;
  END IF;

  UPDATE shop_orders SET delivery_ring_status = 'ringing' WHERE id = p_order_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT veh.portal_user_id, 'shop_delivery_invited', 'Delivery request',
    'A delivery job is available' || CASE WHEN v_is_home THEN '' ELSE ' (out of village)' END || '.',
    '/portal/my-vehicle/deliveries'
  FROM shop_delivery_invitations i JOIN vehicles veh ON veh.id = i.vehicle_id
  WHERE i.order_id = p_order_id AND i.status = 'ringing' AND veh.portal_user_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
