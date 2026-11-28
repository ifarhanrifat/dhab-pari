-- Migration 981: real bug caught live while verification-testing 980 —
-- booking_thread_id() returned null for a fleet manager account acting
-- on a real machinery booking, even though create_equipment_booking had
-- already created the thread. Root cause: the whole negotiation chat
-- system (422) checks vehicle party membership as raw
-- `vehicles.portal_user_id = current_portal_user_id()` everywhere —
-- exactly the same bug class migration 852 already fixed for every
-- other equipment RPC ("equipment fleet parity"), just never applied to
-- chat. Confirmed by reading every negotiation_* function: only the
-- vehicle's own literally-registered driver account can read or send a
-- message, or even see the thread in their own list — a fleet owner or
-- any fleet_staff member (manager included) is invisible to the chat
-- system entirely today. This is not equipment-specific — the same
-- negotiation_threads/negotiation_messages system also backs hourly/
-- rental/shadi booking chat, so the fix benefits all of them identically.
--
-- Three functions actually do the raw check (is_party_to_negotiation,
-- send_negotiation_message, my_negotiation_threads); negotiation_thread_
-- detail and chat_has_unread both call is_party_to_negotiation so they're
-- fixed transitively. mark_chat_read does no party check at all today
-- (pre-existing, out of scope — it only ever marks the caller's own read
-- marker, nothing sensitive to leak).

CREATE OR REPLACE FUNCTION is_party_to_negotiation(p_thread_id uuid) RETURNS boolean AS $$
  SELECT COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (
    SELECT 1 FROM negotiation_threads t
    WHERE t.id = p_thread_id
      AND (t.initiator_portal_user_id = current_portal_user_id() OR can_manage_vehicle(t.vehicle_id))
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

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
  ELSIF can_manage_vehicle(v.id) THEN
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

CREATE OR REPLACE FUNCTION my_negotiation_threads() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', t.id, 'kind', t.kind, 'status', t.status, 'item', t.item, 'agreed_amount_pkr', t.agreed_amount_pkr,
    'created_at', t.created_at, 'as_role', CASE WHEN t.initiator_portal_user_id = current_portal_user_id() THEN 'user' ELSE 'driver' END,
    'vehicle_owner_name', v.owner_name, 'vehicle_type', v.vehicle_type,
    'last_message', (SELECT COALESCE(m.body, 'Rs ' || m.amount_pkr::text) FROM negotiation_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1)
  ) ORDER BY t.created_at DESC), '[]'::jsonb)
  FROM negotiation_threads t JOIN vehicles v ON v.id = t.vehicle_id
  WHERE t.initiator_portal_user_id = current_portal_user_id() OR can_manage_vehicle(v.id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
