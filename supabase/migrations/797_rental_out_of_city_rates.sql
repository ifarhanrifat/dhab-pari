-- Migration 797: real ask, 2026-11-04 — "this is still looking garbage
-- way... fare is almost half of what marketplace/travel vehicles are
-- getting."
--
-- Root cause (traced against the real seed data in 786, confirmed by
-- back-solving the user's actual on-screen numbers to the exact km):
-- rental_tier_fare_guides has a single flat per-km rate, calibrated for
-- short in-city hire-and-wait use where the base fare + wait charge
-- dominate. Rental's booking flow never checks distance at all, so
-- that same cheap rate silently applies to an 83km outstation trip too
-- — Rs 16-18/km vs vehicle_categories' (Travel's) out-of-city Rs 45-72/km
-- for the identical physical trip. No driver takes a highway run at
-- roughly half the going rate, which is also why 796's return-offer
-- bridge sits on a booking no one will ever accept for long trips.
--
-- Fix: give rental_tier_fare_guides the same in-city/out-of-city rate
-- split vehicle_categories already has (760), and have
-- create_rental_booking switch to it whenever either endpoint is more
-- than 8km from the tenant's home city — the same threshold and the
-- same "is this actually a highway trip" question Travel's own
-- destFarFromCity nudge already asks, just evaluated server-side
-- against real coordinates instead of client-side against the nearest
-- known city. In-city rental/hire-and-wait pricing (the table's actual
-- original purpose) is untouched.

ALTER TABLE rental_tier_fare_guides ADD COLUMN IF NOT EXISTS out_of_city_base_pkr decimal;
ALTER TABLE rental_tier_fare_guides ADD COLUMN IF NOT EXISTS out_of_city_per_km_pkr decimal;

-- Seeded from vehicle_categories' real out-of-city numbers (794) where
-- a direct size match exists (big_ac/van -> "big car" 700/58, suv ->
-- suv 900/72), scaled proportionally by the same ratio the in-city
-- flat rates already use for everything above a car's size (hiace/
-- coaster/bus have no Travel equivalent to borrow from). Admin-editable
-- from here on, same as every other committee rate card.
UPDATE rental_tier_fare_guides SET out_of_city_base_pkr = 500, out_of_city_per_km_pkr = 45 WHERE tier_key = 'small_non_ac';
UPDATE rental_tier_fare_guides SET out_of_city_base_pkr = 550, out_of_city_per_km_pkr = 48 WHERE tier_key = 'small_ac';
UPDATE rental_tier_fare_guides SET out_of_city_base_pkr = 650, out_of_city_per_km_pkr = 55 WHERE tier_key = 'big_non_ac';
UPDATE rental_tier_fare_guides SET out_of_city_base_pkr = 700, out_of_city_per_km_pkr = 58 WHERE tier_key = 'big_ac';
UPDATE rental_tier_fare_guides SET out_of_city_base_pkr = 900, out_of_city_per_km_pkr = 72 WHERE tier_key = 'suv';
UPDATE rental_tier_fare_guides SET out_of_city_base_pkr = 1200, out_of_city_per_km_pkr = 85 WHERE tier_key = 'luxury';
UPDATE rental_tier_fare_guides SET out_of_city_base_pkr = 700, out_of_city_per_km_pkr = 58 WHERE tier_key = 'van';
UPDATE rental_tier_fare_guides SET out_of_city_base_pkr = 1000, out_of_city_per_km_pkr = 84 WHERE tier_key = 'hiace';
UPDATE rental_tier_fare_guides SET out_of_city_base_pkr = 2000, out_of_city_per_km_pkr = 130 WHERE tier_key = 'coaster';
UPDATE rental_tier_fare_guides SET out_of_city_base_pkr = 3600, out_of_city_per_km_pkr = 180 WHERE tier_key = 'bus';

ALTER TABLE rental_tier_fare_guides ALTER COLUMN out_of_city_base_pkr SET NOT NULL;
ALTER TABLE rental_tier_fare_guides ALTER COLUMN out_of_city_per_km_pkr SET NOT NULL;

