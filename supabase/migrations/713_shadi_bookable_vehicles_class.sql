-- Migration 713: shadi_bookable_vehicles() never surfaced which
-- shadi_vehicle_class (654) a vehicle belongs to — needed now to group
-- the rider's vehicle picker by category, matching the design mockup's
-- real category-card-with-dropdown flow instead of one flat list.
-- Same signature, same every other field, byte-identical otherwise.
CREATE OR REPLACE FUNCTION shadi_bookable_vehicles() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'color', v.color, 'model', v.model, 'has_ac', v.has_ac,
    'shadi_vehicle_class', v.shadi_vehicle_class,
    'shadi_full_day_rate_pkr', v.shadi_full_day_rate_pkr,
    'cover_url', (SELECT m.url FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.is_cover LIMIT 1),
    'avg_rating', (SELECT round(avg(r.stars)::numeric, 1) FROM ratings r WHERE r.target_party_type = 'vehicle' AND r.target_party_id = v.id),
    'shared_from_other_village', v.tenant_id <> my_tenant_id(),
    'owner_village_name', CASE WHEN v.tenant_id <> my_tenant_id() THEN (SELECT t.name FROM tenants t WHERE t.id = v.tenant_id) ELSE NULL END
  ) ORDER BY v.owner_name), '[]'::jsonb)
  FROM vehicles v
  WHERE v.is_active AND v.offers_shadi AND v.shadi_full_day_rate_pkr IS NOT NULL
    AND (v.tenant_id = my_tenant_id() OR EXISTS (
      SELECT 1 FROM marketplace_share_agreements sa
      WHERE sa.owner_tenant_id = v.tenant_id AND sa.target_tenant_id = my_tenant_id() AND sa.category = 'shadi' AND sa.is_active
    ));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
