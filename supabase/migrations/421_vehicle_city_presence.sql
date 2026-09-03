-- Migration 421: "I am in Chakwal until 3pm" — an explicit driver
-- check-in, not GPS-derived. Per the design spec's own §7 ("Still to
-- build: presence check-in") and the owner's brief ("if any village
-- vehicle is in that city, the user sends it a message") — this is
-- exactly what nearby_open_trips (414) does NOT cover: that system is
-- about a vehicle physically live-tracked near the *village* on its way
-- home; this is a vehicle that has told the app it's *in a specific
-- city* right now, for however long, regardless of whether it's live-
-- sharing GPS at all. Two independent concepts, deliberately not merged.
--
-- One active presence per vehicle at a time (same "one live row" pattern
-- adda_queue_one_live_per_vehicle already established) — a vehicle can't
-- honestly be checked into two cities simultaneously.
CREATE TABLE IF NOT EXISTS vehicle_city_presence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  city_id uuid NOT NULL REFERENCES cities(id),
  checked_in_at timestamptz NOT NULL DEFAULT now(),
  expected_return_at timestamptz,
  checked_out_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_city_presence_one_live_per_vehicle
  ON vehicle_city_presence(vehicle_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS vehicle_city_presence_city_id_idx ON vehicle_city_presence(city_id) WHERE is_active;

ALTER TABLE vehicle_city_presence ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_vehicle_city_presence" ON vehicle_city_presence FOR SELECT USING (true);
CREATE POLICY "vehicle_city_presence_write" ON vehicle_city_presence FOR ALL TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id())
  )
  WITH CHECK (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id())
  );

CREATE OR REPLACE FUNCTION vehicle_check_in_city(p_vehicle_id uuid, p_city_id uuid, p_expected_return_at timestamptz DEFAULT NULL)
RETURNS uuid AS $$
DECLARE
  v vehicles%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
  v_id uuid;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cities WHERE id = p_city_id AND is_active) THEN
    RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001';
  END IF;

  -- Re-checking in (a new city, or the same one with a fresh return
  -- time) supersedes whatever was there before rather than erroring —
  -- a driver moving from Chakwal to Rawalpindi mid-trip shouldn't have
  -- to explicitly check out first.
  UPDATE vehicle_city_presence SET is_active = false, checked_out_at = now()
    WHERE vehicle_id = p_vehicle_id AND is_active;

  INSERT INTO vehicle_city_presence (vehicle_id, city_id, expected_return_at)
  VALUES (p_vehicle_id, p_city_id, p_expected_return_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_check_in_city(uuid, uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_check_in_city(uuid, uuid, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION vehicle_check_out_city(p_vehicle_id uuid) RETURNS void AS $$
DECLARE v vehicles%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE vehicle_city_presence SET is_active = false, checked_out_at = now()
    WHERE vehicle_id = p_vehicle_id AND is_active;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_check_out_city(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_check_out_city(uuid) TO authenticated;

-- Read: every vehicle currently present in a given city and willing to
-- deliver — tier 1 of the dispatch broadcast (423) and the city-fetch
-- rider list both read straight off this, not off the raw table, so
-- both stay consistent by construction if the eligibility rule ever
-- changes (right now: presence.is_active AND vehicles.delivers AND
-- vehicles.is_active).
CREATE OR REPLACE FUNCTION vehicles_present_in_city(p_city_id uuid)
RETURNS TABLE(vehicle_id uuid, owner_name varchar, owner_mobile varchar, vehicle_type varchar, vehicle_number varchar, checked_in_at timestamptz, expected_return_at timestamptz) AS $$
  SELECT v.id, v.owner_name, v.owner_mobile, v.vehicle_type, v.vehicle_number, p.checked_in_at, p.expected_return_at
  FROM vehicle_city_presence p
  JOIN vehicles v ON v.id = p.vehicle_id
  WHERE p.city_id = p_city_id AND p.is_active AND v.is_active AND v.delivers
  ORDER BY p.checked_in_at ASC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicles_present_in_city(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicles_present_in_city(uuid) TO authenticated;
