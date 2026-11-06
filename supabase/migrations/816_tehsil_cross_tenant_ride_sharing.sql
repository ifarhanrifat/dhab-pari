-- Migration 816: real ask, 2026-11-06 — "local" means the main city
-- or into the villages of the same tehsil. Every village here is its
-- own fully isolated tenant; the only cross-tenant mechanism
-- (marketplace_share_agreements, 667) never covered Routes/Adda/
-- trip-sharing. This adds a tehsil grouping + lets a rider discover
-- and book a same-tehsil neighbouring village's route/trip-share.
--
-- Found and fixed along the way: place_ride_booking/book_adda_seat/
-- book_trip_offer are all SECURITY DEFINER with NO tenant check at all
-- today — any rider who already knew another tenant's route_id could
-- book it with zero gate. The share-agreement check added below closes
-- that pre-existing gap, not just enables the new feature.
--
-- Also found: ride_bookings_keeper_read never covered adda_queue_entry_id
-- bookings at all (only checked via vehicle_routes) -- a pre-existing,
-- same-tenant gap, fixed here while this exact policy is being touched.

-- ═══ 1. Tehsil schema ═══
CREATE TABLE tehsils (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar NOT NULL,
  name_ur varchar,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE tehsils ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tehsils_read" ON tehsils FOR SELECT TO authenticated USING (true);
CREATE POLICY "tehsils_platform_write" ON tehsils FOR ALL TO authenticated
  USING (is_platform_admin()) WITH CHECK (is_platform_admin());

ALTER TABLE tenants ADD COLUMN tehsil_id uuid REFERENCES tehsils(id);

-- ═══ 2. Widen marketplace_share_agreements (667/751) for Routes/Adda/trip-sharing ═══
ALTER TABLE marketplace_share_agreements DROP CONSTRAINT IF EXISTS marketplace_share_agreements_category_check;
ALTER TABLE marketplace_share_agreements ADD CONSTRAINT marketplace_share_agreements_category_check
  CHECK (category IN ('hourly', 'shadi', 'rental', 'machinery', 'tractor', 'loader', 'ride_dispatch', 'route', 'adda', 'trip_share'));

-- The first reusable helper for this check — every consumer before this
-- (9+ call sites) inlined its own copy of this exact EXISTS subquery.
CREATE OR REPLACE FUNCTION has_share_agreement(p_owner_tenant_id uuid, p_target_tenant_id uuid, p_category varchar) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM marketplace_share_agreements
    WHERE owner_tenant_id = p_owner_tenant_id AND target_tenant_id = p_target_tenant_id AND category = p_category AND is_active
  );
$$;

-- Platform-admin action (not a live trigger, matching the existing
-- admin-curated-not-silent sharing convention) -- bidirectional, one
-- call per tehsil whenever a tenant is assigned/reassigned to it.
CREATE OR REPLACE FUNCTION sync_tehsil_share_agreements(p_tehsil_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cat varchar; v_a uuid; v_b uuid;
BEGIN
  IF NOT is_platform_admin() THEN RAISE EXCEPTION 'Platform admin access required.' USING ERRCODE = '42501'; END IF;
  FOR v_a IN SELECT id FROM tenants WHERE tehsil_id = p_tehsil_id LOOP
    FOR v_b IN SELECT id FROM tenants WHERE tehsil_id = p_tehsil_id AND id != v_a LOOP
      FOREACH v_cat IN ARRAY ARRAY['route', 'adda', 'trip_share'] LOOP
        INSERT INTO marketplace_share_agreements (owner_tenant_id, category, target_tenant_id, is_active)
        VALUES (v_a, v_cat, v_b, true)
        ON CONFLICT (owner_tenant_id, category, target_tenant_id) DO UPDATE SET is_active = true;
      END LOOP;
    END LOOP;
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION sync_tehsil_share_agreements(uuid) TO authenticated;

-- ═══ 3. RLS widening — strictly self/FK-ownership only, never broader ═══
-- ride_bookings/vehicle_trip_bookings default tenant_id to whichever
-- party's session wrote the row (rider for a direct booking, driver for
-- a ride-dispatch accept) -- so a cross-tenant booking's tenant_id can
-- land on EITHER side depending on who called the insert. Both the
-- rider's own-row read and the driver's own-route/vehicle read need the
-- tenant_id requirement dropped, kept to ownership only, to be correct
-- in both directions. This also fixes the already-live ride-dispatch
-- cross-tenant tracking bug found this session (not just the new case).
ALTER POLICY "ride_bookings_portal_read_own" ON ride_bookings
  USING (portal_user_id = current_portal_user_id());

