-- Migration 801: real ask, 2026-11-04 — "when there is a message of
-- rider or driver then there should be a red alert on that chat icon."
-- One generic read-mark table, keyed by the exact (thread_type,
-- thread_ref_id) pairs the chat panels already use as props
-- (hourly_booking/rental_booking/equipment_booking/shadi_vehicle_request
-- for the 1:1 BookingChatPanel; trip/adda for the group GroupChatPanel)
-- — no new identifiers invented, this just remembers "when did this
-- portal_user last look at this specific chat."

CREATE TABLE IF NOT EXISTS chat_read_marks (
  thread_type varchar NOT NULL CHECK (thread_type IN ('hourly_booking', 'rental_booking', 'equipment_booking', 'shadi_vehicle_request', 'trip', 'adda')),
  thread_ref_id uuid NOT NULL,
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_type, thread_ref_id, portal_user_id)
);
ALTER TABLE chat_read_marks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chat_read_marks_own" ON chat_read_marks FOR ALL TO authenticated
  USING (portal_user_id = current_portal_user_id()) WITH CHECK (portal_user_id = current_portal_user_id());

CREATE OR REPLACE FUNCTION mark_chat_read(p_thread_type varchar, p_thread_ref_id uuid) RETURNS void AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF v_portal_user_id IS NULL THEN RETURN; END IF;
  INSERT INTO chat_read_marks (thread_type, thread_ref_id, portal_user_id, last_read_at)
  VALUES (p_thread_type, p_thread_ref_id, v_portal_user_id, now())
  ON CONFLICT (thread_type, thread_ref_id, portal_user_id) DO UPDATE SET last_read_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION mark_chat_read(varchar, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mark_chat_read(varchar, uuid) TO authenticated;

-- One check per chat icon rendered, cheap enough (STABLE, indexed
-- lookups) to call per-mount + a short poll, same pattern every other
-- "is there something new" indicator in this app already uses.
CREATE OR REPLACE FUNCTION chat_has_unread(p_thread_type varchar, p_thread_ref_id uuid) RETURNS boolean AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_last_read timestamptz;
  v_thread_id uuid;
  v_is_user boolean;
BEGIN
  IF v_portal_user_id IS NULL THEN RETURN false; END IF;
  SELECT last_read_at INTO v_last_read FROM chat_read_marks
  WHERE thread_type = p_thread_type AND thread_ref_id = p_thread_ref_id AND portal_user_id = v_portal_user_id;

  IF p_thread_type IN ('hourly_booking', 'rental_booking', 'equipment_booking', 'shadi_vehicle_request') THEN
    SELECT t.id, (t.initiator_portal_user_id = v_portal_user_id) INTO v_thread_id, v_is_user
    FROM negotiation_threads t WHERE t.ref_type = p_thread_type AND t.ref_id = p_thread_ref_id AND is_party_to_negotiation(t.id);
    IF v_thread_id IS NULL THEN RETURN false; END IF;
    RETURN EXISTS (
      SELECT 1 FROM negotiation_messages m
      WHERE m.thread_id = v_thread_id AND m.sender_role != (CASE WHEN v_is_user THEN 'user' ELSE 'driver' END)
        AND (v_last_read IS NULL OR m.created_at > v_last_read)
    );
  ELSIF p_thread_type = 'trip' THEN
    IF NOT is_party_to_trip_group(p_thread_ref_id) THEN RETURN false; END IF;
    RETURN EXISTS (
      SELECT 1 FROM trip_group_messages m
      WHERE m.trip_offer_id = p_thread_ref_id AND m.sender_portal_user_id != v_portal_user_id
        AND (v_last_read IS NULL OR m.created_at > v_last_read)
    );
  ELSIF p_thread_type = 'adda' THEN
    IF NOT is_party_to_adda_group(p_thread_ref_id) THEN RETURN false; END IF;
    RETURN EXISTS (
      SELECT 1 FROM trip_group_messages m
      WHERE m.adda_queue_entry_id = p_thread_ref_id AND m.sender_portal_user_id != v_portal_user_id
        AND (v_last_read IS NULL OR m.created_at > v_last_read)
    );
  END IF;
  RETURN false;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION chat_has_unread(varchar, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat_has_unread(varchar, uuid) TO authenticated;
