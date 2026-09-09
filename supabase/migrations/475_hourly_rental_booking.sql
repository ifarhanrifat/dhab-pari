-- Hourly rental, phase 2: the actual booking + live-GPS overage billing,
-- confirmed directly. A direct booking (like ride_bookings), not a
-- negotiation thread — the price is formulaic (hourly_rate × hours),
-- there's nothing to haggle over.
--
-- Flow: customer requests a vehicle for N hours → owner accepts/declines
-- → owner starts the trip when the customer is actually picked up (GPS
-- tracking begins) → owner ends it when done (distance/overage computed
-- from the accumulated GPS trail) → financially settled the same way
-- every other per_order/monthly_lumpsum booking in this app already is
-- (confirm_ride_booking/confirm_shop_order's own commission-vs-gross-
-- voucher split, reused as-is).
--
-- Distance comes from real GPS pings (useLiveLocation, the same hook
-- already driving trip-offer live sharing), summed segment-by-segment
-- via haversine — not trusted blindly: a sub-20m segment is treated as
-- GPS jitter from a stationary phone and ignored, and a segment implying
-- over ~450km/h between two ~12s-apart pings is treated as a GPS
-- teleport glitch and ignored too. Neither threshold ever rejects real
-- village-road travel; both exist purely so a parked vehicle's own GPS
-- noise can't inflate the bill.

CREATE OR REPLACE FUNCTION haversine_km(p_lat1 decimal, p_lng1 decimal, p_lat2 decimal, p_lng2 decimal) RETURNS decimal AS $$
  SELECT 6371 * acos(least(1, greatest(-1,
    cos(radians(p_lat1)) * cos(radians(p_lat2)) * cos(radians(p_lng2) - radians(p_lng1))
    + sin(radians(p_lat1)) * sin(radians(p_lat2))
  )));
$$ LANGUAGE sql IMMUTABLE;

CREATE TABLE IF NOT EXISTS hourly_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  hours int NOT NULL CHECK (hours > 0),
  pickup_address text NOT NULL,
  -- Locked in at request time — a later committee rate change never
  -- retroactively changes an existing booking's price.
  hourly_rate_pkr decimal NOT NULL,
  included_km decimal NOT NULL,
  overage_per_km_pkr decimal NOT NULL,
  base_amount_pkr decimal NOT NULL,
  status varchar NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'accepted', 'declined', 'in_progress', 'completed', 'cancelled')),
  requested_at timestamptz DEFAULT now(),
  responded_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  distance_km decimal NOT NULL DEFAULT 0,
  overage_km decimal,
  overage_amount_pkr decimal,
  total_amount_pkr decimal,
  status_confirmed boolean NOT NULL DEFAULT false,
  commission_voucher_id uuid REFERENCES vouchers(id),
  gross_voucher_id uuid REFERENCES vouchers(id)
);
CREATE INDEX IF NOT EXISTS hourly_bookings_portal_user_idx ON hourly_bookings(portal_user_id);
CREATE INDEX IF NOT EXISTS hourly_bookings_vehicle_idx ON hourly_bookings(vehicle_id);

CREATE TABLE IF NOT EXISTS hourly_booking_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES hourly_bookings(id) ON DELETE CASCADE,
  lat decimal NOT NULL,
  lng decimal NOT NULL,
  recorded_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hourly_booking_locations_booking_idx ON hourly_booking_locations(booking_id, recorded_at);

-- No write policies on either table — every mutation goes through the
-- SECURITY DEFINER functions below.
ALTER TABLE hourly_bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hourly_bookings_parties_read" ON hourly_bookings FOR SELECT TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR portal_user_id = current_portal_user_id()
    OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id())
  );

ALTER TABLE hourly_booking_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hourly_booking_locations_parties_read" ON hourly_booking_locations FOR SELECT TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR EXISTS (
      SELECT 1 FROM hourly_bookings b WHERE b.id = booking_id AND (
        b.portal_user_id = current_portal_user_id()
        OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = b.vehicle_id AND v.portal_user_id = current_portal_user_id())
      )
    )
  );