ALTER POLICY "ride_bookings_keeper_read" ON ride_bookings
  USING (
    EXISTS (SELECT 1 FROM vehicle_routes r JOIN vehicles v ON v.id = r.vehicle_id WHERE r.id = ride_bookings.route_id AND v.portal_user_id = current_portal_user_id())
    OR EXISTS (SELECT 1 FROM adda_queue_entries e JOIN vehicles v ON v.id = e.vehicle_id WHERE e.id = ride_bookings.adda_queue_entry_id AND v.portal_user_id = current_portal_user_id())
  );

ALTER POLICY "trip_bookings_rider_read" ON vehicle_trip_bookings
  USING (portal_user_id = current_portal_user_id());

ALTER POLICY "trip_bookings_driver_read" ON vehicle_trip_bookings
  USING (EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_trip_bookings.vehicle_id AND v.portal_user_id = current_portal_user_id()));

-- ═══ 4. Booking RPCs — close the pre-existing no-gate-at-all hole, and
-- allow it through specifically for an active share agreement ═══
CREATE OR REPLACE FUNCTION place_ride_booking(
  p_route_id uuid, p_travel_date date, p_seats int, p_method varchar, p_proof_url text
) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE;
  v_vehicle vehicles%ROWTYPE;
  v_available int;
  v_total decimal;
  v_per_seat decimal;
  v_seats_booked_so_far int;
  v_booking_id uuid;
  v_weekday int;
  v_commission_pct decimal;
  v_expected_commission decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND OR NOT v_route.is_active THEN RAISE EXCEPTION 'Route not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;

  IF v_vehicle.tenant_id != my_tenant_id() AND NOT has_share_agreement(v_vehicle.tenant_id, my_tenant_id(), 'route') THEN
    RAISE EXCEPTION 'This route is not shared with your village yet.' USING ERRCODE = 'P0001';
  END IF;

  IF p_seats IS NULL OR p_seats <= 0 THEN RAISE EXCEPTION 'Pick at least one seat.' USING ERRCODE = 'P0001'; END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;

  v_weekday := extract(dow FROM p_travel_date)::int;
  IF NOT (v_weekday = ANY(v_route.days_of_week)) THEN
    RAISE EXCEPTION 'This route does not run on that day.' USING ERRCODE = 'P0001';
  END IF;

  v_available := route_seats_available(p_route_id, p_travel_date);
  IF p_seats > v_available THEN
    RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001';
  END IF;

  IF v_route.fare_mode = 'flex' THEN
    SELECT COALESCE(SUM(seats), 0) INTO v_seats_booked_so_far FROM ride_bookings
      WHERE route_id = p_route_id AND travel_date = p_travel_date AND status IN ('announced', 'confirmed');
    v_per_seat := v_route.total_fare_pkr / (v_seats_booked_so_far + p_seats);
    v_total := p_seats * v_per_seat;
  ELSE
    v_total := p_seats * v_route.fare_per_seat_pkr;
  END IF;

  IF v_vehicle.commission_mode = 'monthly_lumpsum' THEN
    IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  ELSE
    IF NOT v_vehicle.is_active THEN
      RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings — try another one.' USING ERRCODE = 'P0001';
    END IF;
    v_commission_pct := vehicle_commission_pct(v_vehicle.vehicle_type, v_route.classification);
    v_expected_commission := round(v_total * v_commission_pct / 100, 2);
    IF seller_account_balance(ensure_vehicle_account(v_vehicle.id)) < v_expected_commission THEN
      RAISE EXCEPTION 'This vehicle''s wallet balance is too low to cover this booking''s commission — the driver needs to top up first.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO ride_bookings (route_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at)
  VALUES (p_route_id, v_portal_user_id, p_travel_date, p_seats, v_total, 'announced', v_total, p_method, p_proof_url, now())
  RETURNING id INTO v_booking_id;

  IF v_vehicle.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_vehicle.portal_user_id, 'route_seat_booked', 'New seat booked on your route',
      p_seats || ' seat(s) for ' || to_char(p_travel_date, 'DD Mon') || ' — Rs ' || round(v_total), '/portal/my-vehicle/routes');
  END IF;

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION book_adda_seat(p_entry_id uuid, p_seats int, p_method varchar, p_proof_url text) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  e adda_queue_entries%ROWTYPE; v vehicles%ROWTYPE; v_available int; v_total decimal; v_booking_id uuid;
  v_commission_pct decimal; v_expected_commission decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id;
  IF NOT FOUND OR e.status NOT IN ('waiting', 'current') THEN RAISE EXCEPTION 'This vehicle is no longer taking bookings.' USING ERRCODE = 'P0001'; END IF;
  IF e.fare_mode <> 'fixed' THEN RAISE EXCEPTION 'This vehicle takes ride requests, not fixed-fare bookings — propose a fare instead.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = e.vehicle_id;

  IF v.tenant_id != my_tenant_id() AND NOT has_share_agreement(v.tenant_id, my_tenant_id(), 'adda') THEN
    RAISE EXCEPTION 'This vehicle is not shared with your village yet.' USING ERRCODE = 'P0001';
  END IF;

  IF p_seats IS NULL OR p_seats <= 0 THEN RAISE EXCEPTION 'Pick at least one seat.' USING ERRCODE = 'P0001'; END IF;

  v_total := p_seats * e.fixed_fare_per_seat_pkr;

  IF v.commission_mode = 'monthly_lumpsum' THEN
    IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  ELSE
    IF NOT v.is_active THEN RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings.' USING ERRCODE = 'P0001'; END IF;
    v_commission_pct := vehicle_commission_pct(v.vehicle_type, (SELECT classification FROM addas WHERE id = e.adda_id));
    v_expected_commission := round(v_total * v_commission_pct / 100, 2);
    IF seller_account_balance(ensure_vehicle_account(v.id)) < v_expected_commission THEN
      RAISE EXCEPTION 'This vehicle''s wallet balance is too low to cover this booking''s commission — the driver needs to top up first.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_available := adda_entry_seats_available(p_entry_id);
  IF p_seats > v_available THEN RAISE EXCEPTION 'Only % seat(s) left on this vehicle.', v_available USING ERRCODE = 'P0001'; END IF;

  INSERT INTO ride_bookings (adda_queue_entry_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at)
  VALUES (p_entry_id, v_portal_user_id, (now() AT TIME ZONE 'Asia/Karachi')::date, p_seats, v_total, 'announced', v_total, p_method, p_proof_url, now())
  RETURNING id INTO v_booking_id;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'adda_seat_booked', 'New seat booked',
      p_seats || ' seat(s) — Rs ' || round(v_total), '/portal/my-vehicle/adda');
  END IF;

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total_amount_pkr', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.book_trip_offer(p_trip_offer_id uuid, p_seats_requested integer, p_leg character varying DEFAULT 'oneway')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  o vehicle_trip_offers%ROWTYPE;
  v_owner_tenant_id uuid;
  v_fare_offer_id uuid;
  v_booking_id uuid;
  v_leg character varying;
  v_fare_per_seat numeric;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO o FROM vehicle_trip_offers WHERE id = p_trip_offer_id FOR UPDATE;
  IF NOT FOUND OR o.status <> 'open' THEN RAISE EXCEPTION 'This trip is no longer available.' USING ERRCODE = 'P0001'; END IF;

  SELECT tenant_id INTO v_owner_tenant_id FROM vehicles WHERE id = o.vehicle_id;
  IF v_owner_tenant_id != my_tenant_id() AND NOT has_share_agreement(v_owner_tenant_id, my_tenant_id(), 'trip_share') THEN
    RAISE EXCEPTION 'This trip is not shared with your village yet.' USING ERRCODE = 'P0001';
  END IF;

  IF p_seats_requested IS NULL OR p_seats_requested <= 0 OR p_seats_requested > o.seats_available THEN
    RAISE EXCEPTION 'Only % seat(s) available on this trip.', o.seats_available USING ERRCODE = 'P0001';
  END IF;

  v_leg := CASE WHEN o.trip_type = 'return' AND p_leg = 'return' THEN 'return' ELSE 'oneway' END;
  v_fare_per_seat := CASE WHEN o.trip_type = 'return' AND v_leg = 'oneway' THEN round(o.listed_fare_per_seat_pkr / 2) ELSE o.listed_fare_per_seat_pkr END;

  INSERT INTO vehicle_trip_fare_offers (trip_offer_id, portal_user_id, seats_requested, proposed_fare_per_seat_pkr, status, responded_at)
  VALUES (p_trip_offer_id, v_portal_user_id, p_seats_requested, v_fare_per_seat, 'accepted', now())
  RETURNING id INTO v_fare_offer_id;

  INSERT INTO vehicle_trip_bookings (trip_offer_id, fare_offer_id, vehicle_id, portal_user_id, seats, agreed_fare_per_seat_pkr, total_amount_pkr, leg)
  VALUES (o.id, v_fare_offer_id, o.vehicle_id, v_portal_user_id, p_seats_requested, v_fare_per_seat, p_seats_requested * v_fare_per_seat, v_leg)
  RETURNING id INTO v_booking_id;

  UPDATE vehicle_trip_offers SET seats_available = o.seats_available - p_seats_requested,
    status = CASE WHEN o.seats_available - p_seats_requested <= 0 THEN 'closed' ELSE status END
    WHERE id = o.id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'trip_booked', 'Seat booked',
    p_seats_requested || ' seat(s) booked (' || v_leg || ') at ' || v_fare_per_seat || '/seat for your ' || o.origin || ' → ' || o.destination || ' trip.', '/portal/my-vehicle/trips'
  FROM vehicles v WHERE v.id = o.vehicle_id AND v.portal_user_id IS NOT NULL;

  RETURN jsonb_build_object('booking_id', v_booking_id, 'leg', v_leg, 'fare_per_seat', v_fare_per_seat);