-- Real flag instead of the km>25 proxy 796's return-offer trigger used
-- — also lets the booking lists (rider + driver) label a trip as
-- outstation instead of silently applying a different rate with no
-- on-screen explanation.
ALTER TABLE rental_bookings ADD COLUMN IF NOT EXISTS is_out_of_city boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION rental_tier_fare_guides_list() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'tier_key', tier_key, 'hourly_rate_pkr', hourly_rate_pkr, 'hourly_included_km_per_hour', hourly_included_km_per_hour,
    'hourly_overage_per_km_pkr', hourly_overage_per_km_pkr, 'rental_base_pkr', rental_base_pkr, 'rental_per_km_pkr', rental_per_km_pkr,
    'rental_wait_hour_pkr', rental_wait_hour_pkr, 'out_of_city_base_pkr', out_of_city_base_pkr, 'out_of_city_per_km_pkr', out_of_city_per_km_pkr
  ) ORDER BY display_order), '[]'::jsonb)
  FROM rental_tier_fare_guides WHERE tenant_id = my_tenant_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION rental_tier_options() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'tier_key', g.tier_key, 'vehicle_count', cnt.n,
    'rental_base_pkr', g.rental_base_pkr, 'rental_per_km_pkr', g.rental_per_km_pkr, 'rental_wait_hour_pkr', g.rental_wait_hour_pkr,
    'out_of_city_base_pkr', g.out_of_city_base_pkr, 'out_of_city_per_km_pkr', g.out_of_city_per_km_pkr
  ) ORDER BY g.display_order), '[]'::jsonb)
  FROM rental_tier_fare_guides g
  JOIN LATERAL (SELECT count(*) AS n FROM vehicles v WHERE v.rental_tier = g.tier_key AND v.is_active AND v.offers_rental AND v.tenant_id = my_tenant_id()) cnt ON cnt.n > 0
  WHERE g.tenant_id = my_tenant_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- create_rental_booking: unchanged validation/idempotency/notification
-- logic — only the rate source changes, picked per-trip instead of
-- always reading the flat in-city numbers off the guide row.
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
  v_is_out_of_city boolean := false; v_home_lat decimal; v_home_lng decimal;
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

  SELECT lat, lng INTO v_home_lat, v_home_lng FROM cities WHERE tenant_id = v_tenant_id AND is_home_city LIMIT 1;
  IF v_home_lat IS NOT NULL THEN
    v_is_out_of_city := haversine_km(v_home_lat, v_home_lng, p_from_lat, p_from_lng) > 8
      OR haversine_km(v_home_lat, v_home_lng, p_to_lat, p_to_lng) > 8;
  END IF;
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

-- respond_rental_booking: same body as 796, except the return-offer
-- trigger now reads the real is_out_of_city flag instead of the km>25
-- proxy, and the discounted return-seat fare is priced off the same
-- out-of-city per-km rate the original trip was actually charged —
-- otherwise the "discount" would look absurd next to the now-correct
-- one-way fare (cheap in-city rate vs. the real highway rate).
CREATE OR REPLACE FUNCTION respond_rental_booking(p_booking_id uuid, p_accept boolean, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE
  b rental_bookings%ROWTYPE; v vehicles%ROWTYPE; g rental_tier_fare_guides%ROWTYPE;
  v_offer_id uuid; v_home_lat decimal; v_home_lng decimal; v_return_per_km decimal;
BEGIN
  SELECT * INTO b FROM rental_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;

  IF b.vehicle_id IS NULL THEN
    IF NOT p_accept THEN RAISE EXCEPTION 'This request is open to every matching driver — there is nothing to decline, just leave it to someone else.' USING ERRCODE = 'P0001'; END IF;
    IF b.status <> 'requested' THEN RAISE EXCEPTION 'Someone else already accepted this request.' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO v FROM vehicles WHERE portal_user_id = current_portal_user_id() AND rental_tier = b.rental_tier AND is_active AND offers_rental;
    IF NOT FOUND THEN RAISE EXCEPTION 'This request is not for your vehicle category.' USING ERRCODE = 'P0001'; END IF;

    UPDATE rental_bookings SET vehicle_id = v.id, status = 'accepted', responded_at = now(), pin = lpad(floor(random() * 10000)::text, 4, '0')
    WHERE id = p_booking_id AND vehicle_id IS NULL AND status = 'requested';
    IF NOT FOUND THEN RAISE EXCEPTION 'Someone else already accepted this request.' USING ERRCODE = 'P0001'; END IF;

    PERFORM ensure_booking_thread('rental_booking', p_booking_id, v.id, b.portal_user_id, trim(coalesce(v.model, v.vehicle_type)) || ' — ' || b.to_address);
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (b.portal_user_id, 'rental_booking_accepted', 'Booking accepted', v.owner_name || ' will pick you up.', '/portal/marketplace');

    IF b.trip_type = 'one' AND b.is_out_of_city THEN
      SELECT * INTO g FROM rental_tier_fare_guides WHERE tier_key = b.rental_tier AND tenant_id = v.tenant_id;
      v_return_per_km := COALESCE(g.out_of_city_per_km_pkr, g.rental_per_km_pkr, 0);
      INSERT INTO rental_return_offers (
        source_booking_id, vehicle_id, tenant_id, rental_tier, from_address, from_lat, from_lng,
        to_address, to_lat, to_lng, km, per_seat_fare_pkr, total_seats, expected_arrival_at
      ) VALUES (
        b.id, v.id, v.tenant_id, b.rental_tier, b.to_address, b.to_lat, b.to_lng,
        b.from_address, b.from_lat, b.from_lng, b.km, round(v_return_per_km * b.km),
        rental_tier_seat_capacity(b.rental_tier), now() + (b.km / 45.0) * interval '1 hour'
      ) RETURNING id INTO v_offer_id;

      SELECT lat, lng INTO v_home_lat, v_home_lng FROM cities WHERE tenant_id = v.tenant_id AND is_home_city LIMIT 1;
      IF v_home_lat IS NOT NULL THEN
        INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
        SELECT DISTINCT r.initiator_portal_user_id, 'rental_return_offer_available',
          '🔄 A vehicle is heading your way', 'A ' || b.rental_tier || ' will reach ' || b.to_address || ' around ' ||
          to_char(now() + (b.km / 45.0) * interval '1 hour', 'HH12:MI AM') || ' — book a discounted ride back.',
          '/portal/marketplace/travel?goHomeOffer=' || v_offer_id
        FROM ride_dispatch_requests r
        WHERE r.status = 'open' AND r.is_out_of_city
          AND haversine_km(r.pickup_lat, r.pickup_lng, b.to_lat, b.to_lng) < 15
          AND haversine_km(r.dropoff_lat, r.dropoff_lng, v_home_lat, v_home_lng) < 15
        LIMIT 20;
      END IF;
    END IF;
    RETURN;
  END IF;

  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'requested' THEN RAISE EXCEPTION 'This booking has already been responded to.' USING ERRCODE = 'P0001'; END IF;

  UPDATE rental_bookings SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END,
    responded_at = now(), decline_reason = CASE WHEN p_accept THEN NULL ELSE p_reason END
  WHERE id = p_booking_id;
  IF NOT p_accept THEN PERFORM close_booking_thread('rental_booking', p_booking_id, 'declined'); END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, CASE WHEN p_accept THEN 'rental_booking_accepted' ELSE 'rental_booking_declined' END,
    CASE WHEN p_accept THEN 'Booking accepted' ELSE 'Booking declined' END,
    CASE WHEN p_accept THEN v.owner_name || ' will pick you up.'
      ELSE 'This vehicle is not available for your booking.' || COALESCE(' — ' || p_reason, '') END,
    '/portal/marketplace');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Admin rate-card editor now covers 2 more numbers per tier — signature
