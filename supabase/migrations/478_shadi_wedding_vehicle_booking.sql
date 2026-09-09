-- Shadi (wedding) vehicle booking — the other half of migration 474's
-- "hourly rental + shadi" foundation. Confirmed directly: a booker
-- hand-picks several specific vehicles (by photo/colour/model) for one
-- wedding day, each driver independently accepts or declines against
-- their own full-day rate card, and once at least one has accepted the
-- booker sends ONE combined, non-refundable advance to the committee —
-- not a per-vehicle deposit.
--
-- Deliberately NOT like hourly rental:
--   - No GPS/live tracking at all — the rate is a flat full-day figure,
--     not distance-metered, so there's nothing to measure. The distance
--     the booker enters is purely informational context shown to the
--     driver (e.g. "this is a long way"), never used in any charge.
--   - No start/end trip state machine — once a request is accepted and
--     the event's advance is confirmed, the driver just shows up on the
--     day and collects the balance directly from the customer, same
--     off-ledger convention as every other per_order flow in this app.
--     Only the advance itself is ever voucherized.
--   - The advance IS the committee's whole financial involvement — it's
--     a straight income receipt (no seller wallet account is touched),
--     computed as one settings-controlled percentage of the SUM of the
--     accepted vehicles' full-day rates, split back out per vehicle
--     (advance_share_pkr) purely so drivers can see their own balance-
--     due without doing the maths themselves.
--
-- Known, deliberate limitation (flagging rather than silently skipping):
-- once an event is confirmed there is no in-app path for a driver to
-- back out (e.g. a breakdown) or for the booker to cancel — the advance
-- was explicitly described as non-refundable, so any real-world need to
-- unwind a confirmed booking is a committee decision made outside the
-- app, not a button here.

-- Same split as hourly (474): the rate itself stays committee/admin-set;
-- offers_shadi's own gate below is fixed to check ITS OWN rate field,
-- not hourly_rate_pkr — a vehicle offering shadi only (no hourly) could
-- never turn shadi on before this fix.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS shadi_full_day_rate_pkr decimal CHECK (shadi_full_day_rate_pkr IS NULL OR shadi_full_day_rate_pkr >= 0);

CREATE OR REPLACE FUNCTION set_vehicle_catalog_prefs(
  p_vehicle_id uuid, p_color text, p_model text, p_has_ac boolean, p_offers_hourly boolean, p_offers_shadi boolean
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

  UPDATE vehicles SET
    color = NULLIF(trim(p_color), ''), model = NULLIF(trim(p_model), ''),
    has_ac = p_has_ac, offers_hourly = p_offers_hourly, offers_shadi = p_offers_shadi
  WHERE id = p_vehicle_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

INSERT INTO accounts (code, name, name_ur, type, system, description, is_protected) VALUES
  ('DP-4051', 'Shadi Vehicle Booking Advances', 'شادی گاڑی بکنگ ایڈوانس', 'income', 'donors_projects',
   'Non-refundable advances collected for wedding-day vehicle bookings', true)
ON CONFLICT (code, system) DO NOTHING;

INSERT INTO site_settings (key, value, description) VALUES
  ('marketplace_shadi_advance_pct', '20', 'The non-refundable advance a shadi booker must pay the committee, as a percentage of the combined full-day rate of every vehicle that has accepted')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS shadi_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  event_date date NOT NULL,
  venue_address text NOT NULL,
  distance_km decimal NOT NULL CHECK (distance_km >= 0),
  notes text,
  status varchar NOT NULL DEFAULT 'collecting' CHECK (status IN ('collecting', 'advance_announced', 'confirmed', 'cancelled')),
  advance_pct decimal,
  advance_amount_pkr decimal,
  advance_method varchar,
  advance_proof_url text,
  advance_announced_at timestamptz,
  advance_confirmed_at timestamptz,
  advance_confirmed_by uuid REFERENCES admin_users(id),
  advance_voucher_id uuid REFERENCES vouchers(id),
  advance_rejected_reason text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shadi_events_portal_user_idx ON shadi_events(portal_user_id);

CREATE TABLE IF NOT EXISTS shadi_vehicle_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES shadi_events(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  -- Locked in at request time, same as hourly's rate fields — a later
  -- committee rate change never retroactively changes a pending or
  -- accepted request.
  full_day_rate_pkr decimal NOT NULL,
  status varchar NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'accepted', 'declined', 'cancelled')),
  decline_reason text,
  -- This vehicle's slice of the event's combined advance — filled in
  -- only once the advance is actually confirmed, so a driver can see
  -- their own exact balance-due without doing the maths.
  advance_share_pkr decimal,
  responded_at timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE (event_id, vehicle_id)
);
CREATE INDEX IF NOT EXISTS shadi_vehicle_requests_event_idx ON shadi_vehicle_requests(event_id);
CREATE INDEX IF NOT EXISTS shadi_vehicle_requests_vehicle_idx ON shadi_vehicle_requests(vehicle_id);

