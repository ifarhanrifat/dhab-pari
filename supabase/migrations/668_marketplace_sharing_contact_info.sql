-- Migration 668: add owner_mobile + the owning village's name to the 4
-- browse RPCs from 667. Needed for the frontend decision just made:
-- a shared-from-another-village listing shows but "Book" is disabled
-- (the cross-tenant booking lifecycle isn't safe to wire up yet --
-- confirm/complete RPCs key bookings by the booking's own tenant_id,
-- which defaults to the RIDER's tenant at insert time, not the
-- vehicle's, so a cross-tenant booking would become invisible to the
-- very committee that owns the vehicle and needs to confirm/pay it --
-- that's its own, separately-scoped fix). Until then, a shared listing
-- shows "contact them directly" with the owner's phone and village name.
CREATE OR REPLACE FUNCTION hourly_bookable_vehicles() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'color', v.color, 'model', v.model,
    'has_ac', v.has_ac, 'hourly_rate_pkr', v.hourly_rate_pkr, 'hourly_included_km', v.hourly_included_km,
    'hourly_overage_per_km_pkr', v.hourly_overage_per_km_pkr,
    'cover_url', (SELECT m.url FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.is_cover LIMIT 1),
    'avg_rating', (SELECT round(avg(r.stars)::numeric, 1) FROM ratings r WHERE r.target_party_type = 'vehicle' AND r.target_party_id = v.id),
    'shared_from_other_village', v.tenant_id <> my_tenant_id(),
    'owner_village_name', CASE WHEN v.tenant_id <> my_tenant_id() THEN (SELECT t.name FROM tenants t WHERE t.id = v.tenant_id) ELSE NULL END
  ) ORDER BY v.owner_name), '[]'::jsonb)
  FROM vehicles v
  WHERE v.is_active AND v.offers_hourly AND v.hourly_rate_pkr IS NOT NULL
    AND (v.tenant_id = my_tenant_id() OR EXISTS (
      SELECT 1 FROM marketplace_share_agreements sa
      WHERE sa.owner_tenant_id = v.tenant_id AND sa.target_tenant_id = my_tenant_id() AND sa.category = 'hourly' AND sa.is_active
    ));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION shadi_bookable_vehicles() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'color', v.color, 'model', v.model, 'has_ac', v.has_ac,
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

CREATE OR REPLACE FUNCTION rental_bookable_vehicles() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'color', v.color, 'model', v.model,
    'rental_base_pkr', v.rental_base_pkr, 'rental_per_km_pkr', v.rental_per_km_pkr, 'rental_wait_hour_pkr', v.rental_wait_hour_pkr,
    'cover_url', (SELECT m.url FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.is_cover LIMIT 1),
    'avg_rating', (SELECT round(avg(r.stars)::numeric, 1) FROM ratings r WHERE r.target_party_type = 'vehicle' AND r.target_party_id = v.id),
    'shared_from_other_village', v.tenant_id <> my_tenant_id(),
    'owner_village_name', CASE WHEN v.tenant_id <> my_tenant_id() THEN (SELECT t.name FROM tenants t WHERE t.id = v.tenant_id) ELSE NULL END
  ) ORDER BY v.owner_name), '[]'::jsonb)
  FROM vehicles v
  WHERE v.is_active AND v.offers_rental AND v.rental_base_pkr IS NOT NULL AND v.rental_per_km_pkr IS NOT NULL
    AND (v.tenant_id = my_tenant_id() OR EXISTS (
      SELECT 1 FROM marketplace_share_agreements sa
      WHERE sa.owner_tenant_id = v.tenant_id AND sa.target_tenant_id = my_tenant_id() AND sa.category = 'rental' AND sa.is_active
    ));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION equipment_bookable_vehicles(p_kind varchar) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'color', v.color, 'model', v.model,
    'machinery_hourly_rate_pkr', v.machinery_hourly_rate_pkr, 'machinery_min_hours', v.machinery_min_hours, 'machinery_mobilization_fee_pkr', v.machinery_mobilization_fee_pkr,
    'loader_trip_rate_pkr', v.loader_trip_rate_pkr,
    'cover_url', (SELECT m.url FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.is_cover LIMIT 1),
    'avg_rating', (SELECT round(avg(r.stars)::numeric, 1) FROM ratings r WHERE r.target_party_type = 'vehicle' AND r.target_party_id = v.id),
    'shared_from_other_village', v.tenant_id <> my_tenant_id(),
    'owner_village_name', CASE WHEN v.tenant_id <> my_tenant_id() THEN (SELECT t.name FROM tenants t WHERE t.id = v.tenant_id) ELSE NULL END,
    'tractor_services', CASE WHEN p_kind = 'tractor' THEN (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('service_key', ts.service_key, 'name_en', ts.name_en, 'name_ur', ts.name_ur, 'rate_pkr', ts.rate_pkr, 'unit', ts.unit) ORDER BY ts.name_en), '[]'::jsonb)
      FROM tractor_services ts WHERE ts.vehicle_id = v.id
    ) ELSE NULL END
  ) ORDER BY v.owner_name), '[]'::jsonb)
  FROM vehicles v
  WHERE v.is_active AND (
    (p_kind = 'machinery' AND v.offers_machinery AND v.machinery_hourly_rate_pkr IS NOT NULL)
    OR (p_kind = 'tractor' AND v.offers_tractor AND EXISTS (SELECT 1 FROM tractor_services ts WHERE ts.vehicle_id = v.id))
    OR (p_kind = 'loader' AND v.offers_loader AND v.loader_trip_rate_pkr IS NOT NULL)
  )
  AND (v.tenant_id = my_tenant_id() OR EXISTS (
    SELECT 1 FROM marketplace_share_agreements sa
    WHERE sa.owner_tenant_id = v.tenant_id AND sa.target_tenant_id = my_tenant_id() AND sa.category = p_kind AND sa.is_active
  ));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
