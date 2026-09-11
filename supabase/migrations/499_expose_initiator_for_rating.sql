-- city_purchase_request_detail (495) — same signature, adds
-- initiator_portal_user_id so the accepted driver's client can file a
-- complaint against the rider (RateAndReport needs a real
-- against_party_id, not just "the other side" in the abstract).
CREATE OR REPLACE FUNCTION city_purchase_request_detail(p_request_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'request', jsonb_build_object(
      'id', r.id, 'item', r.item, 'has_item_attachment', (r.item_attachment_path IS NOT NULL), 'pickup_label', r.pickup_label,
      'pickup_lat', r.pickup_lat, 'pickup_lng', r.pickup_lng, 'goods_budget_pkr', r.goods_budget_pkr, 'status', r.status,
      'distance_fare_pkr', r.distance_fare_pkr, 'addon_fee_pkr', r.addon_fee_pkr, 'total_fare_pkr', r.total_fare_pkr,
      'actual_goods_cost_pkr', r.actual_goods_cost_pkr, 'has_bill_attachment', (r.bill_attachment_path IS NOT NULL),
      'city_name', ci.name, 'city_name_ur', ci.name_ur, 'city_km', ci.distance_km,
      'accepted_vehicle_id', av.id, 'accepted_owner_name', av.owner_name, 'accepted_owner_mobile', av.owner_mobile, 'accepted_vehicle_type', av.vehicle_type,
      'initiator_portal_user_id', r.initiator_portal_user_id,
      'created_at', r.created_at
    ),
    'invitations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'vehicle_id', v.id, 'owner_name', v.owner_name, 'source', i.source, 'reference_destination', i.reference_destination,
        'status', i.status, 'invited_at', i.invited_at, 'responded_at', i.responded_at
      ) ORDER BY i.invited_at)
      FROM city_purchase_invitations i JOIN vehicles v ON v.id = i.vehicle_id WHERE i.request_id = r.id
    ), '[]'::jsonb)
  )
  FROM city_purchase_requests r
  JOIN cities ci ON ci.id = r.city_id
  LEFT JOIN vehicles av ON av.id = r.accepted_vehicle_id
  WHERE r.id = p_request_id AND is_party_to_city_purchase(r.id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- dispatch_call_detail (487's version, the real live one — verified
-- against the actual migration rather than the frontend's own
-- CallDetail interface, which references purchase_fee_pkr/accepted_tier/
-- shop_is_general fields that turn out not to exist on any version of
-- this function in the migration history; that's a pre-existing gap,
-- left alone here since fixing it isn't this migration's job) — same
-- addition as above: initiator_portal_user_id for RateAndReport.
CREATE OR REPLACE FUNCTION dispatch_call_detail(p_call_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'call', jsonb_build_object(
      'id', c.id, 'item', c.item, 'address', c.address, 'goods_budget_pkr', c.goods_budget_pkr, 'status', c.status,
      'fare_outbound_pkr', c.fare_outbound_pkr, 'fare_return_pkr', c.fare_return_pkr, 'wait_fee_pkr', c.wait_fee_pkr, 'total_pkr', c.total_pkr,
      'shop_name', s.name, 'shop_name_ur', s.name_ur, 'city_name', ci.name, 'city_km', ci.distance_km,
      'accepted_vehicle_id', av.id, 'accepted_owner_name', av.owner_name, 'accepted_owner_mobile', av.owner_mobile, 'accepted_vehicle_type', av.vehicle_type,
      'initiator_portal_user_id', c.initiator_portal_user_id,
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
