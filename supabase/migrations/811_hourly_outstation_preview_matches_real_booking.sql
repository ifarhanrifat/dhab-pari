-- Migration 811: real bug, 2026-11-05 — "request is showing 1200 rs
-- but the driver received request is showing 2640... no checkbox of
-- outstation." Root cause: 808 made the server correctly auto-detect
-- outstation from real pickup/destination GPS distance whenever a
-- destination is pinned, overriding the rider's checkbox — but the
-- checkbox itself got HIDDEN once a destination is pinned (same
-- commit), and the rider-facing price PREVIEW only ever read that
-- checkbox, never the real GPS detection. So a rider pinning a far
-- destination saw the in-city estimate right up until submitting,
-- then got charged (and the driver saw) the real outstation rate —
-- two different numbers for the same booking, no warning either way.
--
-- Fix: pull the is-out-of-city decision logic out of
-- create_hourly_booking into its own function, and expose a thin,
-- tenant-scoped preview wrapper the booking FORM can call with the
-- same inputs the real booking will use — so the number shown before
-- submitting is guaranteed to be the number actually charged, by
-- construction, not by keeping two copies of the same logic in sync
-- by hand.

CREATE OR REPLACE FUNCTION hourly_booking_is_out_of_city(
  p_tenant_id uuid, p_pickup_lat decimal, p_pickup_lng decimal,
  p_destination_lat decimal, p_destination_lng decimal, p_is_outstation boolean
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_destination_lat IS NOT NULL AND p_destination_lng IS NOT NULL THEN
    RETURN fare_is_out_of_city(p_tenant_id, p_pickup_lat, p_pickup_lng)
      OR fare_is_out_of_city(p_tenant_id, p_destination_lat, p_destination_lng);
  ELSIF fare_is_out_of_city(p_tenant_id, p_pickup_lat, p_pickup_lng) THEN
    RETURN true;
  ELSE
    RETURN COALESCE(p_is_outstation, false);
  END IF;
END;
$$;

-- Client-facing preview: no tenant_id param (reads the caller's own
-- tenant via my_tenant_id(), same convention as every other rider-
-- facing quote RPC here) so the booking form can ask "would this be
-- outstation?" live, as the rider fills in pickup/destination, and
-- show the real rate before they ever tap submit.
CREATE OR REPLACE FUNCTION hourly_is_out_of_city_preview(
  p_pickup_lat decimal, p_pickup_lng decimal,
  p_destination_lat decimal DEFAULT NULL, p_destination_lng decimal DEFAULT NULL, p_is_outstation boolean DEFAULT false
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT hourly_booking_is_out_of_city(my_tenant_id(), p_pickup_lat, p_pickup_lng, p_destination_lat, p_destination_lng, p_is_outstation);
$$;
REVOKE ALL ON FUNCTION hourly_is_out_of_city_preview(decimal, decimal, decimal, decimal, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION hourly_is_out_of_city_preview(decimal, decimal, decimal, decimal, boolean) TO authenticated;

-- create_hourly_booking: same as 810 — only the is_out_of_city
-- determination now calls the shared function instead of repeating
-- the same IF/ELSIF/ELSE inline, so this and the preview above can
-- never drift apart again.
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
  v_is_out_of_city boolean; v_overage_per_km_pkr decimal; v_effective_hourly_rate_pkr decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_hours IS NULL OR p_hours < 2 THEN RAISE EXCEPTION 'Hourly bookings start at a minimum of 2 hours.' USING ERRCODE = 'P0001'; END IF;
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

  v_is_out_of_city := hourly_booking_is_out_of_city(v_tenant_id, p_pickup_lat, p_pickup_lng, p_destination_lat, p_destination_lng, p_is_outstation);

  v_overage_per_km_pkr := CASE WHEN v_is_out_of_city THEN COALESCE(g.out_of_city_per_km_pkr, g.hourly_overage_per_km_pkr) ELSE g.hourly_overage_per_km_pkr END;
  v_effective_hourly_rate_pkr := CASE
    WHEN v_is_out_of_city AND g.out_of_city_base_pkr IS NOT NULL AND g.rental_base_pkr > 0
      THEN round(g.hourly_rate_pkr * (g.out_of_city_base_pkr / g.rental_base_pkr))
    ELSE g.hourly_rate_pkr
  END;

  INSERT INTO hourly_bookings (
    portal_user_id, vehicle_id, hours, pickup_address, pickup_lat, pickup_lng, hourly_rate_pkr, included_km, overage_per_km_pkr, base_amount_pkr,
    notes, payment_method, destination_address, destination_lat, destination_lng, is_outstation, rental_tier, preferred_year
  ) VALUES (
    v_portal_user_id, NULL, p_hours, trim(p_pickup_address), p_pickup_lat, p_pickup_lng, v_effective_hourly_rate_pkr, g.hourly_included_km_per_hour * p_hours, v_overage_per_km_pkr, v_effective_hourly_rate_pkr * p_hours,
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
    p_hours || ' hour(s) — Rs ' || round(v_effective_hourly_rate_pkr * p_hours), '/portal/my-vehicle/hourly'
  FROM vehicles v
  WHERE v.rental_tier = p_rental_tier AND v.is_active AND v.offers_hourly AND v.tenant_id = v_tenant_id AND v.portal_user_id IS NOT NULL
    AND (v_exact_count = 0 OR v.model_year = p_preferred_year);

  RETURN v_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