END;
$function$;

-- ═══ 5. Browse RPC — cross-tenant discovery, denormalized inside the
-- function body (SECURITY DEFINER) so the 4 underlying tables' RLS is
-- never touched/weakened for this ═══
CREATE OR REPLACE FUNCTION nearby_tehsil_rides() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_my_tenant_id uuid := my_tenant_id();
  v_tehsil_id uuid;
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
BEGIN
  IF v_my_tenant_id IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT tehsil_id INTO v_tehsil_id FROM tenants WHERE id = v_my_tenant_id;
  IF v_tehsil_id IS NULL THEN RETURN '[]'::jsonb; END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(merged.row), '[]'::jsonb) FROM (
      SELECT jsonb_build_object(
        'kind', 'route', 'id', r.id, 'origin', r.origin, 'origin_ur', r.origin_ur,
        'destination', r.destination, 'destination_ur', r.destination_ur,
        'fare_per_seat_pkr', r.fare_per_seat_pkr, 'departure_time', r.departure_time,
        'return_departure_time', r.return_departure_time, 'days_of_week', r.days_of_week,
        'is_two_way', r.is_two_way, 'distance_km', r.distance_km, 'route_duration_min', r.route_duration_min,
        'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color,
        'total_seats', v.total_seats, 'has_ac', v.has_ac, 'vehicle_number', v.vehicle_number,
        'source_tenant_id', v.tenant_id, 'source_tenant_name', t.name
      ) AS row
      FROM vehicle_routes r
      JOIN vehicles v ON v.id = r.vehicle_id
      JOIN tenants t ON t.id = v.tenant_id
      WHERE r.is_active AND NOT r.is_monthly_fixed AND v.tenant_id != v_my_tenant_id
        AND t.tehsil_id = v_tehsil_id
        AND has_share_agreement(v.tenant_id, v_my_tenant_id, 'route')

      UNION ALL

      SELECT jsonb_build_object(
        'kind', 'trip', 'id', o.id, 'origin', o.origin, 'origin_ur', o.origin_ur,
        'destination', o.destination, 'destination_ur', o.destination_ur,
        'fare_per_seat_pkr', o.listed_fare_per_seat_pkr, 'travel_date', o.travel_date,
        'departure_time_estimate', o.departure_time_estimate, 'seats_available', o.seats_available,
        'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color,
        'total_seats', v.total_seats, 'has_ac', v.has_ac, 'vehicle_number', v.vehicle_number,
        'source_tenant_id', v.tenant_id, 'source_tenant_name', t.name
      ) AS row
      FROM vehicle_trip_offers o
      JOIN vehicles v ON v.id = o.vehicle_id
      JOIN tenants t ON t.id = v.tenant_id
      WHERE o.status = 'open' AND o.travel_date >= v_today AND v.tenant_id != v_my_tenant_id
        AND t.tehsil_id = v_tehsil_id
        AND has_share_agreement(v.tenant_id, v_my_tenant_id, 'trip_share')
    ) merged
  );
