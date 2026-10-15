-- Migration 653: point-to-point vehicle rental, ported from the design
-- file's own distinct "rental" vertical (sheetRentBook/priceRental) —
-- confirmed structurally different from our existing hourly_bookings
-- (rate × hours, single fixed pickup): rental is base + per-km distance
-- between a REAL pickup and destination + a one-way/return multiplier +
-- an optional wait fee for a return trip, computed once at request time
-- (no live-GPS overage tracking the way hourly has, since both ends of
-- the trip are already known up front).
--
-- Two scope decisions, approved directly rather than guessed:
-- 1. Rate is committee-set PER VEHICLE (base_pkr + per_km_pkr + a
--    wait_hour_pkr for return trips), matching hourly/equipment/shadi's
--    existing self-service-opt-in-but-committee-priced pattern — not
--    the design's own single shared car/van class tariff, which would
--    be the one inconsistent pricing model in this app.
-- 2. The design's "approach fee" (extra charge if the vehicle has to
--    travel >15km from its CURRENT position to reach the pickup point)
--    is deliberately NOT implemented — this app has no live vehicle-
--    position data before a trip starts (only during an active one,
--    via hourly_booking_locations-style GPS pings), and fabricating a
--    stand-in position just to bill a fee off it would be worse than
--    not charging it. Base + distance + wait fee only.
--
-- Distance uses the same "road ≈ straight-line × 1.3" approximation the
-- design itself uses (its own road() helper) via the existing
-- haversine_km() (475) — not a new invented fudge factor, the one the
-- source file already specifies.

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS offers_rental boolean NOT NULL DEFAULT false;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS rental_base_pkr decimal CHECK (rental_base_pkr IS NULL OR rental_base_pkr >= 0);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS rental_per_km_pkr decimal CHECK (rental_per_km_pkr IS NULL OR rental_per_km_pkr >= 0);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS rental_wait_hour_pkr decimal CHECK (rental_wait_hour_pkr IS NULL OR rental_wait_hour_pkr >= 0);

CREATE TABLE IF NOT EXISTS rental_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  from_address text NOT NULL, from_lat decimal, from_lng decimal,
  to_address text NOT NULL, to_lat decimal, to_lng decimal,
  trip_type varchar NOT NULL CHECK (trip_type IN ('one', 'return')),
  wait_hours int NOT NULL DEFAULT 0 CHECK (wait_hours >= 0),
  km decimal NOT NULL CHECK (km > 0),
  -- Locked in at request time, same reasoning as every other vertical's
  -- own rate columns — a later committee rate change never retroactively
  -- changes an existing booking's price.
  base_amount_pkr decimal NOT NULL,
  trip_amount_pkr decimal NOT NULL,
  wait_amount_pkr decimal NOT NULL DEFAULT 0,
  total_amount_pkr decimal NOT NULL,
  pin varchar(4) NOT NULL,
  status varchar NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'accepted', 'declined', 'in_progress', 'completed', 'cancelled')),
  decline_reason text,
  requested_at timestamptz DEFAULT now(),
  responded_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  status_confirmed boolean NOT NULL DEFAULT false,
  commission_voucher_id uuid REFERENCES vouchers(id),
  gross_voucher_id uuid REFERENCES vouchers(id)
);
CREATE INDEX IF NOT EXISTS rental_bookings_portal_user_idx ON rental_bookings(portal_user_id);
CREATE INDEX IF NOT EXISTS rental_bookings_vehicle_idx ON rental_bookings(vehicle_id);

ALTER TABLE rental_bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rental_bookings_parties_read" ON rental_bookings FOR SELECT TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR portal_user_id = current_portal_user_id()
    OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id())
  );
-- No write policy — every mutation goes through the SECURITY DEFINER
-- functions below.