-- No write policies on either table — every mutation goes through the
-- SECURITY DEFINER functions below.
ALTER TABLE shadi_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shadi_events_parties_read" ON shadi_events FOR SELECT TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR portal_user_id = current_portal_user_id()
    OR EXISTS (SELECT 1 FROM shadi_vehicle_requests r JOIN vehicles v ON v.id = r.vehicle_id WHERE r.event_id = shadi_events.id AND v.portal_user_id = current_portal_user_id())
  );

ALTER TABLE shadi_vehicle_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shadi_vehicle_requests_parties_read" ON shadi_vehicle_requests FOR SELECT TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = vehicle_id AND v.portal_user_id = current_portal_user_id())
    OR EXISTS (SELECT 1 FROM shadi_events e WHERE e.id = event_id AND e.portal_user_id = current_portal_user_id())
  );

-- Browse: vehicles offering shadi, with a real rate set. Public/anon
-- like hourly_bookable_vehicles, so the marketplace can be browsed
-- before signing in.
CREATE OR REPLACE FUNCTION shadi_bookable_vehicles() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'color', v.color, 'model', v.model,
    'has_ac', v.has_ac, 'shadi_full_day_rate_pkr', v.shadi_full_day_rate_pkr,
    'cover_url', (SELECT m.url FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.is_cover LIMIT 1)
  ) ORDER BY v.owner_name), '[]'::jsonb)
  FROM vehicles v WHERE v.is_active AND v.offers_shadi AND v.shadi_full_day_rate_pkr IS NOT NULL;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION shadi_bookable_vehicles() TO authenticated, anon;

