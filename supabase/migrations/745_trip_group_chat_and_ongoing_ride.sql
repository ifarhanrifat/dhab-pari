-- Real ask, 2026-10-27: "a floating button from where rider can view
-- his ongoing booking and driver can now view and start his return
-- ride and view his riders location, and from where he will send the
-- chat to his riders in group."
--
-- Two real gaps, closed here:
-- 1. No single place tells a driver/rider "you have something live
--    right now" — they had to remember which page to open. One RPC,
--    my_ongoing_ride(), checks both roles and returns exactly one
--    thing to link to; the floating button (frontend, separate commit)
--    is driven entirely by this.
-- 2. No group chat exists at all for a trip's current riders — only
--    negotiation_threads (422), which is strictly one rider <-> one
--    driver, pre-booking. This is a genuinely different shape (one
--    driver, N confirmed riders, during an active trip), so it's its
--    own table rather than stretching negotiation_threads' 2-party
--    model to fit N parties.

CREATE TABLE IF NOT EXISTS trip_group_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_offer_id uuid NOT NULL REFERENCES vehicle_trip_offers(id) ON DELETE CASCADE,
  sender_portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  sender_role varchar NOT NULL CHECK (sender_role IN ('driver', 'rider')),
  body text NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trip_group_messages_trip_idx ON trip_group_messages(trip_offer_id, created_at);

-- Driver, or any rider with a confirmed (not cancelled) booking on this
-- exact trip -- same "who's really a party to this" shape as every
-- other thread-style table in this app.
CREATE OR REPLACE FUNCTION is_party_to_trip_group(p_trip_offer_id uuid) RETURNS boolean AS $$
  SELECT COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (
    SELECT 1 FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id
    WHERE o.id = p_trip_offer_id AND v.portal_user_id = current_portal_user_id()
  ) OR EXISTS (
    SELECT 1 FROM vehicle_trip_bookings b
    WHERE b.trip_offer_id = p_trip_offer_id AND b.portal_user_id = current_portal_user_id() AND b.status = 'confirmed'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION is_party_to_trip_group(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_party_to_trip_group(uuid) TO authenticated;

ALTER TABLE trip_group_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "trip_group_messages_parties_read" ON trip_group_messages FOR SELECT TO authenticated
  USING (is_party_to_trip_group(trip_offer_id));
-- Writes only via send_trip_group_message() below.

CREATE OR REPLACE FUNCTION trip_group_chat_messages(p_trip_offer_id uuid) RETURNS jsonb AS $$
  SELECT CASE WHEN NOT is_party_to_trip_group(p_trip_offer_id) THEN '[]'::jsonb ELSE COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', m.id, 'sender_role', m.sender_role, 'sender_name', pu.full_name,
      'is_me', m.sender_portal_user_id = current_portal_user_id(),
      'body', m.body, 'created_at', m.created_at
    ) ORDER BY m.created_at ASC)
    FROM trip_group_messages m JOIN portal_users pu ON pu.id = m.sender_portal_user_id
    WHERE m.trip_offer_id = p_trip_offer_id
  ), '[]'::jsonb) END;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION trip_group_chat_messages(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION trip_group_chat_messages(uuid) TO authenticated;

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
  ELSIF EXISTS (SELECT 1 FROM vehicle_trip_bookings b WHERE b.trip_offer_id = p_trip_offer_id AND b.portal_user_id = v_portal_user_id AND b.status = 'confirmed') THEN v_role := 'rider';
  ELSE RAISE EXCEPTION 'You are not part of this trip.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO trip_group_messages (trip_offer_id, sender_portal_user_id, sender_role, body)
  VALUES (p_trip_offer_id, v_portal_user_id, v_role, trim(p_body))
  RETURNING id INTO v_msg_id;

  SELECT full_name INTO v_sender_name FROM portal_users WHERE id = v_portal_user_id;

  -- Notify every other real party: the driver (if someone else sent it)
  -- plus every other confirmed rider -- never the sender themselves.
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT DISTINCT pu_id, 'trip_group_message', v_sender_name || ' (' || o.origin || ' → ' || o.destination || ')', trim(p_body), '/portal/marketplace/trip-group/' || p_trip_offer_id
  FROM (
    SELECT v.portal_user_id AS pu_id WHERE v.portal_user_id IS NOT NULL AND v.portal_user_id != v_portal_user_id
    UNION
    SELECT b.portal_user_id FROM vehicle_trip_bookings b WHERE b.trip_offer_id = p_trip_offer_id AND b.status = 'confirmed' AND b.portal_user_id != v_portal_user_id
  ) parties(pu_id);

  RETURN v_msg_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION send_trip_group_message(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION send_trip_group_message(uuid, text) TO authenticated;

-- The floating button's single source of truth: "do I have something
-- live right now, as either role?" Driver context wins when both are
-- somehow true (rare — a driver could also be someone else's rider),
-- since the driver's own open trip is the more operationally urgent one.
CREATE OR REPLACE FUNCTION my_ongoing_ride() RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_driver_trip record; v_rider_booking record;
BEGIN
  IF v_portal_user_id IS NULL THEN RETURN NULL; END IF;

  SELECT o.id AS trip_offer_id, o.origin, o.destination INTO v_driver_trip
  FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id
  WHERE v.portal_user_id = v_portal_user_id AND o.status = 'open' AND o.travel_date = v_today
  ORDER BY o.created_at DESC LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('role', 'driver', 'trip_offer_id', v_driver_trip.trip_offer_id,
      'label', v_driver_trip.origin || ' → ' || v_driver_trip.destination,
      'link', '/portal/my-vehicle/trips');
  END IF;

  SELECT b.id AS booking_id, o.origin, o.destination INTO v_rider_booking
  FROM vehicle_trip_bookings b JOIN vehicle_trip_offers o ON o.id = b.trip_offer_id
  WHERE b.portal_user_id = v_portal_user_id AND b.status = 'confirmed' AND o.travel_date = v_today
  ORDER BY b.created_at DESC LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('role', 'rider', 'booking_id', v_rider_booking.booking_id,
      'label', v_rider_booking.origin || ' → ' || v_rider_booking.destination,
      'link', '/portal/marketplace/trip/' || v_rider_booking.booking_id);
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_ongoing_ride() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_ongoing_ride() TO authenticated;
