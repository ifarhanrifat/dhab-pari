-- Migration 869: real gap confirmed live — a rider who pays a driver
-- directly (the whole seat-booking system is direct P2P payment, no
-- platform escrow — confirmed by place_ride_booking's own design: the
-- uploaded "proof" is just evidence for the driver to review before
-- confirming, not money the platform ever holds) then has to cancel
-- before the driver confirms had ZERO path to escalate "I paid and
-- didn't get refunded." The disputes queue (485) already solves exactly
-- this shape of problem for four other booking kinds — ride_booking was
-- simply never added as a ref_type. No new ledger logic needed: a
-- cancelled, pre-confirmation booking never had a voucher posted in the
-- first place (cancel_ride_booking's own reversal logic only fires
-- when status = 'confirmed'), so this is a ruling/record-keeping
-- mechanism exactly like the other four kinds already are, not a money
-- movement.

ALTER TABLE disputes DROP CONSTRAINT IF EXISTS disputes_kind_check;
ALTER TABLE disputes ADD CONSTRAINT disputes_kind_check
  CHECK (kind IN ('fare_dispute', 'damaged_goods', 'no_show', 'shadi_withdrawal', 'hourly_overage', 'unrefunded_payment'));

ALTER TABLE disputes DROP CONSTRAINT IF EXISTS disputes_ref_type_check;
ALTER TABLE disputes ADD CONSTRAINT disputes_ref_type_check
  CHECK (ref_type IN ('shop_order', 'hourly_booking', 'shadi_request', 'trip_offer', 'ride_booking'));

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
  ELSIF p_ref_type = 'ride_booking' THEN
    SELECT (b.portal_user_id = v_portal_user_id AND b.status = 'cancelled' AND b.announced_proof_url IS NOT NULL), b.announced_amount_pkr
      INTO v_is_party, v_agreed
      FROM ride_bookings b
      WHERE b.id = p_ref_id;
  END IF;

  IF NOT COALESCE(v_is_party, false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO disputes (kind, ref_type, ref_id, filed_by_portal_user_id, claimed_amount_pkr, agreed_amount_pkr, note)
  VALUES (p_kind, p_ref_type, p_ref_id, v_portal_user_id, p_claimed_amount_pkr, v_agreed, trim(p_note))
  RETURNING id INTO v_dispute_id;

  RETURN v_dispute_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION admin_list_disputes(p_status varchar DEFAULT 'open') RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;

  SELECT coalesce(jsonb_agg(row ORDER BY (row->>'created_at') DESC), '[]'::jsonb) INTO v_result FROM (
    SELECT jsonb_build_object(
      'id', d.id, 'kind', d.kind, 'ref_type', d.ref_type, 'ref_id', d.ref_id,
      'claimed_amount_pkr', d.claimed_amount_pkr, 'agreed_amount_pkr', d.agreed_amount_pkr,
      'note', d.note, 'status', d.status, 'ruling', d.ruling, 'resolution_note', d.resolution_note,
      'created_at', d.created_at, 'resolved_at', d.resolved_at,
      'filed_by_name', pu.full_name, 'filed_by_mobile', pu.mobile,
      'ref_summary', CASE d.ref_type
        WHEN 'shop_order' THEN (SELECT jsonb_build_object('shop_name', s.name, 'vehicle_owner', v.owner_name) FROM shop_orders o LEFT JOIN shops s ON s.id = o.shop_id LEFT JOIN vehicles v ON v.id = o.delivery_vehicle_id WHERE o.id = d.ref_id)
        WHEN 'hourly_booking' THEN (SELECT jsonb_build_object('vehicle_owner', v.owner_name, 'hours', b.hours) FROM hourly_bookings b LEFT JOIN vehicles v ON v.id = b.vehicle_id WHERE b.id = d.ref_id)
        WHEN 'shadi_request' THEN (SELECT jsonb_build_object('vehicle_owner', v.owner_name, 'event_date', e.event_date) FROM shadi_vehicle_requests r LEFT JOIN vehicles v ON v.id = r.vehicle_id LEFT JOIN shadi_events e ON e.id = r.event_id WHERE r.id = d.ref_id)
        WHEN 'trip_offer' THEN (SELECT jsonb_build_object('vehicle_owner', v.owner_name, 'origin', o.origin, 'destination', o.destination) FROM vehicle_trip_offers o LEFT JOIN vehicles v ON v.id = o.vehicle_id WHERE o.id = d.ref_id)
        WHEN 'ride_booking' THEN (
          SELECT jsonb_build_object('vehicle_owner', v.owner_name, 'vehicle_mobile', v.owner_mobile, 'origin', vr.origin, 'destination', vr.destination, 'travel_date', b.travel_date, 'proof_url', b.announced_proof_url, 'cancellation_reason', b.cancellation_reason)
          FROM ride_bookings b LEFT JOIN vehicle_routes vr ON vr.id = b.route_id LEFT JOIN vehicles v ON v.id = vr.vehicle_id WHERE b.id = d.ref_id
        )
        ELSE NULL
      END
    ) AS row
    FROM disputes d
    LEFT JOIN portal_users pu ON pu.id = d.filed_by_portal_user_id
    WHERE p_status IS NULL OR d.status = p_status
    LIMIT 200
  ) rows;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE;
