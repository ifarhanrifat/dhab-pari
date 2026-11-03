-- Migration 792: real feedback, 2026-11-03, after seeing 791's numbers live.
--
-- 1. "there is car, small cars, big cars, etc what is this car? please
--    remove this car" — the generic 'car' category (707's original
--    seed row) was fully superseded by the small/big/AC split (749) and
--    the named-model rows (757, Mehran/Alto/Corolla). No UI anywhere
--    lets a driver pick it any more (registration/admin both offer the
--    granular tiers), so it's dead weight in the list. Deactivated,
--    not deleted — any already-registered vehicle (unlikely; it was
--    never offered after 749 shipped) keeps a valid category_id via FK,
--    committee can reactivate from the admin screen if ever needed.
UPDATE vehicle_categories SET is_active = false WHERE key = 'car';

-- 2. "if this fare will be kept increasing as per time if no driver is
--    accepting... we will decrease the per km rates in the cards so
--    that the starting fare will be more less than the current one" —
--    confirmed: escalate_stale_ride_dispatch_requests (788/789) already
--    raises an unaccepted request by +1/6, +1/3, then +1/2 of its
--    ORIGINAL fare (so it tops out at exactly +50%) before going flat.
--    791's numbers were calibrated to BE the real-market ceiling
--    (e.g. small car ~9,500 for 100km round trip) — so if that's the
--    ceiling, the starting ask should be the ceiling ÷ 1.5, letting
--    escalation do the climbing only when it's actually needed.
--    New-starting × 1.5 (max escalation) reproduces 791's numbers
--    almost exactly (small car: 330 + 30×km×2 → ×1.5 = 495 + 45×km×2,
--    i.e. 791's own 500/45 at the ceiling step).
UPDATE vehicle_categories SET out_of_city_base_fare_pkr = 130, out_of_city_per_km_pkr = 15
  WHERE key IN ('bike', 'electric_bike');
UPDATE vehicle_categories SET out_of_city_base_fare_pkr = 230, out_of_city_per_km_pkr = 25
  WHERE key IN ('rickshaw', 'electric_rickshaw');
UPDATE vehicle_categories SET out_of_city_base_fare_pkr = 330, out_of_city_per_km_pkr = 30
  WHERE key IN ('small_car_ac', 'small_car_non_ac', 'suzuki_mehran_ac', 'suzuki_mehran_non_ac', 'suzuki_alto');
UPDATE vehicle_categories SET out_of_city_base_fare_pkr = 470, out_of_city_per_km_pkr = 39
  WHERE key IN ('car', 'big_car_ac', 'big_car_non_ac', 'toyota_corolla', 'luxury');
UPDATE vehicle_categories SET out_of_city_base_fare_pkr = 600, out_of_city_per_km_pkr = 48
  WHERE key = 'suv';

-- 3. "outstation ride will have the hours limit so and so" — today
--    EVERY ride_dispatch_request (759) escalates on the same clock
--    (steps every 4 min, capped at 12 min) and expires at a flat 20
--    minutes regardless of type. That's reasonable for an in-city ride
--    (lots of nearby drivers) but too tight for an outstation one —
--    fewer drivers are willing/able to make a long trip, so it needs
--    more time to find the one who says yes. Outstation requests now
--    get their own, longer clock: escalation steps every 15 min
--    (reaching the +50% ceiling at 45 min) and a 60-minute expiry
--    instead of 20 — in-city requests are completely unchanged.
CREATE OR REPLACE FUNCTION escalate_stale_ride_dispatch_requests() RETURNS void AS $$
DECLARE r RECORD; v_new_fare decimal; v_step_minutes int;
BEGIN
  FOR r IN
    SELECT * FROM ride_dispatch_requests
    WHERE status = 'open' AND activated_at IS NOT NULL AND escalation_count < 3
    FOR UPDATE SKIP LOCKED
  LOOP
    v_step_minutes := CASE WHEN r.is_out_of_city THEN 15 ELSE 4 END;
    IF r.activated_at >= now() - (r.escalation_count + 1) * (v_step_minutes * interval '1 minute') THEN CONTINUE; END IF;

    -- +1/6, +1/3, +1/2 of the original fare — step 3 lands at exactly
    -- +50% and no further, regardless of rounding on earlier steps.
    v_new_fare := round(r.original_fare_pkr * (1 + (r.escalation_count + 1) / 6.0));
    UPDATE ride_dispatch_requests SET fare_pkr = v_new_fare, escalation_count = escalation_count + 1 WHERE id = r.id;

    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT v.portal_user_id, 'ride_dispatch_requested', 'Fare increased — ride still needs a driver',
      r.pickup_label || ' → ' || r.dropoff_label || ' — now Rs ' || v_new_fare::text,
      '/portal/marketplace/ride-dispatch/' || r.id
    FROM vehicles v
    WHERE v.category_id = ANY(r.category_ids) AND v.is_active AND v.portal_user_id IS NOT NULL
      AND (NOT r.is_out_of_city OR v.allows_out_of_city);
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION expire_stale_ride_dispatch_requests() RETURNS void AS $$
  UPDATE ride_dispatch_requests SET status = 'expired'
  WHERE status = 'open' AND activated_at IS NOT NULL
    AND activated_at < now() - (CASE WHEN is_out_of_city THEN interval '60 minutes' ELSE interval '20 minutes' END);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;