CREATE OR REPLACE FUNCTION create_rental_booking(
  p_vehicle_id uuid, p_from_address text, p_from_lat decimal, p_from_lng decimal,
  p_to_address text, p_to_lat decimal, p_to_lng decimal, p_trip_type varchar, p_wait_hours int DEFAULT 0
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v vehicles%ROWTYPE;
  v_km decimal; v_trip_amount decimal; v_wait_amount decimal; v_total decimal;
  v_booking_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_trip_type NOT IN ('one', 'return') THEN RAISE EXCEPTION 'Choose one-way or return.' USING ERRCODE = 'P0001'; END IF;
  IF p_from_address IS NULL OR trim(p_from_address) = '' THEN RAISE EXCEPTION 'Enter a pickup location.' USING ERRCODE = 'P0001'; END IF;
  IF p_to_address IS NULL OR trim(p_to_address) = '' THEN RAISE EXCEPTION 'Enter a destination.' USING ERRCODE = 'P0001'; END IF;
  IF p_from_lat IS NULL OR p_from_lng IS NULL OR p_to_lat IS NULL OR p_to_lng IS NULL THEN
    RAISE EXCEPTION 'Pin both the pickup and destination on the map.' USING ERRCODE = 'P0001';
  END IF;
  IF p_wait_hours IS NULL OR p_wait_hours < 0 THEN p_wait_hours := 0; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active AND offers_rental FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available for rental.' USING ERRCODE = 'P0001'; END IF;
  IF v.rental_base_pkr IS NULL OR v.rental_per_km_pkr IS NULL THEN RAISE EXCEPTION 'This vehicle has no rate set yet.' USING ERRCODE = 'P0001'; END IF;
  IF v.portal_user_id = v_portal_user_id THEN RAISE EXCEPTION 'You cannot book your own vehicle.' USING ERRCODE = 'P0001'; END IF;

  v_km := greatest(1, round(haversine_km(p_from_lat, p_from_lng, p_to_lat, p_to_lng) * 1.3));
  -- One-way trip bills the one-way distance at a 1.5× multiplier (the
  -- vehicle still has to drive back empty); a return trip bills the
  -- full there-and-back distance at the plain rate — exactly the
  -- design's own priceRental() split.
  v_trip_amount := round(CASE WHEN p_trip_type = 'return' THEN v_km * 2 * v.rental_per_km_pkr ELSE v_km * v.rental_per_km_pkr * 1.5 END, 2);
  v_wait_amount := CASE WHEN p_trip_type = 'return' THEN p_wait_hours * COALESCE(v.rental_wait_hour_pkr, 0) ELSE 0 END;
  v_total := v.rental_base_pkr + v_trip_amount + v_wait_amount;

  INSERT INTO rental_bookings (
    portal_user_id, vehicle_id, from_address, from_lat, from_lng, to_address, to_lat, to_lng,
    trip_type, wait_hours, km, base_amount_pkr, trip_amount_pkr, wait_amount_pkr, total_amount_pkr, pin
  ) VALUES (
    v_portal_user_id, p_vehicle_id, trim(p_from_address), p_from_lat, p_from_lng, trim(p_to_address), p_to_lat, p_to_lng,
    p_trip_type, p_wait_hours, v_km, v.rental_base_pkr, v_trip_amount, v_wait_amount, v_total, lpad(floor(random() * 10000)::text, 4, '0')
  ) RETURNING id INTO v_booking_id;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'rental_booking_requested', 'Vehicle rental request',
      round(v_km) || 'km ' || (CASE WHEN p_trip_type = 'return' THEN 'return' ELSE 'one-way' END) || ' — Rs ' || round(v_total), '/portal/my-vehicle/rental');
  END IF;

  RETURN v_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_rental_booking(uuid, text, decimal, decimal, text, decimal, decimal, varchar, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_rental_booking(uuid, text, decimal, decimal, text, decimal, decimal, varchar, int) TO authenticated;

CREATE OR REPLACE FUNCTION respond_rental_booking(p_booking_id uuid, p_accept boolean, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE b rental_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM rental_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'requested' THEN RAISE EXCEPTION 'This booking has already been responded to.' USING ERRCODE = 'P0001'; END IF;

  UPDATE rental_bookings SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END,
    responded_at = now(), decline_reason = CASE WHEN p_accept THEN NULL ELSE p_reason END
  WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, CASE WHEN p_accept THEN 'rental_booking_accepted' ELSE 'rental_booking_declined' END,
    CASE WHEN p_accept THEN 'Booking accepted' ELSE 'Booking declined' END,
    CASE WHEN p_accept THEN v.owner_name || ' will pick you up.'
      ELSE 'This vehicle is not available for your booking.' || COALESCE(' — ' || p_reason, '') END,
    '/portal/marketplace');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION respond_rental_booking(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION respond_rental_booking(uuid, boolean, text) TO authenticated;

CREATE OR REPLACE FUNCTION start_rental_trip(p_booking_id uuid, p_pin varchar) RETURNS void AS $$
DECLARE b rental_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM rental_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'accepted' THEN RAISE EXCEPTION 'This booking is not ready to start.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM rental_bookings other WHERE other.vehicle_id = b.vehicle_id AND other.id <> b.id AND other.status = 'in_progress') THEN
    RAISE EXCEPTION 'This vehicle is already on another trip — end that one first.' USING ERRCODE = 'P0001';
  END IF;
  IF trim(COALESCE(p_pin, '')) <> b.pin THEN
    RAISE EXCEPTION 'Incorrect PIN — ask the rider for the 4-digit code shown in their app.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE rental_bookings SET status = 'in_progress', started_at = now() WHERE id = p_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION start_rental_trip(uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION start_rental_trip(uuid, varchar) TO authenticated;

CREATE OR REPLACE FUNCTION end_rental_trip(p_booking_id uuid) RETURNS jsonb AS $$
DECLARE b rental_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM rental_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'in_progress' THEN RAISE EXCEPTION 'This trip is not in progress.' USING ERRCODE = 'P0001'; END IF;

  UPDATE rental_bookings SET status = 'completed', ended_at = now() WHERE id = p_booking_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'rental_booking_completed', 'Trip completed', 'Total: Rs ' || round(b.total_amount_pkr), '/portal/marketplace');

  RETURN jsonb_build_object('total_amount_pkr', b.total_amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION end_rental_trip(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION end_rental_trip(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION cancel_rental_booking(p_booking_id uuid) RETURNS void AS $$
DECLARE b rental_bookings%ROWTYPE; v vehicles%ROWTYPE; v_is_customer boolean; v_is_owner boolean; v_notify_id uuid;
BEGIN
  SELECT * INTO b FROM rental_bookings WHERE id = p_booking_id FOR UPDATE;
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

  UPDATE rental_bookings SET status = 'cancelled' WHERE id = p_booking_id;

  v_notify_id := CASE WHEN v_is_customer THEN v.portal_user_id ELSE b.portal_user_id END;
  IF v_notify_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_notify_id, 'rental_booking_cancelled', 'Booking cancelled', 'A rental booking was cancelled.', '/portal/marketplace');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION cancel_rental_booking(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancel_rental_booking(uuid) TO authenticated;

-- Financial settlement — byte-for-byte the same commission-vs-gross-
-- voucher split confirm_hourly_booking (475) already uses, against its
-- own new marketplace_rental_commission_pct setting.
CREATE OR REPLACE FUNCTION confirm_rental_booking(p_booking_id uuid) RETURNS jsonb AS $$
DECLARE
  b rental_bookings%ROWTYPE; v vehicles%ROWTYPE;
  v_vehicle_account uuid; v_cash_account uuid; v_commission_account uuid;
  v_commission_pct decimal; v_commission_amount decimal;
  v_gross_voucher_id uuid; v_gross_voucher_no varchar; v_commission_voucher_id uuid;
  v_is_keeper boolean;
BEGIN
  SELECT * INTO b FROM rental_bookings WHERE id = p_booking_id FOR UPDATE;
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
    v_commission_pct := COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_rental_commission_pct'), 0);
    v_commission_amount := round(b.total_amount_pkr * v_commission_pct / 100, 2);

    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — vehicle rental (' || round(b.km) || 'km, paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
      RETURNING id INTO v_commission_voucher_id;
    END IF;

    UPDATE rental_bookings SET status_confirmed = true, commission_voucher_id = v_commission_voucher_id WHERE id = p_booking_id;
    PERFORM check_seller_balance_notify('vehicle', v.id);
    RETURN jsonb_build_object('amount', b.total_amount_pkr, 'commission', v_commission_amount);
  END IF;

  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-1001';

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Vehicle rental (' || round(b.km) || 'km) — confirmed', b.total_amount_pkr, v_vehicle_account, v_cash_account, v.owner_name)
  RETURNING id, voucher_no INTO v_gross_voucher_id, v_gross_voucher_no;

  UPDATE rental_bookings SET status_confirmed = true, gross_voucher_id = v_gross_voucher_id WHERE id = p_booking_id;
  RETURN jsonb_build_object('voucher_no', v_gross_voucher_no, 'amount', b.total_amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION confirm_rental_booking(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION confirm_rental_booking(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION rental_bookable_vehicles() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'color', v.color, 'model', v.model,
    'has_ac', v.has_ac, 'rental_base_pkr', v.rental_base_pkr, 'rental_per_km_pkr', v.rental_per_km_pkr, 'rental_wait_hour_pkr', v.rental_wait_hour_pkr,
    'cover_url', (SELECT m.url FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.is_cover LIMIT 1)
  ) ORDER BY v.owner_name), '[]'::jsonb)
  FROM vehicles v WHERE v.is_active AND v.offers_rental AND v.rental_base_pkr IS NOT NULL AND v.rental_per_km_pkr IS NOT NULL;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION rental_bookable_vehicles() TO authenticated, anon;

CREATE OR REPLACE FUNCTION my_rental_bookings() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'from_address', b.from_address, 'from_lat', b.from_lat, 'from_lng', b.from_lng,
    'to_address', b.to_address, 'to_lat', b.to_lat, 'to_lng', b.to_lng, 'trip_type', b.trip_type, 'wait_hours', b.wait_hours,
    'km', b.km, 'status', b.status, 'decline_reason', b.decline_reason, 'pin', b.pin,
    'base_amount_pkr', b.base_amount_pkr, 'trip_amount_pkr', b.trip_amount_pkr, 'wait_amount_pkr', b.wait_amount_pkr, 'total_amount_pkr', b.total_amount_pkr,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'vehicle_id', b.vehicle_id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color
  ) ORDER BY b.requested_at DESC), '[]'::jsonb)
  FROM rental_bookings b JOIN vehicles v ON v.id = b.vehicle_id
  WHERE b.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_rental_bookings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_rental_bookings() TO authenticated;

CREATE OR REPLACE FUNCTION vehicle_rental_bookings(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'from_address', b.from_address, 'from_lat', b.from_lat, 'from_lng', b.from_lng,
    'to_address', b.to_address, 'to_lat', b.to_lat, 'to_lng', b.to_lng, 'trip_type', b.trip_type, 'wait_hours', b.wait_hours,
    'km', b.km, 'status', b.status, 'decline_reason', b.decline_reason,
    'base_amount_pkr', b.base_amount_pkr, 'trip_amount_pkr', b.trip_amount_pkr, 'wait_amount_pkr', b.wait_amount_pkr, 'total_amount_pkr', b.total_amount_pkr, 'status_confirmed', b.status_confirmed,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at,
    'customer_portal_user_id', pu.id, 'customer_name', pu.full_name, 'customer_mobile', pu.mobile, 'customer_trust', portal_user_trust(pu.id)
  ) ORDER BY b.requested_at DESC), '[]'::jsonb) INTO v_result
  FROM rental_bookings b JOIN portal_users pu ON pu.id = b.portal_user_id
  WHERE b.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_rental_bookings(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_rental_bookings(uuid) TO authenticated;

INSERT INTO site_settings (key, value, description) VALUES
  ('marketplace_rental_commission_pct', '10', 'Committee''s commission on a confirmed point-to-point rental booking (per_order vehicles), as a percentage of the final total')
ON CONFLICT DO NOTHING;

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('rental_booking_requested', 'A customer requested a vehicle rental booking', false, true),
  ('rental_booking_accepted', 'A vehicle rental booking was accepted', false, true),
  ('rental_booking_declined', 'A vehicle rental booking was declined', false, true),
  ('rental_booking_completed', 'A vehicle rental trip was completed', false, true),
  ('rental_booking_cancelled', 'A vehicle rental booking was cancelled', false, true)
ON CONFLICT DO NOTHING;

-- ── ratings + disputes coverage, same pattern as 650 ─────────────────
ALTER TABLE ratings DROP CONSTRAINT IF EXISTS ratings_ref_type_check;
ALTER TABLE ratings ADD CONSTRAINT ratings_ref_type_check CHECK (ref_type IN (
  'dispatch_call', 'city_purchase_request', 'shop_order', 'ride_booking', 'trip_booking',
  'hourly_booking', 'shadi_vehicle_request', 'equipment_booking', 'rental_booking'
));

CREATE OR REPLACE FUNCTION submit_rating(p_ref_type varchar, p_ref_id uuid, p_stars int, p_comment text DEFAULT NULL) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_customer_portal_user_id uuid; v_provider_type varchar; v_provider_id uuid; v_terminal boolean := false;
  v_rater_type varchar; v_rater_id uuid; v_target_type varchar; v_target_id uuid; v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_stars IS NULL OR p_stars < 1 OR p_stars > 5 THEN RAISE EXCEPTION 'Pick 1 to 5 stars.' USING ERRCODE = 'P0001'; END IF;

  IF p_ref_type = 'dispatch_call' THEN
    SELECT initiator_portal_user_id, accepted_vehicle_id, (status = 'completed') INTO v_customer_portal_user_id, v_provider_id, v_terminal FROM dispatch_calls WHERE id = p_ref_id;
    v_provider_type := 'vehicle';
  ELSIF p_ref_type = 'city_purchase_request' THEN
    SELECT initiator_portal_user_id, accepted_vehicle_id, (status = 'completed') INTO v_customer_portal_user_id, v_provider_id, v_terminal FROM city_purchase_requests WHERE id = p_ref_id;
    v_provider_type := 'vehicle';
  ELSIF p_ref_type = 'shop_order' THEN
    SELECT portal_user_id, shop_id, (fulfillment_status = 'delivered') INTO v_customer_portal_user_id, v_provider_id, v_terminal FROM shop_orders WHERE id = p_ref_id;
    v_provider_type := 'shop';
  ELSIF p_ref_type = 'ride_booking' THEN
    SELECT rb.portal_user_id, vr.vehicle_id, (rb.status = 'confirmed')
      INTO v_customer_portal_user_id, v_provider_id, v_terminal
      FROM ride_bookings rb JOIN vehicle_routes vr ON vr.id = rb.route_id WHERE rb.id = p_ref_id;
    v_provider_type := 'vehicle';
  ELSIF p_ref_type = 'trip_booking' THEN
    SELECT portal_user_id, vehicle_id, (status = 'completed') INTO v_customer_portal_user_id, v_provider_id, v_terminal FROM vehicle_trip_bookings WHERE id = p_ref_id;
    v_provider_type := 'vehicle';
  ELSIF p_ref_type = 'hourly_booking' THEN
    SELECT portal_user_id, vehicle_id, (status = 'completed') INTO v_customer_portal_user_id, v_provider_id, v_terminal FROM hourly_bookings WHERE id = p_ref_id;
    v_provider_type := 'vehicle';
  ELSIF p_ref_type = 'equipment_booking' THEN
    SELECT portal_user_id, vehicle_id, (status = 'completed') INTO v_customer_portal_user_id, v_provider_id, v_terminal FROM equipment_bookings WHERE id = p_ref_id;
    v_provider_type := 'vehicle';
  ELSIF p_ref_type = 'rental_booking' THEN
    SELECT portal_user_id, vehicle_id, (status = 'completed') INTO v_customer_portal_user_id, v_provider_id, v_terminal FROM rental_bookings WHERE id = p_ref_id;
    v_provider_type := 'vehicle';
  ELSIF p_ref_type = 'shadi_vehicle_request' THEN
    SELECT e.portal_user_id, r.vehicle_id,
      (r.status = 'accepted' AND e.status = 'confirmed' AND e.event_date < (now() AT TIME ZONE 'Asia/Karachi')::date)
      INTO v_customer_portal_user_id, v_provider_id, v_terminal
      FROM shadi_vehicle_requests r JOIN shadi_events e ON e.id = r.event_id WHERE r.id = p_ref_id;
    v_provider_type := 'vehicle';
  ELSE
    RAISE EXCEPTION 'This can''t be rated.' USING ERRCODE = 'P0001';
  END IF;

  IF v_customer_portal_user_id IS NULL THEN RAISE EXCEPTION 'Not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT v_terminal THEN RAISE EXCEPTION 'This can only be rated once it''s finished.' USING ERRCODE = 'P0001'; END IF;

  IF v_portal_user_id = v_customer_portal_user_id THEN
    v_rater_type := 'portal_user'; v_rater_id := v_portal_user_id;
    v_target_type := v_provider_type; v_target_id := v_provider_id;
  ELSIF v_provider_type = 'vehicle' AND EXISTS (SELECT 1 FROM vehicles WHERE id = v_provider_id AND portal_user_id = v_portal_user_id) THEN
    v_rater_type := 'vehicle'; v_rater_id := v_provider_id;
    v_target_type := 'portal_user'; v_target_id := v_customer_portal_user_id;
  ELSIF v_provider_type = 'shop' AND user_manages_shop(v_provider_id) THEN
    v_rater_type := 'shop'; v_rater_id := v_provider_id;
    v_target_type := 'portal_user'; v_target_id := v_customer_portal_user_id;
  ELSE
    RAISE EXCEPTION 'You are not part of this.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO ratings (ref_type, ref_id, rater_party_type, rater_party_id, target_party_type, target_party_id, stars, comment)
  VALUES (p_ref_type, p_ref_id, v_rater_type, v_rater_id, v_target_type, v_target_id, p_stars, NULLIF(p_comment, ''))
  ON CONFLICT (ref_type, ref_id, rater_party_type, rater_party_id) DO UPDATE SET stars = excluded.stars, comment = excluded.comment
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

ALTER TABLE disputes DROP CONSTRAINT IF EXISTS disputes_ref_type_check;
ALTER TABLE disputes ADD CONSTRAINT disputes_ref_type_check CHECK (ref_type IN ('shop_order', 'hourly_booking', 'shadi_request', 'trip_offer', 'equipment_booking', 'rental_booking'));

CREATE OR REPLACE FUNCTION file_dispute(
  p_kind varchar, p_ref_type varchar, p_ref_id uuid, p_claimed_amount_pkr decimal, p_note text
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_is_party boolean := false;
  v_agreed decimal;
  v_dispute_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  IF p_note IS NULL OR trim(p_note) = '' THEN RAISE EXCEPTION 'A note is required' USING ERRCODE = 'P0001'; END IF;

  IF p_ref_type = 'shop_order' THEN
    SELECT (o.portal_user_id = v_portal_user_id OR v.portal_user_id = v_portal_user_id), o.total_amount_pkr
      INTO v_is_party, v_agreed
      FROM shop_orders o LEFT JOIN vehicles v ON v.id = o.delivery_vehicle_id
      WHERE o.id = p_ref_id;
  ELSIF p_ref_type = 'hourly_booking' THEN
    SELECT (b.portal_user_id = v_portal_user_id OR v.portal_user_id = v_portal_user_id), coalesce(b.total_amount_pkr, b.base_amount_pkr)
      INTO v_is_party, v_agreed
      FROM hourly_bookings b JOIN vehicles v ON v.id = b.vehicle_id
      WHERE b.id = p_ref_id;
  ELSIF p_ref_type = 'shadi_request' THEN
    SELECT (e.portal_user_id = v_portal_user_id OR v.portal_user_id = v_portal_user_id), r.advance_share_pkr
      INTO v_is_party, v_agreed
      FROM shadi_vehicle_requests r JOIN shadi_events e ON e.id = r.event_id JOIN vehicles v ON v.id = r.vehicle_id
      WHERE r.id = p_ref_id;
  ELSIF p_ref_type = 'trip_offer' THEN
    SELECT (v.portal_user_id = v_portal_user_id OR EXISTS (SELECT 1 FROM vehicle_trip_fare_offers f WHERE f.trip_offer_id = o.id AND f.portal_user_id = v_portal_user_id)), o.listed_fare_per_seat_pkr
      INTO v_is_party, v_agreed
      FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id
      WHERE o.id = p_ref_id;
  ELSIF p_ref_type = 'equipment_booking' THEN
    SELECT (b.portal_user_id = v_portal_user_id OR v.portal_user_id = v_portal_user_id), coalesce(b.total_amount_pkr, b.rate_pkr)
      INTO v_is_party, v_agreed
      FROM equipment_bookings b JOIN vehicles v ON v.id = b.vehicle_id
      WHERE b.id = p_ref_id;
  ELSIF p_ref_type = 'rental_booking' THEN
    SELECT (b.portal_user_id = v_portal_user_id OR v.portal_user_id = v_portal_user_id), b.total_amount_pkr
      INTO v_is_party, v_agreed
      FROM rental_bookings b JOIN vehicles v ON v.id = b.vehicle_id
      WHERE b.id = p_ref_id;
  END IF;

  IF NOT COALESCE(v_is_party, false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO disputes (kind, ref_type, ref_id, filed_by_portal_user_id, claimed_amount_pkr, agreed_amount_pkr, note)
  VALUES (p_kind, p_ref_type, p_ref_id, v_portal_user_id, p_claimed_amount_pkr, v_agreed, trim(p_note))
  RETURNING id INTO v_dispute_id;

  RETURN v_dispute_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION file_dispute(varchar, varchar, uuid, decimal, text) TO authenticated;

-- ── catalog opt-in, extended with rental (7th param, default false so
-- the existing 6-arg frontend callers keep working until updated) ───
CREATE OR REPLACE FUNCTION set_vehicle_catalog_prefs(
  p_vehicle_id uuid, p_color text, p_model text, p_has_ac boolean, p_offers_hourly boolean, p_offers_shadi boolean, p_offers_rental boolean DEFAULT NULL
) RETURNS void AS $$
DECLARE v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF p_offers_hourly AND v.hourly_rate_pkr IS NULL THEN
    RAISE EXCEPTION 'Ask the committee to set your hourly rate before turning this on.' USING ERRCODE = 'P0001';
  END IF;
  IF p_offers_shadi AND v.shadi_full_day_rate_pkr IS NULL THEN
    RAISE EXCEPTION 'Ask the committee to set your full-day wedding rate before turning this on.' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(p_offers_rental, false) AND (v.rental_base_pkr IS NULL OR v.rental_per_km_pkr IS NULL) THEN
    RAISE EXCEPTION 'Ask the committee to set your rental rate before turning this on.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicles SET
    color = NULLIF(trim(p_color), ''), model = NULLIF(trim(p_model), ''),
    has_ac = p_has_ac, offers_hourly = p_offers_hourly, offers_shadi = p_offers_shadi,
    offers_rental = COALESCE(p_offers_rental, offers_rental)
  WHERE id = p_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION set_vehicle_catalog_prefs(uuid, text, text, boolean, boolean, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_vehicle_catalog_prefs(uuid, text, text, boolean, boolean, boolean, boolean) TO authenticated;
