-- Real gap surfaced by the user directly: nothing let an accepted
-- vehicle back out, and once the automatic payout sweep (480) existed,
-- that silence became dangerous — a real-world no-show would still get
-- their advance share released on schedule, since the system had no
-- way to know they weren't coming.
--
-- Confirmed decisions:
--   - The driver can self-withdraw any time before the wedding date —
--     no admin approval needed.
--   - A withdrawn vehicle's reserved advance share is NOT forfeited to
--     the committee and NOT paid to them — it stays held, available to
--     transfer to a replacement vehicle the booker invites for that
--     specific slot. If no replacement is ever invited/accepted, it
--     simply stays parked in DP-5004 forever (a committee decision to
--     unwind that, like every other post-confirmation edge case here,
--     stays outside the app).
--
-- Mechanically this needs almost no new machinery: sweep_due_shadi_
-- advances() already only ever looks at status = 'accepted' rows, so a
-- 'withdrawn' row is automatically excluded — the money was never
-- actually disbursed per-vehicle until sweep time, only reserved via
-- advance_share_pkr, so "staying held" requires no ledger entry at all.
-- What's new is purely: a way to mark 'accepted' -> 'withdrawn', and a
-- way to point a fresh replacement request at that specific reservation
-- so accepting it transfers the reserved amount instead of leaving it
-- to confirm_shadi_advance (which only ever runs once per event).

ALTER TABLE shadi_vehicle_requests DROP CONSTRAINT IF EXISTS shadi_vehicle_requests_status_check;
ALTER TABLE shadi_vehicle_requests ADD CONSTRAINT shadi_vehicle_requests_status_check
  CHECK (status IN ('requested', 'accepted', 'declined', 'cancelled', 'withdrawn'));
ALTER TABLE shadi_vehicle_requests ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz;
-- Set only on a fresh request created specifically to fill a withdrawn
-- vehicle's slot — lets respond_shadi_request know to transfer that
-- slot's reserved advance_share_pkr on acceptance instead of leaving it
-- null (there's no future confirm_shadi_advance call for this request;
-- the event is already confirmed).
ALTER TABLE shadi_vehicle_requests ADD COLUMN IF NOT EXISTS replaces_request_id uuid REFERENCES shadi_vehicle_requests(id);

