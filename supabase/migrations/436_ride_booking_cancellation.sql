-- Migration 436: ride_bookings had no way to cancel a CONFIRMED booking at
-- all — confirm_ride_booking/reject_ride_booking (394) only ever touch an
-- 'announced' one. Neither a rider nor a driver could undo a confirmed
-- seat. This adds real cancellation for both sides, plus a way for a
-- driver to close an entire route (cascading cancellation to every
-- future booking on it).
--
-- Money handling: reverse_voucher() (207) exists and does exactly the
-- right thing, but it hard-requires current_admin_permission
-- ('post_transactions') — auth.uid()-based, unaffected by this
-- function's own SECURITY DEFINER, so a rider or driver calling it
-- would always get "Not authorized" even through this wrapper. The
-- reversal INSERT is duplicated inline here instead, gated by THIS
-- function's own authorization (rider owns the booking, OR is the
-- vehicle's own keeper, OR admin with post_transactions) rather than
-- reverse_voucher's blanket admin-only gate.
--
-- Cancellation policy (confirmed with the committee):
--   - Rider-initiated, outside the 2-hour-before-departure cutoff: full
--     reversal of whatever was posted on confirm.
--   - Rider-initiated, inside the cutoff: booking still cancels (frees
--     the seat for reporting purposes) but nothing is reversed — the
--     driver already turned away other business for that seat. Flagged
--     is_late_cancellation for visibility.
--   - Driver/admin-initiated (including via close_vehicle_route below):
--     always fully reversed — not the rider's fault.
--   - An 'announced' (not yet confirmed) booking has nothing posted yet
--     either way, so cancelling it is just a status flip.

ALTER TABLE ride_bookings DROP CONSTRAINT IF EXISTS ride_bookings_status_check;
ALTER TABLE ride_bookings ADD CONSTRAINT ride_bookings_status_check CHECK (status IN ('announced', 'confirmed', 'rejected', 'cancelled'));
ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS cancelled_by_portal_user_id uuid REFERENCES portal_users(id);
ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS cancellation_reason text;
ALTER TABLE ride_bookings ADD COLUMN IF NOT EXISTS is_late_cancellation boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION cancel_ride_booking(p_booking_id uuid, p_reason text) RETURNS jsonb AS $$
DECLARE
  b ride_bookings%ROWTYPE; r vehicle_routes%ROWTYPE; v vehicles%ROWTYPE;
  v_portal_user_id uuid := current_portal_user_id();
  v_is_rider boolean; v_is_driver boolean; v_is_admin boolean;
  v_departure timestamptz;
  v_within_cutoff boolean;
  v_late boolean := false;
  v_reversal_id uuid; v_reversal_no varchar;
