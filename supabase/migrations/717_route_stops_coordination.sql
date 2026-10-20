-- Migration 717: Route Stops & Coordination.
--
-- Real ask: roads to a city aren't all obvious from a flat map (driver
-- should pick from real computed alternatives), villages a route
-- passes through want to know its timing, a driver's schedule can
-- change and riders should be told, and a route's regular riders +
-- driver should be able to coordinate (chat, live location) the way a
-- one-off trip booking already can.
--
-- Three things already existed and are reused, not rebuilt:
-- `create_vehicle_route_self` (699) already carries origin/destination
-- lat/lng + distance_km; `haversine_km()` (475) is the existing plain-
-- SQL distance helper (no PostGIS anywhere in this codebase, and this
-- table is small enough it doesn't need one); migration 189's
-- set-based `INSERT ... SELECT` is the existing fan-out-notification
-- idiom, copied below instead of a loop.
--
-- Three things genuinely don't exist yet and are built fresh here
-- rather than extended, because extending them would corrupt their
-- existing shape: the 1:1 chat (negotiation_threads/messages) has
-- `sender_role CHECK IN ('user','driver')` baked into every RPC —
-- structurally two-party, not groups. The bilateral location table
-- (vehicle_trip_locations, 400/706) has `(trip_booking_id, role)` as
-- its actual primary key — structurally one driver + one rider, not
-- many. `villages` has no lat/lng at all (its fee logic is deliberately
-- flat-rate, not distance-based) — so "auto-suggest stops from nearby
-- villages" can't just query existing coordinates on day one; this
-- migration adds the columns and backfills them the first time a real
-- stop is confirmed against a village, so coverage grows with use
-- instead of requiring a one-time data-entry project first.

ALTER TABLE villages ADD COLUMN IF NOT EXISTS lat double precision;
ALTER TABLE villages ADD COLUMN IF NOT EXISTS lng double precision;

ALTER TABLE vehicle_routes ADD COLUMN IF NOT EXISTS route_path jsonb;
ALTER TABLE vehicle_routes ADD COLUMN IF NOT EXISTS route_duration_min numeric;

-- ═════════════════════════════════════════════════════════════════════
-- Schema
-- ═════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS route_stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES vehicle_routes(id) ON DELETE CASCADE,
  village_id uuid REFERENCES villages(id),
  label varchar NOT NULL,
  label_ur varchar,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  stop_order int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS route_stops_route_id_idx ON route_stops(route_id);

CREATE TABLE IF NOT EXISTS route_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES vehicle_routes(id) ON DELETE CASCADE,
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  joined_at timestamptz DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  sharing_location boolean NOT NULL DEFAULT false,
  UNIQUE (route_id, portal_user_id)
);
CREATE INDEX IF NOT EXISTS route_participants_route_id_idx ON route_participants(route_id);

CREATE TABLE IF NOT EXISTS route_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES vehicle_routes(id) ON DELETE CASCADE,
  sender_portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  body text NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS route_chat_messages_route_id_idx ON route_chat_messages(route_id, created_at);

-- Many rows per route (one per currently-sharing member), unlike
-- vehicle_trip_locations' fixed (trip_booking_id, role) pair — the
-- real structural reason that table couldn't just be reused.
CREATE TABLE IF NOT EXISTS route_live_locations (
  route_id uuid NOT NULL REFERENCES vehicle_routes(id) ON DELETE CASCADE,
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (route_id, portal_user_id)
);

