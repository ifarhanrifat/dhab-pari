-- Migration 794: real feedback, 2026-11-03, after watching a live
-- outstation request sit unaccepted.
--
-- "this default fare is too low and this is why no driver will accept
-- and will not wait for 15 minutes to watch the increment" — correct,
-- and it overturns 792's own assumption. 792 reasoned that starting at
-- ceiling÷1.5 and letting escalate_stale_ride_dispatch_requests climb
-- to the real market rate over 45 minutes would let a driver volunteer
-- for less when they "really want to go there." In practice a driver
-- looks at the ONE number on the request right now and decides — they
-- don't bookmark a lowball offer and keep checking back every 15
-- minutes to see if it eventually becomes worth it. A slow climb on an
-- outstation route (where there are already few willing drivers to
-- begin with) just means the request sits dead until it expires at the
-- 60-minute mark.
--
-- Fix: the starting out-of-city rate IS the real market rate again —
-- back to 791's original numbers (these were the ones calibrated
-- against the Bykea screenshot at the very start of this work, e.g.
-- small car ~7,400-7,500 and big car ~9,000-9,600 for the distance
-- actually tested). Escalation (792's 15-min-step/60-min-expiry clock)
-- stays in place unchanged — it's just no longer the thing doing the
-- real pricing work, only a backstop for the rare case where even a
-- fair starting price sits unaccepted a while.
UPDATE vehicle_categories SET out_of_city_base_fare_pkr = 200, out_of_city_per_km_pkr = 22
  WHERE key IN ('bike', 'electric_bike');
UPDATE vehicle_categories SET out_of_city_base_fare_pkr = 350, out_of_city_per_km_pkr = 38
  WHERE key IN ('rickshaw', 'electric_rickshaw');
UPDATE vehicle_categories SET out_of_city_base_fare_pkr = 500, out_of_city_per_km_pkr = 45
  WHERE key IN ('small_car_ac', 'small_car_non_ac', 'suzuki_mehran_ac', 'suzuki_mehran_non_ac', 'suzuki_alto');
UPDATE vehicle_categories SET out_of_city_base_fare_pkr = 700, out_of_city_per_km_pkr = 58
  WHERE key IN ('car', 'big_car_ac', 'big_car_non_ac', 'toyota_corolla', 'luxury');
UPDATE vehicle_categories SET out_of_city_base_fare_pkr = 900, out_of_city_per_km_pkr = 72
  WHERE key = 'suv';
