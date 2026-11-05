-- Migration 806: real ask, 2026-11-05 — "we have map boundary saved
-- in the backend for home village and home city I think" — correct,
-- and Rental (797) and Hourly (804) weren't using it. Both determined
-- in-city vs outstation with a hardcoded "more than 8km from one
-- lat/lng point" proxy (cities.is_home_city), completely ignoring the
-- real per-tenant village boundary already drawn in
-- tenant_service_zones (zone_kind='village' — either a circle with its
-- own configured radius_km, or a hand-drawn polygon for an irregular
-- shape, reusable via point_in_tenant_zone, 754). A village bigger
-- than 8km in some direction could have a perfectly ordinary in-
-- village trip wrongly billed at the outstation rate; a village
-- smaller than 8km somewhere could undercharge a trip that's already
-- left it.
--
-- (Travel/ride_dispatch's own is_out_of_city, 760, is unaffected by
-- this — it's decided by picking a destination city from the cities
-- table and reading that city's own is_home_city flag, not by
-- distance math, so there's no boundary-precision question there.)
--
-- Fix: a shared helper that checks the real configured village zone
-- first, and only falls back to the flat 8km-from-the-home-city-point
-- proxy for a tenant that's never drawn a village zone at all —
-- today's exact behaviour is preserved for anyone who hasn't set one
-- up yet, nothing regresses for them.

CREATE OR REPLACE FUNCTION fare_is_out_of_city(p_tenant_id uuid, p_lat decimal, p_lng decimal) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_has_zone boolean; v_home_lat decimal; v_home_lng decimal;
BEGIN
  IF p_lat IS NULL OR p_lng IS NULL THEN RETURN false; END IF;

  SELECT EXISTS (SELECT 1 FROM tenant_service_zones WHERE tenant_id = p_tenant_id AND zone_kind = 'village' AND is_active) INTO v_has_zone;
  IF v_has_zone THEN
    RETURN NOT point_in_tenant_zone(p_lat, p_lng, p_tenant_id, 'village');
  END IF;

  SELECT lat, lng INTO v_home_lat, v_home_lng FROM cities WHERE tenant_id = p_tenant_id AND is_home_city LIMIT 1;
  IF v_home_lat IS NULL THEN RETURN false; END IF;
  RETURN haversine_km(v_home_lat, v_home_lng, p_lat, p_lng) > 8;
END;
$$;

-- create_rental_booking: same as 797 — only the is_out_of_city source changes.
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
  v_is_out_of_city boolean := false;
  v_base_pkr decimal; v_per_km_pkr decimal;
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

  v_is_out_of_city := fare_is_out_of_city(v_tenant_id, p_from_lat, p_from_lng) OR fare_is_out_of_city(v_tenant_id, p_to_lat, p_to_lng);
  v_base_pkr := CASE WHEN v_is_out_of_city THEN COALESCE(g.out_of_city_base_pkr, g.rental_base_pkr) ELSE g.rental_base_pkr END;
  v_per_km_pkr := CASE WHEN v_is_out_of_city THEN COALESCE(g.out_of_city_per_km_pkr, g.rental_per_km_pkr) ELSE g.rental_per_km_pkr END;

  v_km := greatest(1, round(haversine_km(p_from_lat, p_from_lng, p_to_lat, p_to_lng) * 1.3));
  v_trip_amount := round(CASE WHEN p_trip_type = 'return' THEN v_km * 2 * v_per_km_pkr ELSE v_km * v_per_km_pkr * 1.5 END, 2);
  v_wait_amount := CASE WHEN p_trip_type = 'return' THEN p_wait_hours * COALESCE(g.rental_wait_hour_pkr, 0) ELSE 0 END;
  v_total := v_base_pkr + v_trip_amount + v_wait_amount;

  INSERT INTO rental_bookings (
    portal_user_id, vehicle_id, from_address, from_lat, from_lng, to_address, to_lat, to_lng,
    trip_type, wait_hours, km, base_amount_pkr, trip_amount_pkr, wait_amount_pkr, total_amount_pkr, notes, payment_method, rental_tier, preferred_year, is_out_of_city
  ) VALUES (
    v_portal_user_id, NULL, trim(p_from_address), p_from_lat, p_from_lng, trim(p_to_address), p_to_lat, p_to_lng,
    p_trip_type, p_wait_hours, v_km, v_base_pkr, v_trip_amount, v_wait_amount, v_total, NULLIF(trim(p_notes), ''), COALESCE(p_payment_method, 'cash'), p_rental_tier, p_preferred_year, v_is_out_of_city
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

-- create_hourly_booking: same as 804 — only the is_out_of_city source changes.
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
  v_is_out_of_city boolean; v_overage_per_km_pkr decimal;
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

  IF p_pickup_lat IS NOT NULL AND p_pickup_lng IS NOT NULL THEN
    v_is_out_of_city := fare_is_out_of_city(v_tenant_id, p_pickup_lat, p_pickup_lng);
    IF NOT v_is_out_of_city AND p_destination_lat IS NOT NULL AND p_destination_lng IS NOT NULL THEN
      v_is_out_of_city := fare_is_out_of_city(v_tenant_id, p_destination_lat, p_destination_lng);
    END IF;
  ELSE
    v_is_out_of_city := COALESCE(p_is_outstation, false);
  END IF;
  v_overage_per_km_pkr := CASE WHEN v_is_out_of_city THEN COALESCE(g.out_of_city_per_km_pkr, g.hourly_overage_per_km_pkr) ELSE g.hourly_overage_per_km_pkr END;

  INSERT INTO hourly_bookings (
    portal_user_id, vehicle_id, hours, pickup_address, pickup_lat, pickup_lng, hourly_rate_pkr, included_km, overage_per_km_pkr, base_amount_pkr,
    notes, payment_method, destination_address, destination_lat, destination_lng, is_outstation, rental_tier, preferred_year
  ) VALUES (
    v_portal_user_id, NULL, p_hours, trim(p_pickup_address), p_pickup_lat, p_pickup_lng, g.hourly_rate_pkr, g.hourly_included_km_per_hour * p_hours, v_overage_per_km_pkr, g.hourly_rate_pkr * p_hours,
    NULLIF(trim(p_notes), ''), COALESCE(p_payment_method, 'cash'), NULLIF(trim(p_destination_address), ''), p_destination_lat, p_destination_lng, v_is_out_of_city, p_rental_tier, p_preferred_year
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
