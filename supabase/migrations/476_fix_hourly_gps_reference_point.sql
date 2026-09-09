-- Real bug caught by live testing before this ever reached a real trip:
-- ping_hourly_trip_location compared every new fix against whatever the
-- LATEST inserted row was — including a rejected implausible-jump row.
-- Once a genuine GPS glitch landed (a real, if rare, one-off phone GPS
-- artifact), every subsequent real movement got measured against that
-- glitch's faraway coordinates instead of the last known-good position,
-- so it ALSO measured as an implausible jump and got rejected too — and
-- so did every ping after that, forever. One bad fix would have
-- silently blackholed the rest of the trip's distance.
--
-- last_lat/last_lng now live on hourly_bookings itself as the tracked
-- "reference point," advanced only when a fix is actually accepted
-- (real movement OR stationary jitter) — never on a rejected implausible
-- jump, so the next real fix is still compared against solid ground.
-- Every raw fix is still inserted into hourly_booking_locations either
-- way, so the full trail (including rejected/glitch fixes) stays
-- available to look at, just never used as the comparison baseline.
ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS last_lat decimal;
ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS last_lng decimal;

CREATE OR REPLACE FUNCTION ping_hourly_trip_location(p_booking_id uuid, p_lat decimal, p_lng decimal) RETURNS void AS $$
DECLARE
  b hourly_bookings%ROWTYPE;
  v_segment_km decimal;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicles v2 WHERE v2.id = b.vehicle_id AND v2.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'in_progress' THEN RAISE EXCEPTION 'This trip is not in progress.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO hourly_booking_locations (booking_id, lat, lng) VALUES (p_booking_id, p_lat, p_lng);

  IF b.last_lat IS NULL THEN
    -- First fix of the trip — nothing to measure against yet.
    UPDATE hourly_bookings SET last_lat = p_lat, last_lng = p_lng WHERE id = p_booking_id;
    RETURN;
  END IF;

  v_segment_km := haversine_km(b.last_lat, b.last_lng, p_lat, p_lng);

  IF v_segment_km >= 1.5 THEN
    -- Implausible one-ping jump (~450km/h+ at the app's own 12s ping
    -- interval) — a GPS glitch, not real travel. Reject the distance
    -- AND leave last_lat/last_lng exactly where they were, so the next
    -- fix is still measured against real ground, not this glitch.
    RETURN;
  END IF;

  -- Either real movement or stationary jitter below the noise floor —
  -- both advance the reference point; only real movement (> 20m) adds
  -- to the running total. Advancing on jitter too matters just as much
  -- as rejecting the glitch: without it, the reference point goes
  -- stale while parked, and a long string of sub-threshold wobbles away
  -- from an old anchor can add up to looking like one big implausible
  -- jump by the time real movement resumes.
  IF v_segment_km > 0.02 THEN
    UPDATE hourly_bookings SET distance_km = distance_km + v_segment_km, last_lat = p_lat, last_lng = p_lng WHERE id = p_booking_id;
  ELSE
    UPDATE hourly_bookings SET last_lat = p_lat, last_lng = p_lng WHERE id = p_booking_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- start_hourly_trip also needs to clear last_lat/last_lng on a fresh
-- start (distance_km was already reset to 0 here; the reference point
-- needs the same treatment so a re-started/re-tested trip doesn't
-- silently inherit a stale anchor from some earlier state).
CREATE OR REPLACE FUNCTION start_hourly_trip(p_booking_id uuid) RETURNS void AS $$
DECLARE b hourly_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'accepted' THEN RAISE EXCEPTION 'This booking is not ready to start.' USING ERRCODE = 'P0001'; END IF;
  UPDATE hourly_bookings SET status = 'in_progress', started_at = now(), distance_km = 0, last_lat = NULL, last_lng = NULL WHERE id = p_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
