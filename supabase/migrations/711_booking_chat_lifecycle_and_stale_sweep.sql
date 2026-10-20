-- Migration 711: two related real bugs found live in the vehicle
-- marketplace — (1) a booking's own status and its negotiation_threads
-- row are two completely unlinked state machines, so chat stays open
-- forever on a completed/cancelled/declined booking; (2) nothing ever
-- auto-resolves a request nobody responded to (confirmed live: a shadi
-- request from 2026-10-15 was still sitting "waiting for driver" with
-- no way for it to ever end other than the rider noticing and manually
-- cancelling, which only shadi even has a cancel button for). Fixes
-- both for rental/hourly/equipment now; shadi's own chat-closing is
-- deliberately left for the shadi flow rebuild (its request-level
-- negotiation_threads are entangled with the "Request by Type" path
-- that rebuild retires — wiring it in twice would be wasted work).
-- Confirmed via AskUserQuestion: auto-expiry window is 3 days.

-- close_booking_thread: internal-only helper (same trust model as
-- ensure_booking_thread, 658 — no GRANT to authenticated, only ever
-- called from inside another SECURITY DEFINER function that has
-- already authorized the caller for this booking). negotiation_threads
-- itself only allows ('open','agreed','declined','cancelled') — there
-- is no 'completed' value, so a booking reaching 'completed' maps onto
-- 'agreed' (the deal happened, there's nothing left to negotiate).
CREATE OR REPLACE FUNCTION close_booking_thread(p_ref_type varchar, p_ref_id uuid, p_status varchar) RETURNS void AS $$
BEGIN
  IF p_status NOT IN ('agreed', 'declined', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid thread close status.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE negotiation_threads SET status = p_status, closed_at = now()
  WHERE ref_type = p_ref_type AND ref_id = p_ref_id AND status = 'open';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION close_booking_thread(varchar, uuid, varchar) FROM PUBLIC, anon;

-- ── Rental ───────────────────────────────────────────────────────────
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
  IF NOT p_accept THEN PERFORM close_booking_thread('rental_booking', p_booking_id, 'declined'); END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, CASE WHEN p_accept THEN 'rental_booking_accepted' ELSE 'rental_booking_declined' END,
    CASE WHEN p_accept THEN 'Booking accepted' ELSE 'Booking declined' END,
    CASE WHEN p_accept THEN v.owner_name || ' will pick you up.'
      ELSE 'This vehicle is not available for your booking.' || COALESCE(' — ' || p_reason, '') END,
    '/portal/marketplace');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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
  PERFORM close_booking_thread('rental_booking', p_booking_id, 'agreed');

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'rental_booking_completed', 'Trip completed', 'Total: Rs ' || round(b.total_amount_pkr), '/portal/marketplace');

  RETURN jsonb_build_object('total_amount_pkr', b.total_amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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
  PERFORM close_booking_thread('rental_booking', p_booking_id, 'cancelled');

  v_notify_id := CASE WHEN v_is_customer THEN v.portal_user_id ELSE b.portal_user_id END;
  IF v_notify_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_notify_id, 'rental_booking_cancelled', 'Booking cancelled', 'A rental booking was cancelled.', '/portal/marketplace');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── Hourly ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION respond_hourly_booking(p_booking_id uuid, p_accept boolean, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE b hourly_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'requested' THEN RAISE EXCEPTION 'This booking has already been responded to.' USING ERRCODE = 'P0001'; END IF;

  UPDATE hourly_bookings SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END, responded_at = now(),
    decline_reason = CASE WHEN p_accept THEN NULL ELSE p_reason END
  WHERE id = p_booking_id;
  IF NOT p_accept THEN PERFORM close_booking_thread('hourly_booking', p_booking_id, 'declined'); END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, CASE WHEN p_accept THEN 'hourly_booking_accepted' ELSE 'hourly_booking_declined' END,
    CASE WHEN p_accept THEN 'Booking accepted' ELSE 'Booking declined' END,
    CASE WHEN p_accept THEN v.owner_name || ' will pick you up.'
      ELSE 'This vehicle is not available for your booking.' || COALESCE(' — ' || p_reason, '') END,
    '/portal/marketplace');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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
  PERFORM close_booking_thread('hourly_booking', p_booking_id, 'agreed');

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, 'hourly_booking_completed', 'Trip completed',
    'Distance: ' || round(b.distance_km, 1) || 'km — Total: Rs ' || round(v_total), '/portal/marketplace');

  RETURN jsonb_build_object('distance_km', b.distance_km, 'overage_km', v_overage_km, 'overage_amount_pkr', v_overage_amount, 'total_amount_pkr', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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
  PERFORM close_booking_thread('hourly_booking', p_booking_id, 'cancelled');

  v_notify_id := CASE WHEN v_is_customer THEN v.portal_user_id ELSE b.portal_user_id END;
  IF v_notify_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_notify_id, 'hourly_booking_cancelled', 'Booking cancelled', 'An hourly rental booking was cancelled.', '/portal/marketplace');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── Equipment ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION respond_equipment_booking(p_booking_id uuid, p_accept boolean, p_reason text DEFAULT NULL) RETURNS void AS $$
