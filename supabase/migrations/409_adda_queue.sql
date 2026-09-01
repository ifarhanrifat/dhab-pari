-- Migration 409: the "adda" turn-based departure queue — Dhab Pari's own
-- version of a real Pakistani van stand's number system, not a scheduled
-- timetable (vehicle_routes/389 already covers that). A driver checks in
-- at a stand; the first vehicle to check in becomes "current" and gets a
-- fixed turn window (default 30 min) to fill up and leave; when it
-- leaves, passes, or its window runs out and another driver claims the
-- front, the next vehicle in line becomes current with a fresh window.
--
-- Deliberately a real table (addas), not two hardcoded site_settings rows
-- — every comparable concept here (vehicle_routes, shops, commission
-- rates) is already admin-CRUD, the queue needs a real FK to say *which*
-- stand regardless, and a third stand later is then just a new row, not
-- a migration.
--
-- ═════════════════════════════════════════════════════════════════════════
-- 1. The stands themselves — one row per physical stand, paired with the
--    stand at the other end of the route. lat/lng nullable exactly like
--    vehicle_routes' map pins (399): an admin clicks them in later, the
--    stand works (minus the map) before that.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS addas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar NOT NULL,
  name_ur varchar,
  lat decimal,
  lng decimal,
  pair_adda_id uuid REFERENCES addas(id),
  classification varchar NOT NULL DEFAULT 'intercity' CHECK (classification IN ('intercity', 'out_of_city')),
  turn_minutes int NOT NULL DEFAULT 30 CHECK (turn_minutes > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE addas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_addas" ON addas FOR SELECT USING (true);
CREATE POLICY "addas_admin_write" ON addas FOR ALL TO authenticated
  USING (current_admin_permission('manage_parties')) WITH CHECK (current_admin_permission('manage_parties'));

-- Seed the two stands the whole feature exists for. Coordinates left
-- NULL — the committee clicks the actual pins on the admin map, same as
-- every route's origin/destination pin today. Two statements because
-- each needs the other's id to exist first.
INSERT INTO addas (id, name, name_ur, classification, turn_minutes)
VALUES
  ('00000000-0000-0000-0000-00000000ad01', 'Dhab Pari Chowk', 'ڈھب پڑی چوک', 'intercity', 30),
  ('00000000-0000-0000-0000-00000000ad02', 'Chakwal Adda', 'چکوال اڈا', 'intercity', 30)
ON CONFLICT (id) DO NOTHING;
UPDATE addas SET pair_adda_id = '00000000-0000-0000-0000-00000000ad02' WHERE id = '00000000-0000-0000-0000-00000000ad01' AND pair_adda_id IS NULL;
UPDATE addas SET pair_adda_id = '00000000-0000-0000-0000-00000000ad01' WHERE id = '00000000-0000-0000-0000-00000000ad02' AND pair_adda_id IS NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. The queue itself. queue_date scopes every uniqueness rule and every
--    read to "today" (Asia/Karachi) so a row nobody closed out yesterday
--    can never block anything this morning — no nightly reset cron needed.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS adda_queue_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adda_id uuid NOT NULL REFERENCES addas(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  queue_date date NOT NULL,
  position int NOT NULL,
  status varchar NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'current', 'departed', 'passed', 'expired', 'cancelled')),
  fare_mode varchar NOT NULL DEFAULT 'fixed' CHECK (fare_mode IN ('fixed', 'request')),
  fixed_fare_per_seat_pkr decimal CHECK (fixed_fare_per_seat_pkr IS NULL OR fixed_fare_per_seat_pkr >= 0),
  trip_offer_id uuid, -- set only when fare_mode='request'; FK added in migration 410 once vehicle_trip_offers is in scope there too
  seats_total int NOT NULL CHECK (seats_total > 0),
  share_location_on_depart boolean NOT NULL DEFAULT false,
  checked_in_at timestamptz NOT NULL DEFAULT now(),
  turn_started_at timestamptz,
  turn_expires_at timestamptz,
  departed_at timestamptz,
  passed_at timestamptz,
  lap int NOT NULL DEFAULT 1,
  checked_in_by_admin uuid REFERENCES admin_users(id), -- NULL = the driver checked himself in
  created_at timestamptz DEFAULT now()
);