-- ═════════════════════════════════════════════════════════════════════
-- RLS helpers — same SECURITY DEFINER + owner-bypass pattern every
-- other cross-table predicate in this codebase already uses
-- (current_portal_user_id, my_tenant_id, is_party_to_negotiation).
-- ═════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION is_route_owner(p_route_id uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id
    WHERE vr.id = p_route_id AND v.portal_user_id = current_portal_user_id()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION is_route_owner(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION is_route_member(p_route_id uuid) RETURNS boolean AS $$
  SELECT is_route_owner(p_route_id) OR EXISTS (
    SELECT 1 FROM route_participants rp
    WHERE rp.route_id = p_route_id AND rp.portal_user_id = current_portal_user_id() AND rp.is_active = true
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION is_route_member(uuid) TO authenticated;

ALTER TABLE route_stops ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_route_stops" ON route_stops FOR SELECT USING (true);
CREATE POLICY "route_stops_owner_insert" ON route_stops FOR INSERT TO authenticated WITH CHECK (is_route_owner(route_id));
CREATE POLICY "route_stops_owner_update" ON route_stops FOR UPDATE TO authenticated USING (is_route_owner(route_id)) WITH CHECK (is_route_owner(route_id));
CREATE POLICY "route_stops_owner_delete" ON route_stops FOR DELETE TO authenticated USING (is_route_owner(route_id));

ALTER TABLE route_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "route_participants_member_read" ON route_participants FOR SELECT TO authenticated
  USING (portal_user_id = current_portal_user_id() OR is_route_member(route_id));
CREATE POLICY "route_participants_self_insert" ON route_participants FOR INSERT TO authenticated WITH CHECK (portal_user_id = current_portal_user_id());
CREATE POLICY "route_participants_self_update" ON route_participants FOR UPDATE TO authenticated
  USING (portal_user_id = current_portal_user_id()) WITH CHECK (portal_user_id = current_portal_user_id());

ALTER TABLE route_chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "route_chat_member_read" ON route_chat_messages FOR SELECT TO authenticated USING (is_route_member(route_id));
CREATE POLICY "route_chat_member_insert" ON route_chat_messages FOR INSERT TO authenticated
  WITH CHECK (is_route_member(route_id) AND sender_portal_user_id = current_portal_user_id());

ALTER TABLE route_live_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "route_live_locations_member_read" ON route_live_locations FOR SELECT TO authenticated USING (is_route_member(route_id));
CREATE POLICY "route_live_locations_self_insert" ON route_live_locations FOR INSERT TO authenticated WITH CHECK (portal_user_id = current_portal_user_id());
CREATE POLICY "route_live_locations_self_update" ON route_live_locations FOR UPDATE TO authenticated
  USING (portal_user_id = current_portal_user_id()) WITH CHECK (portal_user_id = current_portal_user_id());
CREATE POLICY "route_live_locations_self_delete" ON route_live_locations FOR DELETE TO authenticated USING (portal_user_id = current_portal_user_id());

-- ═════════════════════════════════════════════════════════════════════
-- create_vehicle_route_self gains the chosen OSRM path + its duration
-- — reproduced from the live body verbatim (confirmed via
-- pg_get_functiondef, not the migration-file history, since this
-- session already found more than one case where the two had
-- diverged), with only the two new trailing params and their two new
-- INSERT columns added.
-- ═════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.create_vehicle_route_self(uuid, character varying, character varying, character varying, character varying, numeric, time without time zone, integer[], character varying, character varying, numeric, numeric, numeric, numeric, numeric);

CREATE OR REPLACE FUNCTION public.create_vehicle_route_self(p_vehicle_id uuid, p_origin character varying, p_destination character varying, p_classification character varying, p_fare_mode character varying, p_total_fare_pkr numeric DEFAULT NULL::numeric, p_departure_time time without time zone DEFAULT NULL::time without time zone, p_days_of_week integer[] DEFAULT '{}'::integer[], p_origin_ur character varying DEFAULT NULL::character varying, p_destination_ur character varying DEFAULT NULL::character varying, p_origin_lat numeric DEFAULT NULL::numeric, p_origin_lng numeric DEFAULT NULL::numeric, p_destination_lat numeric DEFAULT NULL::numeric, p_destination_lng numeric DEFAULT NULL::numeric, p_distance_km numeric DEFAULT NULL::numeric, p_route_path jsonb DEFAULT NULL, p_route_duration_min numeric DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_tenant_id uuid;
  v_seats int;
  v_per_seat decimal;
  v_id uuid;
  v_fair_total decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required';
  END IF;

  SELECT tenant_id, total_seats INTO v_tenant_id, v_seats
    FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = v_portal_user_id AND is_active = true;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'You can only post a route for your own vehicle';
  END IF;

  IF EXISTS (SELECT 1 FROM vehicle_routes WHERE vehicle_id = p_vehicle_id AND is_active = true) THEN
    RAISE EXCEPTION 'You already have an active route posted — close it before posting a new one.' USING ERRCODE = 'P0001';
  END IF;

  IF coalesce(trim(p_origin), '') = '' OR coalesce(trim(p_destination), '') = '' THEN
    RAISE EXCEPTION 'Origin and destination are required';
  END IF;
  IF p_days_of_week IS NULL OR array_length(p_days_of_week, 1) IS NULL THEN
    RAISE EXCEPTION 'Pick at least one day';
  END IF;

  IF p_distance_km IS NOT NULL THEN
    v_fair_total := (fare_band_for('route', p_distance_km)->>'fair')::decimal;
    IF v_fair_total IS NOT NULL THEN
      IF p_total_fare_pkr IS NULL THEN
        p_total_fare_pkr := round(v_fair_total);
      ELSIF round(p_total_fare_pkr) > round(v_fair_total) THEN
        RAISE EXCEPTION 'The fair total fare for this distance is ₨% — you can list that or less, not more.', round(v_fair_total) USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  IF p_total_fare_pkr IS NULL OR p_total_fare_pkr <= 0 THEN
    RAISE EXCEPTION 'Enter the total fare';
  END IF;

  v_per_seat := round(p_total_fare_pkr / greatest(1, coalesce(v_seats, 1)));

  INSERT INTO vehicle_routes (
    vehicle_id, tenant_id, origin, origin_ur, destination, destination_ur,
    classification, fare_mode, total_fare_pkr, fare_per_seat_pkr,
    departure_time, days_of_week, is_active,
    origin_lat, origin_lng, destination_lat, destination_lng, distance_km,
    route_path, route_duration_min
  ) VALUES (
    p_vehicle_id, v_tenant_id, trim(p_origin), nullif(trim(coalesce(p_origin_ur, '')), ''), trim(p_destination), nullif(trim(coalesce(p_destination_ur, '')), ''),
    p_classification, p_fare_mode, p_total_fare_pkr, v_per_seat,
    p_departure_time, p_days_of_week, true,
    p_origin_lat, p_origin_lng, p_destination_lat, p_destination_lng, p_distance_km,
    p_route_path, p_route_duration_min
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- ═════════════════════════════════════════════════════════════════════
-- Editing an existing route's schedule — this RPC never existed before
-- this migration (only create + close did), so "notify riders when the
-- driver changes timing" needed a real edit path to exist first.
-- ═════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_vehicle_route_schedule(p_route_id uuid, p_departure_time time, p_days_of_week int[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only edit your own route.' USING ERRCODE = 'P0001'; END IF;
  IF p_days_of_week IS NULL OR array_length(p_days_of_week, 1) IS NULL THEN RAISE EXCEPTION 'Pick at least one day.' USING ERRCODE = 'P0001'; END IF;

  UPDATE vehicle_routes SET departure_time = p_departure_time, days_of_week = p_days_of_week WHERE id = p_route_id;

  -- Set-based fan-out, same idiom as migration 189's blood-request
  -- notify loop collapsed to one INSERT ... SELECT — every rider who
  -- still has a live booking, plus every active permanent-group member
  -- (the two lists overlap but UNION already dedupes).
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT DISTINCT riders.portal_user_id, 'route_schedule_changed', 'Route timing changed',
    'The departure time or days for a route you ride changed — check the new schedule.', '/portal/marketplace/route/' || p_route_id
  FROM (
    SELECT portal_user_id FROM ride_bookings WHERE route_id = p_route_id AND status NOT IN ('cancelled', 'rejected')
    UNION
    SELECT portal_user_id FROM route_participants WHERE route_id = p_route_id AND is_active = true
  ) riders;
END;
$$;
GRANT EXECUTE ON FUNCTION update_vehicle_route_schedule(uuid, time, int[]) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- Village-near-path suggestion — plain haversine loop against the
-- (small, single-committee-scale) villages table; no PostGIS needed at
-- this scale, same reasoning as every other distance calc in this app.
-- ═════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION villages_near_path(p_path jsonb, p_max_km numeric DEFAULT 2)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid := coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
  v_result jsonb := '[]'::jsonb;
  v_village record;
  v_point record;
  v_min_dist numeric;
BEGIN
  FOR v_village IN SELECT id, name, name_ur, lat, lng FROM villages WHERE tenant_id = v_tenant AND is_active = true AND lat IS NOT NULL AND lng IS NOT NULL LOOP
    v_min_dist := NULL;
    FOR v_point IN SELECT (p->>'lat')::decimal AS lat, (p->>'lng')::decimal AS lng FROM jsonb_array_elements(p_path) p LOOP
      v_min_dist := LEAST(coalesce(v_min_dist, 999999), haversine_km(v_village.lat, v_village.lng, v_point.lat, v_point.lng));
    END LOOP;
    IF v_min_dist IS NOT NULL AND v_min_dist <= p_max_km THEN
      v_result := v_result || jsonb_build_object('village_id', v_village.id, 'name', v_village.name, 'name_ur', v_village.name_ur, 'lat', v_village.lat, 'lng', v_village.lng, 'distance_km', round(v_min_dist, 2));
    END IF;
  END LOOP;
  RETURN v_result;
END;
$$;
GRANT EXECUTE ON FUNCTION villages_near_path(jsonb, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION create_route_stop(p_route_id uuid, p_label varchar, p_label_ur varchar, p_lat numeric, p_lng numeric, p_village_id uuid DEFAULT NULL, p_stop_order int DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_order int;
BEGIN
  IF NOT is_route_owner(p_route_id) THEN RAISE EXCEPTION 'You can only manage stops on your own route.' USING ERRCODE = 'P0001'; END IF;
  IF coalesce(trim(p_label), '') = '' THEN RAISE EXCEPTION 'Enter a stop name.' USING ERRCODE = 'P0001'; END IF;
  IF p_lat IS NULL OR p_lng IS NULL THEN RAISE EXCEPTION 'Pick a point on the map.' USING ERRCODE = 'P0001'; END IF;

  v_order := coalesce(p_stop_order, (SELECT coalesce(max(stop_order), 0) + 1 FROM route_stops WHERE route_id = p_route_id));

  INSERT INTO route_stops (route_id, village_id, label, label_ur, lat, lng, stop_order)
  VALUES (p_route_id, p_village_id, trim(p_label), nullif(trim(coalesce(p_label_ur, '')), ''), p_lat, p_lng, v_order)
  RETURNING id INTO v_id;

  -- Progressive enrichment: the first real stop ever confirmed against
  -- a village becomes that village's own reference point. Never
  -- overwrites a coordinate a previous stop already set.
  IF p_village_id IS NOT NULL THEN
    UPDATE villages SET lat = p_lat, lng = p_lng WHERE id = p_village_id AND lat IS NULL AND lng IS NULL;
  END IF;

  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION create_route_stop(uuid, varchar, varchar, numeric, numeric, uuid, int) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- Permanent route group: join/leave, chat, live-location opt-in/out —
-- same poll-and-upsert, opt-out-by-delete mechanics as the existing
-- bilateral trip-location sharing (706), generalized off its fixed
-- (trip_booking_id, role) pair onto (route_id, portal_user_id).
-- ═════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION join_route_group(p_route_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO route_participants (route_id, portal_user_id, is_active)
  VALUES (p_route_id, v_portal_user_id, true)
  ON CONFLICT (route_id, portal_user_id) DO UPDATE SET is_active = true;
END;
$$;
GRANT EXECUTE ON FUNCTION join_route_group(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION leave_route_group(p_route_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id();
BEGIN
  UPDATE route_participants SET is_active = false, sharing_location = false WHERE route_id = p_route_id AND portal_user_id = v_portal_user_id;
  DELETE FROM route_live_locations WHERE route_id = p_route_id AND portal_user_id = v_portal_user_id;
END;
$$;
GRANT EXECUTE ON FUNCTION leave_route_group(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION send_route_message(p_route_id uuid, p_body text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT is_route_member(p_route_id) THEN RAISE EXCEPTION 'Join this route''s group first.' USING ERRCODE = 'P0001'; END IF;
  IF coalesce(trim(p_body), '') = '' THEN RAISE EXCEPTION 'Message is empty.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO route_chat_messages (route_id, sender_portal_user_id, body)
  VALUES (p_route_id, v_portal_user_id, trim(p_body))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION send_route_message(uuid, text) TO authenticated;

-- The driver (route owner) toggling sharing also lazily upserts their
-- own route_participants row — makes the driver a real member of their
-- own permanent group (visible in the roster, included in chat) rather
-- than a special case tracked nowhere.
CREATE OR REPLACE FUNCTION set_route_location_sharing(p_route_id uuid, p_on boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT is_route_member(p_route_id) THEN RAISE EXCEPTION 'Join this route''s group first.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO route_participants (route_id, portal_user_id, is_active, sharing_location)
  VALUES (p_route_id, v_portal_user_id, true, p_on)
  ON CONFLICT (route_id, portal_user_id) DO UPDATE SET sharing_location = p_on, is_active = true;

  IF NOT p_on THEN
    DELETE FROM route_live_locations WHERE route_id = p_route_id AND portal_user_id = v_portal_user_id;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION set_route_location_sharing(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION ping_route_location(p_route_id uuid, p_lat numeric, p_lng numeric) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_sharing boolean;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT sharing_location INTO v_sharing FROM route_participants WHERE route_id = p_route_id AND portal_user_id = v_portal_user_id;
  IF v_sharing IS NOT TRUE THEN RETURN; END IF;

  INSERT INTO route_live_locations (route_id, portal_user_id, lat, lng, updated_at)
  VALUES (p_route_id, v_portal_user_id, p_lat, p_lng, now())
  ON CONFLICT (route_id, portal_user_id) DO UPDATE SET lat = p_lat, lng = p_lng, updated_at = now();
END;
$$;
GRANT EXECUTE ON FUNCTION ping_route_location(uuid, numeric, numeric) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- place_ride_booking: "book once, you're in the group" — auto-joins
-- the rider to the route's permanent group right after a successful
-- booking, without a separate tap. Reproduced from the live body
-- verbatim (confirmed via pg_get_functiondef), with only the one new
-- upsert added before RETURN. Leaving later stays a real, explicit
-- opt-out via leave_route_group — this never re-joins someone who left.
-- ═════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.place_ride_booking(p_route_id uuid, p_travel_date date, p_seats integer, p_method character varying, p_proof_url text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND tenant_id = my_tenant_id();
  IF NOT FOUND OR NOT v_route.is_active THEN RAISE EXCEPTION 'Route not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;
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

  INSERT INTO route_participants (route_id, portal_user_id, is_active)
  VALUES (p_route_id, v_portal_user_id, true)
  ON CONFLICT (route_id, portal_user_id) DO NOTHING;

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total);
END;
$function$;
