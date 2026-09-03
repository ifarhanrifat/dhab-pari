-- Migration 426: "Pro service"/Loading whole-vehicle charter booking.
-- Reuses negotiation_threads (422) exactly like weekend-commuter seat
-- requests do (424) — kind='pro' — rather than a third tiered-broadcast
-- clone of 423. A villager browses service_classes (Car AC, Rickshaw,
-- Suzuki Dala, ...), sees which vehicles currently offer that class
-- (vehicle_service_offers), and picks one to request from directly; the
-- system-computed proFare (pro_service_fare, 420) is passed through as
-- the opening budget so both sides start from the same number instead of
-- a cold open, exactly the role played by 424's fare_per_seat_pkr.
ALTER TABLE negotiation_threads DROP CONSTRAINT IF EXISTS negotiation_threads_kind_check;
ALTER TABLE negotiation_threads ADD CONSTRAINT negotiation_threads_kind_check CHECK (kind IN ('fetch', 'share', 'pro'));

-- start_negotiation (422) also hardcodes its own allowed-kind check
-- independent of the table constraint above — widen it the same way,
-- everything else in the function body unchanged.
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

CREATE OR REPLACE FUNCTION request_pro_service(p_vehicle_id uuid, p_service_class_id uuid, p_city_id uuid, p_is_return boolean)
RETURNS uuid AS $$
DECLARE
  sc service_classes%ROWTYPE;
  city cities%ROWTYPE;
  v_fare decimal;
  v_thread_id uuid;
BEGIN
  SELECT * INTO sc FROM service_classes WHERE id = p_service_class_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That service is not available.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO city FROM cities WHERE id = p_city_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicle_service_offers o WHERE o.vehicle_id = p_vehicle_id AND o.service_class_id = p_service_class_id AND o.is_active) THEN
    RAISE EXCEPTION 'This vehicle does not offer that service.' USING ERRCODE = 'P0001';
  END IF;

  v_fare := pro_service_fare(city.distance_km, sc.base_fare_pkr, sc.per_km_pkr, p_is_return);
  v_thread_id := start_negotiation(
    p_kind := 'pro', p_vehicle_id := p_vehicle_id,
    p_item := sc.name || ' · ' || city.name || (CASE WHEN p_is_return THEN ' (return)' ELSE ' (one-way)' END),
    p_qty := NULL, p_budget_pkr := v_fare, p_city_id := p_city_id
  );
  RETURN v_thread_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION request_pro_service(uuid, uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION request_pro_service(uuid, uuid, uuid, boolean) TO authenticated;

-- Read: every active vehicle offering a given service class, for the
-- browse screen — mirrors vehicles_present_in_city's role for dispatch.
CREATE OR REPLACE FUNCTION vehicles_offering_service(p_service_class_id uuid)
RETURNS TABLE(vehicle_id uuid, owner_name varchar, owner_mobile varchar, vehicle_type varchar, vehicle_number varchar) AS $$
  SELECT v.id, v.owner_name, v.owner_mobile, v.vehicle_type, v.vehicle_number
  FROM vehicle_service_offers o JOIN vehicles v ON v.id = o.vehicle_id
  WHERE o.service_class_id = p_service_class_id AND o.is_active AND v.is_active
  ORDER BY v.owner_name;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicles_offering_service(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicles_offering_service(uuid) TO authenticated;
