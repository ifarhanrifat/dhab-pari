-- Migration 795: real gap found while analyzing the Travel vs Rental
-- duplication question, 2026-11-03.
--
-- rental_tier_fare_guides (786) started as "a suggestion next to the
-- blank rate box" for a driver typing their own vehicle's rate. 787
-- then made it the actual, binding, locked-at-request-time price for
-- every Hourly and Rental booking — but never finished the move:
-- 1. It has no tenant_id. One global rate for all 10 tiers, shared by
--    EVERY village on the platform — unlike every other committee rate
--    card (vehicle_categories, fare_bands, service_fare_policies),
--    which is correctly per-tenant. A single committee editing "SUV"
--    would silently reprice SUV rentals for every other village too.
-- 2. It has a read policy but no write policy at all, and no RPC to
--    update it — meaning no admin, anywhere, in any village, has ever
--    had a way to change these numbers since the one-time seed insert.
--    Exactly the "admin staff can't define what we need to put there"
--    complaint this whole cleanup pass has been about, just on a table
--    that hadn't been looked at yet.
--
-- Fix: give it a tenant_id (one row per tenant per tier, seeded by
-- copying today's global numbers to every existing tenant), scope the
-- read policy the same way vehicle_categories already is, and add the
-- missing admin-write policy so the new marketplace-reference tab
-- (next commit) can actually save changes.

ALTER TABLE rental_tier_fare_guides ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id);

-- Must drop the old single-column PK (tier_key) before inserting the
-- per-tenant rows below — otherwise every tenant after the first hits
-- a duplicate-key error on the same tier_key, exactly what happened on
-- the first attempt at this migration.
ALTER TABLE rental_tier_fare_guides DROP CONSTRAINT IF EXISTS rental_tier_fare_guides_pkey;

INSERT INTO rental_tier_fare_guides (tenant_id, tier_key, display_order, hourly_rate_pkr, hourly_included_km_per_hour, hourly_overage_per_km_pkr, rental_base_pkr, rental_per_km_pkr, rental_wait_hour_pkr)
SELECT t.id, g.tier_key, g.display_order, g.hourly_rate_pkr, g.hourly_included_km_per_hour, g.hourly_overage_per_km_pkr, g.rental_base_pkr, g.rental_per_km_pkr, g.rental_wait_hour_pkr
FROM tenants t
CROSS JOIN (SELECT * FROM rental_tier_fare_guides WHERE tenant_id IS NULL) g;

DELETE FROM rental_tier_fare_guides WHERE tenant_id IS NULL;

ALTER TABLE rental_tier_fare_guides ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE rental_tier_fare_guides ADD PRIMARY KEY (tenant_id, tier_key);

DROP POLICY IF EXISTS "rental_tier_fare_guides_read" ON rental_tier_fare_guides;
CREATE POLICY "rental_tier_fare_guides_read" ON rental_tier_fare_guides FOR SELECT TO authenticated, anon
  USING (tenant_id = COALESCE(request_tenant_id(), my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid));
CREATE POLICY "rental_tier_fare_guides_admin_write" ON rental_tier_fare_guides FOR ALL TO authenticated
  USING (tenant_id = my_tenant_id() AND current_admin_permission('manage_parties'))
  WITH CHECK (tenant_id = my_tenant_id() AND current_admin_permission('manage_parties'));

