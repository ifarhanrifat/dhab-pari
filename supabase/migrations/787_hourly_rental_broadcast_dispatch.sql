-- Migration 787: real, sharp correction, 2026-11-03 — "when i chose a
-- vehicle category then there will be dozens or maybe hundreds of
-- vehicles on that catalog, how will the rider choose between them?
-- ... the purpose of these online taxi systems is to send the calls to
-- all drivers who are nearby so everyone gets a chance for their jobs
-- ... we can't allow the rider to pick up a separate vehicle from the
-- catalog, it will be unjustifying — only shadi vehicles work this way,
-- which is already existing."
--
-- 786 wired Hourly into the same category-then-pick-a-specific-vehicle
-- pattern Car Rental already had — but that pattern itself is wrong for
-- both verticals: a rider who can see a ranked list always picks
-- whoever's listed first, so the driver at the bottom of a long list
-- never gets a job. Real ride-hailing apps broadcast a category request
-- to every matching driver and let whoever accepts first win — exactly
-- what this app's own ride_dispatch flow (746+) already does. Shadi is
-- the one deliberate, confirmed exception: a wedding booking genuinely
-- needs a SPECIFIC decorated car and a known driver, not a blind match
-- — left completely untouched.
--
-- This migration converts Hourly and point-to-point Rental to that
-- same broadcast model:
--   1. Rider picks a category tile (as 786 already does) and an
--      optional preferred vehicle model year.
--   2. The request goes out with NO vehicle assigned yet
--      (hourly_bookings.vehicle_id / rental_bookings.vehicle_id is now
--      nullable) — every active, offers_hourly/offers_rental vehicle
--      in that tier is notified.
--   3. If any vehicle in the tier has that exact model_year, only
--      those are notified; if none exist, every vehicle in the tier is
--      notified instead ("top/nearby models" — approximated as "the
--      whole tier" rather than a fragile nearest-year ranking, honest
--      given how small a village fleet actually is).
--   4. First driver to accept (respond_hourly_booking/
--      respond_rental_booking) wins — same FOR UPDATE race-safe pattern
--      accept_ride_dispatch already uses — and the booking is priced
--      at the TIER'S OWN fare-guide rate (786's rental_tier_fare_guides),
--      locked at request time, the same for whoever accepts. This also
--      resolves a real fairness question: every vehicle in a tier
--      previously had its own committee-set rate, which would have
--      made "which price applies" ambiguous once several vehicles can
--      accept the same request — now the price is fixed before anyone
--      accepts, same discipline ride_dispatch's category rate card
--      already has.
-- Everything downstream of acceptance — PIN, live-GPS billing
-- (hourly), start/end, settlement, My Bookings, the driver's
-- LifecycleBookingsList — is completely unchanged; only how a booking
-- gets its first vehicle assigned has changed.

-- A vehicle's real model year — never collected anywhere before.
-- Driver-editable (like color/model, not committee-gated like rate
-- cards): a vehicle's year is a plain fact its owner already knows,
-- not a pricing decision.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS model_year int
  CHECK (model_year IS NULL OR (model_year >= 1980 AND model_year <= extract(year FROM now())::int + 1));

