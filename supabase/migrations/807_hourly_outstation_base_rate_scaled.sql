-- Migration 807: real ask, 2026-11-05, direct follow-up to 804/806 —
-- "why is this vehicle showing Rs 300/hr fare?" 804 only switched the
-- overage-per-km rate for an outstation Hourly booking; the flat per-
-- hour price stayed the same as an in-city booking. Rental's own in-
-- city/out-of-city split (797) doesn't just raise the per-km rate, it
-- also raises the BASE fee (small_ac: Rs 250 in-city -> Rs 550 out-of-
-- city, roughly 2.2x) — Hourly's per-hour rate never got the
-- equivalent treatment.
--
-- Fix, per explicit choice: scale the tier's own hourly_rate_pkr by
-- the same ratio Rental's own base fee jumps for that tier
-- (out_of_city_base_pkr / rental_base_pkr) rather than inventing a
-- brand new outstation hourly rate card — reuses a real, already-
-- committee-reviewed number the same way 804 already reused
-- out_of_city_per_km_pkr for the overage rate. For most tiers this
-- ratio is 2.0-2.2x.
--
-- Stored directly into the booking's own hourly_rate_pkr column at
-- creation time (same column end_hourly_trip's overtime math already
-- reads), so overtime billing on an outstation trip automatically
-- scales too — no change needed there.

CREATE OR REPLACE FUNCTION hourly_tier_options() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'tier_key', g.tier_key, 'vehicle_count', cnt.n,
    'hourly_rate_pkr', g.hourly_rate_pkr, 'hourly_included_km_per_hour', g.hourly_included_km_per_hour, 'hourly_overage_per_km_pkr', g.hourly_overage_per_km_pkr,
    'out_of_city_per_km_pkr', g.out_of_city_per_km_pkr,
    'out_of_city_hourly_rate_pkr', round(g.hourly_rate_pkr * (g.out_of_city_base_pkr / NULLIF(g.rental_base_pkr, 0)))
  ) ORDER BY g.display_order), '[]'::jsonb)
  FROM rental_tier_fare_guides g
  JOIN LATERAL (SELECT count(*) AS n FROM vehicles v WHERE v.rental_tier = g.tier_key AND v.is_active AND v.offers_hourly AND v.tenant_id = my_tenant_id()) cnt ON cnt.n > 0
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

  IF p_pickup_lat IS NOT NULL AND p_pickup_lng IS NOT NULL THEN
    v_is_out_of_city := fare_is_out_of_city(v_tenant_id, p_pickup_lat, p_pickup_lng);
    IF NOT v_is_out_of_city AND p_destination_lat IS NOT NULL AND p_destination_lng IS NOT NULL THEN
      v_is_out_of_city := fare_is_out_of_city(v_tenant_id, p_destination_lat, p_destination_lng);
    END IF;
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
