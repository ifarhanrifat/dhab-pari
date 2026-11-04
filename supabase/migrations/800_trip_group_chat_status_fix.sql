-- Migration 800: real bug reported live, 2026-11-04 — "driver can send
-- the text but it's not reaching the rider end, and rider can't write
-- anything, it says you are not part of this trip." Confirmed directly
-- against a real booking: status was 'in_progress' (the driver had
-- already started the trip), but is_party_to_trip_group's rider check
-- (745) only ever matched status = 'confirmed' — the exact status a
-- booking leaves behind the moment the trip actually starts. A rider
-- loses access to their own trip's chat at precisely the point they'd
-- most want it. Predates tonight's session entirely (745); it only
-- surfaced now because the chat became reachable through a working
-- inline panel for the first time.
--
-- vehicle_trip_bookings_status_check (764) allows 'confirmed',
-- 'in_progress', 'completed', 'cancelled' — widening the membership
-- check to the first three (every real, non-cancelled state) instead
-- of just one.

CREATE OR REPLACE FUNCTION is_party_to_trip_group(p_trip_offer_id uuid) RETURNS boolean AS $$
  SELECT COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (
    SELECT 1 FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id
    WHERE o.id = p_trip_offer_id AND v.portal_user_id = current_portal_user_id()
  ) OR EXISTS (
    SELECT 1 FROM vehicle_trip_bookings b
    WHERE b.trip_offer_id = p_trip_offer_id AND b.portal_user_id = current_portal_user_id() AND b.status IN ('confirmed', 'in_progress', 'completed')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION send_trip_group_message(p_trip_offer_id uuid, p_body text) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  o vehicle_trip_offers%ROWTYPE; v vehicles%ROWTYPE; v_role varchar; v_msg_id uuid; v_sender_name text;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_body IS NULL OR trim(p_body) = '' THEN RAISE EXCEPTION 'Message cannot be empty.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO o FROM vehicle_trip_offers WHERE id = p_trip_offer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = o.vehicle_id;

  IF v.portal_user_id = v_portal_user_id THEN v_role := 'driver';
  ELSIF EXISTS (SELECT 1 FROM vehicle_trip_bookings b WHERE b.trip_offer_id = p_trip_offer_id AND b.portal_user_id = v_portal_user_id AND b.status IN ('confirmed', 'in_progress', 'completed')) THEN v_role := 'rider';
  ELSE RAISE EXCEPTION 'You are not part of this trip.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO trip_group_messages (trip_offer_id, sender_portal_user_id, sender_role, body)
  VALUES (p_trip_offer_id, v_portal_user_id, v_role, trim(p_body))
  RETURNING id INTO v_msg_id;

  SELECT full_name INTO v_sender_name FROM portal_users WHERE id = v_portal_user_id;

  -- Notify every other real party: the driver (if someone else sent it)
  -- plus every other confirmed/in_progress/completed rider -- never the
  -- sender themselves.
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT DISTINCT pu_id, 'trip_group_message', v_sender_name || ' (' || o.origin || ' → ' || o.destination || ')', trim(p_body), '/portal/marketplace/trip-group/' || p_trip_offer_id
  FROM (
    SELECT v.portal_user_id AS pu_id WHERE v.portal_user_id IS NOT NULL AND v.portal_user_id != v_portal_user_id
    UNION
    SELECT b.portal_user_id FROM vehicle_trip_bookings b WHERE b.trip_offer_id = p_trip_offer_id AND b.status IN ('confirmed', 'in_progress', 'completed') AND b.portal_user_id != v_portal_user_id
  ) parties(pu_id);

  RETURN v_msg_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
