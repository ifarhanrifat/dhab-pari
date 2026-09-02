-- Migration 417: ping_trip_offer_location (414) still required
-- status='open' to accept a location update. 415 decoupled *visibility*
-- (RLS + nearby_open_trips) from status, on the reasoning that an
-- adda-departed offer is deliberately closed to new fare proposals but
-- should still show its live position — but missed that the write path
-- itself has the exact same gate, one level upstream: adda_mark_departed
-- always sets status='closed' before turning sharing on, so every ping
-- from a departed adda vehicle was being rejected outright and no
-- location row could ever exist for 415's fix to surface. Found by
-- actually driving the flow end-to-end with a live test account rather
-- than trusting the earlier migration's own review.
--
-- Fix: gate purely on share_live_location (+ a fresh travel_date, same
-- as the read side), matching 415's stated intent exactly. A trip that's
-- had sharing turned off no longer has share_live_location=true at all
-- (set_trip_offer_live_sharing clears it), so this isn't a wider hole —
-- status is simply not the right signal for "should this still ping."
CREATE OR REPLACE FUNCTION ping_trip_offer_location(p_trip_offer_id uuid, p_lat decimal, p_lng decimal) RETURNS void AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); o vehicle_trip_offers%ROWTYPE;
BEGIN
  SELECT * INTO o FROM vehicle_trip_offers WHERE id = p_trip_offer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip offer not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = o.vehicle_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this trip.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT o.share_live_location OR o.travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN
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
