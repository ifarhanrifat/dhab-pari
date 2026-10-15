-- Migration 667: cross-tenant marketplace sharing, part 1 of the
-- cross-tenant plan — category-scoped, per-target-village opt-in.
--
-- Real bug found live while building this (not by inspection — checked
-- every rider-facing browse RPC directly): hourly_bookable_vehicles(),
-- shadi_bookable_vehicles(), rental_bookable_vehicles() and
-- equipment_bookable_vehicles() have NO tenant filter in their body at
-- all. They're SECURITY DEFINER, so they don't inherit the RLS policies
-- the underlying `vehicles` table correctly has (public_read_vehicles/
-- vehicles_authenticated_read, both properly tenant='s own). Today this
-- hasn't leaked anything real -- confirmed live, the other two tenants
-- (Dhab Khushal, Dhab Kalan) have zero vehicles -- but the moment either
-- gets its first offers_hourly vehicle, every other tenant's riders
-- would see it with no opt-in at all, the exact opposite of what this
-- migration is building. Fixed here as the necessary foundation before
-- adding the real opt-in layer on top: own-tenant vehicles stay visible
-- unconditionally, another tenant's vehicles only show up when a live
-- marketplace_share_agreements row explicitly grants it for that exact
-- category.
--
-- Scoped to the 4 vehicle-browse RPCs this pass (hourly/shadi/rental/
-- machinery+tractor+loader via equipment_bookable_vehicles) -- shop
-- browsing is a direct client-side `.from('shops')` RLS read, not an
-- RPC, and dispatch/city-purchase is its own broadcast mechanism;
-- extending sharing to those is a natural follow-up using this same
-- pattern, not done here.

CREATE TABLE IF NOT EXISTS marketplace_share_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_tenant_id uuid NOT NULL REFERENCES tenants(id),
  category varchar NOT NULL CHECK (category IN ('hourly', 'shadi', 'rental', 'machinery', 'tractor', 'loader')),
  target_tenant_id uuid NOT NULL REFERENCES tenants(id) CHECK (target_tenant_id <> owner_tenant_id),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE (owner_tenant_id, category, target_tenant_id)
);
ALTER TABLE marketplace_share_agreements ENABLE ROW LEVEL SECURITY;
-- Any authenticated reader can see which agreements exist (needed so the
-- browse RPCs' own EXISTS check works, and so a rider's app can show
-- "N shared from nearby villages") -- only the owning tenant's admin can
-- write.
CREATE POLICY "marketplace_share_agreements_read" ON marketplace_share_agreements FOR SELECT TO authenticated USING (true);
CREATE POLICY "marketplace_share_agreements_write" ON marketplace_share_agreements FOR ALL TO authenticated
  USING (owner_tenant_id = my_tenant_id() AND current_admin_permission('manage_parties'))
  WITH CHECK (owner_tenant_id = my_tenant_id() AND current_admin_permission('manage_parties'));

CREATE OR REPLACE FUNCTION hourly_bookable_vehicles() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'color', v.color, 'model', v.model,
    'has_ac', v.has_ac, 'hourly_rate_pkr', v.hourly_rate_pkr, 'hourly_included_km', v.hourly_included_km,
    'hourly_overage_per_km_pkr', v.hourly_overage_per_km_pkr,
    'cover_url', (SELECT m.url FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.is_cover LIMIT 1),
    'avg_rating', (SELECT round(avg(r.stars)::numeric, 1) FROM ratings r WHERE r.target_party_type = 'vehicle' AND r.target_party_id = v.id),
    'shared_from_other_village', v.tenant_id <> my_tenant_id()
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
    'id', v.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'color', v.color, 'model', v.model, 'has_ac', v.has_ac,
    'shadi_full_day_rate_pkr', v.shadi_full_day_rate_pkr,
    'cover_url', (SELECT m.url FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.is_cover LIMIT 1),
    'avg_rating', (SELECT round(avg(r.stars)::numeric, 1) FROM ratings r WHERE r.target_party_type = 'vehicle' AND r.target_party_id = v.id),
    'shared_from_other_village', v.tenant_id <> my_tenant_id()
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
    'id', v.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'color', v.color, 'model', v.model,
    'rental_base_pkr', v.rental_base_pkr, 'rental_per_km_pkr', v.rental_per_km_pkr, 'rental_wait_hour_pkr', v.rental_wait_hour_pkr,
    'cover_url', (SELECT m.url FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.is_cover LIMIT 1),
    'avg_rating', (SELECT round(avg(r.stars)::numeric, 1) FROM ratings r WHERE r.target_party_type = 'vehicle' AND r.target_party_id = v.id),
    'shared_from_other_village', v.tenant_id <> my_tenant_id()
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
    'id', v.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'color', v.color, 'model', v.model,
    'machinery_hourly_rate_pkr', v.machinery_hourly_rate_pkr, 'machinery_min_hours', v.machinery_min_hours, 'machinery_mobilization_fee_pkr', v.machinery_mobilization_fee_pkr,
    'loader_trip_rate_pkr', v.loader_trip_rate_pkr,
    'cover_url', (SELECT m.url FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.is_cover LIMIT 1),
    'avg_rating', (SELECT round(avg(r.stars)::numeric, 1) FROM ratings r WHERE r.target_party_type = 'vehicle' AND r.target_party_id = v.id),
    'shared_from_other_village', v.tenant_id <> my_tenant_id(),
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