-- Every reader/writer of this table now needs a tenant filter —
-- previously implicit (the table only ever had one row per tier_key).
CREATE OR REPLACE FUNCTION rental_tier_fare_guides_list() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'tier_key', tier_key, 'hourly_rate_pkr', hourly_rate_pkr, 'hourly_included_km_per_hour', hourly_included_km_per_hour,
    'hourly_overage_per_km_pkr', hourly_overage_per_km_pkr, 'rental_base_pkr', rental_base_pkr, 'rental_per_km_pkr', rental_per_km_pkr,
    'rental_wait_hour_pkr', rental_wait_hour_pkr
  ) ORDER BY display_order), '[]'::jsonb)
  FROM rental_tier_fare_guides WHERE tenant_id = my_tenant_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION hourly_tier_options() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'tier_key', g.tier_key, 'vehicle_count', cnt.n,
    'hourly_rate_pkr', g.hourly_rate_pkr, 'hourly_included_km_per_hour', g.hourly_included_km_per_hour, 'hourly_overage_per_km_pkr', g.hourly_overage_per_km_pkr
  ) ORDER BY g.display_order), '[]'::jsonb)
  FROM rental_tier_fare_guides g
  JOIN LATERAL (SELECT count(*) AS n FROM vehicles v WHERE v.rental_tier = g.tier_key AND v.is_active AND v.offers_hourly AND v.tenant_id = my_tenant_id()) cnt ON cnt.n > 0
  WHERE g.tenant_id = my_tenant_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION rental_tier_options() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'tier_key', g.tier_key, 'vehicle_count', cnt.n,
    'rental_base_pkr', g.rental_base_pkr, 'rental_per_km_pkr', g.rental_per_km_pkr, 'rental_wait_hour_pkr', g.rental_wait_hour_pkr
  ) ORDER BY g.display_order), '[]'::jsonb)
  FROM rental_tier_fare_guides g
  JOIN LATERAL (SELECT count(*) AS n FROM vehicles v WHERE v.rental_tier = g.tier_key AND v.is_active AND v.offers_rental AND v.tenant_id = my_tenant_id()) cnt ON cnt.n > 0
  WHERE g.tenant_id = my_tenant_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION create_hourly_booking(
  p_rental_tier varchar, p_hours int, p_pickup_address text, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL,
  p_preferred_year int DEFAULT NULL, p_notes text DEFAULT NULL, p_payment_method varchar DEFAULT 'cash',
  p_destination_address text DEFAULT NULL, p_destination_lat decimal DEFAULT NULL, p_destination_lng decimal DEFAULT NULL, p_is_outstation boolean DEFAULT false
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_tenant_id uuid;
  g rental_tier_fare_guides%ROWTYPE;
  v_booking_id uuid;
  v_exact_count int;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_hours IS NULL OR p_hours <= 0 THEN RAISE EXCEPTION 'Enter how many hours you need.' USING ERRCODE = 'P0001'; END IF;
  IF p_pickup_address IS NULL OR trim(p_pickup_address) = '' THEN RAISE EXCEPTION 'Enter a pickup address.' USING ERRCODE = 'P0001'; END IF;

  SELECT tenant_id INTO v_tenant_id FROM portal_users WHERE id = v_portal_user_id;
  SELECT * INTO g FROM rental_tier_fare_guides WHERE tier_key = p_rental_tier AND tenant_id = v_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown vehicle category.' USING ERRCODE = 'P0001'; END IF;

  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE rental_tier = p_rental_tier AND is_active AND offers_hourly AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'No vehicles in this category are available right now.' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_booking_id FROM hourly_bookings
  WHERE portal_user_id = v_portal_user_id AND rental_tier = p_rental_tier AND status = 'requested' AND vehicle_id IS NULL
    AND pickup_address = trim(p_pickup_address) AND hours = p_hours AND requested_at > now() - interval '2 minutes'
  ORDER BY requested_at DESC LIMIT 1;
  IF v_booking_id IS NOT NULL THEN RETURN v_booking_id; END IF;

  INSERT INTO hourly_bookings (
    portal_user_id, vehicle_id, hours, pickup_address, pickup_lat, pickup_lng, hourly_rate_pkr, included_km, overage_per_km_pkr, base_amount_pkr,
    notes, payment_method, destination_address, destination_lat, destination_lng, is_outstation, rental_tier, preferred_year
  ) VALUES (
    v_portal_user_id, NULL, p_hours, trim(p_pickup_address), p_pickup_lat, p_pickup_lng, g.hourly_rate_pkr, g.hourly_included_km_per_hour * p_hours, g.hourly_overage_per_km_pkr, g.hourly_rate_pkr * p_hours,
    NULLIF(trim(p_notes), ''), COALESCE(p_payment_method, 'cash'), NULLIF(trim(p_destination_address), ''), p_destination_lat, p_destination_lng, COALESCE(p_is_outstation, false), p_rental_tier, p_preferred_year
  )
  RETURNING id INTO v_booking_id;

  IF p_preferred_year IS NOT NULL THEN
    SELECT count(*) INTO v_exact_count FROM vehicles WHERE rental_tier = p_rental_tier AND is_active AND offers_hourly AND tenant_id = v_tenant_id AND model_year = p_preferred_year;
  ELSE
    v_exact_count := 0;
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'hourly_booking_requested', 'Hourly rental request',
    p_hours || ' hour(s) — Rs ' || round(g.hourly_rate_pkr * p_hours), '/portal/my-vehicle/hourly'
  FROM vehicles v
  WHERE v.rental_tier = p_rental_tier AND v.is_active AND v.offers_hourly AND v.tenant_id = v_tenant_id AND v.portal_user_id IS NOT NULL
    AND (v_exact_count = 0 OR v.model_year = p_preferred_year);

  RETURN v_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION create_rental_booking(
  p_rental_tier varchar, p_from_address text, p_from_lat decimal, p_from_lng decimal,
  p_to_address text, p_to_lat decimal, p_to_lng decimal, p_trip_type varchar, p_wait_hours int DEFAULT 0,
  p_preferred_year int DEFAULT NULL, p_notes text DEFAULT NULL, p_payment_method varchar DEFAULT 'cash'
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_tenant_id uuid;
  g rental_tier_fare_guides%ROWTYPE;
  v_km decimal; v_trip_amount decimal; v_wait_amount decimal; v_total decimal;
  v_booking_id uuid;
  v_exact_count int;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_trip_type NOT IN ('one', 'return') THEN RAISE EXCEPTION 'Choose one-way or return.' USING ERRCODE = 'P0001'; END IF;
  IF p_from_address IS NULL OR trim(p_from_address) = '' THEN RAISE EXCEPTION 'Enter a pickup location.' USING ERRCODE = 'P0001'; END IF;
  IF p_to_address IS NULL OR trim(p_to_address) = '' THEN RAISE EXCEPTION 'Enter a destination.' USING ERRCODE = 'P0001'; END IF;
  IF p_from_lat IS NULL OR p_from_lng IS NULL OR p_to_lat IS NULL OR p_to_lng IS NULL THEN
    RAISE EXCEPTION 'Pin both the pickup and destination on the map.' USING ERRCODE = 'P0001';
  END IF;
  IF p_wait_hours IS NULL OR p_wait_hours < 0 THEN p_wait_hours := 0; END IF;

  SELECT tenant_id INTO v_tenant_id FROM portal_users WHERE id = v_portal_user_id;
  SELECT * INTO g FROM rental_tier_fare_guides WHERE tier_key = p_rental_tier AND tenant_id = v_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown vehicle category.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE rental_tier = p_rental_tier AND is_active AND offers_rental AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'No vehicles in this category are available right now.' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_booking_id FROM rental_bookings
  WHERE portal_user_id = v_portal_user_id AND rental_tier = p_rental_tier AND status = 'requested' AND vehicle_id IS NULL
    AND trip_type = p_trip_type AND from_address = trim(p_from_address) AND to_address = trim(p_to_address)
    AND requested_at > now() - interval '2 minutes'
  ORDER BY requested_at DESC LIMIT 1;
  IF v_booking_id IS NOT NULL THEN RETURN v_booking_id; END IF;

  v_km := greatest(1, round(haversine_km(p_from_lat, p_from_lng, p_to_lat, p_to_lng) * 1.3));
  v_trip_amount := round(CASE WHEN p_trip_type = 'return' THEN v_km * 2 * g.rental_per_km_pkr ELSE v_km * g.rental_per_km_pkr * 1.5 END, 2);
  v_wait_amount := CASE WHEN p_trip_type = 'return' THEN p_wait_hours * COALESCE(g.rental_wait_hour_pkr, 0) ELSE 0 END;
  v_total := g.rental_base_pkr + v_trip_amount + v_wait_amount;

  INSERT INTO rental_bookings (
    portal_user_id, vehicle_id, from_address, from_lat, from_lng, to_address, to_lat, to_lng,
    trip_type, wait_hours, km, base_amount_pkr, trip_amount_pkr, wait_amount_pkr, total_amount_pkr, notes, payment_method, rental_tier, preferred_year
  ) VALUES (
    v_portal_user_id, NULL, trim(p_from_address), p_from_lat, p_from_lng, trim(p_to_address), p_to_lat, p_to_lng,
    p_trip_type, p_wait_hours, v_km, g.rental_base_pkr, v_trip_amount, v_wait_amount, v_total, NULLIF(trim(p_notes), ''), COALESCE(p_payment_method, 'cash'), p_rental_tier, p_preferred_year
  ) RETURNING id INTO v_booking_id;

  IF p_preferred_year IS NOT NULL THEN
    SELECT count(*) INTO v_exact_count FROM vehicles WHERE rental_tier = p_rental_tier AND is_active AND offers_rental AND tenant_id = v_tenant_id AND model_year = p_preferred_year;
  ELSE
    v_exact_count := 0;
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'rental_booking_requested', 'Vehicle rental request',
    round(v_km) || 'km ' || (CASE WHEN p_trip_type = 'return' THEN 'return' ELSE 'one-way' END) || ' — Rs ' || round(v_total), '/portal/my-vehicle/rental'
  FROM vehicles v
  WHERE v.rental_tier = p_rental_tier AND v.is_active AND v.offers_rental AND v.tenant_id = v_tenant_id AND v.portal_user_id IS NOT NULL
    AND (v_exact_count = 0 OR v.model_year = p_preferred_year);

  RETURN v_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- New: the admin-facing update RPC the marketplace-reference "Rental &
-- Hourly" tab (next commit) calls. A plain table UPDATE from the
-- client would also work under the new RLS policy, but a dedicated RPC
-- keeps the "which 6 numbers belong to this tier" contract explicit
-- and matches the validation discipline every other admin write here
-- already has, instead of a bare .update(form) relying only on RLS.
CREATE OR REPLACE FUNCTION admin_update_rental_tier_fare_guide(
  p_tier_key varchar, p_hourly_rate_pkr decimal, p_hourly_included_km_per_hour decimal, p_hourly_overage_per_km_pkr decimal,
  p_rental_base_pkr decimal, p_rental_per_km_pkr decimal, p_rental_wait_hour_pkr decimal
) RETURNS void AS $$
DECLARE v_tenant_id uuid := my_tenant_id();
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN
    RAISE EXCEPTION 'You do not have permission to edit rate cards.' USING ERRCODE = 'P0001';
  END IF;
  IF p_hourly_rate_pkr < 0 OR p_hourly_included_km_per_hour < 0 OR p_hourly_overage_per_km_pkr < 0
    OR p_rental_base_pkr < 0 OR p_rental_per_km_pkr < 0 OR p_rental_wait_hour_pkr < 0 THEN
    RAISE EXCEPTION 'Rates cannot be negative.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE rental_tier_fare_guides SET
    hourly_rate_pkr = p_hourly_rate_pkr, hourly_included_km_per_hour = p_hourly_included_km_per_hour, hourly_overage_per_km_pkr = p_hourly_overage_per_km_pkr,
    rental_base_pkr = p_rental_base_pkr, rental_per_km_pkr = p_rental_per_km_pkr, rental_wait_hour_pkr = p_rental_wait_hour_pkr
  WHERE tenant_id = v_tenant_id AND tier_key = p_tier_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown vehicle tier.' USING ERRCODE = 'P0001'; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION admin_update_rental_tier_fare_guide(varchar, decimal, decimal, decimal, decimal, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_update_rental_tier_fare_guide(varchar, decimal, decimal, decimal, decimal, decimal, decimal) TO authenticated;