-- change, so the old 7-arg version must be dropped explicitly.
DROP FUNCTION IF EXISTS admin_update_rental_tier_fare_guide(varchar, decimal, decimal, decimal, decimal, decimal, decimal);
CREATE OR REPLACE FUNCTION admin_update_rental_tier_fare_guide(
  p_tier_key varchar, p_hourly_rate_pkr decimal, p_hourly_included_km_per_hour decimal, p_hourly_overage_per_km_pkr decimal,
  p_rental_base_pkr decimal, p_rental_per_km_pkr decimal, p_rental_wait_hour_pkr decimal,
  p_out_of_city_base_pkr decimal, p_out_of_city_per_km_pkr decimal
) RETURNS void AS $$
DECLARE v_tenant_id uuid := my_tenant_id();
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN
    RAISE EXCEPTION 'You do not have permission to edit rate cards.' USING ERRCODE = 'P0001';
  END IF;
  IF p_hourly_rate_pkr < 0 OR p_hourly_included_km_per_hour < 0 OR p_hourly_overage_per_km_pkr < 0
    OR p_rental_base_pkr < 0 OR p_rental_per_km_pkr < 0 OR p_rental_wait_hour_pkr < 0
    OR p_out_of_city_base_pkr < 0 OR p_out_of_city_per_km_pkr < 0 THEN
    RAISE EXCEPTION 'Rates cannot be negative.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE rental_tier_fare_guides SET
    hourly_rate_pkr = p_hourly_rate_pkr, hourly_included_km_per_hour = p_hourly_included_km_per_hour, hourly_overage_per_km_pkr = p_hourly_overage_per_km_pkr,
    rental_base_pkr = p_rental_base_pkr, rental_per_km_pkr = p_rental_per_km_pkr, rental_wait_hour_pkr = p_rental_wait_hour_pkr,
    out_of_city_base_pkr = p_out_of_city_base_pkr, out_of_city_per_km_pkr = p_out_of_city_per_km_pkr
  WHERE tenant_id = v_tenant_id AND tier_key = p_tier_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown vehicle tier.' USING ERRCODE = 'P0001'; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION admin_update_rental_tier_fare_guide(varchar, decimal, decimal, decimal, decimal, decimal, decimal, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_update_rental_tier_fare_guide(varchar, decimal, decimal, decimal, decimal, decimal, decimal, decimal, decimal) TO authenticated;