CREATE OR REPLACE FUNCTION set_vehicle_catalog_prefs(
  p_vehicle_id uuid, p_color text, p_model text, p_has_ac boolean, p_offers_hourly boolean, p_offers_shadi boolean,
  p_offers_rental boolean DEFAULT NULL::boolean, p_shadi_vehicle_class character varying DEFAULT NULL::character varying,
  p_rental_tier character varying DEFAULT NULL::character varying, p_model_year int DEFAULT NULL
) RETURNS void AS $$
DECLARE v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF p_offers_hourly AND v.hourly_rate_pkr IS NULL THEN
    RAISE EXCEPTION 'Ask the committee to set your hourly rate before turning this on.' USING ERRCODE = 'P0001';
  END IF;
  IF p_offers_shadi AND v.shadi_full_day_rate_pkr IS NULL THEN
    RAISE EXCEPTION 'Ask the committee to set your full-day wedding rate before turning this on.' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(p_offers_rental, false) AND (v.rental_base_pkr IS NULL OR v.rental_per_km_pkr IS NULL) THEN
    RAISE EXCEPTION 'Ask the committee to set your rental rate before turning this on.' USING ERRCODE = 'P0001';
  END IF;
  IF p_shadi_vehicle_class IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM shadi_vehicle_classes WHERE class_key = p_shadi_vehicle_class AND is_active) THEN
      RAISE EXCEPTION 'Unknown vehicle type.' USING ERRCODE = 'P0001';
    END IF;
    IF (p_shadi_vehicle_class = 'hiace' AND v.vehicle_type NOT ILIKE '%hiace%')
      OR (p_shadi_vehicle_class = 'bolan' AND v.vehicle_type NOT ILIKE '%bolan%')
      OR (p_shadi_vehicle_class = 'sedan' AND (v.vehicle_type ILIKE '%hiace%' OR v.vehicle_type ILIKE '%bolan%'))
    THEN
      RAISE EXCEPTION 'This wedding-vehicle category doesn''t match your registered vehicle (%). Ask the committee if you think this is wrong.', v.vehicle_type USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF p_rental_tier IS NOT NULL AND p_rental_tier NOT IN ('small_ac', 'small_non_ac', 'big_ac', 'big_non_ac', 'suv', 'luxury', 'van', 'hiace', 'coaster', 'bus') THEN
    RAISE EXCEPTION 'Unknown rental category.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicles SET
    color = NULLIF(trim(p_color), ''), model = NULLIF(trim(p_model), ''),
    has_ac = p_has_ac, offers_hourly = p_offers_hourly, offers_shadi = p_offers_shadi,
    offers_rental = COALESCE(p_offers_rental, offers_rental),
    shadi_vehicle_class = CASE WHEN p_shadi_vehicle_class IS NOT NULL THEN p_shadi_vehicle_class ELSE shadi_vehicle_class END,
    rental_tier = CASE WHEN p_rental_tier IS NOT NULL THEN p_rental_tier ELSE rental_tier END,
    model_year = COALESCE(p_model_year, model_year)
  WHERE id = p_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Real production-data concern: rental_tier was only ever assigned by
-- an admin for the Car Rental vertical (714) — a real, already-active
-- hourly vehicle may never have gotten one, which would silently drop
-- it out of every future broadcast. One-time backfill from the
-- vehicle's own category_id, same mapping 781 already used for the
-- ride-dispatch groups.
UPDATE vehicles v SET rental_tier = (
  SELECT CASE
    WHEN c.key IN ('small_car_ac', 'suzuki_mehran_ac', 'suzuki_alto') THEN 'small_ac'
    WHEN c.key IN ('small_car_non_ac', 'suzuki_mehran_non_ac') THEN 'small_non_ac'
    WHEN c.key IN ('big_car_ac', 'toyota_corolla') THEN 'big_ac'
    WHEN c.key = 'big_car_non_ac' THEN 'big_non_ac'
    WHEN c.key = 'luxury' THEN 'luxury'
    WHEN c.key = 'suv' THEN 'suv'
    WHEN c.key IN ('van', 'suzuki_ravi', 'suzuki_carry_dabba') THEN 'van'
    ELSE NULL
  END
  FROM vehicle_categories c WHERE c.id = v.category_id
)
WHERE v.rental_tier IS NULL AND (v.offers_hourly OR v.offers_rental) AND v.category_id IS NOT NULL;

-- Both booking tables: a request can now exist with no vehicle
-- assigned yet (the broadcast's "open" state) — carries its own
-- rental_tier/preferred_year instead of inheriting them from a chosen
-- vehicle.
ALTER TABLE hourly_bookings ALTER COLUMN vehicle_id DROP NOT NULL;
ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS rental_tier varchar;
ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS preferred_year int;

ALTER TABLE rental_bookings ALTER COLUMN vehicle_id DROP NOT NULL;
ALTER TABLE rental_bookings ADD COLUMN IF NOT EXISTS rental_tier varchar;
ALTER TABLE rental_bookings ADD COLUMN IF NOT EXISTS preferred_year int;

-- Real browse-step read: per tier, how many vehicles actually exist
-- and what the tier's own locked fare-guide rate is — no per-vehicle
-- data needed any more, since the price is fixed before anyone accepts.
CREATE OR REPLACE FUNCTION hourly_tier_options() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'tier_key', g.tier_key, 'vehicle_count', cnt.n,
    'hourly_rate_pkr', g.hourly_rate_pkr, 'hourly_included_km_per_hour', g.hourly_included_km_per_hour, 'hourly_overage_per_km_pkr', g.hourly_overage_per_km_pkr
  ) ORDER BY g.display_order), '[]'::jsonb)
  FROM rental_tier_fare_guides g
  JOIN LATERAL (SELECT count(*) AS n FROM vehicles v WHERE v.rental_tier = g.tier_key AND v.is_active AND v.offers_hourly AND v.tenant_id = my_tenant_id()) cnt ON cnt.n > 0;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION hourly_tier_options() TO authenticated, anon;

