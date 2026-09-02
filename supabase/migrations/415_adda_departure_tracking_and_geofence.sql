-- Migration 415: several real gaps found from live testing on Altaf
-- Hussain's actual dispatch from the adda.
--
-- BUG: adda_mark_departed flips share_live_location=true on the trip
-- offer, but both the RLS policy and nearby_open_trips() (414) required
-- status='open' to show anything — and adda_mark_departed sets
-- status='closed' on that very same offer one statement earlier, so a
-- departed vehicle's live pin could never actually appear. Fixed by
-- decoupling "can this offer receive a NEW fare proposal" (still
-- status='open', unchanged in propose_trip_fare) from "is this offer's
-- position visible on the live map" (now purely share_live_location +
-- a fresh travel_date, regardless of status).
--
-- SECOND BUG (would have hidden this from the very vehicle tested):
-- adda_check_in only ever created a vehicle_trip_offers row for
-- fare_mode='request' — a fixed-fare check-in (what was actually used
-- in testing) had nowhere to put a live position at all. Now both fare
-- modes get a trip offer; a fixed-fare one carries the real fixed fare
-- as listed_fare_per_seat_pkr (a request-mode one keeps the 0 sentinel
-- from 410) so the rider-facing map can tell "this fare is fixed,
-- informational only" from "propose your own" without a new column.
--
-- NEW: a driver can only check himself in at an adda he is actually,
-- physically at — p_lat/p_lng are now real (optional) parameters,
-- geofenced against the adda's own pin with a 300m allowance for GPS
-- drift and the stand's own physical size. Skipped entirely for an
-- admin check-in (staff coordinating by phone isn't expected to be
-- standing at the stand with a GPS-enabled device) and skipped if the
-- adda has no pin set yet (nothing to geofence against — matches how
-- every other nullable-pin feature in this app degrades).
--
-- NEW: once departed, a vehicle only actually shows on the map once its
-- live position is genuinely away from the adda it left — otherwise a
-- driver who's checked "departed" but hasn't actually pulled out yet
-- would show as a second marker sitting right on top of the adda's own
-- pin, which isn't useful and reads as a glitch.
--
-- NEW: turning live sharing off on a plain (non-adda) posted trip now
-- also closes the trip offer itself — "stop sharing" means the posted
-- destination is cancelled, not paused; a driver who wants to go live
-- again (village→city or back) has to set a fresh destination, the same
-- way this was described. Adda-vehicles are unaffected by this — their
-- trip offer is spawned/closed by the check-in/departure lifecycle, not
-- by this toggle.

-- ─── 1. Un-gate visibility from status='open' ──────────────────────────
DROP POLICY IF EXISTS "trip_offer_locations_signed_in_read" ON vehicle_trip_offer_locations;
CREATE POLICY "trip_offer_locations_signed_in_read" ON vehicle_trip_offer_locations
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM vehicle_trip_offers o
    WHERE o.id = trip_offer_id AND o.share_live_location
      AND o.travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
  ));

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
  -- The adda this offer was spawned from, if any, and its pin — an
  -- adda-originated offer with no matching live queue entry anymore
  -- (the normal case once departed) still resolves via a plain equality
  -- join on adda_id captured at check-in time, not through the entry row.
  LEFT JOIN LATERAL (
    SELECT a.lat AS origin_lat, a.lng AS origin_lng FROM adda_queue_entries e JOIN addas a ON a.id = e.adda_id
    WHERE e.trip_offer_id = o.id ORDER BY e.created_at DESC LIMIT 1
  ) origin_adda ON true
  WHERE o.share_live_location
    AND o.travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
    AND l.updated_at > now() - interval '5 minutes'
    AND (p_destination IS NULL OR trim(p_destination) = '' OR o.destination ILIKE '%' || p_destination || '%' OR o.destination_ur ILIKE '%' || p_destination || '%')
    AND (p_lat IS NULL OR p_lng IS NULL OR (6371 * acos(least(1, greatest(-1,
        cos(radians(p_lat)) * cos(radians(l.lat)) * cos(radians(l.lng) - radians(p_lng))
        + sin(radians(p_lat)) * sin(radians(l.lat))
      )))) <= p_radius_km)
    -- Not still sitting at the adda he checked in at — see the migration header.
    AND (origin_adda.origin_lat IS NULL OR origin_adda.origin_lng IS NULL OR (6371 * acos(least(1, greatest(-1,
        cos(radians(origin_adda.origin_lat)) * cos(radians(l.lat)) * cos(radians(origin_adda.origin_lng) - radians(l.lng))
        + sin(radians(origin_adda.origin_lat)) * sin(radians(l.lat))
      )))) > 0.3);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Public-transport fares are set by the committee, once, per stand — not