CREATE OR REPLACE FUNCTION create_shadi_event(
  p_event_date date, p_venue_address text, p_distance_km decimal, p_notes text, p_vehicle_ids uuid[]
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_event_id uuid;
  v_vehicle_id uuid;
  v vehicles%ROWTYPE;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_event_date IS NULL OR p_event_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN
    RAISE EXCEPTION 'Pick a wedding date that has not already passed.' USING ERRCODE = 'P0001';
  END IF;
  IF p_venue_address IS NULL OR trim(p_venue_address) = '' THEN RAISE EXCEPTION 'Enter the venue address.' USING ERRCODE = 'P0001'; END IF;
  IF p_distance_km IS NULL OR p_distance_km < 0 THEN RAISE EXCEPTION 'Enter the approximate distance.' USING ERRCODE = 'P0001'; END IF;
  IF p_vehicle_ids IS NULL OR array_length(p_vehicle_ids, 1) IS NULL OR array_length(p_vehicle_ids, 1) = 0 THEN
    RAISE EXCEPTION 'Select at least one vehicle.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO shadi_events (portal_user_id, event_date, venue_address, distance_km, notes)
  VALUES (v_portal_user_id, p_event_date, trim(p_venue_address), p_distance_km, NULLIF(trim(p_notes), ''))
  RETURNING id INTO v_event_id;

  FOREACH v_vehicle_id IN ARRAY p_vehicle_ids LOOP
    SELECT * INTO v FROM vehicles WHERE id = v_vehicle_id AND is_active AND offers_shadi;
    IF NOT FOUND OR v.shadi_full_day_rate_pkr IS NULL THEN
      RAISE EXCEPTION 'One of the selected vehicles is no longer available for wedding booking.' USING ERRCODE = 'P0001';
    END IF;
    IF v.portal_user_id = v_portal_user_id THEN RAISE EXCEPTION 'You cannot book your own vehicle.' USING ERRCODE = 'P0001'; END IF;

    INSERT INTO shadi_vehicle_requests (event_id, vehicle_id, full_day_rate_pkr) VALUES (v_event_id, v_vehicle_id, v.shadi_full_day_rate_pkr);

    IF v.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (v.portal_user_id, 'shadi_request_received', 'Wedding booking request',
        'For ' || to_char(p_event_date, 'DD Mon YYYY') || ' — Rs ' || round(v.shadi_full_day_rate_pkr) || ' full day', '/portal/my-vehicle/shadi');
    END IF;
  END LOOP;

  RETURN v_event_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_shadi_event(date, text, decimal, text, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_shadi_event(date, text, decimal, text, uuid[]) TO authenticated;

-- Lets a booker invite one more candidate vehicle to an already-created
-- event (e.g. after a decline) without starting over — only while still
-- collecting responses.
CREATE OR REPLACE FUNCTION add_shadi_vehicle_request(p_event_id uuid, p_vehicle_id uuid) RETURNS uuid AS $$
DECLARE e shadi_events%ROWTYPE; v vehicles%ROWTYPE; v_request_id uuid;
BEGIN
  SELECT * INTO e FROM shadi_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'P0001'; END IF;
  IF e.portal_user_id <> current_portal_user_id() THEN RAISE EXCEPTION 'This is not your booking.' USING ERRCODE = 'P0001'; END IF;
  IF e.status <> 'collecting' THEN RAISE EXCEPTION 'This booking is no longer collecting responses.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active AND offers_shadi;
  IF NOT FOUND OR v.shadi_full_day_rate_pkr IS NULL THEN RAISE EXCEPTION 'This vehicle is not available for wedding booking.' USING ERRCODE = 'P0001'; END IF;
  IF v.portal_user_id = e.portal_user_id THEN RAISE EXCEPTION 'You cannot book your own vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM shadi_vehicle_requests WHERE event_id = p_event_id AND vehicle_id = p_vehicle_id) THEN
    RAISE EXCEPTION 'This vehicle has already been asked for this event.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO shadi_vehicle_requests (event_id, vehicle_id, full_day_rate_pkr) VALUES (p_event_id, p_vehicle_id, v.shadi_full_day_rate_pkr)
  RETURNING id INTO v_request_id;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'shadi_request_received', 'Wedding booking request',
      'For ' || to_char(e.event_date, 'DD Mon YYYY') || ' — Rs ' || round(v.shadi_full_day_rate_pkr) || ' full day', '/portal/my-vehicle/shadi');
  END IF;
  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION add_shadi_vehicle_request(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION add_shadi_vehicle_request(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION respond_shadi_request(p_request_id uuid, p_accept boolean, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE r shadi_vehicle_requests%ROWTYPE; e shadi_events%ROWTYPE; v vehicles%ROWTYPE; booker portal_users%ROWTYPE;
BEGIN
  SELECT * INTO r FROM shadi_vehicle_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = r.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF r.status <> 'requested' THEN RAISE EXCEPTION 'This request has already been responded to.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO e FROM shadi_events WHERE id = r.event_id;
  -- Once the booker has announced their advance the accepted set is
  -- effectively locked in (the advance amount was computed from it) —
  -- freeze further responses until the committee confirms or rejects.
  IF e.status <> 'collecting' THEN RAISE EXCEPTION 'This booking is no longer accepting responses.' USING ERRCODE = 'P0001'; END IF;

  IF p_accept AND EXISTS (
    SELECT 1 FROM shadi_vehicle_requests r2 JOIN shadi_events e2 ON e2.id = r2.event_id
    WHERE r2.vehicle_id = r.vehicle_id AND r2.id <> r.id AND r2.status = 'accepted' AND e2.event_date = e.event_date AND e2.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'This vehicle is already booked for another wedding on that date.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE shadi_vehicle_requests SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END,
    responded_at = now(), decline_reason = CASE WHEN p_accept THEN NULL ELSE p_reason END
  WHERE id = p_request_id;

  SELECT * INTO booker FROM portal_users WHERE id = e.portal_user_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (e.portal_user_id, CASE WHEN p_accept THEN 'shadi_request_accepted' ELSE 'shadi_request_declined' END,
    CASE WHEN p_accept THEN 'A driver accepted your wedding request' ELSE 'A driver declined your wedding request' END,
    CASE WHEN p_accept THEN v.owner_name || ' will be available on ' || to_char(e.event_date, 'DD Mon YYYY') || '.'
      ELSE v.owner_name || ' is not available.' || COALESCE(' — ' || p_reason, '') END,
    '/portal/marketplace/shadi/' || e.id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION respond_shadi_request(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION respond_shadi_request(uuid, boolean, text) TO authenticated;

CREATE OR REPLACE FUNCTION cancel_shadi_event(p_event_id uuid) RETURNS void AS $$
DECLARE e shadi_events%ROWTYPE; r RECORD;
BEGIN
  SELECT * INTO e FROM shadi_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR e.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'This is not your booking.' USING ERRCODE = 'P0001';
  END IF;
  IF e.status <> 'collecting' THEN RAISE EXCEPTION 'This booking can no longer be cancelled here — contact the committee.' USING ERRCODE = 'P0001'; END IF;

  FOR r IN SELECT * FROM shadi_vehicle_requests WHERE event_id = p_event_id AND status IN ('requested', 'accepted') LOOP
    IF r.status = 'accepted' THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      SELECT v.portal_user_id, 'shadi_event_cancelled', 'Wedding booking cancelled', 'The booker cancelled this wedding booking.', '/portal/my-vehicle/shadi'
      FROM vehicles v WHERE v.id = r.vehicle_id AND v.portal_user_id IS NOT NULL;
    END IF;
  END LOOP;
  UPDATE shadi_vehicle_requests SET status = 'cancelled' WHERE event_id = p_event_id AND status IN ('requested', 'accepted');
  UPDATE shadi_events SET status = 'cancelled' WHERE id = p_event_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION cancel_shadi_event(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancel_shadi_event(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION announce_shadi_advance(p_event_id uuid, p_method varchar, p_proof_url text) RETURNS jsonb AS $$
DECLARE e shadi_events%ROWTYPE; v_pct decimal; v_amount decimal; v_accepted_count int;
BEGIN
  SELECT * INTO e FROM shadi_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'P0001'; END IF;
  IF e.portal_user_id <> current_portal_user_id() THEN RAISE EXCEPTION 'This is not your booking.' USING ERRCODE = 'P0001'; END IF;
  IF e.status <> 'collecting' THEN RAISE EXCEPTION 'This booking is not awaiting an advance.' USING ERRCODE = 'P0001'; END IF;
  IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;

  SELECT count(*) INTO v_accepted_count FROM shadi_vehicle_requests WHERE event_id = p_event_id AND status = 'accepted';
  IF v_accepted_count = 0 THEN RAISE EXCEPTION 'At least one vehicle must accept before you can pay the advance.' USING ERRCODE = 'P0001'; END IF;

  v_pct := COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_shadi_advance_pct'), 0);
  -- Fixed by policy, not by the booker — the same "no dispute" principle
  -- as every other formula-priced flow here (client never supplies the
  -- amount that actually gets charged).
  SELECT round(sum(full_day_rate_pkr) * v_pct / 100, 2) INTO v_amount FROM shadi_vehicle_requests WHERE event_id = p_event_id AND status = 'accepted';

  UPDATE shadi_events SET status = 'advance_announced', advance_pct = v_pct, advance_amount_pkr = v_amount,
    advance_method = p_method, advance_proof_url = p_proof_url, advance_announced_at = now(), advance_rejected_reason = NULL
  WHERE id = p_event_id;

  RETURN jsonb_build_object('amount', v_amount, 'pct', v_pct);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION announce_shadi_advance(uuid, varchar, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION announce_shadi_advance(uuid, varchar, text) TO authenticated;

CREATE OR REPLACE FUNCTION confirm_shadi_advance(p_event_id uuid) RETURNS jsonb AS $$
DECLARE
  e shadi_events%ROWTYPE; booker portal_users%ROWTYPE;
  v_income_account uuid; v_cash_account uuid; v_voucher_id uuid; v_voucher_no varchar;
  r RECORD;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO e FROM shadi_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'P0001'; END IF;
  IF e.status <> 'advance_announced' THEN RAISE EXCEPTION 'This advance is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO booker FROM portal_users WHERE id = e.portal_user_id;

  SELECT id INTO v_income_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4051';
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects' AND code = (CASE WHEN e.advance_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Shadi vehicle booking advance — ' || booker.full_name || ' (' || to_char(e.event_date, 'DD Mon YYYY') || ')', e.advance_amount_pkr, v_income_account, v_cash_account, booker.full_name)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE shadi_events SET status = 'confirmed', advance_confirmed_at = now(), advance_confirmed_by = current_admin_user_id(), advance_voucher_id = v_voucher_id
  WHERE id = p_event_id;

  -- Split the combined advance back out per accepted vehicle, and lock
  -- in that as its own record so a driver can see their exact balance
  -- due (full_day_rate_pkr - advance_share_pkr) without doing the maths.
  UPDATE shadi_vehicle_requests SET advance_share_pkr = round(full_day_rate_pkr * e.advance_pct / 100, 2)
  WHERE event_id = p_event_id AND status = 'accepted';

  FOR r IN SELECT r.vehicle_id, r.status, v.portal_user_id, r.advance_share_pkr, r.full_day_rate_pkr
           FROM shadi_vehicle_requests r JOIN vehicles v ON v.id = r.vehicle_id WHERE r.event_id = p_event_id LOOP
    IF r.status = 'accepted' AND r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (r.portal_user_id, 'shadi_advance_confirmed', 'Wedding booking confirmed',
        'Confirmed for ' || to_char(e.event_date, 'DD Mon YYYY') || '. Collect Rs ' || round(r.full_day_rate_pkr - r.advance_share_pkr) || ' from the customer on the day.',
        '/portal/my-vehicle/shadi');
    END IF;
  END LOOP;

  -- Anyone who never got a chance to respond is now moot — the booker's
  -- accepted set is locked in.
  UPDATE shadi_vehicle_requests SET status = 'cancelled' WHERE event_id = p_event_id AND status = 'requested';
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'shadi_request_auto_cancelled', 'Wedding request closed', 'This booking has been finalized with other vehicles.', '/portal/my-vehicle/shadi'
  FROM shadi_vehicle_requests r JOIN vehicles v ON v.id = r.vehicle_id
  WHERE r.event_id = p_event_id AND r.status = 'cancelled' AND r.responded_at IS NULL AND v.portal_user_id IS NOT NULL;

  IF e.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (e.portal_user_id, 'shadi_advance_confirmed', 'Advance confirmed', 'Your wedding booking is confirmed.', '/portal/marketplace/shadi/' || e.id);
  END IF;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', e.advance_amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION confirm_shadi_advance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION confirm_shadi_advance(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION reject_shadi_advance(p_event_id uuid, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE e shadi_events%ROWTYPE;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO e FROM shadi_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'P0001'; END IF;
  IF e.status <> 'advance_announced' THEN RAISE EXCEPTION 'This advance is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;

  UPDATE shadi_events SET status = 'collecting', advance_rejected_reason = p_reason WHERE id = p_event_id;
  IF e.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (e.portal_user_id, 'shadi_advance_rejected', 'Advance could not be confirmed',
      'Your payment could not be confirmed.' || COALESCE(' ' || p_reason, '') || ' Please try again.', '/portal/marketplace/shadi/' || e.id);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION reject_shadi_advance(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reject_shadi_advance(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION my_shadi_events() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', e.id, 'event_date', e.event_date, 'venue_address', e.venue_address, 'distance_km', e.distance_km, 'notes', e.notes,
    'status', e.status, 'advance_pct', e.advance_pct, 'advance_amount_pkr', e.advance_amount_pkr, 'advance_rejected_reason', e.advance_rejected_reason,
    'created_at', e.created_at,
    'requests', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', r.id, 'vehicle_id', r.vehicle_id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile,
        'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color,
        'full_day_rate_pkr', r.full_day_rate_pkr, 'status', r.status, 'decline_reason', r.decline_reason, 'advance_share_pkr', r.advance_share_pkr
      ) ORDER BY r.created_at), '[]'::jsonb)
      FROM shadi_vehicle_requests r JOIN vehicles v ON v.id = r.vehicle_id WHERE r.event_id = e.id
    )
  ) ORDER BY e.event_date DESC), '[]'::jsonb)
  FROM shadi_events e WHERE e.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_shadi_events() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_shadi_events() TO authenticated;

CREATE OR REPLACE FUNCTION vehicle_shadi_requests(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'status', r.status, 'decline_reason', r.decline_reason, 'full_day_rate_pkr', r.full_day_rate_pkr, 'advance_share_pkr', r.advance_share_pkr,
    'event_id', e.id, 'event_date', e.event_date, 'venue_address', e.venue_address, 'distance_km', e.distance_km, 'notes', e.notes, 'event_status', e.status,
    'customer_name', pu.full_name, 'customer_mobile', pu.mobile
  ) ORDER BY e.event_date), '[]'::jsonb) INTO v_result
  FROM shadi_vehicle_requests r JOIN shadi_events e ON e.id = r.event_id JOIN portal_users pu ON pu.id = e.portal_user_id
  WHERE r.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_shadi_requests(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_shadi_requests(uuid) TO authenticated;
