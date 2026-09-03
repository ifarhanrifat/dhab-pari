-- Migration 422: one general-purpose negotiation/chat system, reused by
-- both the city-fetch flow (§3 of the spec — "message a rider who's in
-- that city about an item") and weekend-commuter seat requests (§5) —
-- the handoff doc explicitly says to keep these two flows on "the same
-- negotiation thread... with chatKind: 'share'" rather than building a
-- second chat system. Deliberately NOT the same table as
-- vehicle_trip_fare_offers (400) — that one is seat-count + fare-per-seat
-- against a specific vehicle_trip_offer row; this is a free-text item/
-- request against a vehicle directly, with a real message thread, which
-- vehicle_trip_fare_offers was never built to carry.
--
-- In-app chat is the primary channel by design (see the same reasoning
-- captured in the frontend's PortalHelp copy later): it leaves a record
-- of the agreed price, which matters in a cash-only economy if there's
-- ever a dispute, and works over data rather than airtime. A real phone
-- call is still one tap away everywhere this is used — vehicles.
-- owner_mobile is already public, no separate "reveal number" step
-- needed.
CREATE TABLE IF NOT EXISTS negotiation_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind varchar NOT NULL CHECK (kind IN ('fetch', 'share')),
  initiator_portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  city_id uuid REFERENCES cities(id),
  item text,
  qty text,
  budget_pkr decimal,
  status varchar NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'agreed', 'declined', 'cancelled')),
  agreed_amount_pkr decimal,
  created_at timestamptz DEFAULT now(),
  closed_at timestamptz
);
CREATE INDEX IF NOT EXISTS negotiation_threads_initiator_idx ON negotiation_threads(initiator_portal_user_id);
CREATE INDEX IF NOT EXISTS negotiation_threads_vehicle_idx ON negotiation_threads(vehicle_id);

CREATE TABLE IF NOT EXISTS negotiation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES negotiation_threads(id) ON DELETE CASCADE,
  sender_role varchar NOT NULL CHECK (sender_role IN ('user', 'driver')),
  kind varchar NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'offer', 'system')),
  body text,
  amount_pkr decimal,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS negotiation_messages_thread_idx ON negotiation_messages(thread_id, created_at);

