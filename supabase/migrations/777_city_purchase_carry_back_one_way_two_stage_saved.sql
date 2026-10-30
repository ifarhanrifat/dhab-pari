-- Migration 777: City Purchase — rider chooses one way (a driver already
-- in / going to the city carries it back) or two way (a driver goes from
-- the village), a committee fee floor per area and delivery time, bike /
-- car matched to the right drivers, round-trip detour fuel only when the
-- shop is off the driver's route, a two-stage deal confirmation, saved
-- requests that ring the next driver who goes to that city, and the
-- rider can edit a request until a driver accepts it.
--
-- Real asks, 2026-10-30:
--  * "when the driver is already in the city the calculation should be
--    one way... a driver goes from the village is two way... the rider
--    knew the fee before sending."
--  * "for the in-city purchase the minimum fee will be 250 for 4 hours;
--    3 hours adds 50, 2 hours another 50, now another 50 — the offer
--    can't be decreased."  -> fee floor 250 / 300 / 350 / 400.
--  * "out-of-city is fixed to one day, not hourly; the minimum purchase
--    fee is 700, which can be increased by the driver when he accepts."
--  * "the in-city purchase pickup must be in the home city; if the rider
--    picks another city, suggest the out-of-city option."
--  * "I chose bike and couldn't choose one way or two way" -> the rider
--    picks the trip type; two way invites village drivers (it never
--    invited anyone but a hand-picked vehicle before).
--  * "show how many bikes and cars are in the city right now (one way)
--    and in the village (two way)."
--  * "bike two way was 1100 and car 250" -> the estimate's bike rate can
--    never exceed the car rate, and riders are matched to vehicles of
--    the ride type they chose.
--  * "if the shop is on his route a fixed fee with no fuel, if far from
--    it, fuel is driver destination -> shop -> back."
--  * "both parties must confirm in two stages."
--  * "a saved request is sent to a driver whenever he goes to that city."
--  * "how can the user edit or cancel the saved request?"
--
-- Price (server-side, per accepting vehicle):
--   leg          = round_to_10(city.distance_km x vehicle.per_km_pkr)
--   trip_mode    = carry_back (invited from his own route / trip offer /
--                  city check-in) = 1 leg; dedicated (village driver or
--                  hand-picked) = 2 legs
--   detour_fuel  = 0 if the shop is within city_purchase_detour_free_km
--                  of the driver's own destination, else km x 2 x per_km
--   service_fee  = the driver's offer, never below the floor:
--                  in-city 250 / 300 / 350 / 400 (4h / 3h / 2h / now),
--                  out-of-city 700 (a one-day job); capped by
--                  city_purchase_fee_max_pkr
--   total        = leg(s) + detour_fuel + service_fee + rider tip
-- Delivery deadline (set when the deal is locked): in-city 4/3/2/1 h;
-- out-of-city end of the scheduled day.
--
-- Dry-run on a local replay inside BEGIN ... ROLLBACK; not applied to
-- production by the author.

-- ─── Columns, statuses, settings ───────────────────────────────────────

ALTER TABLE city_purchase_requests ADD COLUMN IF NOT EXISTS trip_preference varchar NOT NULL DEFAULT 'one_way' CHECK (trip_preference IN ('one_way', 'two_way'));
ALTER TABLE city_purchase_requests ADD COLUMN IF NOT EXISTS trip_mode varchar CHECK (trip_mode IS NULL OR trip_mode IN ('carry_back', 'dedicated'));
ALTER TABLE city_purchase_requests ADD COLUMN IF NOT EXISTS service_fee_floor_pkr numeric;
ALTER TABLE city_purchase_requests ADD COLUMN IF NOT EXISTS detour_km numeric;
ALTER TABLE city_purchase_requests ADD COLUMN IF NOT EXISTS driver_confirmed_at timestamptz;
ALTER TABLE city_purchase_requests ADD COLUMN IF NOT EXISTS deliver_by timestamptz;
ALTER TABLE city_purchase_invitations ADD COLUMN IF NOT EXISTS reference_distance_km numeric;

-- In-city delivery times are 4h (standard) / 3h / 2h / now (urgent).
ALTER TABLE city_purchase_requests DROP CONSTRAINT IF EXISTS city_purchase_requests_urgency_check;
ALTER TABLE city_purchase_requests ADD CONSTRAINT city_purchase_requests_urgency_check
  CHECK (urgency IN ('standard', '3hr', '2hr', '1hr', 'urgent'));

INSERT INTO site_settings (key, value, description, tenant_id)
SELECT s.key, s.value, s.description, t.id
FROM tenants t CROSS JOIN (VALUES
  ('city_purchase_city_fee_4h_pkr', '250', 'In-city purchase: minimum fee, delivery within 4 hours'),
  ('city_purchase_city_fee_3h_pkr', '300', 'In-city purchase: minimum fee, delivery within 3 hours'),
  ('city_purchase_city_fee_2h_pkr', '350', 'In-city purchase: minimum fee, delivery within 2 hours'),
  ('city_purchase_city_fee_now_pkr', '400', 'In-city purchase: minimum fee, delivery now (within 1 hour)'),
  ('city_purchase_outstation_min_fee_pkr', '700', 'Out-of-city purchase: minimum fee for the one-day job (the driver may offer more)'),
  ('city_purchase_fee_max_pkr', '5000', 'City purchase: the most a driver may ask as his service fee')
) AS s(key, value, description)
WHERE NOT EXISTS (SELECT 1 FROM site_settings x WHERE x.key = s.key AND x.tenant_id = t.id);

-- ─── Small helpers ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION city_purchase_setting(p_tenant_id uuid, p_key varchar, p_default numeric) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT value::numeric FROM site_settings WHERE key = p_key AND tenant_id = p_tenant_id),
    (SELECT value::numeric FROM site_settings WHERE key = p_key ORDER BY (tenant_id IS NULL) DESC LIMIT 1),
    p_default);
