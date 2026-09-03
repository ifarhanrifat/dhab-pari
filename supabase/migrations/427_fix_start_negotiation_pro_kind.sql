-- Migration 427: 426 edited start_negotiation's kind check in-file after
-- it had already been pushed once (a first `db push` landed the version
-- still missing 'pro', found live-testing request_pro_service). db push
-- tracks applied migrations by filename, not content, so the corrected
-- body in 426 was silently never re-applied — landing it for real here.
-- Identical body to what 426 now contains.
CREATE OR REPLACE FUNCTION start_negotiation(
  p_kind varchar, p_vehicle_id uuid, p_item text, p_qty text DEFAULT NULL,
  p_budget_pkr decimal DEFAULT NULL, p_city_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v vehicles%ROWTYPE; v_thread_id uuid; v_body text;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_kind NOT IN ('fetch', 'share', 'pro') THEN RAISE EXCEPTION 'Invalid request kind.' USING ERRCODE = 'P0001'; END IF;
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
      CASE WHEN p_kind = 'fetch' THEN 'New item request' WHEN p_kind = 'pro' THEN 'New service request' ELSE 'New seat request' END,
      v_body, '/portal/marketplace/negotiations/' || v_thread_id);
  END IF;

  RETURN v_thread_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION start_negotiation(varchar, uuid, text, text, decimal, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION start_negotiation(varchar, uuid, text, text, decimal, uuid) TO authenticated;