-- Only the two real parties to a thread can see it — private
-- correspondence, unlike the public shop/vehicle catalogs.
CREATE OR REPLACE FUNCTION is_party_to_negotiation(p_thread_id uuid) RETURNS boolean AS $$
  SELECT COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (
    SELECT 1 FROM negotiation_threads t
    LEFT JOIN vehicles v ON v.id = t.vehicle_id
    WHERE t.id = p_thread_id
      AND (t.initiator_portal_user_id = current_portal_user_id() OR v.portal_user_id = current_portal_user_id())
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

ALTER TABLE negotiation_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "negotiation_threads_parties_read" ON negotiation_threads FOR SELECT TO authenticated
  USING (is_party_to_negotiation(id));

ALTER TABLE negotiation_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "negotiation_messages_parties_read" ON negotiation_messages FOR SELECT TO authenticated
  USING (is_party_to_negotiation(thread_id));

-- All writes go through SECURITY DEFINER RPCs (below) so every state
-- transition — thread status, closed_at, message insert — happens
-- together and consistently; no direct table INSERT/UPDATE policies.

CREATE OR REPLACE FUNCTION start_negotiation(
  p_kind varchar, p_vehicle_id uuid, p_item text, p_qty text DEFAULT NULL,
  p_budget_pkr decimal DEFAULT NULL, p_city_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v vehicles%ROWTYPE; v_thread_id uuid; v_body text;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_kind NOT IN ('fetch', 'share') THEN RAISE EXCEPTION 'Invalid request kind.' USING ERRCODE = 'P0001'; END IF;
  IF p_item IS NULL OR trim(p_item) = '' THEN RAISE EXCEPTION 'Describe what you need first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF v.portal_user_id = v_portal_user_id THEN
    RAISE EXCEPTION 'You cannot send a request to your own vehicle.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO negotiation_threads (kind, initiator_portal_user_id, vehicle_id, city_id, item, qty, budget_pkr)
  VALUES (p_kind, v_portal_user_id, p_vehicle_id, p_city_id, p_item, p_qty, p_budget_pkr)
  RETURNING id INTO v_thread_id;

  v_body := p_item || COALESCE(' · ' || p_qty, '') || COALESCE(' · budget Rs ' || p_budget_pkr::text, '');
  INSERT INTO negotiation_messages (thread_id, sender_role, kind, body)
  VALUES (v_thread_id, 'user', 'text', v_body);

  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'negotiation_started',
      CASE WHEN p_kind = 'fetch' THEN 'New item request' ELSE 'New seat request' END,
      v_body, '/portal/marketplace/negotiations/' || v_thread_id);
  END IF;

  RETURN v_thread_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION start_negotiation(varchar, uuid, text, text, decimal, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION start_negotiation(varchar, uuid, text, text, decimal, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION send_negotiation_message(p_thread_id uuid, p_body text) RETURNS uuid AS $$
DECLARE
  t negotiation_threads%ROWTYPE; v vehicles%ROWTYPE; v_portal_user_id uuid := current_portal_user_id();
  v_role varchar; v_msg_id uuid; v_notify_portal_user_id uuid;
BEGIN
  IF p_body IS NULL OR trim(p_body) = '' THEN RAISE EXCEPTION 'Message cannot be empty.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO t FROM negotiation_threads WHERE id = p_thread_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Conversation not found.' USING ERRCODE = 'P0001'; END IF;
  IF t.status <> 'open' THEN RAISE EXCEPTION 'This conversation is closed.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = t.vehicle_id;

  IF t.initiator_portal_user_id = v_portal_user_id THEN
    v_role := 'user'; v_notify_portal_user_id := v.portal_user_id;
  ELSIF v.portal_user_id = v_portal_user_id THEN
    v_role := 'driver'; v_notify_portal_user_id := t.initiator_portal_user_id;
  ELSE
    RAISE EXCEPTION 'You are not part of this conversation.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO negotiation_messages (thread_id, sender_role, kind, body) VALUES (p_thread_id, v_role, 'text', p_body)
  RETURNING id INTO v_msg_id;

  IF v_notify_portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_notify_portal_user_id, 'negotiation_message', 'New message', p_body, '/portal/marketplace/negotiations/' || p_thread_id);
  END IF;
  RETURN v_msg_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION send_negotiation_message(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION send_negotiation_message(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION propose_negotiation_offer(p_thread_id uuid, p_amount_pkr decimal) RETURNS uuid AS $$
DECLARE
  t negotiation_threads%ROWTYPE; v vehicles%ROWTYPE; v_portal_user_id uuid := current_portal_user_id();
  v_role varchar; v_msg_id uuid; v_notify_portal_user_id uuid;
BEGIN
  IF p_amount_pkr IS NULL OR p_amount_pkr <= 0 THEN RAISE EXCEPTION 'Enter an amount.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO t FROM negotiation_threads WHERE id = p_thread_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Conversation not found.' USING ERRCODE = 'P0001'; END IF;
  IF t.status <> 'open' THEN RAISE EXCEPTION 'This conversation is closed.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = t.vehicle_id;

  IF t.initiator_portal_user_id = v_portal_user_id THEN
    v_role := 'user'; v_notify_portal_user_id := v.portal_user_id;
  ELSIF v.portal_user_id = v_portal_user_id THEN
    v_role := 'driver'; v_notify_portal_user_id := t.initiator_portal_user_id;
  ELSE
    RAISE EXCEPTION 'You are not part of this conversation.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO negotiation_messages (thread_id, sender_role, kind, amount_pkr) VALUES (p_thread_id, v_role, 'offer', p_amount_pkr)
  RETURNING id INTO v_msg_id;

  IF v_notify_portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_notify_portal_user_id, 'negotiation_offer', 'New price offer', 'Rs ' || p_amount_pkr::text, '/portal/marketplace/negotiations/' || p_thread_id);
  END IF;
  RETURN v_msg_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION propose_negotiation_offer(uuid, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION propose_negotiation_offer(uuid, decimal) TO authenticated;

-- Accepting the OTHER side's most recent offer message closes the deal.
-- Reads the last 'offer' message in the thread rather than taking an
-- amount from the caller, so "accept" always means "accept what they
-- actually last said," not whatever the client happens to have cached.
CREATE OR REPLACE FUNCTION accept_negotiation(p_thread_id uuid) RETURNS void AS $$
DECLARE
  t negotiation_threads%ROWTYPE; v vehicles%ROWTYPE; v_portal_user_id uuid := current_portal_user_id();
  v_role varchar; v_last_offer negotiation_messages%ROWTYPE; v_notify_portal_user_id uuid;
BEGIN
  SELECT * INTO t FROM negotiation_threads WHERE id = p_thread_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Conversation not found.' USING ERRCODE = 'P0001'; END IF;
  IF t.status <> 'open' THEN RAISE EXCEPTION 'This conversation is closed.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = t.vehicle_id;

  IF t.initiator_portal_user_id = v_portal_user_id THEN v_role := 'user'; v_notify_portal_user_id := v.portal_user_id;
  ELSIF v.portal_user_id = v_portal_user_id THEN v_role := 'driver'; v_notify_portal_user_id := t.initiator_portal_user_id;
  ELSE RAISE EXCEPTION 'You are not part of this conversation.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_last_offer FROM negotiation_messages
    WHERE thread_id = p_thread_id AND kind = 'offer' AND sender_role <> v_role
    ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'There is no offer to accept yet.' USING ERRCODE = 'P0001'; END IF;

  UPDATE negotiation_threads SET status = 'agreed', agreed_amount_pkr = v_last_offer.amount_pkr, closed_at = now() WHERE id = p_thread_id;
  INSERT INTO negotiation_messages (thread_id, sender_role, kind, body, amount_pkr)
  VALUES (p_thread_id, v_role, 'system', 'Deal agreed', v_last_offer.amount_pkr);

  IF v_notify_portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_notify_portal_user_id, 'negotiation_agreed', 'Deal agreed', 'Rs ' || v_last_offer.amount_pkr::text, '/portal/marketplace/negotiations/' || p_thread_id);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION accept_negotiation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_negotiation(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION close_negotiation(p_thread_id uuid, p_action varchar) RETURNS void AS $$
DECLARE
  t negotiation_threads%ROWTYPE; v vehicles%ROWTYPE; v_portal_user_id uuid := current_portal_user_id();
  v_role varchar; v_notify_portal_user_id uuid;
BEGIN
  IF p_action NOT IN ('decline', 'cancel') THEN RAISE EXCEPTION 'Invalid action.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO t FROM negotiation_threads WHERE id = p_thread_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Conversation not found.' USING ERRCODE = 'P0001'; END IF;
  IF t.status <> 'open' THEN RAISE EXCEPTION 'This conversation is already closed.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = t.vehicle_id;

  IF t.initiator_portal_user_id = v_portal_user_id THEN v_role := 'user'; v_notify_portal_user_id := v.portal_user_id;
  ELSIF v.portal_user_id = v_portal_user_id THEN v_role := 'driver'; v_notify_portal_user_id := t.initiator_portal_user_id;
  ELSE RAISE EXCEPTION 'You are not part of this conversation.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE negotiation_threads SET status = CASE WHEN p_action = 'decline' THEN 'declined' ELSE 'cancelled' END, closed_at = now()
    WHERE id = p_thread_id;
  INSERT INTO negotiation_messages (thread_id, sender_role, kind, body)
  VALUES (p_thread_id, v_role, 'system', CASE WHEN p_action = 'decline' THEN 'Declined' ELSE 'Cancelled' END);

  IF v_notify_portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v_notify_portal_user_id, 'negotiation_closed',
      CASE WHEN p_action = 'decline' THEN 'Request declined' ELSE 'Request cancelled' END, t.item, '/portal/marketplace/negotiations/' || p_thread_id);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION close_negotiation(uuid, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION close_negotiation(uuid, varchar) TO authenticated;

-- One read RPC returning the thread + its messages together — the chat
-- screen's whole data need in one round trip, same convention adda_board()
-- already established for "header info + list" screens.
CREATE OR REPLACE FUNCTION negotiation_thread_detail(p_thread_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'thread', jsonb_build_object(
      'id', t.id, 'kind', t.kind, 'status', t.status, 'item', t.item, 'qty', t.qty,
      'budget_pkr', t.budget_pkr, 'agreed_amount_pkr', t.agreed_amount_pkr, 'created_at', t.created_at,
      'is_mine_as_user', t.initiator_portal_user_id = current_portal_user_id(),
      'vehicle_id', v.id, 'vehicle_owner_name', v.owner_name, 'vehicle_owner_mobile', v.owner_mobile,
      'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number
    ),
    'messages', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'sender_role', m.sender_role, 'kind', m.kind, 'body', m.body, 'amount_pkr', m.amount_pkr, 'created_at', m.created_at
      ) ORDER BY m.created_at ASC)
      FROM negotiation_messages m WHERE m.thread_id = t.id
    ), '[]'::jsonb)
  )
  FROM negotiation_threads t JOIN vehicles v ON v.id = t.vehicle_id
  WHERE t.id = p_thread_id AND is_party_to_negotiation(t.id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION negotiation_thread_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION negotiation_thread_detail(uuid) TO authenticated;

-- Every thread a portal user is a party to (as the initiating villager
-- OR as the vehicle's own driver) — powers "my conversations" lists on
-- both sides without two separate queries.
CREATE OR REPLACE FUNCTION my_negotiation_threads() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', t.id, 'kind', t.kind, 'status', t.status, 'item', t.item, 'agreed_amount_pkr', t.agreed_amount_pkr,
    'created_at', t.created_at, 'as_role', CASE WHEN t.initiator_portal_user_id = current_portal_user_id() THEN 'user' ELSE 'driver' END,
    'vehicle_owner_name', v.owner_name, 'vehicle_type', v.vehicle_type,
    'last_message', (SELECT COALESCE(m.body, 'Rs ' || m.amount_pkr::text) FROM negotiation_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1)
  ) ORDER BY t.created_at DESC), '[]'::jsonb)
  FROM negotiation_threads t JOIN vehicles v ON v.id = t.vehicle_id
  WHERE t.initiator_portal_user_id = current_portal_user_id() OR v.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_negotiation_threads() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_negotiation_threads() TO authenticated;
