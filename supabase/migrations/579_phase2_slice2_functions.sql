-- Phase 2, slice 2 (functions): the vehicle & marketplace domain re-uses
-- two bug classes seen before (business-key lookups with no tenant filter,
-- and bare `WHERE id = $1` lookups that SECURITY DEFINER lets bypass RLS)
-- but also surfaces a THIRD, new one that's specific to this domain's
-- "admin OR owner" authorization style:
--
--   is_party_to_city_purchase / is_party_to_dispatch / is_party_to_negotiation
--   grant access via `COALESCE(current_admin_permission('manage_parties'), false)
--   OR <row ownership>` -- but current_admin_permission() is a flag on the
--   admin_users row, with NO awareness of which row is being accessed. Any
--   admin in ANY tenant with that permission satisfies the OR branch for
--   EVERY tenant's city-purchase/dispatch/negotiation row. These three
--   helpers gate several other functions (city_purchase_attachment_path,
--   city_purchase_request_detail, dispatch_call_detail,
--   negotiation_thread_detail, negotiation_fare_band) as their ONLY
--   authorization check, so fixing the three helpers protects all of those
--   transitively -- no separate edit needed there.
--
-- The same "admin bypass with no tenant check" shape also appears directly
-- (not through a shared helper) in about twenty mutating functions below --
-- adda_* queue actions, close_vehicle_route, complete_trip_booking,
-- confirm_hourly_booking, start_hourly_trip, vehicle_check_in/out_city,
-- set_vehicle_catalog/delivery_prefs, my_weekend_share_offers,
-- vehicle_hourly_bookings, vehicle_shadi_requests, vehicle_trust_bulk, and
-- the admin_* write/read functions -- fixed by adding `tenant_id =
-- my_tenant_id()` to each one's initial row lookup, so the row itself must
-- belong to the caller's own tenant before EITHER the ownership or the
-- admin-permission branch is even reached.
--
-- Several more functions take a signed-in user for granted but never check
-- that the id they were handed (a route, an adda entry, a weekend offer, a
-- city, a service class) belongs to that user's own tenant -- any
-- authenticated user could otherwise act on another tenant's row by id
-- (book_adda_seat, place_ride_booking, request_pro_service,
-- request_share_seat, set_commuter_schedule, invite_dispatch_tier,
-- route_seats_available, ride_booking_context, post_purchase).
--
-- Chart-of-account / business-key lookups with no tenant filter (same bug
-- class as phase 1's migration 569): vehicle_commission_pct's
-- vehicle_type_commission_rates lookup, and the raw `site_settings WHERE
-- key = ...` / `accounts WHERE code = ...` lookups inlined directly in
-- announce_shadi_advance, invite_dispatch_tier, confirm_hourly_booking,
-- complete_trip_booking, vehicle_bookable and city_purchase_candidate_vehicles
-- (these don't call the already-fixed setting_text() helper from migration
-- 570 -- they're separate inline queries that needed their own fix).
--
-- A handful of genuinely public, pre-login marketplace-browse functions
-- (nearby_addas, nearby_open_trips, hourly_bookable_vehicles,
-- shadi_bookable_vehicles, vehicles_available_for_city,
-- vehicles_present_in_city, vehicles_offering_service,
-- city_purchase_candidate_vehicles, adda_board, adda_entry_seats_available)
-- had NO tenant filter at all and would have mixed every tenant's vehicles/
-- addas/trip-offers into one combined listing -- fixed with the same
-- `coalesce(my_tenant_id(), '<dhab-pari-uuid>'::uuid)` fallback used for
-- anonymous-readable RLS policies, since there's no auth.uid() for a
-- logged-out visitor. Every other fix in this migration uses plain
-- my_tenant_id() (no fallback): these are all authenticated flows, and
-- failing to resolve a tenant should fail closed (no matching row) rather
-- than silently defaulting to Dhab Pari.
--
-- Left unchanged (already safely self-scoped by an FK to one specific
-- already-tenant-scoped row, with no admin-bypass branch, so no fix
-- needed): my_city_purchase_invitations/requests, my_commuter_matches,
-- my_dispatch_calls/invitations, my_hourly_bookings, my_negotiation_threads,
-- my_shadi_events, my_vehicle_registration_status, place_trip_offer,
-- place_vehicle_wallet_topup, ping_trip_location, ping_hourly_trip_location,
-- ping_trip_offer_location, set_trip_offer_live_sharing,
-- set_vehicle_capability_prefs, set_vehicle_online_status, close_trip_offer,
-- cancel_city_purchase_request, cancel_dispatch_call,
-- decline_city_purchase_invitation, decline_dispatch_call,
-- withdraw_trip_fare_offer, vehicle_daily_earnings, submit_vehicle_registration,
-- ensure_vehicle_account, trg_keeper_full_name_to_vehicle,
-- vehicle_delivery_eligible, vehicle_ride_eligible, city_purchase_attachment_path,
-- city_purchase_request_detail, dispatch_call_detail, negotiation_thread_detail,
-- negotiation_fare_band, city_purchase_candidates.

-- ===== The three shared "is party to" gatekeepers =====

create or replace function public.is_party_to_city_purchase(p_request_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT EXISTS (
    SELECT 1 FROM city_purchase_requests r
    WHERE r.id = p_request_id AND r.tenant_id = my_tenant_id()
      AND (COALESCE(current_admin_permission('manage_parties'), false) OR r.initiator_portal_user_id = current_portal_user_id())
  ) OR EXISTS (
    SELECT 1 FROM city_purchase_invitations i JOIN vehicles v ON v.id = i.vehicle_id
    WHERE i.request_id = p_request_id AND i.tenant_id = my_tenant_id() AND v.portal_user_id = current_portal_user_id()
  );
$function$;

create or replace function public.is_party_to_dispatch(p_call_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT EXISTS (
    SELECT 1 FROM dispatch_calls c
    WHERE c.id = p_call_id AND c.tenant_id = my_tenant_id()
      AND (COALESCE(current_admin_permission('manage_parties'), false) OR c.initiator_portal_user_id = current_portal_user_id())
  ) OR EXISTS (
    SELECT 1 FROM dispatch_invitations i JOIN vehicles v ON v.id = i.vehicle_id
    WHERE i.call_id = p_call_id AND i.tenant_id = my_tenant_id() AND v.portal_user_id = current_portal_user_id()
  );
$function$;

create or replace function public.is_party_to_negotiation(p_thread_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT EXISTS (
    SELECT 1 FROM negotiation_threads t
    LEFT JOIN vehicles v ON v.id = t.vehicle_id
    WHERE t.id = p_thread_id AND t.tenant_id = my_tenant_id()
      AND (COALESCE(current_admin_permission('manage_parties'), false)
           OR t.initiator_portal_user_id = current_portal_user_id()
           OR v.portal_user_id = current_portal_user_id())
  );
$function$;

-- ===== adda queue actions (admin-bypass with no tenant check) =====

create or replace function public.adda_check_in(p_adda_id uuid, p_vehicle_id uuid, p_fare_mode character varying DEFAULT 'fixed'::character varying, p_share_location_on_depart boolean DEFAULT false, p_lat numeric DEFAULT NULL::numeric, p_lng numeric DEFAULT NULL::numeric, p_seats_available integer DEFAULT NULL::integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  a addas%ROWTYPE; ap addas%ROWTYPE; v vehicles%ROWTYPE; v_portal_user_id uuid := current_portal_user_id();
  v_queue_date date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_now_time time := (now() AT TIME ZONE 'Asia/Karachi')::time;
  v_next_position int; v_entry_id uuid; v_trip_offer_id uuid; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
  v_distance_km decimal; v_seats int; v_fare decimal;
BEGIN
  SELECT * INTO a FROM addas WHERE id = p_adda_id AND is_active AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This adda is not available.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND tenant_id = my_tenant_id();
  IF NOT FOUND OR NOT v.is_active THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (v_is_admin OR v.portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT v_is_admin AND NOT v.is_online THEN
    RAISE EXCEPTION 'Go online first — you can''t check in to the queue while offline.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT v_is_admin AND NOT vehicle_ride_eligible(p_vehicle_id) THEN
    RAISE EXCEPTION 'Your vehicle''s class is not enabled for rides — ask the committee.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT vehicle_bookable(p_vehicle_id) THEN
    RAISE EXCEPTION 'This vehicle''s wallet balance is too low to join the queue — top up first.' USING ERRCODE = 'P0001';
  END IF;
  IF v.commission_mode = 'per_order' AND seller_account_balance(ensure_vehicle_account(p_vehicle_id)) <= 0 THEN
    RAISE EXCEPTION 'Top up your wallet before checking in — an adda slot needs a positive balance.' USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_is_admin AND a.operating_start_time IS NOT NULL AND a.operating_end_time IS NOT NULL THEN
    IF v_now_time < a.operating_start_time OR v_now_time > a.operating_end_time THEN
      RAISE EXCEPTION 'This adda only runs % to % — check in during those hours, or ask the committee about night service.',
        to_char(a.operating_start_time, 'HH12:MI AM'), to_char(a.operating_end_time, 'HH12:MI AM') USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NOT v_is_admin AND a.lat IS NOT NULL AND a.lng IS NOT NULL THEN
    IF p_lat IS NULL OR p_lng IS NULL THEN
      RAISE EXCEPTION 'Turn on your location to check in — we need to confirm you''re at the adda.' USING ERRCODE = 'P0001';
    END IF;
    v_distance_km := 6371 * acos(least(1, greatest(-1,
      cos(radians(p_lat)) * cos(radians(a.lat)) * cos(radians(p_lng) - radians(a.lng))
      + sin(radians(p_lat)) * sin(radians(a.lat)))));
    IF v_distance_km > 0.3 THEN
      RAISE EXCEPTION 'You need to be at the adda to check in — you appear to be % km away.', round(v_distance_km::numeric, 1) USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM adda_queue_entries WHERE vehicle_id = p_vehicle_id AND queue_date = v_queue_date AND status IN ('waiting', 'current')) THEN
    RAISE EXCEPTION 'This vehicle is already in a queue today.' USING ERRCODE = 'P0001';
  END IF;

  IF p_fare_mode NOT IN ('fixed', 'request') THEN RAISE EXCEPTION 'Invalid fare mode.' USING ERRCODE = 'P0001'; END IF;
  IF p_fare_mode = 'fixed' THEN
    IF a.fixed_fare_per_seat_pkr IS NULL THEN
      RAISE EXCEPTION 'This adda has no fare set yet — ask the committee to set one first.' USING ERRCODE = 'P0001';
    END IF;
    v_fare := a.fixed_fare_per_seat_pkr;
  ELSE
    v_fare := NULL;
  END IF;

  v_seats := COALESCE(p_seats_available, v.total_seats);
  IF v_seats <= 0 OR v_seats > v.total_seats THEN
    RAISE EXCEPTION 'Enter how many seats are actually free (1 to %).', v.total_seats USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(MAX(position), 0) + 1 INTO v_next_position FROM adda_queue_entries
    WHERE adda_id = p_adda_id AND queue_date = v_queue_date AND status IN ('waiting', 'current');

  SELECT * INTO ap FROM addas WHERE id = a.pair_adda_id;
  INSERT INTO vehicle_trip_offers (vehicle_id, origin, origin_ur, destination, destination_ur, classification, travel_date, seats_available, listed_fare_per_seat_pkr)
  VALUES (p_vehicle_id, a.name, a.name_ur, COALESCE(ap.name, 'destination'), ap.name_ur, a.classification, v_queue_date, v_seats, COALESCE(v_fare, 0))
  RETURNING id INTO v_trip_offer_id;

  INSERT INTO adda_queue_entries (adda_id, vehicle_id, queue_date, position, status, fare_mode, fixed_fare_per_seat_pkr, trip_offer_id, seats_total, share_location_on_depart, checked_in_by_admin)
  VALUES (p_adda_id, p_vehicle_id, v_queue_date, v_next_position, 'waiting', p_fare_mode, v_fare, v_trip_offer_id, v_seats, p_share_location_on_depart,
    CASE WHEN v_is_admin AND v.portal_user_id IS DISTINCT FROM v_portal_user_id THEN current_admin_user_id() ELSE NULL END)
  RETURNING id INTO v_entry_id;

  PERFORM adda_promote_next(p_adda_id, v_queue_date);

  RETURN jsonb_build_object('entry_id', v_entry_id, 'trip_offer_id', v_trip_offer_id);
END;
$function$;

create or replace function public.adda_claim_front(p_entry_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  e adda_queue_entries%ROWTYPE; v vehicles%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
  v_current adda_queue_entries%ROWTYPE; v_lowest_waiting_id uuid; v_minutes_left int;
BEGIN
  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Queue entry not found.' USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM addas WHERE id = e.adda_id FOR UPDATE;
  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id AND tenant_id = my_tenant_id() FOR UPDATE;
  SELECT * INTO v FROM vehicles WHERE id = e.vehicle_id;
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF e.status <> 'waiting' THEN RAISE EXCEPTION 'This vehicle is not waiting in this queue.' USING ERRCODE = 'P0001'; END IF;

  SELECT id INTO v_lowest_waiting_id FROM adda_queue_entries
    WHERE adda_id = e.adda_id AND queue_date = e.queue_date AND status = 'waiting' ORDER BY position LIMIT 1;
  IF v_lowest_waiting_id IS DISTINCT FROM p_entry_id THEN
    RAISE EXCEPTION 'A vehicle ahead of you in line can claim the front first.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_current FROM adda_queue_entries WHERE adda_id = e.adda_id AND queue_date = e.queue_date AND status = 'current' FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM adda_promote_next(e.adda_id, e.queue_date);
    RETURN jsonb_build_object('claimed', true);
  END IF;
  IF now() <= v_current.turn_expires_at THEN
    v_minutes_left := ceil(extract(epoch FROM (v_current.turn_expires_at - now())) / 60);
    RAISE EXCEPTION 'The current vehicle still has % minute(s) left on its turn.', v_minutes_left USING ERRCODE = 'P0001';
  END IF;

  UPDATE adda_queue_entries SET status = 'expired' WHERE id = v_current.id;
  INSERT INTO adda_queue_entries (adda_id, vehicle_id, queue_date, position, status, fare_mode, fixed_fare_per_seat_pkr, seats_total, share_location_on_depart, lap)
  VALUES (v_current.adda_id, v_current.vehicle_id, v_current.queue_date,
    (SELECT COALESCE(MAX(position), 0) + 1 FROM adda_queue_entries WHERE adda_id = v_current.adda_id AND queue_date = v_current.queue_date AND status IN ('waiting', 'current')),
    'waiting', v_current.fare_mode, v_current.fixed_fare_per_seat_pkr, v_current.seats_total, v_current.share_location_on_depart, v_current.lap + 1);

  PERFORM adda_promote_next(e.adda_id, e.queue_date);

  RETURN jsonb_build_object('claimed', true);
END;
$function$;

create or replace function public.adda_leave_queue(p_entry_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE e adda_queue_entries%ROWTYPE; v vehicles%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
BEGIN
  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Queue entry not found.' USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM addas WHERE id = e.adda_id FOR UPDATE;
  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id AND tenant_id = my_tenant_id() FOR UPDATE;
  SELECT * INTO v FROM vehicles WHERE id = e.vehicle_id;
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF e.status <> 'waiting' THEN RAISE EXCEPTION 'Only a waiting vehicle can leave the queue this way.' USING ERRCODE = 'P0001'; END IF;

  UPDATE adda_queue_entries SET status = 'cancelled' WHERE id = p_entry_id;
  PERFORM adda_promote_next(e.adda_id, e.queue_date);
END;
$function$;

create or replace function public.adda_mark_departed(p_entry_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE e adda_queue_entries%ROWTYPE; v vehicles%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
BEGIN
  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Queue entry not found.' USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM addas WHERE id = e.adda_id FOR UPDATE;
  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id AND tenant_id = my_tenant_id() FOR UPDATE;
  SELECT * INTO v FROM vehicles WHERE id = e.vehicle_id;
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF e.status <> 'current' THEN RAISE EXCEPTION 'This vehicle is not currently at the front of the queue.' USING ERRCODE = 'P0001'; END IF;

  UPDATE adda_queue_entries SET status = 'departed', departed_at = now() WHERE id = p_entry_id;
  IF e.trip_offer_id IS NOT NULL THEN
    UPDATE vehicle_trip_offers SET status = 'closed' WHERE id = e.trip_offer_id AND status = 'open';
    IF e.share_location_on_depart THEN
      UPDATE vehicle_trip_offers SET share_live_location = true, live_location_started_at = now() WHERE id = e.trip_offer_id;
    END IF;
  END IF;

  PERFORM adda_promote_next(e.adda_id, e.queue_date);
END;
$function$;

create or replace function public.adda_pass_turn(p_entry_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE e adda_queue_entries%ROWTYPE; v vehicles%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
  v_next_position int; v_new_id uuid;
BEGIN
  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Queue entry not found.' USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM addas WHERE id = e.adda_id FOR UPDATE;
  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id AND tenant_id = my_tenant_id() FOR UPDATE;
  SELECT * INTO v FROM vehicles WHERE id = e.vehicle_id;
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF e.status <> 'current' THEN RAISE EXCEPTION 'This vehicle is not currently at the front of the queue.' USING ERRCODE = 'P0001'; END IF;

  -- Close the old row before inserting the new one — insert-first would
  -- momentarily violate adda_queue_one_live_per_vehicle and abort the call.
  UPDATE adda_queue_entries SET status = 'passed', passed_at = now() WHERE id = p_entry_id;

  SELECT COALESCE(MAX(position), 0) + 1 INTO v_next_position FROM adda_queue_entries
    WHERE adda_id = e.adda_id AND queue_date = e.queue_date AND status IN ('waiting', 'current');
  INSERT INTO adda_queue_entries (adda_id, vehicle_id, queue_date, position, status, fare_mode, fixed_fare_per_seat_pkr, seats_total, share_location_on_depart, lap)
  VALUES (e.adda_id, e.vehicle_id, e.queue_date, v_next_position, 'waiting', e.fare_mode, e.fixed_fare_per_seat_pkr, e.seats_total, e.share_location_on_depart, e.lap + 1)
  RETURNING id INTO v_new_id;

  PERFORM adda_promote_next(e.adda_id, e.queue_date);

  RETURN jsonb_build_object('new_entry_id', v_new_id);
END;
$function$;

create or replace function public.adda_update_seats(p_entry_id uuid, p_seats_total integer)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  e adda_queue_entries%ROWTYPE; v vehicles%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
  v_committed int; v_delta int; v_offer_available int;
BEGIN
  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Queue entry not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = e.vehicle_id;
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF e.status NOT IN ('waiting', 'current') THEN
    RAISE EXCEPTION 'This vehicle is no longer waiting at the adda.' USING ERRCODE = 'P0001';
  END IF;
  IF p_seats_total IS NULL OR p_seats_total <= 0 OR p_seats_total > v.total_seats THEN
    RAISE EXCEPTION 'Enter how many seats are actually free (1 to %).', v.total_seats USING ERRCODE = 'P0001';
  END IF;

  IF e.fare_mode = 'fixed' THEN
    v_committed := e.seats_total - adda_entry_seats_available(p_entry_id);
  ELSE
    SELECT seats_available INTO v_offer_available FROM vehicle_trip_offers WHERE id = e.trip_offer_id;
    v_committed := e.seats_total - COALESCE(v_offer_available, e.seats_total);
  END IF;
  IF p_seats_total < v_committed THEN
    RAISE EXCEPTION 'Already % seat(s) booked — can''t set free seats below that.', v_committed USING ERRCODE = 'P0001';
  END IF;

  v_delta := p_seats_total - e.seats_total;
  UPDATE adda_queue_entries SET seats_total = p_seats_total WHERE id = p_entry_id;
  IF e.trip_offer_id IS NOT NULL THEN
    UPDATE vehicle_trip_offers SET seats_available = seats_available + v_delta WHERE id = e.trip_offer_id;
  END IF;
END;
$function$;

create or replace function public.adjust_weekend_share_seats_taken(p_offer_id uuid, p_delta integer)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE o weekend_share_offers%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
BEGIN
  SELECT * INTO o FROM weekend_share_offers WHERE id = p_offer_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'This share ride is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (v_is_admin OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = o.vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE weekend_share_offers SET seats_taken = seats_taken + p_delta WHERE id = p_offer_id;
END;
$function$;

-- ===== admin-permission-gated functions with no tenant check =====

create or replace function public.admin_resolve_dispute(p_dispute_id uuid, p_ruling character varying, p_resolution_note text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  IF p_ruling NOT IN ('rider', 'driver') THEN RAISE EXCEPTION 'Invalid ruling' USING ERRCODE = 'P0001'; END IF;

  UPDATE disputes SET
    status = 'closed', ruling = p_ruling, resolution_note = p_resolution_note,
    resolved_at = now(), resolved_by = current_admin_user_id()
  WHERE id = p_dispute_id AND tenant_id = my_tenant_id() AND status = 'open';

  IF NOT FOUND THEN RAISE EXCEPTION 'Dispute not open' USING ERRCODE = 'P0001'; END IF;
END;
$function$;

create or replace function public.admin_vehicle_registration_document_path(p_request_id uuid, p_which character varying)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT CASE p_which
    WHEN 'owner_id_card' THEN owner_id_card_url
    WHEN 'license' THEN license_url
    WHEN 'vehicle_doc' THEN vehicle_doc_url
    WHEN 'driver_photo' THEN driver_photo_url
    ELSE NULL
  END
  FROM vehicle_registration_requests
  WHERE id = p_request_id AND tenant_id = my_tenant_id() AND current_admin_permission('manage_parties');
$function$;

create or replace function public.admin_list_vehicle_registrations(p_status character varying DEFAULT 'pending'::character varying)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'owner_name', r.owner_name, 'cnic_number', r.cnic_number, 'father_husband_name', r.father_husband_name, 'address', r.address,
    'vehicle_type', r.vehicle_type, 'vehicle_number', r.vehicle_number, 'model', r.model, 'color', r.color, 'total_seats', r.total_seats,
    'owner_id_card_url', r.owner_id_card_url, 'license_url', r.license_url, 'vehicle_doc_url', r.vehicle_doc_url, 'driver_photo_url', r.driver_photo_url,
    'wants_delivers', r.wants_delivers, 'wants_hourly', r.wants_hourly, 'wants_shadi', r.wants_shadi,
    'wants_out_of_city', r.wants_out_of_city, 'wants_night_booking', r.wants_night_booking, 'wants_service_class_ids', r.wants_service_class_ids,
    'status', r.status, 'is_village_resident', r.is_village_resident, 'rejection_reason', r.rejection_reason,
    'created_at', r.created_at, 'reviewed_at', r.reviewed_at,
    'submitter_name', pu.full_name, 'submitter_mobile', pu.mobile
  ) ORDER BY r.created_at DESC), '[]'::jsonb)
  FROM vehicle_registration_requests r JOIN portal_users pu ON pu.id = r.portal_user_id
  WHERE r.tenant_id = my_tenant_id() AND current_admin_permission('manage_parties') AND (p_status IS NULL OR r.status = p_status)
  LIMIT 200;
$function$;

create or replace function public.review_catalog_brand_submission(p_submission_id uuid, p_approve boolean, p_note text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  UPDATE catalog_brand_submissions
  SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
      reviewed_by_admin_id = current_admin_user_id(), reviewed_at = now(), review_note = p_note
  WHERE id = p_submission_id AND tenant_id = my_tenant_id() AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Submission not found or already reviewed.' USING ERRCODE = 'P0001'; END IF;
END;
$function$;

create or replace function public.sync_vehicle_keeper_name(p_vehicle_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_owner_name varchar;
  v_portal_user_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  SELECT owner_name, portal_user_id INTO v_owner_name, v_portal_user_id
    FROM vehicles WHERE id = p_vehicle_id AND tenant_id = my_tenant_id();
  IF v_portal_user_id IS NULL OR v_owner_name IS NULL OR trim(v_owner_name) = '' THEN
    RETURN;
  END IF;

  UPDATE portal_users SET full_name = v_owner_name
   WHERE id = v_portal_user_id AND full_name IS DISTINCT FROM v_owner_name;
END;
$function$;

create or replace function public.vehicle_trust_bulk(p_vehicle_ids uuid[])
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_object_agg(v.id, vehicle_trust(v.id)), '{}'::jsonb)
  FROM vehicles v WHERE v.id = ANY(p_vehicle_ids) AND v.tenant_id = my_tenant_id() AND current_admin_permission('manage_parties');
$function$;

create or replace function public.admin_fleet_locations()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(row), '[]'::jsonb) FROM (
    SELECT jsonb_build_object(
      'source', 'trip', 'ref_id', o.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile,
      'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
      'context', o.origin || ' → ' || o.destination, 'lat', l.lat, 'lng', l.lng, 'updated_at', l.updated_at
    ) AS row
    FROM vehicle_trip_offers o
    JOIN vehicles v ON v.id = o.vehicle_id
    JOIN vehicle_trip_offer_locations l ON l.trip_offer_id = o.id
    WHERE o.tenant_id = my_tenant_id() AND o.share_live_location AND l.updated_at > now() - interval '5 minutes'

    UNION ALL

    SELECT jsonb_build_object(
      'source', 'hourly', 'ref_id', b.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile,
      'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
      'context', b.pickup_address, 'lat', latest.lat, 'lng', latest.lng, 'updated_at', latest.recorded_at
    ) AS row
    FROM hourly_bookings b
    JOIN vehicles v ON v.id = b.vehicle_id
    JOIN LATERAL (
      SELECT lat, lng, recorded_at FROM hourly_booking_locations hl
      WHERE hl.booking_id = b.id ORDER BY hl.recorded_at DESC LIMIT 1
    ) latest ON true
    WHERE b.tenant_id = my_tenant_id() AND b.status = 'in_progress' AND latest.recorded_at > now() - interval '5 minutes'
  ) rows;
$function$;

create or replace function public.invite_dispatch_tier(p_call_id uuid, p_tier integer)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_city_id uuid; v_city_is_home boolean; v_count int; v_floor int;
BEGIN
  SELECT COALESCE(value::int, 15) INTO v_floor FROM site_settings WHERE key = 'vehicle_trust_floor_score' AND tenant_id = my_tenant_id();
  SELECT s.city_id, ci.is_home_city INTO v_city_id, v_city_is_home
  FROM dispatch_calls c JOIN city_shops s ON s.id = c.city_shop_id JOIN cities ci ON ci.id = s.city_id
  WHERE c.id = p_call_id AND c.tenant_id = my_tenant_id();

  INSERT INTO dispatch_invitations (call_id, vehicle_id, tier)
  SELECT p_call_id, v.id, p_tier
  FROM vehicles v
  WHERE v.tenant_id = my_tenant_id() AND v.is_active AND v.delivers AND v.is_online AND vehicle_delivery_eligible(v.id)
    AND vehicle_trust_score(v.id) >= COALESCE(v_floor, 15)
    AND (v_city_is_home OR v.allows_out_of_city)
    AND NOT EXISTS (SELECT 1 FROM dispatch_invitations i WHERE i.call_id = p_call_id AND i.vehicle_id = v.id)
    AND (
      (p_tier = 1 AND EXISTS (SELECT 1 FROM vehicle_city_presence p WHERE p.vehicle_id = v.id AND p.city_id = v_city_id AND p.is_active))
      OR
      (p_tier = 2 AND NOT EXISTS (SELECT 1 FROM vehicle_city_presence p WHERE p.vehicle_id = v.id AND p.city_id = v_city_id AND p.is_active))
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- ===== mutating functions with "owner OR admin" and no tenant check =====

create or replace function public.close_vehicle_route(p_route_id uuid, p_reason text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  r vehicle_routes%ROWTYPE; v vehicles%ROWTYPE;
  v_portal_user_id uuid := current_portal_user_id();
  b RECORD;
  v_cancelled_count int := 0;
BEGIN
  SELECT * INTO r FROM vehicle_routes WHERE id = p_route_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = r.vehicle_id;

  IF NOT ((v.portal_user_id IS NOT NULL AND v.portal_user_id = v_portal_user_id) OR COALESCE(current_admin_permission('post_transactions'), false)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicle_routes SET is_active = false WHERE id = p_route_id;

  FOR b IN
    SELECT id FROM ride_bookings
    WHERE route_id = p_route_id AND status IN ('announced', 'confirmed') AND travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
  LOOP
    PERFORM cancel_ride_booking(b.id, COALESCE(trim(p_reason), 'Route closed by driver'));
    v_cancelled_count := v_cancelled_count + 1;
  END LOOP;

  RETURN jsonb_build_object('route_id', p_route_id, 'bookings_cancelled', v_cancelled_count);
END;
$function$;

create or replace function public.complete_trip_booking(p_trip_booking_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  b vehicle_trip_bookings%ROWTYPE; v vehicles%ROWTYPE; o vehicle_trip_offers%ROWTYPE;
  v_vehicle_account uuid; v_commission_account uuid; v_commission_pct decimal; v_commission_amount decimal := 0;
  v_commission_voucher_id uuid;
BEGIN
  SELECT * INTO b FROM vehicle_trip_bookings WHERE id = p_trip_booking_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'confirmed' THEN RAISE EXCEPTION 'This trip is not awaiting completion.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  SELECT * INTO o FROM vehicle_trip_offers WHERE id = b.trip_offer_id;
  IF v.portal_user_id IS DISTINCT FROM current_portal_user_id() AND NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicle_trip_bookings SET status = 'completed', completed_at = now() WHERE id = p_trip_booking_id;

  IF v.commission_mode = 'per_order' THEN
    v_vehicle_account := ensure_vehicle_account(v.id);
    SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050' AND tenant_id = my_tenant_id();
    v_commission_pct := vehicle_commission_pct(v.vehicle_type, o.classification);
    v_commission_amount := round(b.total_amount_pkr * v_commission_pct / 100, 2);
    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — ' || o.origin || ' → ' || o.destination || ' return trip (paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
      RETURNING id INTO v_commission_voucher_id;
      UPDATE vehicle_trip_bookings SET commission_voucher_id = v_commission_voucher_id WHERE id = p_trip_booking_id;
    END IF;
    PERFORM check_seller_balance_notify('vehicle', v.id);
  END IF;

  RETURN jsonb_build_object('amount', b.total_amount_pkr, 'commission', v_commission_amount);
END;
$function$;

create or replace function public.confirm_hourly_booking(p_booking_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  b hourly_bookings%ROWTYPE; v vehicles%ROWTYPE;
  v_vehicle_account uuid; v_cash_account uuid; v_commission_account uuid;
  v_commission_pct decimal; v_commission_amount decimal;
  v_gross_voucher_id uuid; v_gross_voucher_no varchar; v_commission_voucher_id uuid;
  v_is_keeper boolean;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'completed' THEN RAISE EXCEPTION 'This trip has not been completed yet.' USING ERRCODE = 'P0001'; END IF;
  IF b.status_confirmed THEN RAISE EXCEPTION 'This booking has already been settled.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;

  v_is_keeper := v.portal_user_id IS NOT NULL AND v.portal_user_id = current_portal_user_id() AND v.commission_mode = 'per_order';
  IF NOT (COALESCE(current_admin_permission('post_transactions'), false) OR v_is_keeper) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;

  v_vehicle_account := ensure_vehicle_account(v.id);
  SELECT id INTO v_commission_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4050' AND tenant_id = my_tenant_id();

  IF v.commission_mode = 'per_order' THEN
    v_commission_pct := COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_hourly_commission_pct' AND tenant_id = my_tenant_id()), 0);
    v_commission_amount := round(b.total_amount_pkr * v_commission_pct / 100, 2);

    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — hourly rental (' || b.hours || 'h, paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
      RETURNING id INTO v_commission_voucher_id;
    END IF;

    UPDATE hourly_bookings SET status_confirmed = true, commission_voucher_id = v_commission_voucher_id WHERE id = p_booking_id;
    PERFORM check_seller_balance_notify('vehicle', v.id);
    RETURN jsonb_build_object('amount', b.total_amount_pkr, 'commission', v_commission_amount);
  END IF;

  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-1001' AND tenant_id = my_tenant_id();

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Hourly rental (' || b.hours || 'h) — confirmed', b.total_amount_pkr, v_vehicle_account, v_cash_account, v.owner_name)
  RETURNING id, voucher_no INTO v_gross_voucher_id, v_gross_voucher_no;

  UPDATE hourly_bookings SET status_confirmed = true, gross_voucher_id = v_gross_voucher_id WHERE id = p_booking_id;
  RETURN jsonb_build_object('voucher_no', v_gross_voucher_no, 'amount', b.total_amount_pkr);
END;
$function$;

create or replace function public.start_hourly_trip(p_booking_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE b hourly_bookings%ROWTYPE; v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO b FROM hourly_bookings WHERE id = p_booking_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = b.vehicle_id;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF b.status <> 'accepted' THEN RAISE EXCEPTION 'This booking is not ready to start.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM hourly_bookings other WHERE other.vehicle_id = b.vehicle_id AND other.id <> b.id AND other.status = 'in_progress') THEN
    RAISE EXCEPTION 'This vehicle is already on another trip — end that one first.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE hourly_bookings SET status = 'in_progress', started_at = now(), distance_km = 0, last_lat = NULL, last_lng = NULL WHERE id = p_booking_id;
END;
$function$;

create or replace function public.set_vehicle_catalog_prefs(p_vehicle_id uuid, p_color text, p_model text, p_has_ac boolean, p_offers_hourly boolean, p_offers_shadi boolean)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v vehicles%ROWTYPE;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF p_offers_hourly AND v.hourly_rate_pkr IS NULL THEN
    RAISE EXCEPTION 'Ask the committee to set your hourly rate before turning this on.' USING ERRCODE = 'P0001';
  END IF;
  IF p_offers_shadi AND v.shadi_full_day_rate_pkr IS NULL THEN
    RAISE EXCEPTION 'Ask the committee to set your full-day wedding rate before turning this on.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicles SET
    color = NULLIF(trim(p_color), ''), model = NULLIF(trim(p_model), ''),
    has_ac = p_has_ac, offers_hourly = p_offers_hourly, offers_shadi = p_offers_shadi
  WHERE id = p_vehicle_id;
END;
$function$;

create or replace function public.set_vehicle_delivery_prefs(p_vehicle_id uuid, p_delivers boolean, p_per_km_pkr numeric DEFAULT NULL::numeric)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v vehicles%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF p_per_km_pkr IS NOT NULL THEN
    IF NOT v_is_admin THEN RAISE EXCEPTION 'Only the committee can set the per-km rate.' USING ERRCODE = 'P0001'; END IF;
    IF p_per_km_pkr < 0 THEN RAISE EXCEPTION 'Rate cannot be negative.' USING ERRCODE = 'P0001'; END IF;
  END IF;
  IF p_delivers AND NOT v_is_admin AND NOT vehicle_delivery_eligible(p_vehicle_id) THEN
    RAISE EXCEPTION 'Your vehicle''s class is not enabled for intercity delivery — ask the committee.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicles SET delivers = p_delivers, per_km_pkr = COALESCE(p_per_km_pkr, per_km_pkr) WHERE id = p_vehicle_id;
END;
$function$;

create or replace function public.vehicle_check_in_city(p_vehicle_id uuid, p_city_id uuid, p_expected_return_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v vehicles%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
  v_city cities%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND is_active AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_city FROM cities WHERE id = p_city_id AND is_active AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT v_is_admin AND NOT v_city.is_home_city AND NOT v.allows_out_of_city THEN
    RAISE EXCEPTION 'This vehicle is only set up for the home city — it can''t check in this far out.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE vehicle_city_presence SET is_active = false, checked_out_at = now()
    WHERE vehicle_id = p_vehicle_id AND is_active;

  INSERT INTO vehicle_city_presence (vehicle_id, city_id, expected_return_at)
  VALUES (p_vehicle_id, p_city_id, p_expected_return_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

create or replace function public.vehicle_check_out_city(p_vehicle_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v vehicles%ROWTYPE; v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false);
BEGIN
  SELECT * INTO v FROM vehicles WHERE id = p_vehicle_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'This vehicle is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT (v_is_admin OR v.portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE vehicle_city_presence SET is_active = false, checked_out_at = now()
    WHERE vehicle_id = p_vehicle_id AND is_active;
END;
$function$;

create or replace function public.my_weekend_share_offers(p_vehicle_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_is_admin boolean := COALESCE(current_admin_permission('manage_parties'), false); v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.tenant_id = my_tenant_id() AND (v_is_admin OR v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', o.id, 'city_id', o.city_id, 'city_name', c.name, 'city_name_ur', c.name_ur, 'direction', o.direction,
    'day_of_week', o.day_of_week, 'depart_time', o.depart_time, 'seats_total', o.seats_total,
    'seats_taken', o.seats_taken, 'fare_per_seat_pkr', o.fare_per_seat_pkr, 'is_active', o.is_active
  ) ORDER BY o.day_of_week, o.depart_time), '[]'::jsonb)
  INTO v_result FROM weekend_share_offers o JOIN cities c ON c.id = o.city_id WHERE o.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$function$;

create or replace function public.vehicle_hourly_bookings(p_vehicle_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.tenant_id = my_tenant_id() AND (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'hours', b.hours, 'status', b.status, 'pickup_address', b.pickup_address, 'decline_reason', b.decline_reason,
    'base_amount_pkr', b.base_amount_pkr, 'total_amount_pkr', b.total_amount_pkr, 'distance_km', b.distance_km,
    'included_km', b.included_km, 'overage_km', b.overage_km, 'overage_amount_pkr', b.overage_amount_pkr,
    'requested_at', b.requested_at, 'started_at', b.started_at, 'ended_at', b.ended_at, 'status_confirmed', b.status_confirmed,
    'customer_name', pu.full_name, 'customer_mobile', pu.mobile, 'customer_trust', portal_user_trust(pu.id)
  ) ORDER BY b.requested_at DESC), '[]'::jsonb) INTO v_result
  FROM hourly_bookings b JOIN portal_users pu ON pu.id = b.portal_user_id
  WHERE b.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$function$;

create or replace function public.vehicle_shadi_requests(p_vehicle_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.tenant_id = my_tenant_id() AND (COALESCE(current_admin_permission('manage_parties'), false) OR v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'status', r.status, 'decline_reason', r.decline_reason, 'full_day_rate_pkr', r.full_day_rate_pkr, 'advance_share_pkr', r.advance_share_pkr,
    'paid_out_at', r.paid_out_at, 'withdrawn_at', r.withdrawn_at, 'replaces_request_id', r.replaces_request_id,
    'event_id', e.id, 'event_date', e.event_date, 'venue_address', e.venue_address, 'distance_km', e.distance_km, 'notes', e.notes, 'event_status', e.status,
    'customer_name', pu.full_name, 'customer_mobile', pu.mobile, 'customer_trust', portal_user_trust(pu.id)
  ) ORDER BY e.event_date), '[]'::jsonb) INTO v_result
  FROM shadi_vehicle_requests r JOIN shadi_events e ON e.id = r.event_id JOIN portal_users pu ON pu.id = e.portal_user_id
  WHERE r.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$function$;

-- ===== authenticated flows missing a tenant check on an id argument =====

create or replace function public.book_adda_seat(p_entry_id uuid, p_seats integer, p_method character varying, p_proof_url text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  e adda_queue_entries%ROWTYPE; v vehicles%ROWTYPE; v_available int; v_total decimal; v_booking_id uuid;
  v_commission_pct decimal; v_expected_commission decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO e FROM adda_queue_entries WHERE id = p_entry_id AND tenant_id = my_tenant_id();
  IF NOT FOUND OR e.status NOT IN ('waiting', 'current') THEN RAISE EXCEPTION 'This vehicle is no longer taking bookings.' USING ERRCODE = 'P0001'; END IF;
  IF e.fare_mode <> 'fixed' THEN RAISE EXCEPTION 'This vehicle takes ride requests, not fixed-fare bookings — propose a fare instead.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v FROM vehicles WHERE id = e.vehicle_id;
  IF p_seats IS NULL OR p_seats <= 0 THEN RAISE EXCEPTION 'Pick at least one seat.' USING ERRCODE = 'P0001'; END IF;

  v_total := p_seats * e.fixed_fare_per_seat_pkr;

  IF v.commission_mode = 'monthly_lumpsum' THEN
    IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  ELSE
    IF NOT v.is_active THEN RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings.' USING ERRCODE = 'P0001'; END IF;
    v_commission_pct := vehicle_commission_pct(v.vehicle_type, (SELECT classification FROM addas WHERE id = e.adda_id));
    v_expected_commission := round(v_total * v_commission_pct / 100, 2);
    IF seller_account_balance(ensure_vehicle_account(v.id)) < v_expected_commission THEN
      RAISE EXCEPTION 'This vehicle''s wallet balance is too low to cover this booking''s commission — the driver needs to top up first.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_available := adda_entry_seats_available(p_entry_id);
  IF p_seats > v_available THEN RAISE EXCEPTION 'Only % seat(s) left on this vehicle.', v_available USING ERRCODE = 'P0001'; END IF;

  INSERT INTO ride_bookings (adda_queue_entry_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at)
  VALUES (p_entry_id, v_portal_user_id, (now() AT TIME ZONE 'Asia/Karachi')::date, p_seats, v_total, 'announced', v_total, p_method, p_proof_url, now())
  RETURNING id INTO v_booking_id;

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total_amount_pkr', v_total);
END;
$function$;

create or replace function public.place_ride_booking(p_route_id uuid, p_travel_date date, p_seats integer, p_method character varying, p_proof_url text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_route vehicle_routes%ROWTYPE;
  v_vehicle vehicles%ROWTYPE;
  v_available int;
  v_total decimal;
  v_per_seat decimal;
  v_seats_booked_so_far int;
  v_booking_id uuid;
  v_weekday int;
  v_commission_pct decimal;
  v_expected_commission decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id AND tenant_id = my_tenant_id();
  IF NOT FOUND OR NOT v_route.is_active THEN RAISE EXCEPTION 'Route not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = v_route.vehicle_id;
  IF p_seats IS NULL OR p_seats <= 0 THEN RAISE EXCEPTION 'Pick at least one seat.' USING ERRCODE = 'P0001'; END IF;
  IF p_travel_date < (now() AT TIME ZONE 'Asia/Karachi')::date THEN RAISE EXCEPTION 'Pick a date in the future.' USING ERRCODE = 'P0001'; END IF;

  v_weekday := extract(dow FROM p_travel_date)::int;
  IF NOT (v_weekday = ANY(v_route.days_of_week)) THEN
    RAISE EXCEPTION 'This route does not run on that day.' USING ERRCODE = 'P0001';
  END IF;

  v_available := route_seats_available(p_route_id, p_travel_date);
  IF p_seats > v_available THEN
    RAISE EXCEPTION 'Only % seat(s) left on that date.', v_available USING ERRCODE = 'P0001';
  END IF;

  IF v_route.fare_mode = 'flex' THEN
    SELECT COALESCE(SUM(seats), 0) INTO v_seats_booked_so_far FROM ride_bookings
      WHERE route_id = p_route_id AND travel_date = p_travel_date AND status IN ('announced', 'confirmed');
    v_per_seat := v_route.total_fare_pkr / (v_seats_booked_so_far + p_seats);
    v_total := p_seats * v_per_seat;
  ELSE
    v_total := p_seats * v_route.fare_per_seat_pkr;
  END IF;

  IF v_vehicle.commission_mode = 'monthly_lumpsum' THEN
    IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;
  ELSE
    IF NOT v_vehicle.is_active THEN
      RAISE EXCEPTION 'This vehicle is temporarily unable to take new bookings — try another one.' USING ERRCODE = 'P0001';
    END IF;
    v_commission_pct := vehicle_commission_pct(v_vehicle.vehicle_type, v_route.classification);
    v_expected_commission := round(v_total * v_commission_pct / 100, 2);
    IF seller_account_balance(ensure_vehicle_account(v_vehicle.id)) < v_expected_commission THEN
      RAISE EXCEPTION 'This vehicle''s wallet balance is too low to cover this booking''s commission — the driver needs to top up first.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO ride_bookings (route_id, portal_user_id, travel_date, seats, total_amount_pkr, status, announced_amount_pkr, announced_method, announced_proof_url, announced_at)
  VALUES (p_route_id, v_portal_user_id, p_travel_date, p_seats, v_total, 'announced', v_total, p_method, p_proof_url, now())
  RETURNING id INTO v_booking_id;

  RETURN jsonb_build_object('booking_id', v_booking_id, 'total', v_total);
END;
$function$;

create or replace function public.request_pro_service(p_vehicle_id uuid, p_service_class_id uuid, p_city_id uuid, p_is_return boolean)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  sc service_classes%ROWTYPE;
  city cities%ROWTYPE;
  v_allows_out_of_city boolean;
  v_fare decimal;
  v_thread_id uuid;
BEGIN
  SELECT * INTO sc FROM service_classes WHERE id = p_service_class_id AND is_active AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'That service is not available.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO city FROM cities WHERE id = p_city_id AND is_active AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicle_service_offers o WHERE o.vehicle_id = p_vehicle_id AND o.service_class_id = p_service_class_id AND o.is_active) THEN
    RAISE EXCEPTION 'This vehicle does not offer that service.' USING ERRCODE = 'P0001';
  END IF;
  SELECT allows_out_of_city INTO v_allows_out_of_city FROM vehicles WHERE id = p_vehicle_id;
  IF NOT city.is_home_city AND NOT COALESCE(v_allows_out_of_city, false) THEN
    RAISE EXCEPTION 'This vehicle is only set up for the home city — pick a vehicle that does out-of-station trips.' USING ERRCODE = 'P0001';
  END IF;

  v_fare := pro_service_fare(city.distance_km, sc.base_fare_pkr, sc.per_km_pkr, p_is_return);
  v_thread_id := start_negotiation(
    p_kind := 'pro', p_vehicle_id := p_vehicle_id,
    p_item := sc.name || ' · ' || city.name || (CASE WHEN p_is_return THEN ' (return)' ELSE ' (one-way)' END),
    p_qty := NULL, p_budget_pkr := v_fare, p_city_id := p_city_id
  );
  RETURN v_thread_id;
END;
$function$;

create or replace function public.request_share_seat(p_offer_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  o weekend_share_offers%ROWTYPE;
  v_day_name text;
  v_thread_id uuid;
BEGIN
  SELECT * INTO o FROM weekend_share_offers WHERE id = p_offer_id AND is_active AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'This share ride is not available.' USING ERRCODE = 'P0001'; END IF;
  IF o.seats_taken >= o.seats_total THEN RAISE EXCEPTION 'This share ride is full.' USING ERRCODE = 'P0001'; END IF;

  v_day_name := (ARRAY['Sun','Mon','Tue','Wed','Thu','Fri','Sat'])[o.day_of_week + 1];
  v_thread_id := start_negotiation(
    p_kind := 'share', p_vehicle_id := o.vehicle_id,
    p_item := 'Weekend seat · ' || v_day_name || ' · ' || (CASE WHEN o.direction = 'to_village' THEN 'to village' ELSE 'to city' END),
    p_qty := '1 seat', p_budget_pkr := o.fare_per_seat_pkr, p_city_id := o.city_id
  );
  RETURN v_thread_id;
END;
$function$;

create or replace function public.set_commuter_schedule(p_work_city_id uuid, p_home_day smallint, p_back_day smallint)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'You must be signed in.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cities WHERE id = p_work_city_id AND is_active AND tenant_id = my_tenant_id()) THEN
    RAISE EXCEPTION 'That city is not available.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO commuter_schedules (portal_user_id, work_city_id, home_day, back_day)
  VALUES (v_portal_user_id, p_work_city_id, p_home_day, p_back_day)
  ON CONFLICT (portal_user_id) DO UPDATE SET
    work_city_id = EXCLUDED.work_city_id, home_day = EXCLUDED.home_day, back_day = EXCLUDED.back_day,
    is_active = true, updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

create or replace function public.route_seats_available(p_route_id uuid, p_travel_date date)
 returns integer
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT v.total_seats - COALESCE((
    SELECT SUM(rb.seats)::int FROM ride_bookings rb
    WHERE rb.route_id = p_route_id AND rb.travel_date = p_travel_date AND rb.status IN ('announced', 'confirmed')
  ), 0)
  FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id WHERE vr.id = p_route_id AND vr.tenant_id = my_tenant_id();
$function$;

create or replace function public.ride_booking_context(p_booking_id uuid)
 returns TABLE(origin character varying, destination character varying, classification character varying, vehicle_id uuid)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT
    COALESCE(vr.origin, a.name, 'Unknown origin'),
    COALESCE(vr.destination, ap.name, 'Unknown destination'),
    COALESCE(vr.classification, a.classification, 'intercity'),
    COALESCE(vr.vehicle_id, aqe.vehicle_id)
  FROM ride_bookings b
  LEFT JOIN vehicle_routes vr ON vr.id = b.route_id
  LEFT JOIN adda_queue_entries aqe ON aqe.id = b.adda_queue_entry_id
  LEFT JOIN addas a ON a.id = aqe.adda_id
  LEFT JOIN addas ap ON ap.id = a.pair_adda_id
  WHERE b.id = p_booking_id AND b.tenant_id = my_tenant_id();
$function$;

create or replace function public.post_purchase(p_purchase_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_purchase purchases%ROWTYPE;
  v_note text;
  r record;
BEGIN
  SELECT * INTO v_purchase FROM purchases WHERE id = p_purchase_id AND tenant_id = my_tenant_id();
  IF v_purchase.status = 'posted' THEN RETURN; END IF; -- idempotent
  v_note := 'Purchase' || CASE WHEN v_purchase.vendor IS NOT NULL THEN ' from ' || v_purchase.vendor ELSE '' END
    || CASE WHEN v_purchase.note IS NOT NULL AND trim(v_purchase.note) != '' THEN ' — ' || v_purchase.note ELSE '' END;

  FOR r IN SELECT * FROM purchase_line_items WHERE purchase_id = p_purchase_id LOOP
    INSERT INTO inventory_transactions (item_id, txn_type, quantity, unit_cost_at_time, txn_date, method, note, purchase_id)
    VALUES (r.inventory_item_id, 'purchase', r.quantity, r.unit_cost, v_purchase.purchase_date, v_purchase.method, v_note, p_purchase_id);
  END LOOP;

  UPDATE purchases SET status = 'posted' WHERE id = p_purchase_id;
END;
$function$;

-- ===== business-key lookups with no tenant filter =====

create or replace function public.vehicle_commission_pct(p_vehicle_type character varying, p_classification character varying)
 returns numeric
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE v_pct decimal;
BEGIN
  SELECT commission_pct INTO v_pct FROM vehicle_type_commission_rates
    WHERE lower(vehicle_type) = lower(p_vehicle_type) AND classification = p_classification AND tenant_id = my_tenant_id();
  IF v_pct IS NOT NULL THEN RETURN v_pct; END IF;
  RETURN COALESCE((SELECT value::decimal FROM site_settings WHERE key =
    CASE WHEN p_classification = 'intercity' THEN 'marketplace_intercity_commission_pct' ELSE 'marketplace_outofcity_commission_pct' END
    AND tenant_id = my_tenant_id()), 0);
END;
$function$;

create or replace function public.vehicle_bookable(p_vehicle_id uuid)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_vehicle vehicles%ROWTYPE; v_min decimal;
BEGIN
  SELECT * INTO v_vehicle FROM vehicles WHERE id = p_vehicle_id AND tenant_id = my_tenant_id();
  IF NOT FOUND OR NOT v_vehicle.is_active THEN RETURN false; END IF;
  IF v_vehicle.commission_mode = 'monthly_lumpsum' THEN RETURN true; END IF;
  SELECT COALESCE(value::decimal, 0) INTO v_min FROM site_settings WHERE key = 'marketplace_min_balance_to_order_pkr' AND tenant_id = my_tenant_id();
  RETURN seller_account_balance(ensure_vehicle_account(p_vehicle_id)) >= v_min;
END;
$function$;

create or replace function public.announce_shadi_advance(p_event_id uuid, p_method character varying, p_proof_url text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE e shadi_events%ROWTYPE; v_pct decimal; v_amount decimal; v_accepted_count int;
BEGIN
  SELECT * INTO e FROM shadi_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'P0001'; END IF;
  IF e.portal_user_id <> current_portal_user_id() THEN RAISE EXCEPTION 'This is not your booking.' USING ERRCODE = 'P0001'; END IF;
  IF e.status <> 'collecting' THEN RAISE EXCEPTION 'This booking is not awaiting an advance.' USING ERRCODE = 'P0001'; END IF;
  IF p_proof_url IS NULL OR trim(p_proof_url) = '' THEN RAISE EXCEPTION 'Upload your payment slip.' USING ERRCODE = 'P0001'; END IF;

  SELECT count(*) INTO v_accepted_count FROM shadi_vehicle_requests WHERE event_id = p_event_id AND status = 'accepted';
  IF v_accepted_count = 0 THEN RAISE EXCEPTION 'At least one vehicle must accept before you can pay the advance.' USING ERRCODE = 'P0001'; END IF;

  v_pct := COALESCE((SELECT value::decimal FROM site_settings WHERE key = 'marketplace_shadi_advance_pct' AND tenant_id = e.tenant_id), 0);
  -- Fixed by policy, not by the booker — the same "no dispute" principle
  -- as every other formula-priced flow here (client never supplies the
  -- amount that actually gets charged).
  SELECT round(sum(full_day_rate_pkr) * v_pct / 100, 2) INTO v_amount FROM shadi_vehicle_requests WHERE event_id = p_event_id AND status = 'accepted';

  UPDATE shadi_events SET status = 'advance_announced', advance_pct = v_pct, advance_amount_pkr = v_amount,
    advance_method = p_method, advance_proof_url = p_proof_url, advance_announced_at = now(), advance_rejected_reason = NULL
  WHERE id = p_event_id;

  RETURN jsonb_build_object('amount', v_amount, 'pct', v_pct);
END;
$function$;

-- ===== public, pre-login marketplace-browse functions (coalesce fallback) =====

create or replace function public.adda_board(p_adda_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE v_queue_date date := (now() AT TIME ZONE 'Asia/Karachi')::date;
BEGIN
  RETURN (
    SELECT jsonb_build_object(
      'adda', jsonb_build_object('id', a.id, 'name', a.name, 'name_ur', a.name_ur, 'lat', a.lat, 'lng', a.lng, 'turn_minutes', a.turn_minutes),
      'pair_adda', (SELECT jsonb_build_object('id', p.id, 'name', p.name, 'name_ur', p.name_ur, 'lat', p.lat, 'lng', p.lng) FROM addas p WHERE p.id = a.pair_adda_id),
      'entries', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'entry_id', e.id, 'status', e.status, 'position', e.position, 'lap', e.lap,
          'turn_started_at', e.turn_started_at, 'turn_expires_at', e.turn_expires_at,
          'seats_total', e.seats_total, 'seats_available', adda_entry_seats_available(e.id),
          'fare_mode', e.fare_mode, 'fixed_fare_per_seat_pkr', e.fixed_fare_per_seat_pkr, 'trip_offer_id', e.trip_offer_id,
          'vehicle_id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number
        ) ORDER BY (e.status = 'current') DESC, e.position)
        FROM adda_queue_entries e JOIN vehicles v ON v.id = e.vehicle_id
        WHERE e.adda_id = a.id AND e.queue_date = v_queue_date AND e.status IN ('waiting', 'current')
      ), '[]'::jsonb)
    )
    FROM addas a WHERE a.id = p_adda_id AND a.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
  );
END;
$function$;

create or replace function public.adda_entry_seats_available(p_entry_id uuid)
 returns integer
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT e.seats_total - COALESCE((
    SELECT SUM(rb.seats)::int FROM ride_bookings rb
    WHERE rb.adda_queue_entry_id = p_entry_id AND rb.status IN ('announced', 'confirmed')
  ), 0)
  FROM adda_queue_entries e WHERE e.id = p_entry_id AND e.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
$function$;

create or replace function public.nearby_addas(p_lat numeric DEFAULT NULL::numeric, p_lng numeric DEFAULT NULL::numeric, p_radius_km numeric DEFAULT 50)
 returns TABLE(id uuid, name character varying, name_ur character varying, lat numeric, lng numeric, operating_start_time time without time zone, operating_end_time time without time zone, distance_km numeric)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT a.id, a.name, a.name_ur, a.lat, a.lng, a.operating_start_time, a.operating_end_time,
    CASE WHEN p_lat IS NOT NULL AND p_lng IS NOT NULL AND a.lat IS NOT NULL AND a.lng IS NOT NULL THEN
      round((6371 * acos(least(1, greatest(-1,
        cos(radians(p_lat)) * cos(radians(a.lat)) * cos(radians(a.lng) - radians(p_lng))
        + sin(radians(p_lat)) * sin(radians(a.lat))
      ))))::numeric, 1)
    ELSE NULL END AS distance_km
  FROM addas a
  WHERE a.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
    AND a.is_active
    AND (
      p_lat IS NULL OR p_lng IS NULL OR a.lat IS NULL OR a.lng IS NULL
      OR (6371 * acos(least(1, greatest(-1,
          cos(radians(p_lat)) * cos(radians(a.lat)) * cos(radians(a.lng) - radians(p_lng))
          + sin(radians(p_lat)) * sin(radians(a.lat))
        )))) <= p_radius_km
    )
  ORDER BY distance_km ASC NULLS LAST, a.name;
$function$;

create or replace function public.nearby_open_trips(p_destination text DEFAULT NULL::text, p_lat numeric DEFAULT NULL::numeric, p_lng numeric DEFAULT NULL::numeric, p_radius_km numeric DEFAULT 25)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'trip_offer_id', o.id, 'vehicle_id', o.vehicle_id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile,
    'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
    'origin', o.origin, 'origin_ur', o.origin_ur, 'destination', o.destination, 'destination_ur', o.destination_ur,
    'classification', o.classification, 'travel_date', o.travel_date, 'seats_available', o.seats_available,
    'listed_fare_per_seat_pkr', o.listed_fare_per_seat_pkr,
    'lat', l.lat, 'lng', l.lng, 'updated_at', l.updated_at,
    'distance_km', CASE WHEN p_lat IS NOT NULL AND p_lng IS NOT NULL THEN
      round((6371 * acos(least(1, greatest(-1,
        cos(radians(p_lat)) * cos(radians(l.lat)) * cos(radians(l.lng) - radians(p_lng))
        + sin(radians(p_lat)) * sin(radians(l.lat))
      ))))::numeric, 1)
    ELSE NULL END
  ) ORDER BY l.updated_at DESC), '[]'::jsonb)
  FROM vehicle_trip_offers o
  JOIN vehicles v ON v.id = o.vehicle_id
  JOIN vehicle_trip_offer_locations l ON l.trip_offer_id = o.id
  -- The adda this offer was spawned from, if any, and its pin — an
  -- adda-originated offer with no matching live queue entry anymore
  -- (the normal case once departed) still resolves via a plain equality
  -- join on adda_id captured at check-in time, not through the entry row.
  LEFT JOIN LATERAL (
    SELECT a.lat AS origin_lat, a.lng AS origin_lng FROM adda_queue_entries e JOIN addas a ON a.id = e.adda_id
    WHERE e.trip_offer_id = o.id ORDER BY e.created_at DESC LIMIT 1
  ) origin_adda ON true
  WHERE o.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
    AND o.share_live_location
    AND o.travel_date >= (now() AT TIME ZONE 'Asia/Karachi')::date
    AND l.updated_at > now() - interval '5 minutes'
    AND (p_destination IS NULL OR trim(p_destination) = '' OR o.destination ILIKE '%' || p_destination || '%' OR o.destination_ur ILIKE '%' || p_destination || '%')
    AND (p_lat IS NULL OR p_lng IS NULL OR (6371 * acos(least(1, greatest(-1,
        cos(radians(p_lat)) * cos(radians(l.lat)) * cos(radians(l.lng) - radians(p_lng))
        + sin(radians(p_lat)) * sin(radians(l.lat))
      )))) <= p_radius_km)
    -- Not still sitting at the adda he checked in at — see the migration header.
    AND (origin_adda.origin_lat IS NULL OR origin_adda.origin_lng IS NULL OR (6371 * acos(least(1, greatest(-1,
        cos(radians(origin_adda.origin_lat)) * cos(radians(l.lat)) * cos(radians(origin_adda.origin_lng) - radians(l.lng))
        + sin(radians(origin_adda.origin_lat)) * sin(radians(l.lat))
      )))) > 0.3);
$function$;

create or replace function public.hourly_bookable_vehicles()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'color', v.color, 'model', v.model,
    'has_ac', v.has_ac, 'hourly_rate_pkr', v.hourly_rate_pkr, 'hourly_included_km', v.hourly_included_km,
    'hourly_overage_per_km_pkr', v.hourly_overage_per_km_pkr,
    'cover_url', (SELECT m.url FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.is_cover LIMIT 1)
  ) ORDER BY v.owner_name), '[]'::jsonb)
  FROM vehicles v WHERE v.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND v.is_active AND v.offers_hourly AND v.hourly_rate_pkr IS NOT NULL;
$function$;

create or replace function public.shadi_bookable_vehicles()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'color', v.color, 'model', v.model,
    'has_ac', v.has_ac, 'shadi_full_day_rate_pkr', v.shadi_full_day_rate_pkr,
    'cover_url', (SELECT m.url FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.is_cover LIMIT 1)
  ) ORDER BY v.owner_name), '[]'::jsonb)
  FROM vehicles v WHERE v.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND v.is_active AND v.offers_shadi AND v.shadi_full_day_rate_pkr IS NOT NULL;
$function$;

create or replace function public.vehicles_available_for_city(p_city_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE v_is_home boolean; v_tenant uuid := coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
BEGIN
  SELECT is_home_city INTO v_is_home FROM cities WHERE id = p_city_id AND tenant_id = v_tenant;
  RETURN jsonb_build_object(
    'present', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'vehicle_id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number
      ) ORDER BY p.checked_in_at)
      FROM vehicle_city_presence p JOIN vehicles v ON v.id = p.vehicle_id
      WHERE p.city_id = p_city_id AND p.tenant_id = v_tenant AND p.is_active AND v.is_active AND v.delivers AND v.is_online AND vehicle_delivery_eligible(v.id)
    ), '[]'::jsonb),
    'village', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'vehicle_id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number
      ) ORDER BY v.owner_name)
      FROM vehicles v
      WHERE v.tenant_id = v_tenant AND v.is_active AND v.delivers AND v.is_online AND vehicle_delivery_eligible(v.id) AND (v_is_home OR v.allows_out_of_city)
        AND NOT EXISTS (SELECT 1 FROM vehicle_city_presence p WHERE p.vehicle_id = v.id AND p.city_id = p_city_id AND p.is_active)
    ), '[]'::jsonb)
  );
END;
$function$;

create or replace function public.vehicles_offering_service(p_service_class_id uuid)
 returns TABLE(vehicle_id uuid, owner_name character varying, owner_mobile character varying, vehicle_type character varying, vehicle_number character varying, allows_out_of_city boolean)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT v.id, v.owner_name, v.owner_mobile, v.vehicle_type, v.vehicle_number, v.allows_out_of_city
  FROM vehicle_service_offers o JOIN vehicles v ON v.id = o.vehicle_id
  WHERE o.service_class_id = p_service_class_id AND o.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND o.is_active AND v.is_active
  ORDER BY v.owner_name;
$function$;

create or replace function public.vehicles_present_in_city(p_city_id uuid)
 returns TABLE(vehicle_id uuid, owner_name character varying, owner_mobile character varying, vehicle_type character varying, vehicle_number character varying, checked_in_at timestamp with time zone, expected_return_at timestamp with time zone)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT v.id, v.owner_name, v.owner_mobile, v.vehicle_type, v.vehicle_number, p.checked_in_at, p.expected_return_at
  FROM vehicle_city_presence p
  JOIN vehicles v ON v.id = p.vehicle_id
  WHERE p.city_id = p_city_id AND p.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND p.is_active AND v.is_active AND v.delivers AND v.is_online AND vehicle_delivery_eligible(v.id)
  ORDER BY p.checked_in_at ASC;
$function$;

create or replace function public.city_purchase_candidate_vehicles(p_city_id uuid, p_pickup_lat numeric DEFAULT NULL::numeric, p_pickup_lng numeric DEFAULT NULL::numeric)
 returns TABLE(vehicle_id uuid, source character varying, reference_destination text, distance_km numeric, trust_score integer, trust_tier character varying)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  WITH ci AS (SELECT * FROM cities WHERE id = p_city_id AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)),
  today AS (SELECT (now() AT TIME ZONE 'Asia/Karachi')::date AS d),
  floor_score AS (SELECT COALESCE((SELECT value::int FROM site_settings WHERE key = 'vehicle_trust_floor_score' AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)), 15) AS v),
  candidates AS (
    SELECT v.id AS vehicle_id, 'route'::varchar AS source,
      (r.destination || CASE WHEN r.destination_ur IS NOT NULL THEN ' / ' || r.destination_ur ELSE '' END) AS reference_destination,
      CASE WHEN p_pickup_lat IS NOT NULL AND r.destination_lat IS NOT NULL THEN haversine_km(p_pickup_lat, p_pickup_lng, r.destination_lat, r.destination_lng) END AS distance_km,
      1 AS priority
    FROM vehicle_routes r JOIN vehicles v ON v.id = r.vehicle_id, ci, today, floor_score
    WHERE r.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND r.is_active AND v.is_active AND v.is_online AND vehicle_delivery_eligible(v.id) AND vehicle_trust_score(v.id) >= floor_score.v
      AND (r.destination ILIKE '%' || ci.name || '%' OR (ci.name_ur IS NOT NULL AND r.destination_ur ILIKE '%' || ci.name_ur || '%'))
      AND (r.days_of_week && ARRAY[extract(dow FROM today.d)::int, extract(dow FROM today.d + 1)::int])
    UNION ALL
    SELECT v.id, 'trip_offer',
      (o.destination || CASE WHEN o.destination_ur IS NOT NULL THEN ' / ' || o.destination_ur ELSE '' END),
      CASE WHEN p_pickup_lat IS NOT NULL AND o.dest_lat IS NOT NULL THEN haversine_km(p_pickup_lat, p_pickup_lng, o.dest_lat, o.dest_lng) END,
      1
    FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id, ci, today, floor_score
    WHERE o.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND o.status = 'open' AND v.is_active AND v.is_online AND vehicle_delivery_eligible(v.id) AND vehicle_trust_score(v.id) >= floor_score.v
      AND o.travel_date BETWEEN today.d AND today.d + 1
      AND (o.destination ILIKE '%' || ci.name || '%' OR (ci.name_ur IS NOT NULL AND o.destination_ur ILIKE '%' || ci.name_ur || '%'))
    UNION ALL
    SELECT v.id, 'presence', NULL, NULL, 2
    FROM vehicle_city_presence p JOIN vehicles v ON v.id = p.vehicle_id, floor_score
    WHERE p.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND p.city_id = p_city_id AND p.is_active AND v.is_active AND v.is_online AND vehicle_delivery_eligible(v.id) AND vehicle_trust_score(v.id) >= floor_score.v
  )
  SELECT DISTINCT ON (c.vehicle_id) c.vehicle_id, c.source, c.reference_destination, c.distance_km,
    vehicle_trust_score(c.vehicle_id), (vehicle_trust(c.vehicle_id)->>'tier')::varchar
  FROM candidates c
  ORDER BY c.vehicle_id, c.priority;
$function$;