CREATE OR REPLACE FUNCTION rental_tier_options() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'tier_key', g.tier_key, 'vehicle_count', cnt.n,
    'rental_base_pkr', g.rental_base_pkr, 'rental_per_km_pkr', g.rental_per_km_pkr, 'rental_wait_hour_pkr', g.rental_wait_hour_pkr
  ) ORDER BY g.display_order), '[]'::jsonb)
  FROM rental_tier_fare_guides g
  JOIN LATERAL (SELECT count(*) AS n FROM vehicles v WHERE v.rental_tier = g.tier_key AND v.is_active AND v.offers_rental AND v.tenant_id = my_tenant_id()) cnt ON cnt.n > 0;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION rental_tier_options() TO authenticated, anon;

-- create_hourly_booking: now a broadcast by (tier, preferred_year), not
-- a request to one chosen vehicle. Old 11-arg per-vehicle signature
-- from 786 dropped.
DROP FUNCTION IF EXISTS create_hourly_booking(uuid, int, text, decimal, decimal, text, varchar, text, decimal, decimal, boolean);
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
  SELECT * INTO g FROM rental_tier_fare_guides WHERE tier_key = p_rental_tier;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown vehicle category.' USING ERRCODE = 'P0001'; END IF;

  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE rental_tier = p_rental_tier AND is_active AND offers_hourly AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'No vehicles in this category are available right now.' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotency guard, same discipline 715 already added for rental.
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

  -- Exact year match if one exists anywhere in the tier; otherwise the
  -- whole tier — "top models or nearby year models" approximated
  -- honestly rather than a fragile nearest-year ranking.
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
REVOKE ALL ON FUNCTION create_hourly_booking(varchar, int, text, decimal, decimal, int, text, varchar, text, decimal, decimal, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_hourly_booking(varchar, int, text, decimal, decimal, int, text, varchar, text, decimal, decimal, boolean) TO authenticated;

-- respond_hourly_booking: branches on whether this is still an open
-- broadcast (vehicle_id IS NULL — the new path, first-accept-wins,
-- Accept only, no Decline) or an already-assigned booking (any row
-- that predates this migration, or a future single-target use —
-- behaves exactly as it always did).
CREATE OR REPLACE FUNCTION respond_hourly_booking(p_booking_id uuid, p_accept boolean) RETURNS void AS $$
DECLARE b hourly_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;

  IF b.vehicle_id IS NULL THEN
    IF NOT p_accept THEN RAISE EXCEPTION 'This request is open to every matching driver — there is nothing to decline, just leave it to someone else.' USING ERRCODE = 'P0001'; END IF;
    IF b.status <> 'requested' THEN RAISE EXCEPTION 'Someone else already accepted this request.' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO v FROM vehicles WHERE portal_user_id = current_portal_user_id() AND rental_tier = b.rental_tier AND is_active AND offers_hourly;
    IF NOT FOUND THEN RAISE EXCEPTION 'This request is not for your vehicle category.' USING ERRCODE = 'P0001'; END IF;

    UPDATE hourly_bookings SET vehicle_id = v.id, status = 'accepted', responded_at = now(), pin = lpad(floor(random() * 10000)::text, 4, '0')
    WHERE id = p_booking_id AND vehicle_id IS NULL AND status = 'requested';
    IF NOT FOUND THEN RAISE EXCEPTION 'Someone else already accepted this request.' USING ERRCODE = 'P0001'; END IF;

    PERFORM ensure_booking_thread('hourly_booking', p_booking_id, v.id, b.portal_user_id, trim(coalesce(v.model, v.vehicle_type)) || ' — ' || b.hours || 'h');
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (b.portal_user_id, 'hourly_booking_accepted', 'Booking accepted', v.owner_name || ' will pick you up.', '/portal/marketplace');
    RETURN;
  END IF;

  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'requested' THEN RAISE EXCEPTION 'This booking has already been responded to.' USING ERRCODE = 'P0001'; END IF;

  UPDATE hourly_bookings SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END, responded_at = now() WHERE id = p_booking_id;
  IF NOT p_accept THEN PERFORM close_booking_thread('hourly_booking', p_booking_id, 'declined'); END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, CASE WHEN p_accept THEN 'hourly_booking_accepted' ELSE 'hourly_booking_declined' END,
    CASE WHEN p_accept THEN 'Booking accepted' ELSE 'Booking declined' END,
    CASE WHEN p_accept THEN v.owner_name || ' will pick you up.' ELSE 'This vehicle is not available for your booking.' END,
    '/portal/marketplace');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION respond_hourly_booking(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION respond_hourly_booking(uuid, boolean) TO authenticated;

-- vehicle_hourly_bookings: union of (a) bookings already assigned to
-- this vehicle and (b) open broadcast requests this vehicle is
-- eligible for (same exact-year-else-whole-tier rule as the
-- notification step above, evaluated live so a vehicle that only just
-- turned online/active still sees what's waiting).
CREATE OR REPLACE FUNCTION vehicle_hourly_bookings(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_result jsonb; v_tier varchar; v_year int; v_tenant uuid;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT rental_tier, model_year, tenant_id INTO v_tier, v_year, v_tenant FROM vehicles WHERE id = p_vehicle_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'hours', b.hours, 'status', b.status, 'pickup_address', b.pickup_address, 'pickup_lat', b.pickup_lat, 'pickup_lng', b.pickup_lng, 'decline_reason', b.decline_reason,
    'destination_address', b.destination_address, 'is_outstation', b.is_outstation, 'vehicle_id', b.vehicle_id,
    'base_amount_pkr', b.base_amount_pkr, 'total_amount_pkr', b.total_amount_pkr, 'distance_km', b.distance_km,
    'included_km', b.included_km, 'overage_km', b.overage_km, 'overage_amount_pkr', b.overage_amount_pkr,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at, 'status_confirmed', b.status_confirmed,
    'notes', b.notes, 'payment_method', b.payment_method,
    'customer_portal_user_id', pu.id, 'customer_name', pu.full_name, 'customer_mobile', pu.mobile, 'customer_trust', portal_user_trust(pu.id)
  ) ORDER BY b.requested_at DESC), '[]'::jsonb) INTO v_result
  FROM hourly_bookings b JOIN portal_users pu ON pu.id = b.portal_user_id
  WHERE b.vehicle_id = p_vehicle_id
    OR (
      b.vehicle_id IS NULL AND b.status = 'requested' AND b.rental_tier = v_tier AND v_tier IS NOT NULL
      AND (
        b.preferred_year IS NULL OR v_year = b.preferred_year
        OR NOT EXISTS (SELECT 1 FROM vehicles v2 WHERE v2.rental_tier = b.rental_tier AND v2.is_active AND v2.offers_hourly AND v2.tenant_id = v_tenant AND v2.model_year = b.preferred_year)
      )
    );
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_hourly_bookings(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_hourly_bookings(uuid) TO authenticated;

-- my_hourly_bookings: LEFT JOIN now (vehicle may not be assigned yet).
CREATE OR REPLACE FUNCTION my_hourly_bookings() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'hours', b.hours, 'status', b.status, 'pickup_address', b.pickup_address, 'pickup_lat', b.pickup_lat, 'pickup_lng', b.pickup_lng,
    'destination_address', b.destination_address, 'destination_lat', b.destination_lat, 'destination_lng', b.destination_lng, 'is_outstation', b.is_outstation,
    'base_amount_pkr', b.base_amount_pkr, 'total_amount_pkr', b.total_amount_pkr, 'distance_km', b.distance_km,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at, 'pin', b.pin, 'notes', b.notes, 'payment_method', b.payment_method,
    'decline_reason', b.decline_reason, 'rental_tier', b.rental_tier,
    'vehicle_id', b.vehicle_id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color,
    'category_name', vc.name, 'category_name_ur', vc.name_ur
  ) ORDER BY b.requested_at DESC), '[]'::jsonb)
  FROM hourly_bookings b LEFT JOIN vehicles v ON v.id = b.vehicle_id LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
  WHERE b.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_hourly_bookings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_hourly_bookings() TO authenticated;

