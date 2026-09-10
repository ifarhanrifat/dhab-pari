-- Two known remaining gaps from last night's trust-tiers/fare-bands
-- work, closed now per this morning's "complete the remaining now":
--
-- 1. Trust on dispatch invites (483's own commit note: "trip-fare-
--    offers and dispatch-invites" were left out). A driver deciding
--    whether to accept a dispatch call is judging the requesting
--    villager exactly the same way the hourly/shadi driver already
--    does — my_dispatch_invitations() and dispatch_call_detail() gain
--    'customer_trust', same as vehicle_hourly_bookings/
--    vehicle_shadi_requests (483).
--
-- 2. A proactive fare-band hint for the city-fetch negotiation chat.
--    The band was already enforced server-side (484's
--    propose_negotiation_offer band check) but nothing told a rider
--    the number before they typed one and got rejected. Ported the
--    same fare_band_for('city_fetch', km) read the travel hub tiles
--    already use, exposed here as a per-thread lookup so the chat
--    screen can show it without duplicating the km lookup itself.
CREATE OR REPLACE FUNCTION my_dispatch_invitations(p_vehicle_id uuid) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'call_id', c.id, 'item', c.item, 'address', c.address, 'goods_budget_pkr', c.goods_budget_pkr, 'tier', i.tier,
    'shop_name', s.name, 'city_name', ci.name, 'invited_at', i.invited_at,
    'customer_trust', portal_user_trust(c.initiator_portal_user_id)
  ) ORDER BY i.invited_at DESC), '[]'::jsonb)
  FROM dispatch_invitations i
  JOIN dispatch_calls c ON c.id = i.call_id
  JOIN city_shops s ON s.id = c.city_shop_id
  JOIN cities ci ON ci.id = s.city_id
  JOIN vehicles v ON v.id = p_vehicle_id
  WHERE i.vehicle_id = p_vehicle_id AND i.status = 'ringing' AND c.status IN ('tier1', 'tier2')
    AND v.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_dispatch_invitations(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_dispatch_invitations(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION dispatch_call_detail(p_call_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'call', jsonb_build_object(
      'id', c.id, 'item', c.item, 'address', c.address, 'goods_budget_pkr', c.goods_budget_pkr, 'status', c.status,
      'fare_outbound_pkr', c.fare_outbound_pkr, 'fare_return_pkr', c.fare_return_pkr, 'wait_fee_pkr', c.wait_fee_pkr, 'total_pkr', c.total_pkr,
      'shop_name', s.name, 'shop_name_ur', s.name_ur, 'city_name', ci.name, 'city_km', ci.distance_km,
      'accepted_vehicle_id', av.id, 'accepted_owner_name', av.owner_name, 'accepted_owner_mobile', av.owner_mobile, 'accepted_vehicle_type', av.vehicle_type,
      'customer_trust', portal_user_trust(c.initiator_portal_user_id)
    ),
    'invitations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'vehicle_id', v.id, 'owner_name', v.owner_name, 'tier', i.tier, 'status', i.status, 'invited_at', i.invited_at, 'responded_at', i.responded_at
      ) ORDER BY i.tier, i.invited_at)
      FROM dispatch_invitations i JOIN vehicles v ON v.id = i.vehicle_id WHERE i.call_id = c.id
    ), '[]'::jsonb)
  )
  FROM dispatch_calls c
  JOIN city_shops s ON s.id = c.city_shop_id
  JOIN cities ci ON ci.id = s.city_id
  LEFT JOIN vehicles av ON av.id = c.accepted_vehicle_id
  WHERE c.id = p_call_id AND is_party_to_dispatch(c.id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION dispatch_call_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION dispatch_call_detail(uuid) TO authenticated;

-- City-fetch band hint, read per negotiation thread rather than
-- re-deriving city_id -> distance_km client-side.
CREATE OR REPLACE FUNCTION negotiation_fare_band(p_thread_id uuid) RETURNS jsonb AS $$
  SELECT fare_band_for('city_fetch', ci.distance_km)
  FROM negotiation_threads t JOIN cities ci ON ci.id = t.city_id
  WHERE t.id = p_thread_id AND t.kind = 'fetch' AND t.city_id IS NOT NULL
    AND (t.initiator_portal_user_id = current_portal_user_id()
      OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = t.vehicle_id AND v.portal_user_id = current_portal_user_id()));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION negotiation_fare_band(uuid) TO authenticated;