$$;

-- 'bike' for motorbikes / e-bikes, 'car' for everything else.
CREATE OR REPLACE FUNCTION vehicle_ride_kind(p_vehicle_id uuid) RETURNS varchar
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN vc.key IN ('bike', 'electric_bike') OR v.vehicle_type ~* '(bike|motor|honda 125|cd ?70)' THEN 'bike' ELSE 'car' END
  FROM vehicles v LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
  WHERE v.id = p_vehicle_id;
$$;

CREATE OR REPLACE FUNCTION city_purchase_fee_floor(p_tenant_id uuid, p_area varchar, p_urgency varchar) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN p_area = 'out_of_city' THEN city_purchase_setting(p_tenant_id, 'city_purchase_outstation_min_fee_pkr', 700)
    ELSE CASE p_urgency
      WHEN '3hr' THEN city_purchase_setting(p_tenant_id, 'city_purchase_city_fee_3h_pkr', 300)
      WHEN '2hr' THEN city_purchase_setting(p_tenant_id, 'city_purchase_city_fee_2h_pkr', 350)
      WHEN '1hr' THEN city_purchase_setting(p_tenant_id, 'city_purchase_city_fee_now_pkr', 400)
      WHEN 'urgent' THEN city_purchase_setting(p_tenant_id, 'city_purchase_city_fee_now_pkr', 400)
      ELSE city_purchase_setting(p_tenant_id, 'city_purchase_city_fee_4h_pkr', 250) END
    END;
$$;

CREATE OR REPLACE FUNCTION city_purchase_deliver_hours(p_area varchar, p_urgency varchar) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_area = 'out_of_city' THEN NULL
    ELSE CASE p_urgency WHEN '3hr' THEN 3 WHEN '2hr' THEN 2 WHEN '1hr' THEN 1 WHEN 'urgent' THEN 1 ELSE 4 END END;
$$;

