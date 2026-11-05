-- Migration 804: real bug, 2026-11-05 — worked out against the user's
-- own real example (a big_ac hourly booking covering a 220km round
-- trip to Rawalpindi, 7h30m total): Hourly still charges every km, in-
-- city or outstation, at the one flat hourly_overage_per_km_pkr rate.
-- For that exact trip Hourly comes out to roughly Rs 5,700 while the
-- identical physical trip booked as Rental (which already got the in-
-- city/out-of-city split in 797) comes out to roughly Rs 14,180 — a
-- 2.5x gap for the same vehicle doing the same real work. This is the
-- exact bug 797 already fixed for Rental one-way bookings ("no driver
-- takes a highway run at roughly half the going rate"), just not yet
-- fixed for Hourly.
--
-- Fix, same shape as 797: when a booking is out-of-city (pickup or
-- destination >8km from the tenant's home city — server-computed, not
-- trusted from the client, falling back to the rider's own
-- is_outstation checkbox only when no destination was pinned at all
-- so distance can't be measured), its overage-per-km switches to
-- rental_tier_fare_guides.out_of_city_per_km_pkr — the same real,
-- already-committee-reviewed number Rental's own out-of-city trips use
-- for this exact vehicle tier, per the user's explicit choice to reuse
-- it rather than invent a second rate card. The flat per-hour rate and
-- the included-km-per-hour allowance are untouched — only the cost of
-- km beyond that allowance changes for an outstation trip.
--
-- is_outstation already existed as a purely cosmetic, rider-declared
-- flag (786) with zero pricing effect; it now becomes the real,
-- authoritative driver of the overage rate end_hourly_trip (776)
-- already reads off the booking row at trip-end — no change needed
-- there at all.

CREATE OR REPLACE FUNCTION hourly_tier_options() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'tier_key', g.tier_key, 'vehicle_count', cnt.n,
    'hourly_rate_pkr', g.hourly_rate_pkr, 'hourly_included_km_per_hour', g.hourly_included_km_per_hour, 'hourly_overage_per_km_pkr', g.hourly_overage_per_km_pkr,
    'out_of_city_per_km_pkr', g.out_of_city_per_km_pkr
  ) ORDER BY g.display_order), '[]'::jsonb)
  FROM rental_tier_fare_guides g
  JOIN LATERAL (SELECT count(*) AS n FROM vehicles v WHERE v.rental_tier = g.tier_key AND v.is_active AND v.offers_hourly AND v.tenant_id = my_tenant_id()) cnt ON cnt.n > 0
  WHERE g.tenant_id = my_tenant_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- create_hourly_booking: same signature/validation/idempotency/
-- notification logic as 795 — only the overage-rate source and the
-- authoritativeness of is_outstation change.
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
  v_home_lat decimal; v_home_lng decimal; v_is_out_of_city boolean; v_overage_per_km_pkr decimal;
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

  SELECT lat, lng INTO v_home_lat, v_home_lng FROM cities WHERE tenant_id = v_tenant_id AND is_home_city LIMIT 1;
  IF v_home_lat IS NOT NULL AND p_pickup_lat IS NOT NULL AND p_pickup_lng IS NOT NULL THEN
    v_is_out_of_city := haversine_km(v_home_lat, v_home_lng, p_pickup_lat, p_pickup_lng) > 8;
    IF NOT v_is_out_of_city AND p_destination_lat IS NOT NULL AND p_destination_lng IS NOT NULL THEN
      v_is_out_of_city := haversine_km(v_home_lat, v_home_lng, p_destination_lat, p_destination_lng) > 8;
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