DECLARE b equipment_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM equipment_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'requested' THEN RAISE EXCEPTION 'This booking has already been responded to.' USING ERRCODE = 'P0001'; END IF;

  UPDATE equipment_bookings SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END, responded_at = now(),
    decline_reason = CASE WHEN p_accept THEN NULL ELSE p_reason END
  WHERE id = p_booking_id;
  IF NOT p_accept THEN PERFORM close_booking_thread('equipment_booking', p_booking_id, 'declined'); END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (b.portal_user_id, CASE WHEN p_accept THEN 'equipment_booking_accepted' ELSE 'equipment_booking_declined' END,
    CASE WHEN p_accept THEN 'Booking accepted' ELSE 'Booking declined' END,
    CASE WHEN p_accept THEN v.owner_name || ' accepted your job.'
      ELSE 'This vehicle is not available for your job.' || COALESCE(' — ' || p_reason, '') END,
    '/portal/marketplace');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION complete_equipment_job(p_booking_id uuid) RETURNS jsonb AS $$
DECLARE b equipment_bookings%ROWTYPE; v vehicles%ROWTYPE; v_hours decimal; v_total decimal;
BEGIN
  SELECT * INTO b FROM equipment_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'in_progress' THEN RAISE EXCEPTION 'This job is not in progress.' USING ERRCODE = 'P0001'; END IF;

  v_hours := GREATEST(COALESCE(b.requested_hours, 0), 1);
  v_total := CASE WHEN b.kind = 'loader' THEN b.rate_pkr ELSE b.rate_pkr * v_hours + COALESCE(b.mobilization_fee_pkr, 0) END;

  UPDATE equipment_bookings SET status = 'completed', ended_at = now(), actual_hours = v_hours, total_amount_pkr = v_total WHERE id = p_booking_id;
  PERFORM close_booking_thread('equipment_booking', p_booking_id, 'agreed');

  RETURN jsonb_build_object('total_amount_pkr', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION cancel_equipment_booking(p_booking_id uuid) RETURNS void AS $$
DECLARE b equipment_bookings%ROWTYPE; v vehicles%ROWTYPE; v_is_customer boolean; v_is_owner boolean; v_notify_id uuid;
BEGIN
  SELECT * INTO b FROM equipment_bookings WHERE id = p_booking_id FOR UPDATE;
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

  UPDATE equipment_bookings SET status = 'cancelled' WHERE id = p_booking_id;
  PERFORM close_booking_thread('equipment_booking', p_booking_id, 'cancelled');

  v_notify_id := CASE WHEN v_is_customer THEN v.portal_user_id ELSE b.portal_user_id END;
  IF v_notify_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_notify_id, 'equipment_booking_cancelled', 'Booking cancelled', 'An equipment booking was cancelled.', '/portal/marketplace');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── Stale-request auto-expiry sweep ─────────────────────────────────
-- Admin-editable like every other site_settings-driven constant;
-- confirmed via AskUserQuestion: 3 days default. Runs as a direct
-- status UPDATE (not through the authorization-gated cancel_* RPCs —
-- there is no session/JWT in a cron context, so current_portal_user_id()
-- would be NULL and every one of those RPCs would reject the call) —
-- safe because nothing financial has posted yet at 'requested'/
-- 'accepted'/'collecting'/'ringing'/'no_answer' stages (commission only
-- posts on confirm_*/complete_* functions, which only run much later).
INSERT INTO site_settings (key, value, description) VALUES
  ('stale_booking_expiry_days', '3', 'Days an unanswered rental/hourly/equipment/shadi/city-purchase request sits before it is auto-cancelled')