-- Village drivers for a two-way (special) trip: online, delivery-eligible,
-- above the trust floor, and not checked in to some city right now.
CREATE OR REPLACE FUNCTION city_purchase_village_vehicles(p_city_id uuid, p_exclude_portal_user_id uuid)
RETURNS TABLE (vehicle_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.id FROM vehicles v, cities ci
  WHERE ci.id = p_city_id AND v.tenant_id = ci.tenant_id AND v.is_active AND v.is_online
    AND vehicle_delivery_eligible_for(v.id, ci.is_home_city)
    AND vehicle_trust_score(v.id) >= COALESCE((SELECT value::int FROM site_settings WHERE key = 'vehicle_trust_floor_score' ORDER BY (tenant_id = ci.tenant_id) DESC LIMIT 1), 15)
    AND (p_exclude_portal_user_id IS NULL OR v.portal_user_id IS DISTINCT FROM p_exclude_portal_user_id)
    AND (ci.is_home_city OR COALESCE(v.allows_out_of_city, false))
    AND NOT EXISTS (SELECT 1 FROM vehicle_city_presence p WHERE p.vehicle_id = v.id AND p.is_active);
$$;

-- How many bikes / cars could take it right now: in the city (one way)
-- and in the village (two way).
CREATE OR REPLACE FUNCTION city_purchase_availability(p_city_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH inc AS (SELECT DISTINCT c.vehicle_id FROM city_purchase_candidate_vehicles(p_city_id, NULL, NULL, NULL, current_portal_user_id()) c),
  vil AS (SELECT vehicle_id FROM city_purchase_village_vehicles(p_city_id, current_portal_user_id()))
  SELECT jsonb_build_object(
    'in_city', jsonb_build_object(
      'bike', (SELECT count(*) FROM inc WHERE vehicle_ride_kind(inc.vehicle_id) = 'bike'),
      'car', (SELECT count(*) FROM inc WHERE vehicle_ride_kind(inc.vehicle_id) = 'car')),
    'in_village', jsonb_build_object(
      'bike', (SELECT count(*) FROM vil WHERE vehicle_ride_kind(vil.vehicle_id) = 'bike'),
      'car', (SELECT count(*) FROM vil WHERE vehicle_ride_kind(vil.vehicle_id) = 'car')));
$$;
REVOKE ALL ON FUNCTION city_purchase_availability(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_purchase_availability(uuid) TO authenticated;

-- ─── Where the invited driver is actually headed in the city ───────────
CREATE OR REPLACE FUNCTION trg_city_purchase_invitation_distance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r city_purchase_requests%ROWTYPE; ci cities%ROWTYPE; v_lat numeric; v_lng numeric;
BEGIN
  SELECT * INTO r FROM city_purchase_requests WHERE id = NEW.request_id;
  IF r.pickup_lat IS NULL OR r.pickup_lng IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO ci FROM cities WHERE id = r.city_id;
  IF NEW.source = 'route' THEN
    SELECT vr.destination_lat, vr.destination_lng INTO v_lat, v_lng FROM vehicle_routes vr
    WHERE vr.vehicle_id = NEW.vehicle_id AND vr.is_active AND vr.destination_lat IS NOT NULL
      AND (vr.destination ILIKE '%' || ci.name || '%' OR (ci.name_ur IS NOT NULL AND vr.destination_ur ILIKE '%' || ci.name_ur || '%'))
    LIMIT 1;
  ELSIF NEW.source = 'trip_offer' THEN
    SELECT o.dest_lat, o.dest_lng INTO v_lat, v_lng FROM vehicle_trip_offers o
    WHERE o.vehicle_id = NEW.vehicle_id AND o.status = 'open' AND o.dest_lat IS NOT NULL
      AND (o.destination ILIKE '%' || ci.name || '%' OR (ci.name_ur IS NOT NULL AND o.destination_ur ILIKE '%' || ci.name_ur || '%'))
    ORDER BY o.travel_date LIMIT 1;
  END IF;
  IF v_lat IS NULL THEN v_lat := ci.lat; v_lng := ci.lng; END IF;
  IF v_lat IS NOT NULL THEN NEW.reference_distance_km := round(haversine_km(r.pickup_lat, r.pickup_lng, v_lat, v_lng), 1); END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS city_purchase_invitation_distance ON city_purchase_invitations;
CREATE TRIGGER city_purchase_invitation_distance BEFORE INSERT ON city_purchase_invitations FOR EACH ROW EXECUTE FUNCTION trg_city_purchase_invitation_distance();

-- ─── Inviting drivers (create, edit, saved re-ring) ────────────────────
-- One way: drivers in / going to the city (their route, trip offer, city
-- check-in). Two way: village drivers. Always the ride type the rider
-- chose. Never re-invites a vehicle already invited to this request.
CREATE OR REPLACE FUNCTION city_purchase_invite(p_request_id uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r city_purchase_requests%ROWTYPE; v_count int := 0;
BEGIN
  SELECT * INTO r FROM city_purchase_requests WHERE id = p_request_id;
  IF r.trip_preference = 'two_way' THEN
    INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination)
    SELECT r.id, vv.vehicle_id, 'direct', NULL
    FROM city_purchase_village_vehicles(r.city_id, r.initiator_portal_user_id) vv
    WHERE vehicle_ride_kind(vv.vehicle_id) = r.ride_type
      AND NOT EXISTS (SELECT 1 FROM city_purchase_invitations i WHERE i.request_id = r.id AND i.vehicle_id = vv.vehicle_id)
      AND (vehicle_committed_urgency_tier(vv.vehicle_id) IS NULL OR vehicle_committed_urgency_tier(vv.vehicle_id) = r.urgency)
    ON CONFLICT (request_id, vehicle_id) DO NOTHING;
  ELSE
    INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination)
    SELECT r.id, c.vehicle_id, c.source, c.reference_destination
    FROM city_purchase_candidate_vehicles(r.city_id, r.pickup_lat, r.pickup_lng, r.urgency, r.initiator_portal_user_id) c
    WHERE vehicle_ride_kind(c.vehicle_id) = r.ride_type
      AND NOT EXISTS (SELECT 1 FROM city_purchase_invitations i WHERE i.request_id = r.id AND i.vehicle_id = c.vehicle_id)
    ON CONFLICT (request_id, vehicle_id) DO NOTHING;
  END IF;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF EXISTS (SELECT 1 FROM city_purchase_invitations WHERE request_id = r.id AND status = 'ringing') THEN
    UPDATE city_purchase_requests SET status = 'ringing' WHERE id = r.id AND status IN ('ringing', 'no_answer');
  ELSE
    UPDATE city_purchase_requests SET status = 'no_answer' WHERE id = r.id AND status IN ('ringing', 'no_answer');
  END IF;

  IF v_count > 0 THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT v.portal_user_id, 'city_purchase_invited', 'City purchase request', r.item, '/portal/marketplace/city-purchase/' || r.id
    FROM city_purchase_invitations i JOIN vehicles v ON v.id = i.vehicle_id
    WHERE i.request_id = r.id AND i.status = 'ringing' AND i.invited_at > now() - interval '5 seconds' AND v.portal_user_id IS NOT NULL;
  END IF;
  RETURN v_count;
END;
$$;

-- ─── The one pricing formula (accept + the driver's preview) ───────────
CREATE OR REPLACE FUNCTION city_purchase_price(p_request_id uuid, p_vehicle_id uuid, p_fee_pkr numeric) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r city_purchase_requests%ROWTYPE; v vehicles%ROWTYPE; ci cities%ROWTYPE; i city_purchase_invitations%ROWTYPE;
  v_mode varchar; v_leg numeric; v_distance numeric; v_detour_km numeric; v_free numeric; v_detour numeric := 0;
  v_tenant uuid; v_floor numeric; v_max numeric; v_fee numeric;
BEGIN
  SELECT * INTO r FROM city_purchase_requests WHERE id = p_request_id;
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  SELECT * INTO ci FROM cities WHERE id = r.city_id;
  SELECT * INTO i FROM city_purchase_invitations WHERE request_id = p_request_id AND vehicle_id = p_vehicle_id;
  v_tenant := COALESCE(r.tenant_id, v.tenant_id);

  v_mode := CASE WHEN i.source IN ('presence', 'trip_offer', 'route') THEN 'carry_back' ELSE 'dedicated' END;
  v_leg := round_to_10(COALESCE(ci.distance_km, 0) * COALESCE(v.per_km_pkr, 0));
  v_distance := CASE WHEN v_mode = 'carry_back' THEN v_leg ELSE v_leg * 2 END;

  v_detour_km := COALESCE(i.reference_distance_km,
    CASE WHEN r.pickup_lat IS NOT NULL AND ci.lat IS NOT NULL THEN round(haversine_km(r.pickup_lat, r.pickup_lng, ci.lat, ci.lng), 1) END);
  v_free := city_purchase_setting(v_tenant, 'city_purchase_detour_free_km', 2);
  IF v_detour_km IS NOT NULL AND v_detour_km > v_free THEN
    v_detour := round_to_10(v_detour_km * 2 * COALESCE(v.per_km_pkr, 0));
  END IF;

  v_floor := COALESCE(r.service_fee_floor_pkr, city_purchase_fee_floor(v_tenant, r.area, r.urgency));
  v_max := GREATEST(v_floor, city_purchase_setting(v_tenant, 'city_purchase_fee_max_pkr', 5000));
  v_fee := GREATEST(COALESCE(p_fee_pkr, v_floor), v_floor);

  RETURN jsonb_build_object(
    'trip_mode', v_mode, 'source', i.source, 'reference_destination', i.reference_destination, 'area', r.area,
    'leg_pkr', v_leg, 'distance_fare_pkr', v_distance,
    'detour_km', v_detour_km, 'detour_free_km', v_free, 'on_route', v_detour_km IS NULL OR v_detour_km <= v_free, 'detour_fuel_pkr', v_detour,
    'fee_floor_pkr', v_floor, 'fee_max_pkr', v_max, 'addon_fee_pkr', v_fee, 'tip_pkr', COALESCE(r.tip_pkr, 0),
    'total_fare_pkr', v_distance + v_detour + v_fee + COALESCE(r.tip_pkr, 0),
    'deliver_within_hours', city_purchase_deliver_hours(r.area, r.urgency),
    'scheduled_date', r.scheduled_date,
    -- kept for older screens
    'addon_min_pkr', v_floor, 'addon_max_pkr', v_max, 'urgency_premium_pkr', 0, 'urgency_premium_pct', 0
  );
END;
$$;

CREATE OR REPLACE FUNCTION city_purchase_quote_for_vehicle(p_request_id uuid, p_vehicle_id uuid, p_addon_fee_pkr numeric DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM city_purchase_invitations WHERE request_id = p_request_id AND vehicle_id = p_vehicle_id) THEN
    RAISE EXCEPTION 'You were not invited to this request.' USING ERRCODE = 'P0001';
  END IF;
  RETURN city_purchase_price(p_request_id, p_vehicle_id, p_addon_fee_pkr);
END;
$$;
REVOKE ALL ON FUNCTION city_purchase_quote_for_vehicle(uuid, uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_purchase_quote_for_vehicle(uuid, uuid, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.accept_city_purchase_request(p_request_id uuid, p_vehicle_id uuid, p_addon_fee_pkr numeric)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v vehicles%ROWTYPE; r city_purchase_requests%ROWTYPE; q jsonb; v_committed_tier varchar;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND OR v.portal_user_id IS DISTINCT FROM current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF v.per_km_pkr IS NULL THEN
    RAISE EXCEPTION 'Your per-km rate has not been set yet — ask the committee to set it before accepting jobs.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO r FROM city_purchase_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  IF r.status <> 'ringing' THEN RAISE EXCEPTION 'This request is no longer open.' USING ERRCODE = 'P0001'; END IF;
  IF r.initiator_portal_user_id = current_portal_user_id() THEN
    RAISE EXCEPTION 'You cannot accept your own request.' USING ERRCODE = 'P0001';
  END IF;

  q := city_purchase_price(p_request_id, p_vehicle_id, p_addon_fee_pkr);
  IF p_addon_fee_pkr IS NULL OR p_addon_fee_pkr < (q->>'fee_floor_pkr')::numeric OR p_addon_fee_pkr > (q->>'fee_max_pkr')::numeric THEN
    RAISE EXCEPTION 'Your service fee must be between % and %.', q->>'fee_floor_pkr', q->>'fee_max_pkr' USING ERRCODE = 'P0001';
  END IF;

  v_committed_tier := vehicle_committed_urgency_tier(p_vehicle_id);
  IF v_committed_tier IS NOT NULL AND v_committed_tier <> r.urgency THEN
    RAISE EXCEPTION 'You are committed to % deliveries right now — finish those before accepting a different urgency tier.', v_committed_tier USING ERRCODE = 'P0001';
  END IF;

  UPDATE city_purchase_invitations SET status = 'accepted', responded_at = now()
    WHERE request_id = p_request_id AND vehicle_id = p_vehicle_id AND status = 'ringing';
  IF NOT FOUND THEN RAISE EXCEPTION 'You were not invited to this request, or someone else already accepted it.' USING ERRCODE = 'P0001'; END IF;
  UPDATE city_purchase_invitations SET status = 'expired', responded_at = now()
    WHERE request_id = p_request_id AND vehicle_id <> p_vehicle_id AND status = 'ringing';

  UPDATE city_purchase_requests SET
    status = 'priced', accepted_vehicle_id = p_vehicle_id, trip_mode = q->>'trip_mode',
    distance_fare_pkr = (q->>'distance_fare_pkr')::numeric, detour_km = (q->>'detour_km')::numeric, detour_fuel_pkr = (q->>'detour_fuel_pkr')::numeric,
    addon_fee_pkr = p_addon_fee_pkr, total_fare_pkr = (q->>'total_fare_pkr')::numeric
  WHERE id = p_request_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (r.initiator_portal_user_id, 'city_purchase_accepted', 'City purchase accepted — please review the price',
    v.owner_name || ' — Rs ' || round((q->>'total_fare_pkr')::numeric) || CASE WHEN q->>'trip_mode' = 'carry_back' THEN ' (one way)' ELSE ' (two way)' END,
    '/portal/marketplace/city-purchase/' || p_request_id);

  RETURN city_purchase_request_detail(p_request_id);
END;
$function$;

-- Stage 2: the driver locks the deal after the rider approved the price.
CREATE OR REPLACE FUNCTION confirm_city_purchase_deal(p_request_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r city_purchase_requests%ROWTYPE; v_hours numeric; v_deadline timestamptz;
BEGIN
  SELECT * INTO r FROM city_purchase_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = r.accepted_vehicle_id AND portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this job.' USING ERRCODE = 'P0001';
  END IF;
  IF r.status <> 'approved' THEN RAISE EXCEPTION 'The customer has not approved the price yet.' USING ERRCODE = 'P0001'; END IF;
  IF r.driver_confirmed_at IS NOT NULL THEN RAISE EXCEPTION 'You have already confirmed this deal.' USING ERRCODE = 'P0001'; END IF;
  v_hours := city_purchase_deliver_hours(r.area, r.urgency);
  v_deadline := CASE WHEN v_hours IS NOT NULL THEN now() + make_interval(mins => (v_hours * 60)::int)
    ELSE ((GREATEST(COALESCE(r.scheduled_date, (now() AT TIME ZONE 'Asia/Karachi')::date), (now() AT TIME ZONE 'Asia/Karachi')::date) + time '23:59') AT TIME ZONE 'Asia/Karachi') END;
  UPDATE city_purchase_requests SET driver_confirmed_at = now(), deliver_by = v_deadline WHERE id = p_request_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (r.initiator_portal_user_id, 'city_purchase_deal_confirmed', 'Deal confirmed — your purchase is on the way',
    r.item || ' — by ' || to_char(v_deadline AT TIME ZONE 'Asia/Karachi', 'DD Mon HH12:MI AM'), '/portal/marketplace/city-purchase/' || p_request_id);
END;
$$;
REVOKE ALL ON FUNCTION confirm_city_purchase_deal(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION confirm_city_purchase_deal(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_city_purchase_purchased(p_request_id uuid, p_actual_goods_cost_pkr numeric, p_bill_attachment_path text DEFAULT NULL::text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE r city_purchase_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM city_purchase_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = r.accepted_vehicle_id AND portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this job.' USING ERRCODE = 'P0001';
  END IF;
  IF r.status <> 'approved' THEN RAISE EXCEPTION 'This job is not awaiting purchase.' USING ERRCODE = 'P0001'; END IF;
  IF r.driver_confirmed_at IS NULL THEN RAISE EXCEPTION 'Confirm the deal first, so both of you have locked the final price.' USING ERRCODE = 'P0001'; END IF;
  IF p_actual_goods_cost_pkr IS NULL OR p_actual_goods_cost_pkr < 0 THEN RAISE EXCEPTION 'Enter what you actually paid for the item.' USING ERRCODE = 'P0001'; END IF;
  UPDATE city_purchase_requests SET status = 'purchased', purchased_at = now(),
    actual_goods_cost_pkr = p_actual_goods_cost_pkr, bill_attachment_path = NULLIF(p_bill_attachment_path, '')
  WHERE id = p_request_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (r.initiator_portal_user_id, 'city_purchase_purchased', 'Item purchased', r.item, '/portal/marketplace/city-purchase/' || p_request_id);
END;
$function$;

-- ─── Rider's one-way / two-way prices before sending ───────────────────
DROP FUNCTION IF EXISTS city_purchase_fee_estimate(uuid, numeric, numeric, numeric, varchar);
CREATE FUNCTION city_purchase_fee_estimate(
  p_city_id uuid, p_pickup_lat numeric, p_pickup_lng numeric, p_tip_pkr numeric DEFAULT 0, p_ride_type varchar DEFAULT 'bike',
  p_urgency varchar DEFAULT 'standard', p_area varchar DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ci cities%ROWTYPE; v_area varchar; v_car decimal; v_bike decimal; v_per_km decimal; v_free decimal; v_leg decimal;
  v_detour_km decimal; v_detour decimal := 0; v_tip decimal; v_floor decimal;
BEGIN
  SELECT * INTO ci FROM cities WHERE id = p_city_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001'; END IF;
  v_area := COALESCE(p_area, CASE WHEN ci.is_home_city THEN 'city' ELSE 'out_of_city' END);
  v_car := city_purchase_setting(ci.tenant_id, 'city_purchase_typical_per_km_car_pkr', 20);
  -- A motorbike never costs more per km than a car, whatever the settings say.
  v_bike := LEAST(city_purchase_setting(ci.tenant_id, 'city_purchase_typical_per_km_bike_pkr', 12), v_car);
  v_per_km := CASE WHEN p_ride_type = 'car' THEN v_car ELSE v_bike END;
  v_leg := round_to_10(COALESCE(ci.distance_km, 0) * v_per_km);
  IF p_pickup_lat IS NOT NULL AND p_pickup_lng IS NOT NULL AND ci.lat IS NOT NULL AND ci.lng IS NOT NULL THEN
    v_free := city_purchase_setting(ci.tenant_id, 'city_purchase_detour_free_km', 2);
    v_detour_km := round(haversine_km(p_pickup_lat, p_pickup_lng, ci.lat, ci.lng), 1);
    IF v_detour_km > v_free THEN v_detour := round_to_10(v_detour_km * 2 * v_per_km); END IF;
  END IF;
  v_tip := GREATEST(COALESCE(p_tip_pkr, 0), 0);
  v_floor := city_purchase_fee_floor(ci.tenant_id, v_area, CASE WHEN v_area = 'out_of_city' THEN 'standard' ELSE COALESCE(p_urgency, 'standard') END);
  RETURN jsonb_build_object(
    'area', v_area, 'is_home_city', ci.is_home_city, 'leg_pkr', v_leg, 'detour_km', v_detour_km, 'detour_fuel_pkr', v_detour,
    'fee_floor_pkr', v_floor, 'tip_pkr', v_tip,
    'one_way_total_pkr', v_leg + v_detour + v_floor + v_tip,
    'two_way_total_pkr', v_leg * 2 + v_detour + v_floor + v_tip,
    'fee_4h_pkr', city_purchase_fee_floor(ci.tenant_id, 'city', 'standard'), 'fee_3h_pkr', city_purchase_fee_floor(ci.tenant_id, 'city', '3hr'),
    'fee_2h_pkr', city_purchase_fee_floor(ci.tenant_id, 'city', '2hr'), 'fee_now_pkr', city_purchase_fee_floor(ci.tenant_id, 'city', 'urgent'),
    'outstation_fee_pkr', city_purchase_fee_floor(ci.tenant_id, 'out_of_city', 'standard'),
    'availability', city_purchase_availability(p_city_id),
    -- kept for older screens
    'distance_fare_pkr', v_leg * 2, 'total_fee_pkr', v_leg * 2 + v_detour + v_floor + v_tip, 'carry_total_fee_pkr', v_leg + v_detour + v_floor + v_tip
  );
END;
$$;
REVOKE ALL ON FUNCTION city_purchase_fee_estimate(uuid, numeric, numeric, numeric, varchar, varchar, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_purchase_fee_estimate(uuid, numeric, numeric, numeric, varchar, varchar, varchar) TO authenticated;

-- ─── Create (adds the trip preference) ─────────────────────────────────
DROP FUNCTION IF EXISTS create_city_purchase_request(uuid, text, text, text, numeric, numeric, numeric, uuid, varchar, text, numeric, numeric, varchar, varchar, date, time, numeric, varchar);
CREATE FUNCTION create_city_purchase_request(
  p_city_id uuid, p_item text, p_item_attachment_path text DEFAULT NULL, p_pickup_label text DEFAULT NULL, p_pickup_lat numeric DEFAULT NULL,
  p_pickup_lng numeric DEFAULT NULL, p_goods_budget_pkr numeric DEFAULT 0, p_target_vehicle_id uuid DEFAULT NULL, p_urgency varchar DEFAULT 'standard',
  p_delivery_label text DEFAULT NULL, p_delivery_lat numeric DEFAULT NULL, p_delivery_lng numeric DEFAULT NULL, p_area varchar DEFAULT 'city',
  p_ride_type varchar DEFAULT 'bike', p_scheduled_date date DEFAULT NULL, p_scheduled_time time DEFAULT NULL, p_tip_pkr numeric DEFAULT 0,
  p_payment_method varchar DEFAULT 'cash', p_trip_preference varchar DEFAULT 'one_way'
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id(); v_request_id uuid; v_estimate jsonb; ci cities%ROWTYPE; v_urgency varchar;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_item IS NULL OR trim(p_item) = '' THEN RAISE EXCEPTION 'Describe what you need first.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO ci FROM cities WHERE id = p_city_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001'; END IF;
  IF p_goods_budget_pkr IS NULL OR p_goods_budget_pkr < 0 THEN RAISE EXCEPTION 'Enter a valid amount, or 0 if unsure.' USING ERRCODE = 'P0001'; END IF;
  IF p_area NOT IN ('city', 'out_of_city') THEN RAISE EXCEPTION 'Invalid area.' USING ERRCODE = 'P0001'; END IF;
  IF p_area = 'city' AND NOT ci.is_home_city THEN
    RAISE EXCEPTION 'This shop is outside the home city — choose "Out of city" to buy from another city.' USING ERRCODE = 'P0001';
  END IF;
  IF p_ride_type NOT IN ('bike', 'car') THEN RAISE EXCEPTION 'Invalid ride type.' USING ERRCODE = 'P0001'; END IF;
  IF p_area = 'out_of_city' AND p_ride_type = 'bike' THEN RAISE EXCEPTION 'A motorbike is not available for an out-of-city delivery — choose a car.' USING ERRCODE = 'P0001'; END IF;
  IF p_trip_preference NOT IN ('one_way', 'two_way') THEN RAISE EXCEPTION 'Choose one way or two way.' USING ERRCODE = 'P0001'; END IF;
  IF p_scheduled_date IS NULL THEN RAISE EXCEPTION 'Pick a date for this job.' USING ERRCODE = 'P0001'; END IF;
  -- Out of city is a one-day job: no hourly delivery tiers.
  v_urgency := CASE WHEN p_area = 'out_of_city' THEN 'standard' ELSE COALESCE(p_urgency, 'standard') END;
  IF v_urgency NOT IN ('standard', '3hr', '2hr', '1hr', 'urgent') THEN RAISE EXCEPTION 'Invalid delivery time.' USING ERRCODE = 'P0001'; END IF;
  IF p_target_vehicle_id IS NOT NULL AND EXISTS (SELECT 1 FROM vehicles WHERE id = p_target_vehicle_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You cannot request your own vehicle.' USING ERRCODE = 'P0001';
  END IF;

  v_estimate := city_purchase_fee_estimate(p_city_id, p_pickup_lat, p_pickup_lng, p_tip_pkr, p_ride_type, v_urgency, p_area);

  INSERT INTO city_purchase_requests (
    initiator_portal_user_id, city_id, item, item_attachment_path, pickup_label, pickup_lat, pickup_lng, goods_budget_pkr, status, urgency,
    delivery_label, delivery_lat, delivery_lng, area, ride_type, scheduled_date, scheduled_time, tip_pkr, payment_method, estimated_fee_pkr,
    trip_preference, service_fee_floor_pkr
  ) VALUES (
    v_portal_user_id, p_city_id, trim(p_item), NULLIF(p_item_attachment_path, ''), NULLIF(p_pickup_label, ''), p_pickup_lat, p_pickup_lng, p_goods_budget_pkr, 'ringing', v_urgency,
    NULLIF(p_delivery_label, ''), p_delivery_lat, p_delivery_lng, p_area, p_ride_type, p_scheduled_date, p_scheduled_time, GREATEST(COALESCE(p_tip_pkr, 0), 0), COALESCE(p_payment_method, 'cash'),
    ((v_estimate->>CASE WHEN p_trip_preference = 'two_way' THEN 'two_way_total_pkr' ELSE 'one_way_total_pkr' END))::decimal,
    p_trip_preference, (v_estimate->>'fee_floor_pkr')::decimal
  ) RETURNING id INTO v_request_id;

  IF p_target_vehicle_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM vehicles v WHERE v.id = p_target_vehicle_id AND v.is_active AND v.is_online AND vehicle_delivery_eligible_for(v.id, ci.is_home_city)
    ) THEN
      RAISE EXCEPTION 'That vehicle is not available right now.' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination)
    SELECT v_request_id, c.vehicle_id, c.source, c.reference_destination
    FROM city_purchase_candidate_vehicles(p_city_id, p_pickup_lat, p_pickup_lng, v_urgency, v_portal_user_id) c WHERE c.vehicle_id = p_target_vehicle_id;
    IF NOT FOUND THEN
      INSERT INTO city_purchase_invitations (request_id, vehicle_id, source, reference_destination) VALUES (v_request_id, p_target_vehicle_id, 'direct', NULL);
    END IF;
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT v.portal_user_id, 'city_purchase_invited', 'City purchase request', p_item, '/portal/marketplace/city-purchase/' || v_request_id
    FROM vehicles v WHERE v.id = p_target_vehicle_id AND v.portal_user_id IS NOT NULL;
  ELSE
    PERFORM city_purchase_invite(v_request_id);
  END IF;

  RETURN v_request_id;
END;
$$;
REVOKE ALL ON FUNCTION create_city_purchase_request(uuid, text, text, text, numeric, numeric, numeric, uuid, varchar, text, numeric, numeric, varchar, varchar, date, time, numeric, varchar, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_city_purchase_request(uuid, text, text, text, numeric, numeric, numeric, uuid, varchar, text, numeric, numeric, varchar, varchar, date, time, numeric, varchar, varchar) TO authenticated;

-- ─── Edit a request until a driver accepts it ──────────────────────────
CREATE OR REPLACE FUNCTION update_city_purchase_request(
  p_request_id uuid, p_item text, p_goods_budget_pkr numeric, p_urgency varchar, p_tip_pkr numeric,
  p_scheduled_date date, p_scheduled_time time, p_trip_preference varchar
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r city_purchase_requests%ROWTYPE; v_urgency varchar; v_estimate jsonb; v_pref varchar;
BEGIN
  SELECT * INTO r FROM city_purchase_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.initiator_portal_user_id IS DISTINCT FROM current_portal_user_id() THEN
    RAISE EXCEPTION 'You do not manage this request.' USING ERRCODE = 'P0001';
  END IF;
  IF r.status NOT IN ('ringing', 'no_answer') THEN
    RAISE EXCEPTION 'A driver has already accepted this request — cancel it instead if you need changes.' USING ERRCODE = 'P0001';
  END IF;
  IF p_item IS NULL OR trim(p_item) = '' THEN RAISE EXCEPTION 'Describe what you need first.' USING ERRCODE = 'P0001'; END IF;
  IF p_goods_budget_pkr IS NULL OR p_goods_budget_pkr < 0 THEN RAISE EXCEPTION 'Enter a valid amount, or 0 if unsure.' USING ERRCODE = 'P0001'; END IF;
  IF p_scheduled_date IS NULL OR p_scheduled_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN
    RAISE EXCEPTION 'Pick a date that has not already passed.' USING ERRCODE = 'P0001';
  END IF;
  v_urgency := CASE WHEN r.area = 'out_of_city' THEN 'standard' ELSE COALESCE(p_urgency, r.urgency) END;
  IF v_urgency NOT IN ('standard', '3hr', '2hr', '1hr', 'urgent') THEN RAISE EXCEPTION 'Invalid delivery time.' USING ERRCODE = 'P0001'; END IF;
  v_pref := COALESCE(p_trip_preference, r.trip_preference);
  IF v_pref NOT IN ('one_way', 'two_way') THEN RAISE EXCEPTION 'Choose one way or two way.' USING ERRCODE = 'P0001'; END IF;

  v_estimate := city_purchase_fee_estimate(r.city_id, r.pickup_lat, r.pickup_lng, p_tip_pkr, r.ride_type, v_urgency, r.area);
  UPDATE city_purchase_requests SET
    item = trim(p_item), goods_budget_pkr = p_goods_budget_pkr, urgency = v_urgency, tip_pkr = GREATEST(COALESCE(p_tip_pkr, 0), 0),
    scheduled_date = p_scheduled_date, scheduled_time = p_scheduled_time, trip_preference = v_pref,
    service_fee_floor_pkr = (v_estimate->>'fee_floor_pkr')::decimal,
    estimated_fee_pkr = ((v_estimate->>CASE WHEN v_pref = 'two_way' THEN 'two_way_total_pkr' ELSE 'one_way_total_pkr' END))::decimal
  WHERE id = p_request_id;

  -- Switching one way <-> two way changes who should hear about it.
  IF v_pref <> r.trip_preference THEN
    UPDATE city_purchase_invitations SET status = 'expired', responded_at = now() WHERE request_id = p_request_id AND status = 'ringing';
  END IF;
  PERFORM city_purchase_invite(p_request_id);
END;
$$;
REVOKE ALL ON FUNCTION update_city_purchase_request(uuid, text, numeric, varchar, numeric, date, time, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION update_city_purchase_request(uuid, text, numeric, varchar, numeric, date, time, varchar) TO authenticated;

-- ─── Detail / lists carry the new fields ───────────────────────────────
CREATE OR REPLACE FUNCTION public.city_purchase_request_detail(p_request_id uuid)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'request', jsonb_build_object(
      'id', r.id, 'item', r.item, 'has_item_attachment', (r.item_attachment_path IS NOT NULL), 'pickup_label', r.pickup_label,
      'pickup_lat', r.pickup_lat, 'pickup_lng', r.pickup_lng, 'goods_budget_pkr', r.goods_budget_pkr, 'status', r.status,
      'urgency', r.urgency,
      'distance_fare_pkr', r.distance_fare_pkr, 'addon_fee_pkr', r.addon_fee_pkr, 'detour_fuel_pkr', r.detour_fuel_pkr, 'total_fare_pkr', r.total_fare_pkr,
      'tip_pkr', r.tip_pkr, 'area', r.area, 'ride_type', r.ride_type, 'estimated_fee_pkr', r.estimated_fee_pkr,
      'actual_goods_cost_pkr', r.actual_goods_cost_pkr, 'has_bill_attachment', (r.bill_attachment_path IS NOT NULL),
      'city_name', ci.name, 'city_name_ur', ci.name_ur, 'city_km', ci.distance_km,
      'accepted_vehicle_id', av.id, 'accepted_owner_name', av.owner_name, 'accepted_owner_mobile', av.owner_mobile, 'accepted_vehicle_type', av.vehicle_type,
      'initiator_portal_user_id', r.initiator_portal_user_id,
      'created_at', r.created_at
    ) || jsonb_build_object(
      'trip_preference', r.trip_preference, 'trip_mode', r.trip_mode, 'service_fee_floor_pkr', r.service_fee_floor_pkr, 'detour_km', r.detour_km,
      'approved_at', r.approved_at, 'driver_confirmed_at', r.driver_confirmed_at, 'deliver_by', r.deliver_by,
      'scheduled_date', r.scheduled_date, 'scheduled_time', r.scheduled_time
    ),
    'invitations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'vehicle_id', v.id, 'owner_name', v.owner_name, 'source', i.source, 'reference_destination', i.reference_destination,
        'status', i.status, 'invited_at', i.invited_at, 'responded_at', i.responded_at, 'reference_distance_km', i.reference_distance_km
      ) ORDER BY i.invited_at)
      FROM city_purchase_invitations i JOIN vehicles v ON v.id = i.vehicle_id WHERE i.request_id = r.id
    ), '[]'::jsonb)
  )
  FROM city_purchase_requests r
  JOIN cities ci ON ci.id = r.city_id
  LEFT JOIN vehicles av ON av.id = r.accepted_vehicle_id
  WHERE r.id = p_request_id AND is_party_to_city_purchase(r.id);
$function$;

CREATE OR REPLACE FUNCTION public.my_city_purchase_invitations(p_vehicle_id uuid)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'request_id', r.id, 'item', r.item, 'goods_budget_pkr', r.goods_budget_pkr, 'pickup_label', r.pickup_label, 'urgency', r.urgency,
    'source', i.source, 'reference_destination', i.reference_destination, 'city_name', ci.name, 'city_name_ur', ci.name_ur, 'invited_at', i.invited_at
  ) || jsonb_build_object(
    'trip_mode', CASE WHEN i.source IN ('presence', 'trip_offer', 'route') THEN 'carry_back' ELSE 'dedicated' END,
    'area', r.area, 'reference_distance_km', i.reference_distance_km, 'scheduled_date', r.scheduled_date, 'scheduled_time', r.scheduled_time,
    'tip_pkr', r.tip_pkr, 'service_fee_floor_pkr', r.service_fee_floor_pkr
  ) ORDER BY i.invited_at), '[]'::jsonb)
  FROM city_purchase_invitations i
  JOIN city_purchase_requests r ON r.id = i.request_id
  JOIN cities ci ON ci.id = r.city_id
  WHERE i.vehicle_id = p_vehicle_id AND i.status = 'ringing' AND r.status = 'ringing'
    AND EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id());
$function$;

-- ─── Saved one-way requests ring the next driver who goes to the city ──
CREATE OR REPLACE FUNCTION ring_saved_city_purchases_for_vehicle(p_vehicle_id uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_count int := 0; v_kind varchar; v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM vehicles WHERE id = p_vehicle_id;
  v_kind := vehicle_ride_kind(p_vehicle_id);
  FOR r IN
    SELECT q.id, q.initiator_portal_user_id FROM city_purchase_requests q
    WHERE q.status IN ('no_answer', 'ringing') AND q.trip_preference = 'one_way' AND q.ride_type = v_kind
      AND COALESCE(q.scheduled_date, (now() AT TIME ZONE 'Asia/Karachi')::date) <= (now() AT TIME ZONE 'Asia/Karachi')::date + 1
      AND q.created_at > now() - interval '7 days'
      AND q.tenant_id = v_tenant
      AND NOT EXISTS (SELECT 1 FROM city_purchase_invitations i WHERE i.request_id = q.id AND i.vehicle_id = p_vehicle_id)
  LOOP
    IF city_purchase_invite(r.id) > 0 THEN
      v_count := v_count + 1;
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (r.initiator_portal_user_id, 'city_purchase_driver_found', 'A driver is going to the city', 'Your saved request has been sent to a driver.', '/portal/marketplace/city-purchase/' || r.id);
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION trg_ring_saved_city_purchases() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Separate branches: plpgsql resolves NEW.<field> per table, so one
  -- combined condition would fail on whichever table lacks the column.
  IF TG_TABLE_NAME = 'vehicle_city_presence' THEN
    IF NEW.is_active THEN PERFORM ring_saved_city_purchases_for_vehicle(NEW.vehicle_id); END IF;
  ELSIF TG_TABLE_NAME = 'vehicle_trip_offers' THEN
    IF NEW.status = 'open' THEN PERFORM ring_saved_city_purchases_for_vehicle(NEW.vehicle_id); END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ring_saved_city_purchases ON vehicle_city_presence;
CREATE TRIGGER ring_saved_city_purchases AFTER INSERT ON vehicle_city_presence FOR EACH ROW EXECUTE FUNCTION trg_ring_saved_city_purchases();
DROP TRIGGER IF EXISTS ring_saved_city_purchases ON vehicle_trip_offers;
CREATE TRIGGER ring_saved_city_purchases AFTER INSERT ON vehicle_trip_offers FOR EACH ROW EXECUTE FUNCTION trg_ring_saved_city_purchases();

-- Internal helpers: not callable from the API directly.
REVOKE ALL ON FUNCTION city_purchase_price(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION city_purchase_invite(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ring_saved_city_purchases_for_vehicle(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION city_purchase_village_vehicles(uuid, uuid) FROM PUBLIC, anon, authenticated;