BEGIN
  SELECT * INTO b FROM ride_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status = 'cancelled' THEN RAISE EXCEPTION 'This booking is already cancelled.' USING ERRCODE = 'P0001'; END IF;
  IF b.status = 'rejected' THEN RAISE EXCEPTION 'This booking was already declined.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO r FROM vehicle_routes WHERE id = b.route_id;
  SELECT * INTO v FROM vehicles WHERE id = r.vehicle_id;

  v_is_rider := v_portal_user_id IS NOT NULL AND b.portal_user_id = v_portal_user_id;
  v_is_driver := v.portal_user_id IS NOT NULL AND v.portal_user_id = v_portal_user_id;
  v_is_admin := COALESCE(current_admin_permission('post_transactions'), false);
  IF NOT (v_is_rider OR v_is_driver OR v_is_admin) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  -- Only a rider's OWN cancellation is subject to the cutoff — a driver
  -- or admin cancelling is never the rider's fault, so it's always a
  -- full reversal regardless of timing.
  IF v_is_rider AND NOT v_is_driver AND NOT v_is_admin AND b.status = 'confirmed' THEN
    v_departure := (b.travel_date + COALESCE(r.departure_time, '00:00'::time)) AT TIME ZONE 'Asia/Karachi';
    v_within_cutoff := r.departure_time IS NOT NULL AND v_departure - now() < interval '2 hours';
    v_late := v_within_cutoff;
  END IF;

  -- Reverse whatever confirm_ride_booking posted, unless this is a late
  -- rider cancellation (driver keeps it) or nothing was posted at all
  -- (still 'announced' — no voucher exists yet).
  IF b.status = 'confirmed' AND NOT v_late THEN
    IF b.commission_voucher_id IS NOT NULL THEN
      SELECT id, voucher_no INTO v_reversal_id, v_reversal_no FROM vouchers WHERE id = b.commission_voucher_id;
      -- Same swapped-accounts shape as reverse_voucher() (207) — see this
      -- migration's header for why that RPC can't be called directly here.
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name, reverses_voucher_id, reversal_reason)
      SELECT system, voucher_type, (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Reversal of ' || voucher_no || ' — ride booking cancelled: ' || COALESCE(trim(p_reason), 'no reason given'),
        amount_pkr, to_account_id, from_account_id, party_name, id, COALESCE(trim(p_reason), 'Ride booking cancelled')
      FROM vouchers WHERE id = b.commission_voucher_id
      RETURNING id INTO v_reversal_id;
      UPDATE vouchers SET reversed_by_voucher_id = v_reversal_id WHERE id = b.commission_voucher_id;
    END IF;
    IF b.gross_voucher_id IS NOT NULL THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name, reverses_voucher_id, reversal_reason)
      SELECT system, voucher_type, (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Reversal of ' || voucher_no || ' — ride booking cancelled: ' || COALESCE(trim(p_reason), 'no reason given'),
        amount_pkr, to_account_id, from_account_id, party_name, id, COALESCE(trim(p_reason), 'Ride booking cancelled')
      FROM vouchers WHERE id = b.gross_voucher_id
      RETURNING id INTO v_reversal_id;
      UPDATE vouchers SET reversed_by_voucher_id = v_reversal_id WHERE id = b.gross_voucher_id;
    END IF;
  END IF;

  UPDATE ride_bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by_portal_user_id = v_portal_user_id,
    cancellation_reason = trim(p_reason), is_late_cancellation = v_late
  WHERE id = p_booking_id;

  -- Notify whichever side didn't do the cancelling.
  IF v_is_rider AND NOT v_is_driver THEN
    IF v.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (v.portal_user_id, 'ride_booking_cancelled', 'A rider cancelled',
        'A seat booking for ' || r.origin || ' → ' || r.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || ' was cancelled' || (CASE WHEN v_late THEN ' (late — inside the 2-hour cutoff).' ELSE '.' END), '/my-vehicle');
    END IF;
  ELSE
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (b.portal_user_id, 'ride_booking_cancelled', 'Your booking was cancelled',
      'Your seat booking for ' || r.origin || ' → ' || r.destination || ' on ' || to_char(b.travel_date, 'DD Mon YYYY') || ' was cancelled.' || COALESCE(' ' || trim(p_reason), ''), '/accounts');
  END IF;

  RETURN jsonb_build_object('status', 'cancelled', 'was_late', v_late, 'reversed', b.status = 'confirmed' AND NOT v_late);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION cancel_ride_booking(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancel_ride_booking(uuid, text) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- close_vehicle_route — driver/admin stops a route from running at all,
-- cascading a full (never-late) cancellation across every future
-- 'announced'/'confirmed' booking on it.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION close_vehicle_route(p_route_id uuid, p_reason text) RETURNS jsonb AS $$
DECLARE
  r vehicle_routes%ROWTYPE; v vehicles%ROWTYPE;
  v_portal_user_id uuid := current_portal_user_id();
  b RECORD;
  v_cancelled_count int := 0;
BEGIN
  SELECT * INTO r FROM vehicle_routes WHERE id = p_route_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = r.vehicle_id;

  IF NOT ((v.portal_user_id IS NOT NULL AND v.portal_user_id = v_portal_user_id) OR COALESCE(current_admin_permission('post_transactions'), false)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicle_routes SET is_active = false WHERE id = p_route_id;

  FOR b IN
    SELECT id FROM ride_bookings
    WHERE route_id = p_route_id AND status IN ('announced', 'confirmed') AND travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
  LOOP
    PERFORM cancel_ride_booking(b.id, COALESCE(trim(p_reason), 'Route closed by driver'));
    v_cancelled_count := v_cancelled_count + 1;
  END LOOP;

  RETURN jsonb_build_object('route_id', p_route_id, 'bookings_cancelled', v_cancelled_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION close_vehicle_route(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION close_vehicle_route(uuid, text) TO authenticated;
