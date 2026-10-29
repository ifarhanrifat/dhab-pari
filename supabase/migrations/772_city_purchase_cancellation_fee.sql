-- Migration 772: real gap found in audit, 2026-10-29 — cancel_city_
-- purchase_request (495, never revised since) only ever blocked
-- cancellation once status was 'completed' or 'cancelled'. The real
-- status machine (confirmed directly off the table's own CHECK
-- constraint, 495, never altered since) is:
--   ringing -> no_answer | priced -> approved -> purchased -> delivered -> completed
--   (cancelled reachable from any non-terminal state)
-- That left a genuine hole: a rider could cancel AFTER the driver had
-- already spent real cash buying the goods (status 'purchased') or
-- even AFTER the driver drove over and handed them over (status
-- 'delivered'), with zero fee, zero compensation, and zero commission
-- (commission only ever posts on delivered->completed inside
-- confirm_city_purchase_received, 709).
--
-- Same cash-settled-in-person model this session already shipped for
-- ride-dispatch (770/771 cancel_trip_booking) — this app has no rider
-- wallet to debit, only vehicle wallets for commission, so a
-- cancellation "fee" here is recorded on the row + both parties
-- notified, not an in-app charge:
--   - Before purchase (ringing/no_answer/priced/approved): free —
--     nothing real has been spent yet.
--   - After purchase, before delivery (purchased): the rider owes the
--     driver's actual sunk cost — COALESCE(actual_goods_cost_pkr,
--     goods_budget_pkr), whichever is populated at that point.
--   - After delivery (delivered): cancellation is blocked outright —
--     goods have already changed hands, so "cancel" no longer makes
--     sense. file_dispute (485/650/653) is the right path instead;
--     city_purchase_request was never added to its ref_type allowlist,
--     so that's added here too, with a matching file_dispute branch,
--     otherwise the error message below would point at a dead end.

ALTER TABLE city_purchase_requests ADD COLUMN IF NOT EXISTS cancellation_fee_pkr decimal;

DROP FUNCTION IF EXISTS cancel_city_purchase_request(uuid);

CREATE OR REPLACE FUNCTION cancel_city_purchase_request(p_request_id uuid) RETURNS jsonb AS $$
DECLARE
  r city_purchase_requests%ROWTYPE; v vehicles%ROWTYPE;
  v_fee decimal := 0; v_fee_note text := '';
BEGIN
  SELECT * INTO r FROM city_purchase_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.initiator_portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this request.' USING ERRCODE = 'P0001';
  END IF;
  IF r.status IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'This request is already closed.' USING ERRCODE = 'P0001'; END IF;

  -- Delivered: goods have already changed hands — "cancel" doesn't
  -- apply any more. Point at the real remedy instead of silently
  -- letting a rider wipe out a driver's completed, unpaid delivery.
  IF r.status = 'delivered' THEN
    RAISE EXCEPTION 'This item has already been delivered — cancelling is no longer possible. If something is wrong, file a dispute instead.' USING ERRCODE = 'P0001';
  END IF;

  -- Purchased, not yet delivered: the driver already spent real cash
  -- on the goods. They don't eat that cost for a cancellation that
  -- happens after they've already paid.
  IF r.status = 'purchased' THEN
    v_fee := COALESCE(r.actual_goods_cost_pkr, r.goods_budget_pkr, 0);
    IF v_fee > 0 THEN v_fee_note := ' A cancellation fee of Rs ' || v_fee::text || ' applies — settle in person.'; END IF;
  END IF;

  UPDATE city_purchase_requests SET status = 'cancelled', cancelled_at = now(), cancellation_fee_pkr = NULLIF(v_fee, 0) WHERE id = p_request_id;
  UPDATE city_purchase_invitations SET status = 'expired', responded_at = now() WHERE request_id = p_request_id AND status = 'ringing';

  -- Both sides get a record of this, same convention as cancel_trip_
  -- booking (770) — the canceller sees their own action confirmed, the
  -- driver is told why the job just disappeared (and what's owed, if
  -- anything), not just silence.
  SELECT * INTO v FROM vehicles WHERE id = r.accepted_vehicle_id;
  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'city_purchase_cancelled', 'Request cancelled', ('The villager cancelled this City Purchase request: ' || r.item || '.') || v_fee_note, '/portal/marketplace/city-purchase/' || p_request_id);
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (r.initiator_portal_user_id, 'city_purchase_cancelled', 'You cancelled this request', ('You cancelled your City Purchase request: ' || r.item || '.') || v_fee_note, '/portal/marketplace/city-purchase/' || p_request_id);

  RETURN jsonb_build_object('status', 'cancelled', 'fee_pkr', v_fee);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION cancel_city_purchase_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancel_city_purchase_request(uuid) TO authenticated;

-- ── city_purchase_request into the disputes queue (485/650/653) — the
-- real remedy for a post-delivery problem that cancel_city_purchase_
-- request now points to above. It was never added before now. ───────
ALTER TABLE disputes DROP CONSTRAINT IF EXISTS disputes_ref_type_check;
ALTER TABLE disputes ADD CONSTRAINT disputes_ref_type_check CHECK (ref_type IN ('shop_order', 'hourly_booking', 'shadi_request', 'trip_offer', 'equipment_booking', 'rental_booking', 'city_purchase_request'));

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
  ELSIF p_ref_type = 'city_purchase_request' THEN
    SELECT (r.initiator_portal_user_id = v_portal_user_id OR v.portal_user_id = v_portal_user_id), COALESCE(r.total_fare_pkr, 0) + COALESCE(r.actual_goods_cost_pkr, r.goods_budget_pkr, 0)
      INTO v_is_party, v_agreed
      FROM city_purchase_requests r LEFT JOIN vehicles v ON v.id = r.accepted_vehicle_id
      WHERE r.id = p_ref_id;
  END IF;

  IF NOT COALESCE(v_is_party, false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO disputes (kind, ref_type, ref_id, filed_by_portal_user_id, claimed_amount_pkr, agreed_amount_pkr, note)
  VALUES (p_kind, p_ref_type, p_ref_id, v_portal_user_id, p_claimed_amount_pkr, v_agreed, trim(p_note))
  RETURNING id INTO v_dispute_id;

  RETURN v_dispute_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION file_dispute(varchar, varchar, uuid, decimal, text) TO authenticated;