ON CONFLICT (tenant_id, key) DO NOTHING;

CREATE OR REPLACE FUNCTION run_stale_booking_sweep() RETURNS void AS $$
DECLARE v_days int; r record;
BEGIN
  SELECT COALESCE(value::int, 3) INTO v_days FROM site_settings WHERE key = 'stale_booking_expiry_days' LIMIT 1;

  FOR r IN SELECT id, portal_user_id FROM rental_bookings WHERE status IN ('requested', 'accepted') AND requested_at < now() - (v_days || ' days')::interval LOOP
    UPDATE rental_bookings SET status = 'cancelled' WHERE id = r.id;
    PERFORM close_booking_thread('rental_booking', r.id, 'cancelled');
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.portal_user_id, 'rental_booking_cancelled', 'Booking auto-cancelled', 'No driver responded in time, so this request was automatically cancelled.', '/portal/marketplace');
  END LOOP;

  FOR r IN SELECT id, portal_user_id FROM hourly_bookings WHERE status IN ('requested', 'accepted') AND requested_at < now() - (v_days || ' days')::interval LOOP
    UPDATE hourly_bookings SET status = 'cancelled' WHERE id = r.id;
    PERFORM close_booking_thread('hourly_booking', r.id, 'cancelled');
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.portal_user_id, 'hourly_booking_cancelled', 'Booking auto-cancelled', 'No driver responded in time, so this request was automatically cancelled.', '/portal/marketplace');
  END LOOP;

  FOR r IN SELECT id, portal_user_id FROM equipment_bookings WHERE status IN ('requested', 'accepted') AND requested_at < now() - (v_days || ' days')::interval LOOP
    UPDATE equipment_bookings SET status = 'cancelled' WHERE id = r.id;
    PERFORM close_booking_thread('equipment_booking', r.id, 'cancelled');
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.portal_user_id, 'equipment_booking_cancelled', 'Booking auto-cancelled', 'No owner responded in time, so this request was automatically cancelled.', '/portal/marketplace');
  END LOOP;

  FOR r IN SELECT id, portal_user_id FROM shadi_events WHERE status = 'collecting' AND created_at < now() - (v_days || ' days')::interval LOOP
    UPDATE shadi_vehicle_requests SET status = 'cancelled' WHERE event_id = r.id AND status IN ('requested', 'accepted');
    UPDATE shadi_events SET status = 'cancelled' WHERE id = r.id;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.portal_user_id, 'shadi_event_cancelled', 'Wedding booking auto-cancelled', 'No driver responded in time, so this request was automatically cancelled.', '/portal/marketplace/shadi');
  END LOOP;

  FOR r IN SELECT id, initiator_portal_user_id FROM city_purchase_requests WHERE status IN ('ringing', 'no_answer') AND created_at < now() - (v_days || ' days')::interval LOOP
    UPDATE city_purchase_requests SET status = 'cancelled' WHERE id = r.id;
    UPDATE city_purchase_invitations SET status = 'expired', responded_at = now() WHERE request_id = r.id AND status = 'ringing';
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.initiator_portal_user_id, 'city_purchase_cancelled', 'Request auto-cancelled', 'No driver responded in time, so this request was automatically cancelled.', '/portal/marketplace/city-purchase');
  END LOOP;

  FOR r IN SELECT id, initiator_portal_user_id FROM parcel_deliveries WHERE status IN ('ringing', 'no_answer') AND created_at < now() - (v_days || ' days')::interval LOOP
    UPDATE parcel_deliveries SET status = 'cancelled' WHERE id = r.id;
    UPDATE parcel_delivery_invitations SET status = 'expired', responded_at = now() WHERE delivery_id = r.id AND status = 'ringing';
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (r.initiator_portal_user_id, 'parcel_delivery_cancelled', 'Request auto-cancelled', 'No driver responded in time, so this request was automatically cancelled.', '/portal/marketplace/parcel');
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION run_stale_booking_sweep() FROM PUBLIC, anon;

SELECT cron.schedule('marketplace-stale-request-sweep', '0 3 * * *', $$SELECT run_stale_booking_sweep()$$);