-- The two invariants that make the queue impossible to corrupt even if
-- an RPC's own logic had a bug: one live slot per vehicle per day (so a
-- van can't be waiting in two places, or twice in the same line), and at
-- most one "current" vehicle per stand per day.
CREATE UNIQUE INDEX IF NOT EXISTS adda_queue_one_live_per_vehicle
  ON adda_queue_entries(vehicle_id, queue_date) WHERE status IN ('waiting', 'current');
CREATE UNIQUE INDEX IF NOT EXISTS adda_queue_one_current_per_adda
  ON adda_queue_entries(adda_id, queue_date) WHERE status = 'current';
CREATE INDEX IF NOT EXISTS adda_queue_entries_board_idx ON adda_queue_entries(adda_id, queue_date, status);

ALTER TABLE adda_queue_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_adda_queue_entries" ON adda_queue_entries FOR SELECT USING (true);
-- Writes only ever happen through the SECURITY DEFINER RPCs below (389's
-- own stated discipline) — no direct-write policy is granted at all.

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('adda_turn_started', 'A vehicle''s turn at an adda has started', false, true)
ON CONFLICT (event_type) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Internal helper — renumbers today's live rows and promotes whoever's
--    now in front. Not granted to anyone; only ever called from inside
--    another function that's already holding the adda's row lock.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION adda_promote_next(p_adda_id uuid, p_queue_date date) RETURNS void AS $$
DECLARE v_turn_minutes int; v_next adda_queue_entries%ROWTYPE; v_portal_user_id uuid; r RECORD; v_pos int := 0;
BEGIN
  -- Renumber every still-live row into a clean 1..n by (position, checked_in_at) —
  -- cheap (a handful of rows per stand per day) and means position never drifts.
  FOR r IN SELECT id FROM adda_queue_entries WHERE adda_id = p_adda_id AND queue_date = p_queue_date
           AND status IN ('waiting', 'current') ORDER BY position, checked_in_at
  LOOP
    v_pos := v_pos + 1;
    UPDATE adda_queue_entries SET position = v_pos WHERE id = r.id;
  END LOOP;

  IF EXISTS (SELECT 1 FROM adda_queue_entries WHERE adda_id = p_adda_id AND queue_date = p_queue_date AND status = 'current') THEN
    RETURN; -- someone's already current, nothing to promote
  END IF;

  SELECT * INTO v_next FROM adda_queue_entries
    WHERE adda_id = p_adda_id AND queue_date = p_queue_date AND status = 'waiting'
    ORDER BY position LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT turn_minutes INTO v_turn_minutes FROM addas WHERE id = p_adda_id;
  UPDATE adda_queue_entries SET status = 'current', turn_started_at = now(),
    turn_expires_at = now() + (v_turn_minutes || ' minutes')::interval
    WHERE id = v_next.id;

  SELECT portal_user_id INTO v_portal_user_id FROM vehicles WHERE id = v_next.vehicle_id;
  IF v_portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_portal_user_id, 'adda_turn_started', 'It''s your turn at the adda',
      'You''re now at the front of the queue — ' || v_turn_minutes || ' minutes to fill your seats.', '/portal/my-vehicle');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. The five state transitions. Every one locks the adda row FIRST —
--    the adda row is the mutex for its entire queue's ordering, since the
--    thing being protected (queue order) isn't any single queue row.
--    Lock order is always addas → adda_queue_entries, never reversed.
-- ═════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION adda_check_in(
  p_adda_id uuid, p_vehicle_id uuid, p_fare_mode varchar DEFAULT 'fixed',
  p_fixed_fare_per_seat_pkr decimal DEFAULT NULL, p_share_location_on_depart boolean DEFAULT false
) RETURNS jsonb AS $$
DECLARE
  a addas%ROWTYPE; v vehicles%ROWTYPE; v_portal_user_id uuid := current_portal_user_id();
  v_queue_date date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_next_position int; v_entry_id uuid; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