END;
$$;
GRANT EXECUTE ON FUNCTION nearby_tehsil_rides() TO authenticated;

-- ═══ 6. Platform console — surface tehsil on the tenant list ═══
CREATE OR REPLACE FUNCTION public.platform_list_tenants()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE(jsonb_agg(jsonb_build_object(
    'id', t.id, 'name', t.name, 'name_ur', t.name_ur, 'slug', t.slug,
    'is_active', t.is_active, 'water_supply_enabled', t.water_supply_enabled,
    'donors_enabled', t.donors_enabled, 'created_at', t.created_at,
    'billing_exempt', t.billing_exempt, 'onboarding_status', t.onboarding_status,
    'tehsil_id', t.tehsil_id, 'tehsil_name', th.name,
    'admin_count', (SELECT count(*) FROM admin_users WHERE tenant_id = t.id AND is_active = true),
    'portal_user_count', (SELECT count(*) FROM portal_users WHERE tenant_id = t.id AND is_active = true),
    'subscription_status', (SELECT status FROM tenant_subscriptions WHERE tenant_id = t.id AND status IN ('active', 'trialing', 'past_due') LIMIT 1),
    'subscription_plan', (SELECT p.name FROM tenant_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.tenant_id = t.id AND s.status IN ('active', 'trialing', 'past_due') LIMIT 1)
  ) ORDER BY t.created_at), '[]'::jsonb)
  FROM tenants t
  LEFT JOIN tehsils th ON th.id = t.tehsil_id;
END;
$function$;
