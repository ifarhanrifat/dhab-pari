-- Migration 808: real bug found while answering "it's still Rs 300/hr
-- after your last deployment" — that case had no destination pinned at
-- all, which is correctly in-city by GPS... except the outstation
-- checkbox (p_is_outstation) was ALSO supposed to let a rider flag an
-- outstation trip when they don't know the exact destination address.
-- It never actually worked: create_hourly_booking's fallback to
-- p_is_outstation only ran inside the `ELSE` of "pickup coordinates are
-- missing" — but pickup is a required field with a map pin, so that
-- branch was unreachable in practice. The checkbox was always silently
-- ignored whenever a destination wasn't pinned, which is exactly the
-- one case it exists for.
--
-- Fix: fall back to the rider's own declaration specifically when
-- there's no destination to measure against AND the pickup point
-- itself doesn't already prove it's out of city — not only when
-- coordinates are missing outright.

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

  -- A destination to measure against beats everything — real GPS truth,
  -- same as before. Without one, a pickup that's already provably out
  -- of city wins on its own; only when neither signal exists does the
  -- rider's own checkbox decide, which is the one real case it's for.
  IF p_destination_lat IS NOT NULL AND p_destination_lng IS NOT NULL THEN
    v_is_out_of_city := fare_is_out_of_city(v_tenant_id, p_pickup_lat, p_pickup_lng)
      OR fare_is_out_of_city(v_tenant_id, p_destination_lat, p_destination_lng);
  ELSIF fare_is_out_of_city(v_tenant_id, p_pickup_lat, p_pickup_lng) THEN
    v_is_out_of_city := true;
  ELSE
    v_is_out_of_city := COALESCE(p_is_outstation, false);
  END IF;

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