CREATE OR REPLACE FUNCTION withdraw_shadi_request(p_request_id uuid, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE r shadi_vehicle_requests%ROWTYPE; e shadi_events%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM shadi_vehicle_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = r.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF r.status <> 'accepted' THEN RAISE EXCEPTION 'Only an accepted booking can be withdrawn.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO e FROM shadi_events WHERE id = r.event_id;
  IF e.event_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN
    RAISE EXCEPTION 'The wedding date has already passed — contact the committee directly.' USING ERRCODE = 'P0001';
  END IF;
  IF e.status = 'advance_announced' THEN
    RAISE EXCEPTION 'The customer''s advance payment is awaiting confirmation — wait for that to resolve first.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE shadi_vehicle_requests SET status = 'withdrawn', withdrawn_at = now(), decline_reason = p_reason WHERE id = p_request_id;

  IF e.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (e.portal_user_id, 'shadi_vehicle_withdrawn', 'A vehicle backed out',
      v.owner_name || ' can no longer make your wedding on ' || to_char(e.event_date, 'DD Mon YYYY') || '.' ||
      (CASE WHEN e.status = 'confirmed' THEN ' You can invite a replacement — their share of your advance is still held for whoever takes their place.' ELSE '' END) ||
      COALESCE(' — ' || p_reason, ''),
      '/portal/marketplace/shadi/' || e.id);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION withdraw_shadi_request(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION withdraw_shadi_request(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION invite_shadi_replacement(p_event_id uuid, p_withdrawn_request_id uuid, p_vehicle_id uuid) RETURNS uuid AS $$
DECLARE e shadi_events%ROWTYPE; withdrawn shadi_vehicle_requests%ROWTYPE; v vehicles%ROWTYPE; v_request_id uuid;
BEGIN
  SELECT * INTO e FROM shadi_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'P0001'; END IF;
  IF e.portal_user_id <> current_portal_user_id() THEN RAISE EXCEPTION 'This is not your booking.' USING ERRCODE = 'P0001'; END IF;
  -- Stated explicitly rather than relied on implicitly: a reserved
  -- advance_share_pkr only ever exists once confirm_shadi_advance has
  -- run, which only ever happens once an event reaches 'confirmed' —
  -- but spelling it out here keeps this function correct even if that
  -- invariant ever changes elsewhere.
  IF e.status <> 'confirmed' THEN RAISE EXCEPTION 'This event is not confirmed yet.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO withdrawn FROM shadi_vehicle_requests WHERE id = p_withdrawn_request_id AND event_id = p_event_id;
  IF NOT FOUND OR withdrawn.status <> 'withdrawn' THEN RAISE EXCEPTION 'That vehicle slot is not open for replacement.' USING ERRCODE = 'P0001'; END IF;
  IF withdrawn.advance_share_pkr IS NULL THEN RAISE EXCEPTION 'This slot has no reserved advance to transfer.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM shadi_vehicle_requests WHERE replaces_request_id = p_withdrawn_request_id AND status IN ('requested', 'accepted')) THEN
    RAISE EXCEPTION 'A replacement is already pending or accepted for this slot.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active AND offers_shadi;
  IF NOT FOUND OR v.shadi_full_day_rate_pkr IS NULL THEN RAISE EXCEPTION 'This vehicle is not available for wedding booking.' USING ERRCODE = 'P0001'; END IF;
  IF v.portal_user_id = e.portal_user_id THEN RAISE EXCEPTION 'You cannot book your own vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM shadi_vehicle_requests WHERE event_id = p_event_id AND vehicle_id = p_vehicle_id AND status NOT IN ('declined', 'withdrawn', 'cancelled')) THEN
    RAISE EXCEPTION 'This vehicle already has a live request for this event.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO shadi_vehicle_requests (event_id, vehicle_id, full_day_rate_pkr, replaces_request_id)
  VALUES (p_event_id, p_vehicle_id, v.shadi_full_day_rate_pkr, p_withdrawn_request_id)
  RETURNING id INTO v_request_id;

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'shadi_request_received', 'Wedding booking request (replacing another vehicle)',
      'For ' || to_char(e.event_date, 'DD Mon YYYY') || ' — Rs ' || round(v.shadi_full_day_rate_pkr) || ' full day', '/portal/my-vehicle/shadi');
  END IF;
  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION invite_shadi_replacement(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION invite_shadi_replacement(uuid, uuid, uuid) TO authenticated;

-- respond_shadi_request now also transfers a withdrawn slot's reserved
-- advance_share_pkr to its replacement on acceptance — the only place
-- this needs to happen, since a replacement's event is already
-- confirmed and confirm_shadi_advance will never run for it again.
CREATE OR REPLACE FUNCTION respond_shadi_request(p_request_id uuid, p_accept boolean, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE r shadi_vehicle_requests%ROWTYPE; e shadi_events%ROWTYPE; v vehicles%ROWTYPE; v_transfer_share decimal;
BEGIN
  SELECT * INTO r FROM shadi_vehicle_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = r.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF r.status <> 'requested' THEN RAISE EXCEPTION 'This request has already been responded to.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO e FROM shadi_events WHERE id = r.event_id;
  -- A replacement request's event is already 'confirmed' by definition
  -- (that's the only state a withdrawal/replacement can happen in) —
  -- only freeze responses for the normal, pre-confirmation collecting
  -- window.
  IF r.replaces_request_id IS NULL AND e.status <> 'collecting' THEN
    RAISE EXCEPTION 'This booking is no longer accepting responses.' USING ERRCODE = 'P0001';
  END IF;

  IF p_accept AND EXISTS (
    SELECT 1 FROM shadi_vehicle_requests r2 JOIN shadi_events e2 ON e2.id = r2.event_id
    WHERE r2.vehicle_id = r.vehicle_id AND r2.id <> r.id AND r2.status = 'accepted' AND e2.event_date = e.event_date AND e2.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'This vehicle is already booked for another wedding on that date.' USING ERRCODE = 'P0001';
  END IF;

  IF p_accept AND r.replaces_request_id IS NOT NULL THEN
    SELECT advance_share_pkr INTO v_transfer_share FROM shadi_vehicle_requests WHERE id = r.replaces_request_id FOR UPDATE;
    UPDATE shadi_vehicle_requests SET status = 'accepted', responded_at = now(), advance_share_pkr = v_transfer_share WHERE id = p_request_id;
    -- Consumed — prevents a second replacement invite from claiming the same reservation.
    UPDATE shadi_vehicle_requests SET advance_share_pkr = NULL WHERE id = r.replaces_request_id;
  ELSE
    UPDATE shadi_vehicle_requests SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END,
      responded_at = now(), decline_reason = CASE WHEN p_accept THEN NULL ELSE p_reason END
    WHERE id = p_request_id;
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (e.portal_user_id, CASE WHEN p_accept THEN 'shadi_request_accepted' ELSE 'shadi_request_declined' END,
    CASE WHEN p_accept THEN 'A driver accepted your wedding request' ELSE 'A driver declined your wedding request' END,
    CASE WHEN p_accept THEN v.owner_name || ' will be available on ' || to_char(e.event_date, 'DD Mon YYYY') || '.'
      ELSE v.owner_name || ' is not available.' || COALESCE(' — ' || p_reason, '') END,
    '/portal/marketplace/shadi/' || e.id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION my_shadi_events() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', e.id, 'event_date', e.event_date, 'venue_address', e.venue_address, 'distance_km', e.distance_km, 'notes', e.notes,
    'status', e.status, 'advance_pct', e.advance_pct, 'advance_amount_pkr', e.advance_amount_pkr, 'advance_rejected_reason', e.advance_rejected_reason,
    'created_at', e.created_at,
    'requests', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', r.id, 'vehicle_id', r.vehicle_id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile,
        'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color,
        'full_day_rate_pkr', r.full_day_rate_pkr, 'status', r.status, 'decline_reason', r.decline_reason, 'advance_share_pkr', r.advance_share_pkr,
        'paid_out_at', r.paid_out_at, 'withdrawn_at', r.withdrawn_at, 'replaces_request_id', r.replaces_request_id
      ) ORDER BY r.created_at), '[]'::jsonb)
      FROM shadi_vehicle_requests r JOIN vehicles v ON v.id = r.vehicle_id WHERE r.event_id = e.id
    )
  ) ORDER BY e.event_date DESC), '[]'::jsonb)
  FROM shadi_events e WHERE e.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION vehicle_shadi_requests(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'status', r.status, 'decline_reason', r.decline_reason, 'full_day_rate_pkr', r.full_day_rate_pkr, 'advance_share_pkr', r.advance_share_pkr,
    'paid_out_at', r.paid_out_at, 'withdrawn_at', r.withdrawn_at, 'replaces_request_id', r.replaces_request_id,
    'event_id', e.id, 'event_date', e.event_date, 'venue_address', e.venue_address, 'distance_km', e.distance_km, 'notes', e.notes, 'event_status', e.status,
    'customer_name', pu.full_name, 'customer_mobile', pu.mobile
  ) ORDER BY e.event_date), '[]'::jsonb) INTO v_result
  FROM shadi_vehicle_requests r JOIN shadi_events e ON e.id = r.event_id JOIN portal_users pu ON pu.id = e.portal_user_id
  WHERE r.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
