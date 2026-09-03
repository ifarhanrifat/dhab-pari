-- Migration 423: broadcast dispatch — the "pizza case" from the spec.
-- A villager picks a shop in a city, the call rings every vehicle
-- already present in that city (tier 1); if none accept within the
-- window, it forwards to every other delivery-enabled vehicle village-
-- wide (tier 2, "will travel out for this"); first ACCEPT wins, every
-- other invitation is cancelled. The system then computes a price
-- (goods + round-trip fare + a flat wait fee) that the villager must
-- approve before the driver is considered committed.
--
-- No server-side timer process — advance_dispatch_call() is a plain
-- "check elapsed time, advance if needed" sweep, called from the client
-- poll loop the dispatch screen already needs anyway (same shape as
-- adda_promote_next(): explicit calls, not a persistent job).

-- city_shops — shops OUTSIDE the village, orderable only via broadcast
-- dispatch. Deliberately a separate table from `shops` (388): those are
-- in-village, browsed/ordered directly with real stock; these are just
-- "a place in a city you can ask someone to visit for you" — no
-- inventory, no direct online order, no delivery_enabled flag (dispatch
-- IS the delivery mechanism here).
CREATE TABLE IF NOT EXISTS city_shops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar NOT NULL,
  name_ur varchar,
  city_id uuid NOT NULL REFERENCES cities(id),
  category varchar,
  category_ur varchar,
  place varchar,
  place_ur varchar,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS city_shops_city_id_idx ON city_shops(city_id) WHERE is_active;

ALTER TABLE city_shops ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_city_shops" ON city_shops FOR SELECT USING (true);
CREATE POLICY "city_shops_write" ON city_shops FOR INSERT TO authenticated
  WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "city_shops_update" ON city_shops FOR UPDATE TO authenticated
  USING (true) WITH CHECK (current_admin_permission('manage_parties'));
CREATE POLICY "city_shops_delete" ON city_shops FOR DELETE TO authenticated
  USING (current_admin_permission('delete_transactions'));

-- Per-vehicle km rate for dispatch/pro-service fare math — distinct from
-- service_classes.per_km_pkr (a catalog default) since a real vehicle's
-- own rate can differ from its class average; admin-set, same honesty
-- convention as fixed_fare_per_seat_pkr (415) — NULL until someone sets
-- it, and accept_dispatch_call refuses to price a call for a vehicle
-- that hasn't been given one rather than silently guessing.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS per_km_pkr decimal CHECK (per_km_pkr IS NULL OR per_km_pkr >= 0);

CREATE TABLE IF NOT EXISTS dispatch_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  initiator_portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  city_shop_id uuid NOT NULL REFERENCES city_shops(id),
  item text NOT NULL,
  address text NOT NULL,
  goods_budget_pkr decimal NOT NULL CHECK (goods_budget_pkr >= 0),
  status varchar NOT NULL DEFAULT 'tier1' CHECK (status IN ('tier1', 'tier2', 'no_answer', 'priced', 'approved', 'completed', 'cancelled')),
  tier1_started_at timestamptz DEFAULT now(),
  tier2_started_at timestamptz,
  accepted_vehicle_id uuid REFERENCES vehicles(id),
  fare_outbound_pkr decimal,
  fare_return_pkr decimal,
  wait_fee_pkr decimal DEFAULT 50,
  total_pkr decimal,
  approved_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dispatch_calls_initiator_idx ON dispatch_calls(initiator_portal_user_id);

CREATE TABLE IF NOT EXISTS dispatch_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES dispatch_calls(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  tier int NOT NULL CHECK (tier IN (1, 2)),
  status varchar NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing', 'declined', 'accepted', 'expired')),
  invited_at timestamptz DEFAULT now(),
  responded_at timestamptz,
  UNIQUE (call_id, vehicle_id)
);
CREATE INDEX IF NOT EXISTS dispatch_invitations_call_idx ON dispatch_invitations(call_id);
CREATE INDEX IF NOT EXISTS dispatch_invitations_vehicle_idx ON dispatch_invitations(vehicle_id) WHERE status = 'ringing';