CREATE OR REPLACE FUNCTION create_hourly_booking(p_vehicle_id uuid, p_hours int, p_pickup_address text) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v vehicles%ROWTYPE;
  v_booking_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_hours IS NULL OR p_hours <= 0 THEN RAISE EXCEPTION 'Enter how many hours you need.' USING ERRCODE = 'P0001'; END IF;
  IF p_pickup_address IS NULL OR trim(p_pickup_address) = '' THEN RAISE EXCEPTION 'Enter a pickup address.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active AND offers_hourly FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available for hourly booking.' USING ERRCODE = 'P0001'; END IF;
  IF v.hourly_rate_pkr IS NULL THEN RAISE EXCEPTION 'This vehicle has no rate set yet.' USING ERRCODE = 'P0001'; END IF;
  IF v.portal_user_id = v_portal_user_id THEN RAISE EXCEPTION 'You cannot book your own vehicle.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO hourly_bookings (portal_user_id, vehicle_id, hours, pickup_address, hourly_rate_pkr, included_km, overage_per_km_pkr, base_amount_pkr)
  VALUES (v_portal_user_id, p_vehicle_id, p_hours, trim(p_pickup_address), v.hourly_rate_pkr, COALESCE(v.hourly_included_km, 0) * p_hours, COALESCE(v.hourly_overage_per_km_pkr, 0), v.hourly_rate_pkr * p_hours)
  RETURNING id INTO v_booking_id;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'hourly_booking_requested', 'Hourly rental request',
      p_hours || ' hour(s) — Rs ' || round(v.hourly_rate_pkr * p_hours), '/portal/my-vehicle/hourly');
  END IF;

  RETURN v_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_hourly_booking(uuid, int, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_hourly_booking(uuid, int, text) TO authenticated;

CREATE OR REPLACE FUNCTION respond_hourly_booking(p_booking_id uuid, p_accept boolean) RETURNS void AS $$
DECLARE b hourly_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'requested' THEN RAISE EXCEPTION 'This booking has already been responded to.' USING ERRCODE = 'P0001'; END IF;

  UPDATE hourly_bookings SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END, responded_at = now() WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, CASE WHEN p_accept THEN 'hourly_booking_accepted' ELSE 'hourly_booking_declined' END,
    CASE WHEN p_accept THEN 'Booking accepted' ELSE 'Booking declined' END,
    CASE WHEN p_accept THEN v.owner_name || ' will pick you up.' ELSE 'This vehicle is not available for your booking.' END,
    '/portal/marketplace');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION respond_hourly_booking(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION respond_hourly_booking(uuid, boolean) TO authenticated;

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
  UPDATE hourly_bookings SET status = 'in_progress', started_at = now(), distance_km = 0 WHERE id = p_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION start_hourly_trip(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION start_hourly_trip(uuid) TO authenticated;

-- Raises (rather than silently no-op-ing) once the trip is no longer
-- in_progress — same convention TripLiveShareToggle's own ping RPC
-- already established: the client's onFix treats an error as "stop
-- pinging", not "retry the same ping."
CREATE OR REPLACE FUNCTION ping_hourly_trip_location(p_booking_id uuid, p_lat decimal, p_lng decimal) RETURNS void AS $$
DECLARE
  b hourly_bookings%ROWTYPE;
  v_last_lat decimal; v_last_lng decimal;
  v_segment_km decimal;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicles v2 WHERE v2.id = b.vehicle_id AND v2.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'in_progress' THEN RAISE EXCEPTION 'This trip is not in progress.' USING ERRCODE = 'P0001'; END IF;

  SELECT l.lat, l.lng INTO v_last_lat, v_last_lng FROM hourly_booking_locations l WHERE l.booking_id = p_booking_id ORDER BY l.recorded_at DESC LIMIT 1;

  INSERT INTO hourly_booking_locations (booking_id, lat, lng) VALUES (p_booking_id, p_lat, p_lng);

  IF v_last_lat IS NOT NULL THEN
    v_segment_km := haversine_km(v_last_lat, v_last_lng, p_lat, p_lng);
    IF v_segment_km > 0.02 AND v_segment_km < 1.5 THEN
      UPDATE hourly_bookings SET distance_km = distance_km + v_segment_km WHERE id = p_booking_id;
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION ping_hourly_trip_location(uuid, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ping_hourly_trip_location(uuid, decimal, decimal) TO authenticated;

CREATE OR REPLACE FUNCTION end_hourly_trip(p_booking_id uuid) RETURNS jsonb AS $$
DECLARE b hourly_bookings%ROWTYPE; v vehicles%ROWTYPE; v_overage_km decimal; v_overage_amount decimal; v_total decimal;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'in_progress' THEN RAISE EXCEPTION 'This trip is not in progress.' USING ERRCODE = 'P0001'; END IF;

  v_overage_km := greatest(0, b.distance_km - b.included_km);
  v_overage_amount := round(v_overage_km * b.overage_per_km_pkr, 2);
  v_total := b.base_amount_pkr + v_overage_amount;

  UPDATE hourly_bookings SET status = 'completed', ended_at = now(),
    overage_km = v_overage_km, overage_amount_pkr = v_overage_amount, total_amount_pkr = v_total
  WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'hourly_booking_completed', 'Trip completed',
    'Distance: ' || round(b.distance_km, 1) || 'km — Total: Rs ' || round(v_total), '/portal/marketplace');

  RETURN jsonb_build_object('distance_km', b.distance_km, 'overage_km', v_overage_km, 'overage_amount_pkr', v_overage_amount, 'total_amount_pkr', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION end_hourly_trip(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION end_hourly_trip(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION cancel_hourly_booking(p_booking_id uuid) RETURNS void AS $$
DECLARE b hourly_bookings%ROWTYPE; v vehicles%ROWTYPE; v_is_customer boolean; v_is_owner boolean; v_notify_id uuid;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  v_is_customer := b.portal_user_id = current_portal_user_id();
  v_is_owner := v.portal_user_id = current_portal_user_id();
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v_is_customer OR v_is_owner) THEN
    RAISE EXCEPTION 'You are not part of this booking.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status IN ('in_progress', 'completed', 'cancelled') THEN
    RAISE EXCEPTION 'This booking can no longer be cancelled.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE hourly_bookings SET status = 'cancelled' WHERE id = p_booking_id;

  v_notify_id := CASE WHEN v_is_customer THEN v.portal_user_id ELSE b.portal_user_id END;
  IF v_notify_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_notify_id, 'hourly_booking_cancelled', 'Booking cancelled', 'An hourly rental booking was cancelled.', '/portal/marketplace');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION cancel_hourly_booking(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancel_hourly_booking(uuid) TO authenticated;

-- Financial settlement — byte-for-byte the same commission-vs-gross-
-- voucher split confirm_ride_booking/confirm_shop_order already use,
-- just against a new marketplace_hourly_commission_pct setting. One
-- real simplification, flagged rather than silently guessed: unlike
-- shop_orders/ride_bookings, there's no announced payment-method field
-- here (hourly booking never had a proof-upload step at request time),
-- so the monthly_lumpsum branch always settles against cash (DP-1001).
-- Fine for the common per_order case; a lumpsum vehicle taking hourly
-- bookings would need that revisited.
CREATE OR REPLACE FUNCTION confirm_hourly_booking(p_booking_id uuid) RETURNS jsonb AS $$
DECLARE
  b hourly_bookings%ROWTYPE; v vehicles%ROWTYPE;
  v_vehicle_account uuid; v_cash_account uuid; v_commission_account uuid;
  v_commission_pct decimal; v_commission_amount decimal;
  v_gross_voucher_id uuid; v_gross_voucher_no varchar; v_commission_voucher_id uuid;
  v_is_keeper boolean;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'completed' THEN RAISE EXCEPTION 'This trip has not been completed yet.' USING ERRCODE = 'P0001'; END IF;
  IF b.status_confirmed THEN RAISE EXCEPTION 'This booking has already been settled.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;

  v_is_keeper := v.portal_user_id IS NOT NULL AND v.portal_user_id = current_portal_user_id() AND v.commission_mode = 'per_order';
  IF NOT (COALESCE(current_admin_permission('post_transactions'), false) OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  v_vehicle_account := ensure_vehicle_account(v.id);
  SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050';

  IF v.commission_mode = 'per_order' THEN
    v_commission_pct := COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_hourly_commission_pct'), 0);
    v_commission_amount := round(b.total_amount_pkr * v_commission_pct / 100, 2);

    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — hourly rental (' || b.hours || 'h, paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
      RETURNING id INTO v_commission_voucher_id;
    END IF;

    UPDATE hourly_bookings SET status_confirmed = true, commission_voucher_id = v_commission_voucher_id WHERE id = p_booking_id;
    PERFORM check_seller_balance_notify('vehicle', v.id);
    RETURN jsonb_build_object('amount', b.total_amount_pkr, 'commission', v_commission_amount);
  END IF;

  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-1001';

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Hourly rental (' || b.hours || 'h) — confirmed', b.total_amount_pkr, v_vehicle_account, v_cash_account, v.owner_name)
  RETURNING id, voucher_no INTO v_gross_voucher_id, v_gross_voucher_no;

  UPDATE hourly_bookings SET status_confirmed = true, gross_voucher_id = v_gross_voucher_id WHERE id = p_booking_id;
  RETURN jsonb_build_object('voucher_no', v_gross_voucher_no, 'amount', b.total_amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION confirm_hourly_booking(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION confirm_hourly_booking(uuid) TO authenticated;

-- Browse/list, jsonb-shaped (not RETURNS TABLE) — deliberately, this
-- session's own repeated ambiguous-column bug class only happens with
-- RETURNS TABLE's OUT parameters; a jsonb return has no such trap.
CREATE OR REPLACE FUNCTION hourly_bookable_vehicles() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'color', v.color, 'model', v.model,
    'has_ac', v.has_ac, 'hourly_rate_pkr', v.hourly_rate_pkr, 'hourly_included_km', v.hourly_included_km,
    'hourly_overage_per_km_pkr', v.hourly_overage_per_km_pkr,
    'cover_url', (SELECT m.url FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.is_cover LIMIT 1)
  ) ORDER BY v.owner_name), '[]'::jsonb)
  FROM vehicles v WHERE v.is_active AND v.offers_hourly AND v.hourly_rate_pkr IS NOT NULL;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION hourly_bookable_vehicles() TO authenticated, anon;

CREATE OR REPLACE FUNCTION my_hourly_bookings() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'hours', b.hours, 'status', b.status, 'pickup_address', b.pickup_address,
    'base_amount_pkr', b.base_amount_pkr, 'total_amount_pkr', b.total_amount_pkr, 'distance_km', b.distance_km,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color
  ) ORDER BY b.requested_at DESC), '[]'::jsonb)
  FROM hourly_bookings b JOIN vehicles v ON v.id = b.vehicle_id
  WHERE b.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_hourly_bookings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_hourly_bookings() TO authenticated;

CREATE OR REPLACE FUNCTION vehicle_hourly_bookings(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'hours', b.hours, 'status', b.status, 'pickup_address', b.pickup_address,
    'base_amount_pkr', b.base_amount_pkr, 'total_amount_pkr', b.total_amount_pkr, 'distance_km', b.distance_km,
    'included_km', b.included_km, 'overage_km', b.overage_km, 'overage_amount_pkr', b.overage_amount_pkr,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at, 'status_confirmed', b.status_confirmed,
    'customer_name', pu.full_name, 'customer_mobile', pu.mobile
  ) ORDER BY b.requested_at DESC), '[]'::jsonb) INTO v_result
  FROM hourly_bookings b JOIN portal_users pu ON pu.id = b.portal_user_id
  WHERE b.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_hourly_bookings(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_hourly_bookings(uuid) TO authenticated;

INSERT INTO site_settings (key, value, description) VALUES
  ('marketplace_hourly_commission_pct', '10', 'Committee''s commission on a confirmed hourly rental booking (per_order vehicles), as a percentage of the final total including any overage')
ON CONFLICT (key) DO NOTHING;

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('hourly_booking_requested', 'A customer requested an hourly rental booking', false, true),
  ('hourly_booking_accepted', 'An hourly rental booking was accepted', false, true),
  ('hourly_booking_declined', 'An hourly rental booking was declined', false, true),
  ('hourly_booking_completed', 'An hourly rental trip was completed', false, true),
  ('hourly_booking_cancelled', 'An hourly rental booking was cancelled', false, true)
ON CONFLICT (event_type) DO NOTHING;
