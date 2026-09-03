-- Migration 424: weekend commuter seat-sharing — the spec's Commuter/
-- ShareRide concept. A villager who works in a city on a fixed weekly
-- rhythm (e.g. home Saturday, back Monday) sets that schedule once;
-- vehicle owners who already make that same run list a recurring share
-- offer (day + direction + seats + fare); matching is a pure read-side
-- rule, no booking ledger of its own — actually claiming a seat reuses
-- the existing negotiation_threads system (422) with kind='share',
-- exactly as the handoff spec instructs ("reuse the same negotiation
-- mechanism for city-fetch and weekend-commuter requests"). day_of_week
-- follows the same 0=Sun..6=Sat convention already established by
-- training_batches.session_days.
--
-- Deliberately NOT a full seat-reservation/payment system like a future
-- ride_bookings table might be — negotiation IS the booking here (price
-- and seat are agreed in chat, cash in hand), matching how lightly the
-- prototype itself treats this flow. seats_taken is a simple counter the
-- vehicle owner nudges as negotiations conclude, not a ledger.

CREATE TABLE IF NOT EXISTS commuter_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id uuid NOT NULL UNIQUE REFERENCES portal_users(id) ON DELETE CASCADE,
  work_city_id uuid NOT NULL REFERENCES cities(id),
  home_day smallint NOT NULL CHECK (home_day BETWEEN 0 AND 6),  -- day they travel city → village
  back_day smallint NOT NULL CHECK (back_day BETWEEN 0 AND 6),  -- day they travel village → city
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE commuter_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "commuter_schedules_own" ON commuter_schedules FOR ALL TO authenticated
  USING (current_admin_permission('manage_parties') OR portal_user_id = current_portal_user_id())
  WITH CHECK (current_admin_permission('manage_parties') OR portal_user_id = current_portal_user_id());

CREATE TABLE IF NOT EXISTS weekend_share_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  city_id uuid NOT NULL REFERENCES cities(id),
  direction varchar NOT NULL CHECK (direction IN ('to_village', 'to_city')),
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  depart_time time,
  seats_total int NOT NULL CHECK (seats_total > 0),
  seats_taken int NOT NULL DEFAULT 0 CHECK (seats_taken >= 0 AND seats_taken <= seats_total),
  fare_per_seat_pkr decimal NOT NULL CHECK (fare_per_seat_pkr >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS weekend_share_offers_match_idx
  ON weekend_share_offers(city_id, direction, day_of_week) WHERE is_active;

ALTER TABLE weekend_share_offers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_weekend_share_offers" ON weekend_share_offers FOR SELECT USING (true);
CREATE POLICY "weekend_share_offers_insert" ON weekend_share_offers FOR INSERT TO authenticated
  WITH CHECK (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id())
  );
CREATE POLICY "weekend_share_offers_update" ON weekend_share_offers FOR UPDATE TO authenticated
  USING (true) WITH CHECK (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id())
  );
CREATE POLICY "weekend_share_offers_delete" ON weekend_share_offers FOR DELETE TO authenticated
  USING (
    current_admin_permission('delete_transactions')
    OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id())
  );