CREATE OR REPLACE FUNCTION is_party_to_dispatch(p_call_id uuid) RETURNS boolean AS $$
  SELECT COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (
    SELECT 1 FROM dispatch_calls c WHERE c.id = p_call_id AND c.initiator_portal_user_id = current_portal_user_id()
  ) OR EXISTS (
    SELECT 1 FROM dispatch_invitations i JOIN vehicles v ON v.id = i.vehicle_id
    WHERE i.call_id = p_call_id AND v.portal_user_id = current_portal_user_id()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

ALTER TABLE dispatch_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY "dispatch_calls_parties_read" ON dispatch_calls FOR SELECT TO authenticated USING (is_party_to_dispatch(id));

ALTER TABLE dispatch_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "dispatch_invitations_parties_read" ON dispatch_invitations FOR SELECT TO authenticated USING (is_party_to_dispatch(call_id));

-- Every eligible vehicle for tier1 (present in the shop's city, delivers)
-- or tier2 (delivers, NOT already present in that city — the "will
-- travel out for this" pool). A vehicle already invited (any status) for
-- this call is never re-invited into the other tier.
CREATE OR REPLACE FUNCTION invite_dispatch_tier(p_call_id uuid, p_tier int) RETURNS int AS $$
DECLARE v_city_id uuid; v_count int;
BEGIN
  SELECT s.city_id INTO v_city_id FROM dispatch_calls c JOIN city_shops s ON s.id = c.city_shop_id WHERE c.id = p_call_id;

  INSERT INTO dispatch_invitations (call_id, vehicle_id, tier)
  SELECT p_call_id, v.id, p_tier
  FROM vehicles v
  WHERE v.is_active AND v.delivers
    AND NOT EXISTS (SELECT 1 FROM dispatch_invitations i WHERE i.call_id = p_call_id AND i.vehicle_id = v.id)
    AND (
      (p_tier = 1 AND EXISTS (SELECT 1 FROM vehicle_city_presence p WHERE p.vehicle_id = v.id AND p.city_id = v_city_id AND p.is_active))
      OR
      (p_tier = 2 AND NOT EXISTS (SELECT 1 FROM vehicle_city_presence p WHERE p.vehicle_id = v.id AND p.city_id = v_city_id AND p.is_active))
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION create_dispatch_call(p_city_shop_id uuid, p_item text, p_address text, p_goods_budget_pkr decimal)
RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id(); v_call_id uuid; v_tier1_count int;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_item IS NULL OR trim(p_item) = '' THEN RAISE EXCEPTION 'Describe the order first.' USING ERRCODE = 'P0001'; END IF;
  IF p_address IS NULL OR trim(p_address) = '' THEN RAISE EXCEPTION 'Enter a delivery address.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM city_shops WHERE id = p_city_shop_id AND is_active) THEN
    RAISE EXCEPTION 'This shop is not available.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO dispatch_calls (initiator_portal_user_id, city_shop_id, item, address, goods_budget_pkr, status)
  VALUES (v_portal_user_id, p_city_shop_id, p_item, p_address, p_goods_budget_pkr, 'tier1')
  RETURNING id INTO v_call_id;

  v_tier1_count := invite_dispatch_tier(v_call_id, 1);
  IF v_tier1_count = 0 THEN
    -- Nobody there right now — go straight to tier 2 instead of ringing
    -- an empty room for 60 seconds.
    PERFORM invite_dispatch_tier(v_call_id, 2);
    UPDATE dispatch_calls SET status = 'tier2', tier2_started_at = now() WHERE id = v_call_id;
  END IF;

  -- Notify everyone invited in whichever tier actually got invitations.
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'dispatch_invited', 'Delivery request', p_item, '/portal/marketplace/dispatch/' || v_call_id
  FROM dispatch_invitations i JOIN vehicles v ON v.id = i.vehicle_id
  WHERE i.call_id = v_call_id AND v.portal_user_id IS NOT NULL;

  RETURN v_call_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION create_dispatch_call(uuid, text, text, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_dispatch_call(uuid, text, text, decimal) TO authenticated;

-- Client-polled sweep — call repeatedly while a dispatch screen is open.
-- Advances tier1→tier2 (or tier2→no_answer) once the 60s window has
-- passed with nothing accepted; a no-op otherwise. Also the entry point
-- an explicit decline uses when it empties out the current tier early.
CREATE OR REPLACE FUNCTION advance_dispatch_call(p_call_id uuid) RETURNS jsonb AS $$
DECLARE c dispatch_calls%ROWTYPE; v_ringing_left int;
BEGIN
  SELECT * INTO c FROM dispatch_calls WHERE id = p_call_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Call not found.' USING ERRCODE = 'P0001'; END IF;

  IF c.status = 'tier1' THEN
    SELECT count(*) INTO v_ringing_left FROM dispatch_invitations WHERE call_id = p_call_id AND tier = 1 AND status = 'ringing';
    IF v_ringing_left = 0 OR now() - c.tier1_started_at > interval '60 seconds' THEN
      UPDATE dispatch_invitations SET status = 'expired', responded_at = now() WHERE call_id = p_call_id AND tier = 1 AND status = 'ringing';
      PERFORM invite_dispatch_tier(p_call_id, 2);
      IF EXISTS (SELECT 1 FROM dispatch_invitations WHERE call_id = p_call_id AND tier = 2) THEN
        UPDATE dispatch_calls SET status = 'tier2', tier2_started_at = now() WHERE id = p_call_id;
        INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
        SELECT v.portal_user_id, 'dispatch_invited', 'Delivery request', c.item, '/portal/marketplace/dispatch/' || p_call_id
        FROM dispatch_invitations i JOIN vehicles v ON v.id = i.vehicle_id
        WHERE i.call_id = p_call_id AND i.tier = 2 AND v.portal_user_id IS NOT NULL;
      ELSE
        UPDATE dispatch_calls SET status = 'no_answer' WHERE id = p_call_id;
      END IF;
    END IF;
  ELSIF c.status = 'tier2' THEN
    SELECT count(*) INTO v_ringing_left FROM dispatch_invitations WHERE call_id = p_call_id AND tier = 2 AND status = 'ringing';
    IF v_ringing_left = 0 OR now() - c.tier2_started_at > interval '60 seconds' THEN
      UPDATE dispatch_invitations SET status = 'expired', responded_at = now() WHERE call_id = p_call_id AND tier = 2 AND status = 'ringing';
      UPDATE dispatch_calls SET status = 'no_answer' WHERE id = p_call_id;
    END IF;
  END IF;

  RETURN dispatch_call_detail(p_call_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION advance_dispatch_call(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION advance_dispatch_call(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION decline_dispatch_call(p_call_id uuid, p_vehicle_id uuid) RETURNS void AS $$
DECLARE v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND OR v.portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE dispatch_invitations SET status = 'declined', responded_at = now()
    WHERE call_id = p_call_id AND vehicle_id = p_vehicle_id AND status = 'ringing';
  PERFORM advance_dispatch_call(p_call_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION decline_dispatch_call(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION decline_dispatch_call(uuid, uuid) TO authenticated;

-- dispatchTotal(km, rate, goods) = goods + 2*roundTo10(km*rate) + 50 —
-- outbound and return legs rounded individually then summed (not the
-- total rounded once), matching the spec's own formula and the 4-row
-- price breakdown the UI shows (goods / outbound / return / wait fee).
CREATE OR REPLACE FUNCTION accept_dispatch_call(p_call_id uuid, p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE
  c dispatch_calls%ROWTYPE; v vehicles%ROWTYPE; v_city_km decimal; v_leg_fare decimal;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND OR v.portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF v.per_km_pkr IS NULL THEN
    RAISE EXCEPTION 'Your per-km rate has not been set yet — ask the committee to set it before accepting deliveries.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO c FROM dispatch_calls WHERE id = p_call_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Call not found.' USING ERRCODE = 'P0001'; END IF;
  IF c.status NOT IN ('tier1', 'tier2') THEN RAISE EXCEPTION 'This call is no longer open.' USING ERRCODE = 'P0001'; END IF;

  UPDATE dispatch_invitations SET status = 'accepted', responded_at = now()
    WHERE call_id = p_call_id AND vehicle_id = p_vehicle_id AND status = 'ringing';
  IF NOT FOUND THEN RAISE EXCEPTION 'You were not invited to this call, or someone else already accepted it.' USING ERRCODE = 'P0001'; END IF;

  -- First accept wins — every other still-ringing invitation is closed out.
  UPDATE dispatch_invitations SET status = 'expired', responded_at = now()
    WHERE call_id = p_call_id AND vehicle_id <> p_vehicle_id AND status = 'ringing';

  SELECT ci.distance_km INTO v_city_km FROM city_shops s JOIN cities ci ON ci.id = s.city_id WHERE s.id = c.city_shop_id;
  v_leg_fare := round_to_10(v_city_km * v.per_km_pkr);

  UPDATE dispatch_calls SET
    status = 'priced', accepted_vehicle_id = p_vehicle_id,
    fare_outbound_pkr = v_leg_fare, fare_return_pkr = v_leg_fare, wait_fee_pkr = 50,
    total_pkr = c.goods_budget_pkr + v_leg_fare + v_leg_fare + 50
  WHERE id = p_call_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (c.initiator_portal_user_id, 'dispatch_accepted', 'Delivery accepted', v.owner_name || ' — Rs ' || (c.goods_budget_pkr + v_leg_fare + v_leg_fare + 50)::text, '/portal/marketplace/dispatch/' || p_call_id);

  RETURN dispatch_call_detail(p_call_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION accept_dispatch_call(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_dispatch_call(uuid, uuid) TO authenticated;

-- Approval is the commitment point per the spec — the driver doesn't
-- leave until the villager has seen and approved the total.
CREATE OR REPLACE FUNCTION approve_dispatch_price(p_call_id uuid) RETURNS void AS $$
DECLARE c dispatch_calls%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO c FROM dispatch_calls WHERE id = p_call_id FOR UPDATE;
  IF NOT FOUND OR c.initiator_portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this call.' USING ERRCODE = 'P0001';
  END IF;
  IF c.status <> 'priced' THEN RAISE EXCEPTION 'There is no price waiting for approval.' USING ERRCODE = 'P0001'; END IF;

  UPDATE dispatch_calls SET status = 'approved', approved_at = now() WHERE id = p_call_id;
  SELECT * INTO v FROM vehicles WHERE id = c.accepted_vehicle_id;
  IF v.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (v.portal_user_id, 'dispatch_approved', 'Price approved — go ahead', c.item, '/portal/marketplace/dispatch/' || p_call_id);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION approve_dispatch_price(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION approve_dispatch_price(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION complete_dispatch_call(p_call_id uuid) RETURNS void AS $$
DECLARE c dispatch_calls%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO c FROM dispatch_calls WHERE id = p_call_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Call not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = c.accepted_vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this delivery.' USING ERRCODE = 'P0001';
  END IF;
  IF c.status <> 'approved' THEN RAISE EXCEPTION 'This call is not awaiting completion.' USING ERRCODE = 'P0001'; END IF;
  UPDATE dispatch_calls SET status = 'completed', completed_at = now() WHERE id = p_call_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (c.initiator_portal_user_id, 'dispatch_completed', 'Delivered', c.item, '/portal/marketplace/dispatch/' || p_call_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION complete_dispatch_call(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION complete_dispatch_call(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION cancel_dispatch_call(p_call_id uuid) RETURNS void AS $$
DECLARE c dispatch_calls%ROWTYPE;
BEGIN
  SELECT * INTO c FROM dispatch_calls WHERE id = p_call_id FOR UPDATE;
  IF NOT FOUND OR c.initiator_portal_user_id <> current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this call.' USING ERRCODE = 'P0001';
  END IF;
  IF c.status IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'This call is already closed.' USING ERRCODE = 'P0001'; END IF;
  UPDATE dispatch_calls SET status = 'cancelled', cancelled_at = now() WHERE id = p_call_id;
  UPDATE dispatch_invitations SET status = 'expired', responded_at = now() WHERE call_id = p_call_id AND status = 'ringing';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION cancel_dispatch_call(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancel_dispatch_call(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION dispatch_call_detail(p_call_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'call', jsonb_build_object(
      'id', c.id, 'item', c.item, 'address', c.address, 'goods_budget_pkr', c.goods_budget_pkr, 'status', c.status,
      'fare_outbound_pkr', c.fare_outbound_pkr, 'fare_return_pkr', c.fare_return_pkr, 'wait_fee_pkr', c.wait_fee_pkr, 'total_pkr', c.total_pkr,
      'shop_name', s.name, 'shop_name_ur', s.name_ur, 'city_name', ci.name, 'city_km', ci.distance_km,
      'accepted_vehicle_id', av.id, 'accepted_owner_name', av.owner_name, 'accepted_owner_mobile', av.owner_mobile, 'accepted_vehicle_type', av.vehicle_type
    ),
    'invitations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'vehicle_id', v.id, 'owner_name', v.owner_name, 'tier', i.tier, 'status', i.status, 'invited_at', i.invited_at, 'responded_at', i.responded_at
      ) ORDER BY i.tier, i.invited_at)
      FROM dispatch_invitations i JOIN vehicles v ON v.id = i.vehicle_id WHERE i.call_id = c.id
    ), '[]'::jsonb)
  )
  FROM dispatch_calls c
  JOIN city_shops s ON s.id = c.city_shop_id
  JOIN cities ci ON ci.id = s.city_id
  LEFT JOIN vehicles av ON av.id = c.accepted_vehicle_id
  WHERE c.id = p_call_id AND is_party_to_dispatch(c.id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION dispatch_call_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION dispatch_call_detail(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION my_dispatch_calls() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'item', c.item, 'status', c.status, 'total_pkr', c.total_pkr, 'created_at', c.created_at,
    'shop_name', s.name, 'as_role', CASE WHEN c.initiator_portal_user_id = current_portal_user_id() THEN 'user' ELSE 'driver' END
  ) ORDER BY c.created_at DESC), '[]'::jsonb)
  FROM dispatch_calls c JOIN city_shops s ON s.id = c.city_shop_id
  WHERE c.initiator_portal_user_id = current_portal_user_id()
    OR EXISTS (SELECT 1 FROM dispatch_invitations i JOIN vehicles v ON v.id = i.vehicle_id WHERE i.call_id = c.id AND v.portal_user_id = current_portal_user_id());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_dispatch_calls() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_dispatch_calls() TO authenticated;

-- Every ringing invitation for a given vehicle — the driver's own "you
-- have an incoming call" view (both nearby.tsx-style discovery and a
-- push-notification link land here).
CREATE OR REPLACE FUNCTION my_dispatch_invitations(p_vehicle_id uuid) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'call_id', c.id, 'item', c.item, 'address', c.address, 'goods_budget_pkr', c.goods_budget_pkr, 'tier', i.tier,
    'shop_name', s.name, 'city_name', ci.name, 'invited_at', i.invited_at
  ) ORDER BY i.invited_at DESC), '[]'::jsonb)
  FROM dispatch_invitations i
  JOIN dispatch_calls c ON c.id = i.call_id
  JOIN city_shops s ON s.id = c.city_shop_id
  JOIN cities ci ON ci.id = s.city_id
  JOIN vehicles v ON v.id = p_vehicle_id
  WHERE i.vehicle_id = p_vehicle_id AND i.status = 'ringing' AND c.status IN ('tier1', 'tier2')
    AND v.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_dispatch_invitations(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_dispatch_invitations(uuid) TO authenticated;
