-- Migration 650: close two real rating/reporting gaps surfaced by a
-- line-by-line audit of dhab-pari-mobility.html against this codebase.
--
-- 1. The design rates every job type on completion (sheetRate, tags +
--    stars) but ratings.ref_type (497) only ever covered
--    dispatch_call/city_purchase_request/shop_order/ride_booking/
--    trip_booking — hourly_bookings, shadi_vehicle_requests, and
--    equipment_bookings had no rating path at all, by that migration's
--    own comment ("deliberately deferred rather than guessed at
--    speed"). Added here via the same submit_rating() shape.
--
--    shadi has no "completed" status in this schema (shadi_events only
--    reaches 'confirmed'; the wedding itself isn't tracked as an app
--    event) — treated as terminal once the event date has passed with
--    the advance confirmed, the closest real proxy for "the job
--    happened" without inventing a new status this migration has no
--    mandate to design.
--
-- 2. equipment_bookings (646, built after disputes/485) never got the
--    same <ReportProblemButton>/file_dispute wiring hourly and shadi
--    already have — added as its own ref_type, same pattern.

ALTER TABLE ratings DROP CONSTRAINT IF EXISTS ratings_ref_type_check;
ALTER TABLE ratings ADD CONSTRAINT ratings_ref_type_check CHECK (ref_type IN (
  'dispatch_call', 'city_purchase_request', 'shop_order', 'ride_booking', 'trip_booking',
  'hourly_booking', 'shadi_vehicle_request', 'equipment_booking'
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

-- ── equipment_bookings into the disputes queue ──────────────────────
ALTER TABLE disputes DROP CONSTRAINT IF EXISTS disputes_ref_type_check;
ALTER TABLE disputes ADD CONSTRAINT disputes_ref_type_check CHECK (ref_type IN ('shop_order', 'hourly_booking', 'shadi_request', 'trip_offer', 'equipment_booking'));

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
  END IF;

  IF NOT COALESCE(v_is_party, false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO disputes (kind, ref_type, ref_id, filed_by_portal_user_id, claimed_amount_pkr, agreed_amount_pkr, note)
  VALUES (p_kind, p_ref_type, p_ref_id, v_portal_user_id, p_claimed_amount_pkr, v_agreed, trim(p_note))
  RETURNING id INTO v_dispute_id;

  RETURN v_dispute_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION file_dispute(varchar, varchar, uuid, decimal, text) TO authenticated;

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
        WHEN 'equipment_booking' THEN (SELECT jsonb_build_object('vehicle_owner', v.owner_name, 'kind', b.kind) FROM equipment_bookings b LEFT JOIN vehicles v ON v.id = b.vehicle_id WHERE b.id = d.ref_id)
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
GRANT EXECUTE ON FUNCTION admin_list_disputes(varchar) TO authenticated;