BEGIN
  SELECT * INTO a FROM addas WHERE id = p_adda_id AND is_active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This adda is not available.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND OR NOT v.is_active THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (v_is_admin OR v.portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT vehicle_bookable(p_vehicle_id) THEN
    RAISE EXCEPTION 'This vehicle''s wallet balance is too low to join the queue — top up first.' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM adda_queue_entries WHERE vehicle_id = p_vehicle_id AND queue_date = v_queue_date AND status IN ('waiting', 'current')) THEN
    RAISE EXCEPTION 'This vehicle is already in a queue today.' USING ERRCODE = 'P0001';
  END IF;

  IF p_fare_mode NOT IN ('fixed', 'request') THEN RAISE EXCEPTION 'Invalid fare mode.' USING ERRCODE = 'P0001'; END IF;
  IF p_fare_mode = 'fixed' AND (p_fixed_fare_per_seat_pkr IS NULL OR p_fixed_fare_per_seat_pkr <= 0) THEN
    RAISE EXCEPTION 'Enter the fixed fare per seat.' USING ERRCODE = 'P0001';
  END IF;
  IF p_fare_mode = 'request' AND p_fixed_fare_per_seat_pkr IS NOT NULL THEN
    RAISE EXCEPTION 'A ride-request vehicle should not set a fixed fare.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(MAX(position), 0) + 1 INTO v_next_position FROM adda_queue_entries
    WHERE adda_id = p_adda_id AND queue_date = v_queue_date AND status IN ('waiting', 'current');

  INSERT INTO adda_queue_entries (adda_id, vehicle_id, queue_date, position, status, fare_mode, fixed_fare_per_seat_pkr, seats_total, share_location_on_depart, checked_in_by_admin)
  VALUES (p_adda_id, p_vehicle_id, v_queue_date, v_next_position, 'waiting', p_fare_mode, p_fixed_fare_per_seat_pkr, v.total_seats, p_share_location_on_depart,
    CASE WHEN v_is_admin AND v.portal_user_id IS DISTINCT FROM v_portal_user_id THEN current_admin_user_id() ELSE NULL END)
  RETURNING id INTO v_entry_id;

  PERFORM adda_promote_next(p_adda_id, v_queue_date);

  RETURN jsonb_build_object('entry_id', v_entry_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION adda_check_in(uuid, uuid, varchar, decimal, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION adda_check_in(uuid, uuid, varchar, decimal, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION adda_mark_departed(p_entry_id uuid) RETURNS void AS $$
DECLARE e adda_queue_entries%ROWTYPE; v vehicles%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
BEGIN
  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Queue entry not found.' USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM addas WHERE id = e.adda_id FOR UPDATE;
  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id FOR UPDATE;
  SELECT * INTO v FROM vehicles WHERE id = e.vehicle_id;
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF e.status <> 'current' THEN RAISE EXCEPTION 'This vehicle is not currently at the front of the queue.' USING ERRCODE = 'P0001'; END IF;

  UPDATE adda_queue_entries SET status = 'departed', departed_at = now() WHERE id = p_entry_id;
  IF e.trip_offer_id IS NOT NULL THEN
    UPDATE vehicle_trip_offers SET status = 'closed' WHERE id = e.trip_offer_id AND status = 'open';
    IF e.share_location_on_depart THEN
      UPDATE vehicle_trip_offers SET share_live_location = true, live_location_started_at = now() WHERE id = e.trip_offer_id;
    END IF;
  END IF;

  PERFORM adda_promote_next(e.adda_id, e.queue_date);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION adda_mark_departed(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION adda_mark_departed(uuid) TO authenticated;

-- Voluntary skip — not enough passengers yet, distinct from timing out.
-- The vehicle rejoins at the back for another lap rather than dropping
-- out entirely (real addas work this way — nobody goes home empty).
CREATE OR REPLACE FUNCTION adda_pass_turn(p_entry_id uuid) RETURNS jsonb AS $$
DECLARE e adda_queue_entries%ROWTYPE; v vehicles%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
  v_next_position int; v_new_id uuid;
BEGIN
  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Queue entry not found.' USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM addas WHERE id = e.adda_id FOR UPDATE;
  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id FOR UPDATE;
  SELECT * INTO v FROM vehicles WHERE id = e.vehicle_id;
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF e.status <> 'current' THEN RAISE EXCEPTION 'This vehicle is not currently at the front of the queue.' USING ERRCODE = 'P0001'; END IF;

  -- Close the old row before inserting the new one — insert-first would
  -- momentarily violate adda_queue_one_live_per_vehicle and abort the call.
  UPDATE adda_queue_entries SET status = 'passed', passed_at = now() WHERE id = p_entry_id;

  SELECT COALESCE(MAX(position), 0) + 1 INTO v_next_position FROM adda_queue_entries
    WHERE adda_id = e.adda_id AND queue_date = e.queue_date AND status IN ('waiting', 'current');
  INSERT INTO adda_queue_entries (adda_id, vehicle_id, queue_date, position, status, fare_mode, fixed_fare_per_seat_pkr, seats_total, share_location_on_depart, lap)
  VALUES (e.adda_id, e.vehicle_id, e.queue_date, v_next_position, 'waiting', e.fare_mode, e.fixed_fare_per_seat_pkr, e.seats_total, e.share_location_on_depart, e.lap + 1)
  RETURNING id INTO v_new_id;

  PERFORM adda_promote_next(e.adda_id, e.queue_date);

  RETURN jsonb_build_object('new_entry_id', v_new_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION adda_pass_turn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION adda_pass_turn(uuid) TO authenticated;

-- A waiting driver claims the front once the current vehicle's window has
-- actually run out — an explicit action by the next driver ("any driver
-- ... can replace him"), not an automatic clock-driven promotion: a
-- vehicle that's still physically at the stand keeps it if nobody else
-- claims, exactly like a real adda. Restricted to the lowest-position
-- waiting row so #3 can't jump #2 — see the migration's own build notes
-- for why this narrows the literal wording slightly; one line to relax.
CREATE OR REPLACE FUNCTION adda_claim_front(p_entry_id uuid) RETURNS jsonb AS $$
DECLARE
  e adda_queue_entries%ROWTYPE; v vehicles%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
  v_current adda_queue_entries%ROWTYPE; v_lowest_waiting_id uuid; v_minutes_left int;
BEGIN
  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Queue entry not found.' USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM addas WHERE id = e.adda_id FOR UPDATE;
  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id FOR UPDATE;
  SELECT * INTO v FROM vehicles WHERE id = e.vehicle_id;
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF e.status <> 'waiting' THEN RAISE EXCEPTION 'This vehicle is not waiting in this queue.' USING ERRCODE = 'P0001'; END IF;

  SELECT id INTO v_lowest_waiting_id FROM adda_queue_entries
    WHERE adda_id = e.adda_id AND queue_date = e.queue_date AND status = 'waiting' ORDER BY position LIMIT 1;
  IF v_lowest_waiting_id IS DISTINCT FROM p_entry_id THEN
    RAISE EXCEPTION 'A vehicle ahead of you in line can claim the front first.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_current FROM adda_queue_entries WHERE adda_id = e.adda_id AND queue_date = e.queue_date AND status = 'current' FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM adda_promote_next(e.adda_id, e.queue_date);
    RETURN jsonb_build_object('claimed', true);
  END IF;
  IF now() <= v_current.turn_expires_at THEN
    v_minutes_left := ceil(extract(epoch FROM (v_current.turn_expires_at - now())) / 60);
    RAISE EXCEPTION 'The current vehicle still has % minute(s) left on its turn.', v_minutes_left USING ERRCODE = 'P0001';
  END IF;

  UPDATE adda_queue_entries SET status = 'expired' WHERE id = v_current.id;
  INSERT INTO adda_queue_entries (adda_id, vehicle_id, queue_date, position, status, fare_mode, fixed_fare_per_seat_pkr, seats_total, share_location_on_depart, lap)
  VALUES (v_current.adda_id, v_current.vehicle_id, v_current.queue_date,
    (SELECT COALESCE(MAX(position), 0) + 1 FROM adda_queue_entries WHERE adda_id = v_current.adda_id AND queue_date = v_current.queue_date AND status IN ('waiting', 'current')),
    'waiting', v_current.fare_mode, v_current.fixed_fare_per_seat_pkr, v_current.seats_total, v_current.share_location_on_depart, v_current.lap + 1);

  PERFORM adda_promote_next(e.adda_id, e.queue_date);

  RETURN jsonb_build_object('claimed', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION adda_claim_front(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION adda_claim_front(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION adda_leave_queue(p_entry_id uuid) RETURNS void AS $$
DECLARE e adda_queue_entries%ROWTYPE; v vehicles%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
BEGIN
  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Queue entry not found.' USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM addas WHERE id = e.adda_id FOR UPDATE;
  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id FOR UPDATE;
  SELECT * INTO v FROM vehicles WHERE id = e.vehicle_id;
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF e.status <> 'waiting' THEN RAISE EXCEPTION 'Only a waiting vehicle can leave the queue this way.' USING ERRCODE = 'P0001'; END IF;

  UPDATE adda_queue_entries SET status = 'cancelled' WHERE id = p_entry_id;
  PERFORM adda_promote_next(e.adda_id, e.queue_date);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION adda_leave_queue(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION adda_leave_queue(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- 5. Read board — everything a rider's adda screen needs in one call:
--    both stands' names/pins, who's current with seconds remaining, and
--    the ordered waiting list with owner/vehicle/fare details. Public
--    (anon too) — same convention as route_seats_available/
--    search_marketplace_products, this is browse-before-sign-in content.
--    'seats_available' is a placeholder here (= seats_total, no bookings
--    exist yet in this migration) — migration 410 replaces this whole
--    function the moment ride_bookings can actually target a queue entry,
--    same CREATE OR REPLACE-across-migrations pattern place_ride_booking
--    already uses (394 → 406).
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION adda_board(p_adda_id uuid) RETURNS jsonb AS $$
DECLARE v_queue_date date := (now() AT TIME ZONE 'Asia/Karachi')::date;
BEGIN
  RETURN (
    SELECT jsonb_build_object(
      'adda', jsonb_build_object('id', a.id, 'name', a.name, 'name_ur', a.name_ur, 'lat', a.lat, 'lng', a.lng, 'turn_minutes', a.turn_minutes),
      'pair_adda', (SELECT jsonb_build_object('id', p.id, 'name', p.name, 'name_ur', p.name_ur, 'lat', p.lat, 'lng', p.lng) FROM addas p WHERE p.id = a.pair_adda_id),
      'entries', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'entry_id', e.id, 'status', e.status, 'position', e.position, 'lap', e.lap,
          'turn_started_at', e.turn_started_at, 'turn_expires_at', e.turn_expires_at,
          'seats_total', e.seats_total, 'seats_available', e.seats_total,
          'fare_mode', e.fare_mode, 'fixed_fare_per_seat_pkr', e.fixed_fare_per_seat_pkr, 'trip_offer_id', e.trip_offer_id,
          'vehicle_id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number
        ) ORDER BY (e.status = 'current') DESC, e.position)
        FROM adda_queue_entries e JOIN vehicles v ON v.id = e.vehicle_id
        WHERE e.adda_id = a.id AND e.queue_date = v_queue_date AND e.status IN ('waiting', 'current')
      ), '[]'::jsonb)
    )
    FROM addas a WHERE a.id = p_adda_id
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION adda_board(uuid) TO authenticated, anon;
