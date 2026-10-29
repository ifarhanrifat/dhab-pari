-- Migration 770: real gaps found live, 2026-10-29 — "what if he will
-- cancel the ride when driver reached to rider spot? is the fare
-- cancel policy working, is our system finding the dirty rider who is
-- sending and cancel the riders frequently, is our system recognizing
-- the driver who is cancelling the riders frequently?"
--
-- Checked directly, not guessed: NO cancellation fee exists anywhere
-- in dhab-pari (not just ride-dispatch — every booking type), and
-- cancel_trip_booking (689) has no time limit at all — a rider could
-- cancel even after the ride was already 'in_progress' (driver already
-- arrived and started), with zero consequence. Real trust-score
-- machinery already exists (portal_user_trust/vehicle_trust, 497) but
-- has two real bugs: portal_user_trust's cancellation count never
-- looks at vehicle_trip_bookings at all (only ride_bookings/
-- hourly_bookings) — a rider repeatedly cancelling ride-dispatch today
-- gets zero penalty — and vehicle_trust counts ALL cancelled bookings
-- on a vehicle regardless of who actually cancelled, unfairly docking
-- a driver for a rider-caused cancellation.
--
-- This app has no rider wallet to actually debit (only vehicles have
-- one, for commission) — so "cancellation fee" here is recorded and
-- shown to both sides for in-person cash settlement, the same
-- direct-to-driver model the fare itself already uses, not a new
-- in-app payment/debt system invented unprompted. Scoped to
-- ride-dispatch-sourced bookings only (pin IS NOT NULL) — ordinary
-- trip-share bookings never had any cancellation-fee concept and
-- aren't getting a surprise new one here.

ALTER TABLE vehicle_trip_bookings ADD COLUMN IF NOT EXISTS cancellation_fee_pkr decimal;

CREATE OR REPLACE FUNCTION cancel_trip_booking(p_trip_booking_id uuid, p_reason text DEFAULT NULL) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  b vehicle_trip_bookings%ROWTYPE; v vehicles%ROWTYPE; o vehicle_trip_offers%ROWTYPE;
  v_is_rider boolean; v_is_driver boolean; v_is_admin boolean;
  v_fee decimal := 0; v_fee_note text := '';
BEGIN
  SELECT * INTO b FROM vehicle_trip_bookings WHERE id = p_trip_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status = 'cancelled' THEN RAISE EXCEPTION 'This booking is already cancelled.' USING ERRCODE = 'P0001'; END IF;
  IF b.status = 'completed' THEN RAISE EXCEPTION 'This trip is already complete — it can''t be cancelled.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  SELECT * INTO o FROM vehicle_trip_offers WHERE id = b.trip_offer_id FOR UPDATE;

  v_is_rider := v_portal_user_id IS NOT NULL AND b.portal_user_id = v_portal_user_id;
  v_is_driver := v.portal_user_id IS NOT NULL AND v.portal_user_id = v_portal_user_id;
  v_is_admin := COALESCE(current_admin_permission('post_transactions'), false);
  IF NOT (v_is_rider OR v_is_driver OR v_is_admin) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  -- Real ask, 2026-10-29: a flat, modest fee once the driver has
  -- already committed (accepted and the pickup PIN exists), bigger
  -- once they've actually arrived and started — the two tiers the
  -- real conversation settled on. Cash-settled between the two
  -- parties directly, same as the fare itself; recorded here so
  -- there's a real number to point to, not an in-app charge.
  IF b.pin IS NOT NULL AND (v_is_rider OR v_is_driver) THEN
    IF b.status = 'in_progress' THEN v_fee := 200;
    ELSIF b.status = 'confirmed' THEN v_fee := 50;
    END IF;
    IF v_fee > 0 THEN v_fee_note := ' A cancellation fee of Rs ' || v_fee::text || ' applies — settle in person.'; END IF;
  END IF;

  UPDATE vehicle_trip_bookings SET status = 'cancelled', cancelled_at = now(),
    cancelled_by_portal_user_id = v_portal_user_id, cancellation_reason = trim(p_reason), cancellation_fee_pkr = NULLIF(v_fee, 0)
    WHERE id = p_trip_booking_id;

  UPDATE vehicle_trip_offers SET seats_available = o.seats_available + b.seats,
    status = CASE WHEN status = 'closed' AND travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date THEN 'open' ELSE status END
    WHERE id = o.id;

  -- Both sides get a record of this -- not just "the other side". The
  -- canceller sees their own action confirmed; the other person is
  -- told why their trip plan changed.
  IF v.portal_user_id IS NOT NULL AND v.portal_user_id <> b.portal_user_id THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'trip_booking_cancelled',
      CASE WHEN v_is_driver THEN 'You cancelled a booking' ELSE 'A rider cancelled' END,
      (CASE WHEN v_is_driver
        THEN 'You cancelled the seat booking for ' || o.origin || ' → ' || o.destination || ' on ' || to_char(o.travel_date, 'DD Mon YYYY') || '.' || COALESCE(' ' || trim(p_reason), '')
        ELSE 'A seat booking for ' || o.origin || ' → ' || o.destination || ' on ' || to_char(o.travel_date, 'DD Mon YYYY') || ' was cancelled.' || COALESCE(' ' || trim(p_reason), '') END) || v_fee_note,
      '/portal/my-vehicle/trips');
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'trip_booking_cancelled',
    CASE WHEN v_is_rider THEN 'You cancelled your booking' ELSE 'Your booking was cancelled' END,
    (CASE WHEN v_is_rider
      THEN 'You cancelled your seat booking for ' || o.origin || ' → ' || o.destination || ' on ' || to_char(o.travel_date, 'DD Mon YYYY') || '.'
      ELSE 'Your seat booking for ' || o.origin || ' → ' || o.destination || ' on ' || to_char(o.travel_date, 'DD Mon YYYY') || ' was cancelled by the driver.' || COALESCE(' ' || trim(p_reason), '') END) || v_fee_note,
    '/portal/marketplace/shared');

  RETURN jsonb_build_object('status', 'cancelled', 'fee_pkr', v_fee);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── Trust scoring: count the right cancellations, add a "frequent