-- typed in by each driver at check-in. Admin sets addas.fixed_fare_per_seat_pkr
-- (edit form, alongside the existing pin/turn-length fields); a 'fixed'
-- check-in always uses that rate, full stop. A ride-request check-in is
-- unaffected — that's still genuinely negotiated per ride, by design.
ALTER TABLE addas ADD COLUMN IF NOT EXISTS fixed_fare_per_seat_pkr decimal CHECK (fixed_fare_per_seat_pkr IS NULL OR fixed_fare_per_seat_pkr >= 0);
-- Seeded from the one real fare on record (Altaf Hussain's own test
-- check-in tonight, 150/seat) — an honest starting default, not a
-- claim this is the committee's actual approved rate; change it via
-- the admin Adda edit form.
UPDATE addas SET fixed_fare_per_seat_pkr = 150 WHERE fixed_fare_per_seat_pkr IS NULL;

-- ─── 2. adda_check_in: geofence, system fare, driver-adjustable seats ──
CREATE OR REPLACE FUNCTION adda_check_in(
  p_adda_id uuid, p_vehicle_id uuid, p_fare_mode varchar DEFAULT 'fixed',
  p_share_location_on_depart boolean DEFAULT false,
  p_lat decimal DEFAULT NULL, p_lng decimal DEFAULT NULL, p_seats_available int DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  a addas%ROWTYPE; ap addas%ROWTYPE; v vehicles%ROWTYPE; v_portal_user_id uuid := current_portal_user_id();
  v_queue_date date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_next_position int; v_entry_id uuid; v_trip_offer_id uuid; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
  v_distance_km decimal; v_seats int; v_fare decimal;
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
  IF v.commission_mode = 'per_order' AND seller_account_balance(ensure_vehicle_account(p_vehicle_id)) <= 0 THEN
    RAISE EXCEPTION 'Top up your wallet before checking in — an adda slot needs a positive balance.' USING ERRCODE = 'P0001';
  END IF;

  -- A driver checking himself in must actually be at the stand — skipped
  -- for an admin check-in on someone's behalf, and skipped if the adda
  -- has no pin set yet (nothing to compare against).
  IF NOT v_is_admin AND a.lat IS NOT NULL AND a.lng IS NOT NULL THEN
    IF p_lat IS NULL OR p_lng IS NULL THEN
      RAISE EXCEPTION 'Turn on your location to check in — we need to confirm you''re at the adda.' USING ERRCODE = 'P0001';
    END IF;
    v_distance_km := 6371 * acos(least(1, greatest(-1,
      cos(radians(p_lat)) * cos(radians(a.lat)) * cos(radians(p_lng) - radians(a.lng))
      + sin(radians(p_lat)) * sin(radians(a.lat)))));
    IF v_distance_km > 0.3 THEN
      RAISE EXCEPTION 'You need to be at the adda to check in — you appear to be % km away.', round(v_distance_km::numeric, 1) USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM adda_queue_entries WHERE vehicle_id = p_vehicle_id AND queue_date = v_queue_date AND status IN ('waiting', 'current')) THEN
    RAISE EXCEPTION 'This vehicle is already in a queue today.' USING ERRCODE = 'P0001';
  END IF;

  IF p_fare_mode NOT IN ('fixed', 'request') THEN RAISE EXCEPTION 'Invalid fare mode.' USING ERRCODE = 'P0001'; END IF;
  IF p_fare_mode = 'fixed' THEN
    IF a.fixed_fare_per_seat_pkr IS NULL THEN
      RAISE EXCEPTION 'This adda has no fare set yet — ask the committee to set one first.' USING ERRCODE = 'P0001';
    END IF;
    v_fare := a.fixed_fare_per_seat_pkr;
  ELSE
    v_fare := NULL;
  END IF;

  -- How many seats this check-in is actually offering — not always the
  -- vehicle's full capacity: a driver already carrying passengers who
  -- aren't in the booking system (picked up off-app, or already
  -- carrying riders from an earlier leg) sets however many are
  -- genuinely free right now. Defaults to the vehicle's full capacity
  -- when not given, same as before.
  v_seats := COALESCE(p_seats_available, v.total_seats);
  IF v_seats <= 0 OR v_seats > v.total_seats THEN
    RAISE EXCEPTION 'Enter how many seats are actually free (1 to %).', v.total_seats USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(MAX(position), 0) + 1 INTO v_next_position FROM adda_queue_entries
    WHERE adda_id = p_adda_id AND queue_date = v_queue_date AND status IN ('waiting', 'current');

  -- Both fare modes get a real trip offer now — it's what carries the
  -- destination + live position once departed, for either kind of fare.
  SELECT * INTO ap FROM addas WHERE id = a.pair_adda_id;
  INSERT INTO vehicle_trip_offers (vehicle_id, origin, origin_ur, destination, destination_ur, classification, travel_date, seats_available, listed_fare_per_seat_pkr)
  VALUES (p_vehicle_id, a.name, a.name_ur, COALESCE(ap.name, 'destination'), ap.name_ur, a.classification, v_queue_date, v_seats, COALESCE(v_fare, 0))
  RETURNING id INTO v_trip_offer_id;

  INSERT INTO adda_queue_entries (adda_id, vehicle_id, queue_date, position, status, fare_mode, fixed_fare_per_seat_pkr, trip_offer_id, seats_total, share_location_on_depart, checked_in_by_admin)
  VALUES (p_adda_id, p_vehicle_id, v_queue_date, v_next_position, 'waiting', p_fare_mode, v_fare, v_trip_offer_id, v_seats, p_share_location_on_depart,
    CASE WHEN v_is_admin AND v.portal_user_id IS DISTINCT FROM v_portal_user_id THEN current_admin_user_id() ELSE NULL END)
  RETURNING id INTO v_entry_id;

  PERFORM adda_promote_next(p_adda_id, v_queue_date);

  RETURN jsonb_build_object('entry_id', v_entry_id, 'trip_offer_id', v_trip_offer_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION adda_check_in(uuid, uuid, varchar, boolean, decimal, decimal, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION adda_check_in(uuid, uuid, varchar, boolean, decimal, decimal, int) TO authenticated;
-- The old signatures (driver-typed fare, no geofence, no seat override)
-- are superseded — drop them so nothing can accidentally call the old
-- behaviour.
DROP FUNCTION IF EXISTS adda_check_in(uuid, uuid, varchar, decimal, boolean);
DROP FUNCTION IF EXISTS adda_check_in(uuid, uuid, varchar, decimal, boolean, decimal, decimal);

-- ─── 3. Fare a "propose your own" offer's fixed-fare cousin distinctly ─
-- (no schema change needed — 0 vs a real amount on listed_fare_per_seat_pkr
-- already distinguishes them, per the migration header; nothing to add here.)

-- ─── 4. Turning sharing off cancels a plain (non-adda) posted trip ─────
CREATE OR REPLACE FUNCTION set_trip_offer_live_sharing(p_trip_offer_id uuid, p_on boolean) RETURNS void AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); o vehicle_trip_offers%ROWTYPE; v_from_adda boolean;
BEGIN
  SELECT * INTO o FROM vehicle_trip_offers WHERE id = p_trip_offer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip offer not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = o.vehicle_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this trip.' USING ERRCODE = 'P0001';
  END IF;

  IF p_on THEN
    UPDATE vehicle_trip_offers SET share_live_location = false
      WHERE vehicle_id = o.vehicle_id AND id <> p_trip_offer_id AND share_live_location;
    DELETE FROM vehicle_trip_offer_locations WHERE trip_offer_id IN (
      SELECT id FROM vehicle_trip_offers WHERE vehicle_id = o.vehicle_id AND id <> p_trip_offer_id
    );
    UPDATE vehicle_trip_offers SET share_live_location = true, live_location_started_at = now() WHERE id = p_trip_offer_id;
  ELSE
    UPDATE vehicle_trip_offers SET share_live_location = false WHERE id = p_trip_offer_id;
    DELETE FROM vehicle_trip_offer_locations WHERE trip_offer_id = p_trip_offer_id;

    -- A trip offer this app itself spawned from an adda check-in lives
    -- and dies with the queue entry's own lifecycle (check-in/pass/
    -- depart) — this toggle shouldn't cancel it out from under that.
    -- Only a plain, driver-posted destination (place_trip_offer, no
    -- originating queue entry) gets cancelled by turning sharing off.
    SELECT EXISTS (SELECT 1 FROM adda_queue_entries WHERE trip_offer_id = p_trip_offer_id) INTO v_from_adda;
    IF NOT v_from_adda THEN
      UPDATE vehicle_trip_offers SET status = 'closed' WHERE id = p_trip_offer_id AND status = 'open';
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION set_trip_offer_live_sharing(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_trip_offer_live_sharing(uuid, boolean) TO authenticated;
