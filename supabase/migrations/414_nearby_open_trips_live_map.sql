-- Migration 414: the public "nearby open trips" map — a driver heading
-- back from a city shares his live position on an *open* (not yet
-- booked) trip offer, and any signed-in rider can see him on a map
-- before a match exists, not just after one's already agreed (that
-- already-built case is vehicle_trip_locations/400, a private 1:1
-- channel for a confirmed booking only).
--
-- Deliberately a NEW table rather than reusing vehicle_trip_locations —
-- that table's PK is (trip_booking_id, role) with a NOT NULL FK to
-- vehicle_trip_bookings, and its RLS policy is the sole privacy
-- guarantee for a confirmed booking's two matched parties. Bending it to
-- also carry a public, pre-match broadcast would mean widening that
-- policy — the exact risk of leaking a private position is avoided by
-- construction, not by carefully editing, when it's just a separate table.
--
-- share_live_location / live_location_started_at on vehicle_trip_offers
-- already exist (migration 412, added early so adda_mark_departed had
-- somewhere to flip them) — this migration is what actually makes them
-- do something.

CREATE TABLE IF NOT EXISTS vehicle_trip_offer_locations (
  trip_offer_id uuid PRIMARY KEY REFERENCES vehicle_trip_offers(id) ON DELETE CASCADE,
  lat decimal NOT NULL,
  lng decimal NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Readable by any signed-in rider, but only for an offer that's actually
-- still open, still sharing, and not stale-dated — a driver flipping
-- sharing off (set_trip_offer_live_sharing below) deletes the row
-- outright, so "the row exists" already implies "currently sharing";
-- this policy is the second, independent guarantee of the same thing.
-- TO authenticated (not anon/public) since a signed-out visitor can't do
-- anything with a live GPS pin anyway — propose_trip_fare already
-- requires sign-in (400) — no reason to let it be scraped.
ALTER TABLE vehicle_trip_offer_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "trip_offer_locations_signed_in_read" ON vehicle_trip_offer_locations
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM vehicle_trip_offers o
    WHERE o.id = trip_offer_id AND o.status = 'open' AND o.share_live_location
      AND o.travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
  ));
-- Writes only via ping_trip_offer_location() below.

CREATE OR REPLACE FUNCTION set_trip_offer_live_sharing(p_trip_offer_id uuid, p_on boolean) RETURNS void AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); o vehicle_trip_offers%ROWTYPE;
BEGIN
  SELECT * INTO o FROM vehicle_trip_offers WHERE id = p_trip_offer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip offer not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = o.vehicle_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this trip.' USING ERRCODE = 'P0001';
  END IF;

  IF p_on THEN
    -- One van, one broadcast — switching this offer on turns every other
    -- open offer of the same vehicle off first, and clears their stale
    -- position rows rather than leaving two live pins for one vehicle.
    UPDATE vehicle_trip_offers SET share_live_location = false
      WHERE vehicle_id = o.vehicle_id AND id <> p_trip_offer_id AND share_live_location;
    DELETE FROM vehicle_trip_offer_locations WHERE trip_offer_id IN (
      SELECT id FROM vehicle_trip_offers WHERE vehicle_id = o.vehicle_id AND id <> p_trip_offer_id
    );
    UPDATE vehicle_trip_offers SET share_live_location = true, live_location_started_at = now() WHERE id = p_trip_offer_id;
  ELSE
    UPDATE vehicle_trip_offers SET share_live_location = false WHERE id = p_trip_offer_id;
    DELETE FROM vehicle_trip_offer_locations WHERE trip_offer_id = p_trip_offer_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION set_trip_offer_live_sharing(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_trip_offer_live_sharing(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION ping_trip_offer_location(p_trip_offer_id uuid, p_lat decimal, p_lng decimal) RETURNS void AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); o vehicle_trip_offers%ROWTYPE;
BEGIN
  SELECT * INTO o FROM vehicle_trip_offers WHERE id = p_trip_offer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip offer not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = o.vehicle_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this trip.' USING ERRCODE = 'P0001';
  END IF;
  IF o.status <> 'open' OR NOT o.share_live_location THEN
    -- Raises on purpose (rather than a silent no-op) so the client's
    -- watcher learns sharing was switched off elsewhere and stops,
    -- instead of quietly pinging into the void.
    RAISE EXCEPTION 'Live sharing is not active for this trip.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO vehicle_trip_offer_locations (trip_offer_id, lat, lng, updated_at)
  VALUES (p_trip_offer_id, p_lat, p_lng, now())
  ON CONFLICT (trip_offer_id) DO UPDATE SET lat = p_lat, lng = p_lng, updated_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION ping_trip_offer_location(uuid, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ping_trip_offer_location(uuid, decimal, decimal) TO authenticated;

-- The rider-facing read: every open, live-sharing trip whose destination
-- text matches, with the driver's live position and (if the rider passed
-- their own position) a straight-line distance — good enough for "is he
-- still near me, heading where I'm going", not a routed ETA. Matches the
-- codebase's existing search_marketplace_products()/route_seats_available()
-- convention of a single read RPC building the whole response.
CREATE OR REPLACE FUNCTION nearby_open_trips(p_destination text DEFAULT NULL, p_lat decimal DEFAULT NULL, p_lng decimal DEFAULT NULL, p_radius_km decimal DEFAULT 25)
RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'trip_offer_id', o.id, 'vehicle_id', o.vehicle_id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile,
    'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
    'origin', o.origin, 'origin_ur', o.origin_ur, 'destination', o.destination, 'destination_ur', o.destination_ur,
    'classification', o.classification, 'travel_date', o.travel_date, 'seats_available', o.seats_available,
    'listed_fare_per_seat_pkr', o.listed_fare_per_seat_pkr,
    'lat', l.lat, 'lng', l.lng, 'updated_at', l.updated_at,
    'distance_km', CASE WHEN p_lat IS NOT NULL AND p_lng IS NOT NULL THEN
      round((6371 * acos(least(1, greatest(-1,
        cos(radians(p_lat)) * cos(radians(l.lat)) * cos(radians(l.lng) - radians(p_lng))
        + sin(radians(p_lat)) * sin(radians(l.lat))
      ))))::numeric, 1)
    ELSE NULL END
  ) ORDER BY l.updated_at DESC), '[]'::jsonb)
  FROM vehicle_trip_offers o
  JOIN vehicles v ON v.id = o.vehicle_id
  JOIN vehicle_trip_offer_locations l ON l.trip_offer_id = o.id
  WHERE o.status = 'open' AND o.share_live_location
    AND o.travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
    AND l.updated_at > now() - interval '5 minutes'
    AND (p_destination IS NULL OR trim(p_destination) = '' OR o.destination ILIKE '%' || p_destination || '%' OR o.destination_ur ILIKE '%' || p_destination || '%')
    AND (p_lat IS NULL OR p_lng IS NULL OR (6371 * acos(least(1, greatest(-1,
        cos(radians(p_lat)) * cos(radians(l.lat)) * cos(radians(l.lng) - radians(p_lng))
        + sin(radians(p_lat)) * sin(radians(l.lat))
      )))) <= p_radius_km);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION nearby_open_trips(text, decimal, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION nearby_open_trips(text, decimal, decimal, decimal) TO authenticated;