-- ═════════════════════════ Rental (point-to-point) ═════════════════════════

DROP FUNCTION IF EXISTS create_rental_booking(uuid, text, decimal, decimal, text, decimal, decimal, varchar, int, text, varchar);
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
  SELECT * INTO g FROM rental_tier_fare_guides WHERE tier_key = p_rental_tier;
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
REVOKE ALL ON FUNCTION create_rental_booking(varchar, text, decimal, decimal, text, decimal, decimal, varchar, int, int, text, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_rental_booking(varchar, text, decimal, decimal, text, decimal, decimal, varchar, int, int, text, varchar) TO authenticated;

CREATE OR REPLACE FUNCTION respond_rental_booking(p_booking_id uuid, p_accept boolean, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE b rental_bookings%ROWTYPE; v vehicles%ROWTYPE;
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
REVOKE ALL ON FUNCTION respond_rental_booking(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION respond_rental_booking(uuid, boolean, text) TO authenticated;

CREATE OR REPLACE FUNCTION vehicle_rental_bookings(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_result jsonb; v_tier varchar; v_year int; v_tenant uuid;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT rental_tier, model_year, tenant_id INTO v_tier, v_year, v_tenant FROM vehicles WHERE id = p_vehicle_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'from_address', b.from_address, 'from_lat', b.from_lat, 'from_lng', b.from_lng,
    'to_address', b.to_address, 'to_lat', b.to_lat, 'to_lng', b.to_lng, 'trip_type', b.trip_type, 'wait_hours', b.wait_hours, 'vehicle_id', b.vehicle_id,
    'km', b.km, 'status', b.status, 'decline_reason', b.decline_reason,
    'base_amount_pkr', b.base_amount_pkr, 'trip_amount_pkr', b.trip_amount_pkr, 'wait_amount_pkr', b.wait_amount_pkr, 'total_amount_pkr', b.total_amount_pkr, 'status_confirmed', b.status_confirmed,
    'notes', b.notes, 'payment_method', b.payment_method,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'customer_portal_user_id', pu.id, 'customer_name', pu.full_name, 'customer_mobile', pu.mobile, 'customer_trust', portal_user_trust(pu.id)
  ) ORDER BY b.requested_at DESC), '[]'::jsonb) INTO v_result
  FROM rental_bookings b JOIN portal_users pu ON pu.id = b.portal_user_id
  WHERE b.vehicle_id = p_vehicle_id
    OR (
      b.vehicle_id IS NULL AND b.status = 'requested' AND b.rental_tier = v_tier AND v_tier IS NOT NULL
      AND (
        b.preferred_year IS NULL OR v_year = b.preferred_year
        OR NOT EXISTS (SELECT 1 FROM vehicles v2 WHERE v2.rental_tier = b.rental_tier AND v2.is_active AND v2.offers_rental AND v2.tenant_id = v_tenant AND v2.model_year = b.preferred_year)
      )
    );
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_rental_bookings(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_rental_bookings(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION my_rental_bookings() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'from_address', b.from_address, 'from_lat', b.from_lat, 'from_lng', b.from_lng,
    'to_address', b.to_address, 'to_lat', b.to_lat, 'to_lng', b.to_lng, 'trip_type', b.trip_type, 'wait_hours', b.wait_hours,
    'km', b.km, 'status', b.status, 'decline_reason', b.decline_reason, 'pin', b.pin,
    'base_amount_pkr', b.base_amount_pkr, 'trip_amount_pkr', b.trip_amount_pkr, 'wait_amount_pkr', b.wait_amount_pkr, 'total_amount_pkr', b.total_amount_pkr,
    'notes', b.notes, 'payment_method', b.payment_method, 'rental_tier', b.rental_tier,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'vehicle_id', b.vehicle_id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color,
    'category_name', vc.name, 'category_name_ur', vc.name_ur
  ) ORDER BY b.requested_at DESC), '[]'::jsonb)
  FROM rental_bookings b LEFT JOIN vehicles v ON v.id = b.vehicle_id LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
  WHERE b.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_rental_bookings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_rental_bookings() TO authenticated;