-- canceller" flag for the last 30 days specifically (a stale old
-- cancellation shouldn't carry the same weight as 3 this month). ────

CREATE OR REPLACE FUNCTION portal_user_trust(p_portal_user_id uuid) RETURNS jsonb AS $$
DECLARE
  pu portal_users%ROWTYPE;
  v_completed int;
  v_cancellations int;
  v_recent_cancellations int;
  v_complaints int;
  v_score int;
  v_tier varchar;
BEGIN
  SELECT * INTO pu FROM portal_users WHERE id = p_portal_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('tier', 'outsider', 'score', 0, 'flags', '[]'::jsonb); END IF;

  SELECT
    (SELECT count(*) FROM shop_orders WHERE portal_user_id = p_portal_user_id AND fulfillment_status = 'delivered')
    + (SELECT count(*) FROM hourly_bookings WHERE portal_user_id = p_portal_user_id AND status = 'completed')
    + (SELECT count(*) FROM ride_bookings WHERE portal_user_id = p_portal_user_id AND status = 'confirmed')
    + (SELECT count(*) FROM shadi_vehicle_requests r JOIN shadi_events e ON e.id = r.event_id WHERE e.portal_user_id = p_portal_user_id AND r.status = 'accepted')
  INTO v_completed;

  -- Real bug found live, 2026-10-29: never looked at vehicle_trip_bookings
  -- at all (the table ride-dispatch and trip-share both use) — only
  -- counts a cancellation here when this rider was the one who actually
  -- cancelled it, not every cancelled booking they happened to be on.
  SELECT
    (SELECT count(*) FROM ride_bookings WHERE portal_user_id = p_portal_user_id AND status = 'cancelled')
    + (SELECT count(*) FROM hourly_bookings WHERE portal_user_id = p_portal_user_id AND status = 'cancelled')
    + (SELECT count(*) FROM vehicle_trip_bookings WHERE portal_user_id = p_portal_user_id AND status = 'cancelled' AND cancelled_by_portal_user_id = p_portal_user_id)
  INTO v_cancellations;

  SELECT count(*) FROM vehicle_trip_bookings
  WHERE portal_user_id = p_portal_user_id AND status = 'cancelled' AND cancelled_by_portal_user_id = p_portal_user_id AND cancelled_at > now() - interval '30 days'
  INTO v_recent_cancellations;

  SELECT count(*) FILTER (WHERE status <> 'dismissed') INTO v_complaints FROM party_complaints WHERE against_party_type = 'portal_user' AND against_party_id = p_portal_user_id;

  v_score := (CASE WHEN pu.cnic_verified THEN 30 ELSE 0 END)
    + (CASE WHEN pu.phone_verified THEN 15 ELSE 0 END)
    + (CASE WHEN pu.is_village_resident THEN 20 ELSE 0 END)
    + least(v_completed, 25)
    - (v_cancellations * 5)
    - (v_complaints * 8)
    - (CASE WHEN v_recent_cancellations >= 3 THEN 15 ELSE 0 END);
  v_score := greatest(0, least(100, v_score));

  v_tier := CASE WHEN v_score >= 80 THEN 'verified' WHEN v_score >= 40 THEN 'partial' ELSE 'outsider' END;

  RETURN jsonb_build_object(
    'tier', v_tier, 'score', v_score,
    'flags', jsonb_build_array(
      jsonb_build_object('label', 'CNIC', 'ok', pu.cnic_verified),
      jsonb_build_object('label', 'Phone', 'ok', pu.phone_verified),
      jsonb_build_object('label', 'Resident', 'ok', pu.is_village_resident),
      jsonb_build_object('label', 'Orders', 'ok', v_completed > 0, 'value', v_completed),
      jsonb_build_object('label', 'Frequent canceller', 'ok', v_recent_cancellations < 3, 'value', v_recent_cancellations)
    ),
    'complaints', v_complaints
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION vehicle_trust(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE
  v_completed int; v_cancellations int; v_recent_cancellations int; v_avg_stars decimal; v_rating_count int;
  v_complaints int; v_urgent_upheld int; v_score int; v_tier varchar; v_owner_portal_user_id uuid;
BEGIN
  SELECT portal_user_id INTO v_owner_portal_user_id FROM vehicles WHERE id = p_vehicle_id;

  SELECT
    (SELECT count(*) FROM dispatch_calls WHERE accepted_vehicle_id = p_vehicle_id AND status = 'completed')
    + (SELECT count(*) FROM city_purchase_requests WHERE accepted_vehicle_id = p_vehicle_id AND status = 'completed')
    + (SELECT count(*) FROM vehicle_trip_bookings WHERE vehicle_id = p_vehicle_id AND status = 'completed')
    + (SELECT count(*) FROM ride_bookings rb JOIN vehicle_routes vr ON vr.id = rb.route_id WHERE vr.vehicle_id = p_vehicle_id AND rb.status = 'confirmed')
  INTO v_completed;

  -- Real bug found live, 2026-10-29: used to count every cancelled
  -- booking on this vehicle regardless of who actually cancelled it —
  -- a rider cancelling on a driver unfairly docked the driver's own
  -- score too. Now only counts cancellations the driver themselves
  -- (the vehicle's own owner) actually caused.
  SELECT
    (SELECT count(*) FROM dispatch_calls WHERE accepted_vehicle_id = p_vehicle_id AND status = 'cancelled')
    + (SELECT count(*) FROM city_purchase_requests WHERE accepted_vehicle_id = p_vehicle_id AND status = 'cancelled')
    + (SELECT count(*) FROM vehicle_trip_bookings WHERE vehicle_id = p_vehicle_id AND status = 'cancelled' AND cancelled_by_portal_user_id = v_owner_portal_user_id)
  INTO v_cancellations;

  SELECT count(*) FROM vehicle_trip_bookings
  WHERE vehicle_id = p_vehicle_id AND status = 'cancelled' AND cancelled_by_portal_user_id = v_owner_portal_user_id AND cancelled_at > now() - interval '30 days'
  INTO v_recent_cancellations;

  SELECT avg(stars), count(*) INTO v_avg_stars, v_rating_count FROM ratings WHERE target_party_type = 'vehicle' AND target_party_id = p_vehicle_id;
  SELECT count(*) FILTER (WHERE status <> 'dismissed'), count(*) FILTER (WHERE is_urgent AND status = 'upheld')
    INTO v_complaints, v_urgent_upheld
    FROM party_complaints WHERE against_party_type = 'vehicle' AND against_party_id = p_vehicle_id;

  v_score := 50
    + COALESCE(round((v_avg_stars - 3) * 10), 0)
    + least(v_completed, 30)
    - (v_cancellations * 5)
    - (v_complaints * 8)
    - (v_urgent_upheld * 25)
    - (CASE WHEN v_recent_cancellations >= 3 THEN 15 ELSE 0 END);
  v_score := greatest(0, least(100, v_score));
  v_tier := CASE WHEN v_score >= 70 THEN 'trusted' WHEN v_score >= 40 THEN 'normal' ELSE 'low' END;

  RETURN jsonb_build_object(
    'score', v_score, 'tier', v_tier, 'completed', v_completed, 'cancellations', v_cancellations,
    'avg_stars', round(COALESCE(v_avg_stars, 0)::numeric, 1), 'rating_count', COALESCE(v_rating_count, 0),
    'complaints', v_complaints, 'urgent_upheld', v_urgent_upheld, 'recent_cancellations', v_recent_cancellations,
    'frequent_canceller', v_recent_cancellations >= 3
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