CREATE OR REPLACE FUNCTION set_commuter_schedule(p_work_city_id uuid, p_home_day smallint, p_back_day smallint)
RETURNS uuid AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'You must be signed in.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cities WHERE id = p_work_city_id AND is_active) THEN
    RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO commuter_schedules (portal_user_id, work_city_id, home_day, back_day)
  VALUES (v_portal_user_id, p_work_city_id, p_home_day, p_back_day)
  ON CONFLICT (portal_user_id) DO UPDATE SET
    work_city_id = EXCLUDED.work_city_id, home_day = EXCLUDED.home_day, back_day = EXCLUDED.back_day,
    is_active = true, updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION set_commuter_schedule(uuid, smallint, smallint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_commuter_schedule(uuid, smallint, smallint) TO authenticated;

-- match(commuter, ride): ride.cityId===commuter.workCityId && ride.sharing
-- && ride.seatsFree>0 && (direction==='toVillage' ? ride.day===commuter.homeDay
-- : ride.day===commuter.backDay) — the spec's rule, verbatim, split into
-- its two directions.
CREATE OR REPLACE FUNCTION my_commuter_matches() RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_schedule record;
  v_result jsonb;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'You must be signed in.' USING ERRCODE = 'P0001'; END IF;

  SELECT cs.*, c.name AS city_name, c.name_ur AS city_name_ur
  INTO v_schedule FROM commuter_schedules cs JOIN cities c ON c.id = cs.work_city_id
  WHERE cs.portal_user_id = v_portal_user_id AND cs.is_active;

  IF NOT FOUND THEN RETURN jsonb_build_object('schedule', null, 'to_village', '[]'::jsonb, 'to_city', '[]'::jsonb); END IF;

  v_result := jsonb_build_object(
    'schedule', jsonb_build_object(
      'id', v_schedule.id, 'work_city_id', v_schedule.work_city_id,
      'city_name', v_schedule.city_name, 'city_name_ur', v_schedule.city_name_ur,
      'home_day', v_schedule.home_day, 'back_day', v_schedule.back_day
    ),
    'to_village', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'offer_id', o.id, 'vehicle_id', o.vehicle_id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile,
        'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number, 'depart_time', o.depart_time,
        'seats_free', o.seats_total - o.seats_taken, 'fare_per_seat_pkr', o.fare_per_seat_pkr, 'day_of_week', o.day_of_week
      ) ORDER BY o.depart_time)
      FROM weekend_share_offers o JOIN vehicles v ON v.id = o.vehicle_id
      WHERE o.is_active AND o.city_id = v_schedule.work_city_id AND o.direction = 'to_village'
        AND o.day_of_week = v_schedule.home_day AND o.seats_taken < o.seats_total AND v.is_active
    ), '[]'::jsonb),
    'to_city', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'offer_id', o.id, 'vehicle_id', o.vehicle_id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile,
        'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number, 'depart_time', o.depart_time,
        'seats_free', o.seats_total - o.seats_taken, 'fare_per_seat_pkr', o.fare_per_seat_pkr, 'day_of_week', o.day_of_week
      ) ORDER BY o.depart_time)
      FROM weekend_share_offers o JOIN vehicles v ON v.id = o.vehicle_id
      WHERE o.is_active AND o.city_id = v_schedule.work_city_id AND o.direction = 'to_city'
        AND o.day_of_week = v_schedule.back_day AND o.seats_taken < o.seats_total AND v.is_active
    ), '[]'::jsonb)
  );
  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_commuter_matches() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_commuter_matches() TO authenticated;

-- Requesting a seat reuses start_negotiation (422) with kind='share' —
-- no separate booking table. The offer's fare is passed through as the
-- opening budget so the thread's auto-composed first message already
-- shows the asking price.
CREATE OR REPLACE FUNCTION request_share_seat(p_offer_id uuid) RETURNS uuid AS $$
DECLARE
  o weekend_share_offers%ROWTYPE;
  v_day_name text;
  v_thread_id uuid;
BEGIN
  SELECT * INTO o FROM weekend_share_offers WHERE id = p_offer_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'This share ride is not available.' USING ERRCODE = 'P0001'; END IF;
  IF o.seats_taken >= o.seats_total THEN RAISE EXCEPTION 'This share ride is full.' USING ERRCODE = 'P0001'; END IF;

  v_day_name := (ARRAY['Sun','Mon','Tue','Wed','Thu','Fri','Sat'])[o.day_of_week + 1];
  v_thread_id := start_negotiation(
    p_kind := 'share', p_vehicle_id := o.vehicle_id,
    p_item := 'Weekend seat · ' || v_day_name || ' · ' || (CASE WHEN o.direction = 'to_village' THEN 'to village' ELSE 'to city' END),
    p_qty := '1 seat', p_budget_pkr := o.fare_per_seat_pkr, p_city_id := o.city_id
  );
  RETURN v_thread_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION request_share_seat(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION request_share_seat(uuid) TO authenticated;

-- The vehicle owner nudges this as seats fill up / free up while chatting
-- with commuters — not tied to negotiation status, since agreement
-- happens in conversation, not a state machine.
CREATE OR REPLACE FUNCTION adjust_weekend_share_seats_taken(p_offer_id uuid, p_delta int) RETURNS void AS $$
DECLARE o weekend_share_offers%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
BEGIN
  SELECT * INTO o FROM weekend_share_offers WHERE id = p_offer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This share ride is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (v_is_admin OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = o.vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE weekend_share_offers SET seats_taken = seats_taken + p_delta WHERE id = p_offer_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION adjust_weekend_share_seats_taken(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION adjust_weekend_share_seats_taken(uuid, int) TO authenticated;

-- A vehicle owner's own offers, for their management screen.
CREATE OR REPLACE FUNCTION my_weekend_share_offers(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false); v_result jsonb;
BEGIN
  IF NOT (v_is_admin OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', o.id, 'city_id', o.city_id, 'city_name', c.name, 'city_name_ur', c.name_ur, 'direction', o.direction,
    'day_of_week', o.day_of_week, 'depart_time', o.depart_time, 'seats_total', o.seats_total,
    'seats_taken', o.seats_taken, 'fare_per_seat_pkr', o.fare_per_seat_pkr, 'is_active', o.is_active
  ) ORDER BY o.day_of_week, o.depart_time), '[]'::jsonb)
  INTO v_result FROM weekend_share_offers o JOIN cities c ON c.id = o.city_id WHERE o.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_weekend_share_offers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_weekend_share_offers(uuid) TO authenticated;
