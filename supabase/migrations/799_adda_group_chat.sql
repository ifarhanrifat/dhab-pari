-- Migration 799: real ask, 2026-11-04 — continuing the inline-chat
-- work (step 1 was hourly/rental/equipment's 1:1 negotiation thread).
-- Adda (turn-based queue bookings) has NO chat mechanism at all today
-- — confirmed directly, book_adda_seat never touches negotiation_threads
-- or trip_group_messages.
--
-- Routes were ALSO suspected to be missing this (same research pass
-- that found Adda's gap), but a deeper check found this wrong — Routes
-- already have a real, already-reachable, driver+rider chat
-- (RouteGroupPanel.tsx, send_route_message/route_group_detail, 718),
-- the actual "monthly rider" case this whole push was motivated by. No
-- route changes needed here at all; building a second route chat
-- mechanism would have been a genuine duplicate.
--
-- The right shape for Adda is the GROUP chat trip_group_messages (745)
-- already built for one-off ride-sharing trips — one driver, N
-- currently-booked riders, not negotiation_threads' strict 2-party
-- model. Generalizes that same table to also key off an
-- adda_queue_entry_id (exactly one of trip_offer_id/adda_queue_entry_id
-- set per row) rather than building a near-identical table from scratch.

ALTER TABLE trip_group_messages ALTER COLUMN trip_offer_id DROP NOT NULL;
ALTER TABLE trip_group_messages ADD COLUMN IF NOT EXISTS adda_queue_entry_id uuid REFERENCES adda_queue_entries(id) ON DELETE CASCADE;
ALTER TABLE trip_group_messages DROP CONSTRAINT IF EXISTS trip_group_messages_exactly_one_ref;
ALTER TABLE trip_group_messages ADD CONSTRAINT trip_group_messages_exactly_one_ref CHECK (
  (trip_offer_id IS NOT NULL)::int + (adda_queue_entry_id IS NOT NULL)::int = 1
);
CREATE INDEX IF NOT EXISTS trip_group_messages_adda_idx ON trip_group_messages(adda_queue_entry_id, created_at) WHERE adda_queue_entry_id IS NOT NULL;

-- Adda membership: the queue entry's own driver, or anyone with a real
-- (not rejected) booking on it — 'announced' included, not just
-- 'confirmed', since a rider waiting on committee confirmation is
-- still a genuine party who may need to coordinate pickup details.
CREATE OR REPLACE FUNCTION is_party_to_adda_group(p_adda_queue_entry_id uuid) RETURNS boolean AS $$
  SELECT COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (
    SELECT 1 FROM adda_queue_entries e JOIN vehicles v ON v.id = e.vehicle_id
    WHERE e.id = p_adda_queue_entry_id AND v.portal_user_id = current_portal_user_id()
  ) OR EXISTS (
    SELECT 1 FROM ride_bookings b
    WHERE b.adda_queue_entry_id = p_adda_queue_entry_id AND b.portal_user_id = current_portal_user_id() AND b.status IN ('announced', 'confirmed')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION is_party_to_adda_group(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_party_to_adda_group(uuid) TO authenticated;

CREATE POLICY "trip_group_messages_adda_parties_read" ON trip_group_messages FOR SELECT TO authenticated
  USING (adda_queue_entry_id IS NOT NULL AND is_party_to_adda_group(adda_queue_entry_id));

CREATE OR REPLACE FUNCTION adda_group_chat_messages(p_adda_queue_entry_id uuid) RETURNS jsonb AS $$
  SELECT CASE WHEN NOT is_party_to_adda_group(p_adda_queue_entry_id) THEN '[]'::jsonb ELSE COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', m.id, 'sender_role', m.sender_role, 'sender_name', pu.full_name,
      'is_me', m.sender_portal_user_id = current_portal_user_id(),
      'body', m.body, 'created_at', m.created_at
    ) ORDER BY m.created_at ASC)
    FROM trip_group_messages m JOIN portal_users pu ON pu.id = m.sender_portal_user_id
    WHERE m.adda_queue_entry_id = p_adda_queue_entry_id
  ), '[]'::jsonb) END;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION adda_group_chat_messages(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION adda_group_chat_messages(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION send_adda_group_message(p_adda_queue_entry_id uuid, p_body text) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  e adda_queue_entries%ROWTYPE; v vehicles%ROWTYPE; v_role varchar; v_msg_id uuid; v_sender_name text; v_adda_name text;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_body IS NULL OR trim(p_body) = '' THEN RAISE EXCEPTION 'Message cannot be empty.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO e FROM adda_queue_entries WHERE id = p_adda_queue_entry_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Queue entry not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = e.vehicle_id;

  IF v.portal_user_id = v_portal_user_id THEN v_role := 'driver';
  ELSIF EXISTS (SELECT 1 FROM ride_bookings b WHERE b.adda_queue_entry_id = p_adda_queue_entry_id AND b.portal_user_id = v_portal_user_id AND b.status IN ('announced', 'confirmed')) THEN v_role := 'rider';
  ELSE RAISE EXCEPTION 'You are not part of this ride.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO trip_group_messages (adda_queue_entry_id, sender_portal_user_id, sender_role, body)
  VALUES (p_adda_queue_entry_id, v_portal_user_id, v_role, trim(p_body))
  RETURNING id INTO v_msg_id;

  SELECT full_name INTO v_sender_name FROM portal_users WHERE id = v_portal_user_id;
  SELECT name INTO v_adda_name FROM addas WHERE id = e.adda_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT DISTINCT pu_id, 'trip_group_message', v_sender_name || ' (' || COALESCE(v_adda_name, '') || ')', trim(p_body), '/portal/my-vehicle/adda'
  FROM (
    SELECT v.portal_user_id AS pu_id WHERE v.portal_user_id IS NOT NULL AND v.portal_user_id != v_portal_user_id
    UNION
    SELECT b.portal_user_id FROM ride_bookings b WHERE b.adda_queue_entry_id = p_adda_queue_entry_id AND b.status IN ('announced', 'confirmed') AND b.portal_user_id != v_portal_user_id
  ) parties(pu_id);

  RETURN v_msg_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION send_adda_group_message(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION send_adda_group_message(uuid, text) TO authenticated;
