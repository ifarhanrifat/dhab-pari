-- Migration 497: reputation system — complaints, ratings, and a real
-- trust score for vehicles and shops (portal_user_trust, 483, already
-- did this for riders/buyers but only from verification flags +
-- completed-vs-cancelled counts; nothing existed for drivers or
-- shopkeepers, and nothing anywhere used a score to change what the
-- app actually does — TrustPill is purely informational today).
--
-- Two genuinely different mechanisms, not one score, per the design
-- conversation:
--   1. Identity/safety violations (wrong vehicle, wrong driver) are
--      complaints that CAN end in an immediate block once an admin
--      upholds them — not a slow score decay. One person's claim never
--      blocks anything by itself; only current_admin_permission
--      ('manage_parties') resolving the complaint as upheld does.
--   2. Everything else (cancellations, ratings, general complaints,
--      payment-pending) feeds a gradual 0–100 score, same shape as
--      portal_user_trust already uses (extended here to fold in
--      complaints), now built for vehicles and shops too.
--
-- Scope decision, made without asking (per instruction): ratings/trust
-- are wired into the five booking types with an unambiguous two-party
-- structure and a real terminal status already in this schema —
-- dispatch_calls, city_purchase_requests, shop_orders, ride_bookings,
-- vehicle_trip_bookings. hourly_bookings/shadi/adda are the natural
-- next additions via the same submit_rating shape, deliberately
-- deferred rather than guessed at speed.
--
-- Reputation actually changing app behaviour, concretely: a floor
-- score below which a vehicle stops being invited at all (dispatch
-- rings, City Purchase's candidate list) — "stop receiving calls",
-- literally. City Purchase's candidate list (already sorted by
-- distance) now sorts by trust first, distance second — the one place
-- in this app where list ORDER has real user-facing meaning, so it's
-- the one place "gets contacted first" is genuinely implementable
-- without inventing a staged-timing system dispatch's simultaneous
-- ring doesn't have today.

-- ── Complaints ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS party_complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filed_by_portal_user_id uuid REFERENCES portal_users(id),
  filed_by_admin_id uuid REFERENCES admin_users(id),
  against_party_type varchar NOT NULL CHECK (against_party_type IN ('vehicle', 'shop', 'portal_user')),
  against_party_id uuid NOT NULL,
  kind varchar NOT NULL CHECK (kind IN (
    'wrong_vehicle', 'wrong_driver', 'no_show', 'behaviour', 'payment_pending',
    'fake_booking', 'off_platform_solicitation', 'excessive_cancellations', 'other'
  )),
  ref_type varchar, ref_id uuid,
  note text NOT NULL,
  -- wrong_vehicle/wrong_driver are the identity-violation kinds that
  -- can end in an immediate block once upheld — auto-set from `kind`
  -- at filing time, not admin-chosen, so it can't be under- or over-
  -- flagged by whoever resolves it later.
  is_urgent boolean NOT NULL DEFAULT false,
  status varchar NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'upheld', 'dismissed')),
  resolution_note text,
  resolved_by uuid REFERENCES admin_users(id),
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT party_complaints_filer_check CHECK (filed_by_portal_user_id IS NOT NULL OR filed_by_admin_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS party_complaints_against_idx ON party_complaints(against_party_type, against_party_id);
CREATE INDEX IF NOT EXISTS party_complaints_status_idx ON party_complaints(status, created_at DESC);

ALTER TABLE party_complaints ENABLE ROW LEVEL SECURITY;
-- Read: the filer, or an admin — deliberately NOT the party complained
-- about, to avoid a driver/shop retaliating against whoever reported
-- them before the committee has even looked at it.
CREATE POLICY "party_complaints_filer_or_admin_read" ON party_complaints FOR SELECT TO authenticated
  USING (filed_by_portal_user_id = current_portal_user_id() OR COALESCE(current_admin_permission('manage_parties'), false));
-- Writes only via the RPCs below.

CREATE OR REPLACE FUNCTION file_complaint(
  p_against_party_type varchar, p_against_party_id uuid, p_kind varchar, p_note text,
  p_ref_type varchar DEFAULT NULL, p_ref_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_against_party_type NOT IN ('vehicle', 'shop', 'portal_user') THEN RAISE EXCEPTION 'Invalid target.' USING ERRCODE = 'P0001'; END IF;
  IF p_note IS NULL OR trim(p_note) = '' THEN RAISE EXCEPTION 'Describe what happened first.' USING ERRCODE = 'P0001'; END IF;
  IF p_against_party_type = 'vehicle' AND NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_against_party_id) THEN
    RAISE EXCEPTION 'That vehicle is not available.' USING ERRCODE = 'P0001';
  END IF;
  IF p_against_party_type = 'shop' AND NOT EXISTS (SELECT 1 FROM shops WHERE id = p_against_party_id) THEN
    RAISE EXCEPTION 'That shop is not available.' USING ERRCODE = 'P0001';
  END IF;
  IF p_against_party_type = 'portal_user' AND NOT EXISTS (SELECT 1 FROM portal_users WHERE id = p_against_party_id) THEN
    RAISE EXCEPTION 'That person is not available.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO party_complaints (filed_by_portal_user_id, against_party_type, against_party_id, kind, note, ref_type, ref_id, is_urgent)
  VALUES (v_portal_user_id, p_against_party_type, p_against_party_id, p_kind, trim(p_note), p_ref_type, p_ref_id, p_kind IN ('wrong_vehicle', 'wrong_driver'))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION file_complaint(varchar, uuid, varchar, text, varchar, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION file_complaint(varchar, uuid, varchar, text, varchar, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION admin_list_complaints(p_status varchar DEFAULT NULL) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'kind', c.kind, 'note', c.note, 'is_urgent', c.is_urgent, 'status', c.status,
    'against_party_type', c.against_party_type, 'against_party_id', c.against_party_id,
    'against_name', CASE c.against_party_type
      WHEN 'vehicle' THEN (SELECT owner_name FROM vehicles WHERE id = c.against_party_id)
      WHEN 'shop' THEN (SELECT name FROM shops WHERE id = c.against_party_id)
      WHEN 'portal_user' THEN (SELECT full_name FROM portal_users WHERE id = c.against_party_id)
    END,
    'filed_by_name', COALESCE(
      (SELECT full_name FROM portal_users WHERE id = c.filed_by_portal_user_id),
      (SELECT full_name FROM admin_users WHERE id = c.filed_by_admin_id)
    ),
    'ref_type', c.ref_type, 'ref_id', c.ref_id, 'resolution_note', c.resolution_note, 'resolved_at', c.resolved_at,
    'created_at', c.created_at
  ) ORDER BY c.is_urgent DESC, c.created_at DESC), '[]'::jsonb)
  FROM party_complaints c
  WHERE current_admin_permission('manage_parties') AND (p_status IS NULL OR c.status = p_status);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION admin_list_complaints(varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_list_complaints(varchar) TO authenticated;

CREATE OR REPLACE FUNCTION admin_resolve_complaint(p_complaint_id uuid, p_status varchar, p_resolution_note text DEFAULT NULL, p_block boolean DEFAULT false) RETURNS void AS $$
DECLARE c party_complaints%ROWTYPE;
BEGIN
  IF NOT current_admin_permission('manage_parties') THEN RAISE EXCEPTION 'You do not have permission to do this.' USING ERRCODE = 'P0001'; END IF;
  IF p_status NOT IN ('upheld', 'dismissed') THEN RAISE EXCEPTION 'Invalid status.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO c FROM party_complaints WHERE id = p_complaint_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint not found.' USING ERRCODE = 'P0001'; END IF;
  IF c.status <> 'open' THEN RAISE EXCEPTION 'This complaint was already resolved.' USING ERRCODE = 'P0001'; END IF;

  UPDATE party_complaints SET status = p_status, resolution_note = NULLIF(p_resolution_note, ''), resolved_by = current_admin_user_id(), resolved_at = now()
  WHERE id = p_complaint_id;

  -- The one place a complaint can immediately act on the system, not
  -- just score it: an upheld wrong-vehicle/wrong-driver report,
  -- explicitly confirmed by an admin, blocks the vehicle the same way
  -- the admin panel's own block button does.
  IF p_status = 'upheld' AND p_block AND c.against_party_type = 'vehicle' THEN
    UPDATE vehicles SET is_active = false WHERE id = c.against_party_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION admin_resolve_complaint(uuid, varchar, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_resolve_complaint(uuid, varchar, text, boolean) TO authenticated;

-- ── Ratings ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_type varchar NOT NULL CHECK (ref_type IN ('dispatch_call', 'city_purchase_request', 'shop_order', 'ride_booking', 'trip_booking')),
  ref_id uuid NOT NULL,
  rater_party_type varchar NOT NULL CHECK (rater_party_type IN ('portal_user', 'vehicle', 'shop')),
  rater_party_id uuid NOT NULL,
  target_party_type varchar NOT NULL CHECK (target_party_type IN ('portal_user', 'vehicle', 'shop')),
  target_party_id uuid NOT NULL,
  stars int NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment text,
  created_at timestamptz DEFAULT now(),
  UNIQUE (ref_type, ref_id, rater_party_type, rater_party_id)
);
CREATE INDEX IF NOT EXISTS ratings_target_idx ON ratings(target_party_type, target_party_id);

ALTER TABLE ratings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ratings_party_or_admin_read" ON ratings FOR SELECT TO authenticated USING (
  COALESCE(current_admin_permission('manage_parties'), false)
  OR (rater_party_type = 'portal_user' AND rater_party_id = current_portal_user_id())
  OR (target_party_type = 'portal_user' AND target_party_id = current_portal_user_id())
  OR (rater_party_type = 'vehicle' AND EXISTS (SELECT 1 FROM vehicles WHERE id = rater_party_id AND portal_user_id = current_portal_user_id()))
  OR (target_party_type = 'vehicle' AND EXISTS (SELECT 1 FROM vehicles WHERE id = target_party_id AND portal_user_id = current_portal_user_id()))
  OR (rater_party_type = 'shop' AND user_manages_shop(rater_party_id))
  OR (target_party_type = 'shop' AND user_manages_shop(target_party_id))
);

-- Resolves both parties itself from the ref row rather than trusting a
-- client-supplied target — the same reasoning migration 491's own
-- comment already gives for not trusting a typed phone number: never
-- let the caller assert who they're rating, only who they *are*.
CREATE OR REPLACE FUNCTION submit_rating(p_ref_type varchar, p_ref_id uuid, p_stars int, p_comment text DEFAULT NULL) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_customer_portal_user_id uuid; v_provider_type varchar; v_provider_id uuid; v_terminal boolean := false;
  v_rater_type varchar; v_rater_id uuid; v_target_type varchar; v_target_id uuid; v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_stars IS NULL OR p_stars < 1 OR p_stars > 5 THEN RAISE EXCEPTION 'Pick 1 to 5 stars.' USING ERRCODE = 'P0001'; END IF;

  IF p_ref_type = 'dispatch_call' THEN
    SELECT initiator_portal_user_id, accepted_vehicle_id, (status = 'completed') INTO v_customer_portal_user_id, v_provider_id, v_terminal FROM dispatch_calls WHERE id = p_ref_id;
    v_provider_type := 'vehicle';
  ELSIF p_ref_type = 'city_purchase_request' THEN
    SELECT initiator_portal_user_id, accepted_vehicle_id, (status = 'completed') INTO v_customer_portal_user_id, v_provider_id, v_terminal FROM city_purchase_requests WHERE id = p_ref_id;
    v_provider_type := 'vehicle';
  ELSIF p_ref_type = 'shop_order' THEN
    SELECT portal_user_id, shop_id, (fulfillment_status = 'delivered') INTO v_customer_portal_user_id, v_provider_id, v_terminal FROM shop_orders WHERE id = p_ref_id;
    v_provider_type := 'shop';
  ELSIF p_ref_type = 'ride_booking' THEN
    SELECT rb.portal_user_id, vr.vehicle_id, (rb.status = 'confirmed')
      INTO v_customer_portal_user_id, v_provider_id, v_terminal
      FROM ride_bookings rb JOIN vehicle_routes vr ON vr.id = rb.route_id WHERE rb.id = p_ref_id;
    v_provider_type := 'vehicle';
  ELSIF p_ref_type = 'trip_booking' THEN
    SELECT portal_user_id, vehicle_id, (status = 'completed') INTO v_customer_portal_user_id, v_provider_id, v_terminal FROM vehicle_trip_bookings WHERE id = p_ref_id;
    v_provider_type := 'vehicle';
  ELSE
    RAISE EXCEPTION 'This can''t be rated.' USING ERRCODE = 'P0001';
  END IF;

  IF v_customer_portal_user_id IS NULL THEN RAISE EXCEPTION 'Not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT v_terminal THEN RAISE EXCEPTION 'This can only be rated once it''s finished.' USING ERRCODE = 'P0001'; END IF;

  IF v_portal_user_id = v_customer_portal_user_id THEN
    v_rater_type := 'portal_user'; v_rater_id := v_portal_user_id;
    v_target_type := v_provider_type; v_target_id := v_provider_id;
  ELSIF v_provider_type = 'vehicle' AND EXISTS (SELECT 1 FROM vehicles WHERE id = v_provider_id AND portal_user_id = v_portal_user_id) THEN
    v_rater_type := 'vehicle'; v_rater_id := v_provider_id;
    v_target_type := 'portal_user'; v_target_id := v_customer_portal_user_id;
  ELSIF v_provider_type = 'shop' AND user_manages_shop(v_provider_id) THEN
    v_rater_type := 'shop'; v_rater_id := v_provider_id;
    v_target_type := 'portal_user'; v_target_id := v_customer_portal_user_id;
  ELSE
    RAISE EXCEPTION 'You are not part of this.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO ratings (ref_type, ref_id, rater_party_type, rater_party_id, target_party_type, target_party_id, stars, comment)
  VALUES (p_ref_type, p_ref_id, v_rater_type, v_rater_id, v_target_type, v_target_id, p_stars, NULLIF(p_comment, ''))
  ON CONFLICT (ref_type, ref_id, rater_party_type, rater_party_id) DO UPDATE SET stars = excluded.stars, comment = excluded.comment
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION submit_rating(varchar, uuid, int, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION submit_rating(varchar, uuid, int, text) TO authenticated;

-- Read helper for "have I already rated this" — lets a screen hide the
-- rating widget instead of silently overwriting a prior rating.
CREATE OR REPLACE FUNCTION my_rating_for(p_ref_type varchar, p_ref_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object('stars', r.stars, 'comment', r.comment)
  FROM ratings r
  WHERE r.ref_type = p_ref_type AND r.ref_id = p_ref_id
    AND (
      (r.rater_party_type = 'portal_user' AND r.rater_party_id = current_portal_user_id())
      OR (r.rater_party_type = 'vehicle' AND EXISTS (SELECT 1 FROM vehicles WHERE id = r.rater_party_id AND portal_user_id = current_portal_user_id()))
      OR (r.rater_party_type = 'shop' AND user_manages_shop(r.rater_party_id))
    )
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION my_rating_for(varchar, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_rating_for(varchar, uuid) TO authenticated;

-- ── Trust scores: vehicles and shops (portal_user_trust, 483, already
-- covers riders/buyers) ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION vehicle_trust(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE
  v_completed int; v_cancellations int; v_avg_stars decimal; v_rating_count int;
  v_complaints int; v_urgent_upheld int; v_score int; v_tier varchar;
BEGIN
  SELECT
    (SELECT count(*) FROM dispatch_calls WHERE accepted_vehicle_id = p_vehicle_id AND status = 'completed')
    + (SELECT count(*) FROM city_purchase_requests WHERE accepted_vehicle_id = p_vehicle_id AND status = 'completed')
    + (SELECT count(*) FROM vehicle_trip_bookings WHERE vehicle_id = p_vehicle_id AND status = 'completed')
    + (SELECT count(*) FROM ride_bookings rb JOIN vehicle_routes vr ON vr.id = rb.route_id WHERE vr.vehicle_id = p_vehicle_id AND rb.status = 'confirmed')
  INTO v_completed;

  SELECT
    (SELECT count(*) FROM dispatch_calls WHERE accepted_vehicle_id = p_vehicle_id AND status = 'cancelled')
    + (SELECT count(*) FROM city_purchase_requests WHERE accepted_vehicle_id = p_vehicle_id AND status = 'cancelled')
    + (SELECT count(*) FROM vehicle_trip_bookings WHERE vehicle_id = p_vehicle_id AND status = 'cancelled')
  INTO v_cancellations;

  SELECT avg(stars), count(*) INTO v_avg_stars, v_rating_count FROM ratings WHERE target_party_type = 'vehicle' AND target_party_id = p_vehicle_id;
  SELECT count(*) FILTER (WHERE status <> 'dismissed'), count(*) FILTER (WHERE is_urgent AND status = 'upheld')
    INTO v_complaints, v_urgent_upheld
    FROM party_complaints WHERE against_party_type = 'vehicle' AND against_party_id = p_vehicle_id;

  -- Neutral base of 50; ratings pull it up/down around a 3-star centre
  -- (so nobody starts "bad" just for having zero ratings yet); capped
  -- contributions from volume so one very active vehicle doesn't
  -- permanently max out regardless of quality; complaints subtract
  -- harder than a plain cancellation, an upheld urgent one (wrong
  -- vehicle/driver) hardest of all — matching the "identity violations
  -- hit harder than ordinary quality issues" split from the design
  -- conversation, even within this one gradual number.
  v_score := 50
    + COALESCE(round((v_avg_stars - 3) * 10), 0)
    + least(v_completed, 30)
    - (v_cancellations * 5)
    - (v_complaints * 8)
    - (v_urgent_upheld * 25);
  v_score := greatest(0, least(100, v_score));
  v_tier := CASE WHEN v_score >= 70 THEN 'trusted' WHEN v_score >= 40 THEN 'normal' ELSE 'low' END;

  RETURN jsonb_build_object(
    'score', v_score, 'tier', v_tier, 'completed', v_completed, 'cancellations', v_cancellations,
    'avg_stars', round(COALESCE(v_avg_stars, 0)::numeric, 1), 'rating_count', COALESCE(v_rating_count, 0),
    'complaints', v_complaints, 'urgent_upheld', v_urgent_upheld
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_trust(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_trust(uuid) TO authenticated;

-- Plain-int extraction — the two ring/candidate-list callers below need
-- a sortable/comparable number, not the full breakdown, and this keeps
-- the one real scoring formula in vehicle_trust rather than duplicated.
CREATE OR REPLACE FUNCTION vehicle_trust_score(p_vehicle_id uuid) RETURNS int AS $$
  SELECT (vehicle_trust(p_vehicle_id)->>'score')::int;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_trust_score(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_trust_score(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION shop_trust(p_shop_id uuid) RETURNS jsonb AS $$
DECLARE v_completed int; v_rejected int; v_avg_stars decimal; v_rating_count int; v_complaints int; v_score int; v_tier varchar;
BEGIN
  SELECT count(*) FILTER (WHERE fulfillment_status = 'delivered'), count(*) FILTER (WHERE status = 'rejected')
    INTO v_completed, v_rejected FROM shop_orders WHERE shop_id = p_shop_id;
  SELECT avg(stars), count(*) INTO v_avg_stars, v_rating_count FROM ratings WHERE target_party_type = 'shop' AND target_party_id = p_shop_id;
  SELECT count(*) FILTER (WHERE status <> 'dismissed') INTO v_complaints FROM party_complaints WHERE against_party_type = 'shop' AND against_party_id = p_shop_id;

  v_score := 50 + COALESCE(round((v_avg_stars - 3) * 10), 0) + least(v_completed, 30) - (v_rejected * 5) - (v_complaints * 8);
  v_score := greatest(0, least(100, v_score));
  v_tier := CASE WHEN v_score >= 70 THEN 'trusted' WHEN v_score >= 40 THEN 'normal' ELSE 'low' END;

  RETURN jsonb_build_object(
    'score', v_score, 'tier', v_tier, 'completed', v_completed, 'rejected', v_rejected,
    'avg_stars', round(COALESCE(v_avg_stars, 0)::numeric, 1), 'rating_count', COALESCE(v_rating_count, 0), 'complaints', v_complaints
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION shop_trust(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION shop_trust(uuid) TO authenticated;

-- portal_user_trust (483) — same signature, folding in complaints
-- filed against this rider/buyer (previously only verification flags
-- and completed-vs-cancelled counts).
CREATE OR REPLACE FUNCTION portal_user_trust(p_portal_user_id uuid) RETURNS jsonb AS $$
DECLARE
  pu portal_users%ROWTYPE;
  v_completed int;
  v_cancellations int;
  v_complaints int;
  v_score int;
  v_tier varchar;
BEGIN
  SELECT * INTO pu FROM portal_users WHERE id = p_portal_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('tier', 'outsider', 'score', 0, 'flags', '[]'::jsonb); END IF;

  SELECT
    (SELECT count(*) FROM shop_orders WHERE portal_user_id = p_portal_user_id AND fulfillment_status = 'delivered')
    + (SELECT count(*) FROM hourly_bookings WHERE portal_user_id = p_portal_user_id AND status = 'completed')
    + (SELECT count(*) FROM ride_bookings WHERE portal_user_id = p_portal_user_id AND status = 'confirmed')
    + (SELECT count(*) FROM shadi_vehicle_requests r JOIN shadi_events e ON e.id = r.event_id WHERE e.portal_user_id = p_portal_user_id AND r.status = 'accepted')
  INTO v_completed;

  SELECT
    (SELECT count(*) FROM ride_bookings WHERE portal_user_id = p_portal_user_id AND status = 'cancelled')
    + (SELECT count(*) FROM hourly_bookings WHERE portal_user_id = p_portal_user_id AND status = 'cancelled')
  INTO v_cancellations;

  SELECT count(*) FILTER (WHERE status <> 'dismissed') INTO v_complaints FROM party_complaints WHERE against_party_type = 'portal_user' AND against_party_id = p_portal_user_id;

  v_score := (CASE WHEN pu.cnic_verified THEN 30 ELSE 0 END)
    + (CASE WHEN pu.phone_verified THEN 15 ELSE 0 END)
    + (CASE WHEN pu.is_village_resident THEN 20 ELSE 0 END)
    + least(v_completed, 25)
    - (v_cancellations * 5)
    - (v_complaints * 8);
  v_score := greatest(0, least(100, v_score));

  v_tier := CASE WHEN v_score >= 80 THEN 'verified' WHEN v_score >= 40 THEN 'partial' ELSE 'outsider' END;

  RETURN jsonb_build_object(
    'tier', v_tier, 'score', v_score,
    'flags', jsonb_build_array(
      jsonb_build_object('label', 'CNIC', 'ok', pu.cnic_verified),
      jsonb_build_object('label', 'Phone', 'ok', pu.phone_verified),
      jsonb_build_object('label', 'Resident', 'ok', pu.is_village_resident),
      jsonb_build_object('label', 'Orders', 'ok', v_completed > 0, 'value', v_completed)
    ),
    'complaints', v_complaints
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION portal_user_trust(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION portal_user_trust(uuid) TO authenticated;

-- Bulk lookup for the admin vehicles list ("rating in front of each
-- vehicle" — computing one at a time from the frontend would be one
-- round trip per row).
CREATE OR REPLACE FUNCTION vehicle_trust_bulk(p_vehicle_ids uuid[]) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_object_agg(v.id, vehicle_trust(v.id)), '{}'::jsonb)
  FROM vehicles v WHERE v.id = ANY(p_vehicle_ids) AND current_admin_permission('manage_parties');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_trust_bulk(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_trust_bulk(uuid[]) TO authenticated;

-- ── Reputation floor, admin-tunable ─────────────────────────────────
INSERT INTO site_settings (key, value, description) VALUES
  ('vehicle_trust_floor_score', '15', 'A vehicle scoring below this (0-100) stops receiving new dispatch/city-purchase invitations entirely')
ON CONFLICT (key) DO NOTHING;

-- invite_dispatch_tier (494's version) — same signature, floor added.
CREATE OR REPLACE FUNCTION invite_dispatch_tier(p_call_id uuid, p_tier int) RETURNS int AS $$
DECLARE v_city_id uuid; v_city_is_home boolean; v_count int; v_floor int;
BEGIN
  SELECT COALESCE(value::int, 15) INTO v_floor FROM site_settings WHERE key = 'vehicle_trust_floor_score';
  SELECT s.city_id, ci.is_home_city INTO v_city_id, v_city_is_home
  FROM dispatch_calls c JOIN city_shops s ON s.id = c.city_shop_id JOIN cities ci ON ci.id = s.city_id
  WHERE c.id = p_call_id;

  INSERT INTO dispatch_invitations (call_id, vehicle_id, tier)
  SELECT p_call_id, v.id, p_tier
  FROM vehicles v
  WHERE v.is_active AND v.delivers AND v.is_online AND vehicle_delivery_eligible(v.id)
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- city_purchase_candidate_vehicles (496's version) — same arguments,
-- but the RETURNS TABLE column list is growing two columns (trust_score,
-- trust_tier), and Postgres refuses to CREATE OR REPLACE a function
-- whose return type changed, even with identical arguments — dropped
-- explicitly first, same discipline as every argument-signature change
-- elsewhere in this migration history, just for the return side instead.
DROP FUNCTION IF EXISTS city_purchase_candidate_vehicles(uuid, decimal, decimal);
CREATE OR REPLACE FUNCTION city_purchase_candidate_vehicles(p_city_id uuid, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL)
RETURNS TABLE(vehicle_id uuid, source varchar, reference_destination text, distance_km decimal, trust_score int, trust_tier varchar) AS $$
  WITH ci AS (SELECT * FROM cities WHERE id = p_city_id),
  today AS (SELECT (now() AT TIME ZONE 'Asia/Karachi')::date AS d),
  floor_score AS (SELECT COALESCE((SELECT value::int FROM site_settings WHERE key = 'vehicle_trust_floor_score'), 15) AS v),
  candidates AS (
    SELECT v.id AS vehicle_id, 'route'::varchar AS source,
      (r.destination || CASE WHEN r.destination_ur IS NOT NULL THEN ' / ' || r.destination_ur ELSE '' END) AS reference_destination,
      CASE WHEN p_pickup_lat IS NOT NULL AND r.destination_lat IS NOT NULL THEN haversine_km(p_pickup_lat, p_pickup_lng, r.destination_lat, r.destination_lng) END AS distance_km,
      1 AS priority
    FROM vehicle_routes r JOIN vehicles v ON v.id = r.vehicle_id, ci, today, floor_score
    WHERE r.is_active AND v.is_active AND v.is_online AND vehicle_delivery_eligible(v.id) AND vehicle_trust_score(v.id) >= floor_score.v
      AND (r.destination ILIKE '%' || ci.name || '%' OR (ci.name_ur IS NOT NULL AND r.destination_ur ILIKE '%' || ci.name_ur || '%'))
      AND (r.days_of_week && ARRAY[extract(dow FROM today.d)::int, extract(dow FROM today.d + 1)::int])
    UNION ALL
    SELECT v.id, 'trip_offer',
      (o.destination || CASE WHEN o.destination_ur IS NOT NULL THEN ' / ' || o.destination_ur ELSE '' END),
      CASE WHEN p_pickup_lat IS NOT NULL AND o.dest_lat IS NOT NULL THEN haversine_km(p_pickup_lat, p_pickup_lng, o.dest_lat, o.dest_lng) END,
      1
    FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id, ci, today, floor_score
    WHERE o.status = 'open' AND v.is_active AND v.is_online AND vehicle_delivery_eligible(v.id) AND vehicle_trust_score(v.id) >= floor_score.v
      AND o.travel_date BETWEEN today.d AND today.d + 1
      AND (o.destination ILIKE '%' || ci.name || '%' OR (ci.name_ur IS NOT NULL AND o.destination_ur ILIKE '%' || ci.name_ur || '%'))
    UNION ALL
    SELECT v.id, 'presence', NULL, NULL, 2
    FROM vehicle_city_presence p JOIN vehicles v ON v.id = p.vehicle_id, floor_score
    WHERE p.city_id = p_city_id AND p.is_active AND v.is_active AND v.is_online AND vehicle_delivery_eligible(v.id) AND vehicle_trust_score(v.id) >= floor_score.v
  )
  SELECT DISTINCT ON (c.vehicle_id) c.vehicle_id, c.source, c.reference_destination, c.distance_km,
    vehicle_trust_score(c.vehicle_id), (vehicle_trust(c.vehicle_id)->>'tier')::varchar
  FROM candidates c
  ORDER BY c.vehicle_id, c.priority;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION city_purchase_candidate_vehicles(uuid, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_purchase_candidate_vehicles(uuid, decimal, decimal) TO authenticated;

-- city_purchase_candidates (496's version) — same signature; now sorts
-- trust first, distance second, and surfaces both to the villager.
CREATE OR REPLACE FUNCTION city_purchase_candidates(p_city_id uuid, p_pickup_lat decimal DEFAULT NULL, p_pickup_lng decimal DEFAULT NULL) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'vehicle_id', v.id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile, 'vehicle_type', v.vehicle_type,
    'source', c.source, 'reference_destination', c.reference_destination, 'distance_km', c.distance_km,
    'trust_score', c.trust_score, 'trust_tier', c.trust_tier
  ) ORDER BY c.trust_score DESC, c.distance_km NULLS LAST, c.source, v.owner_name), '[]'::jsonb)
  FROM city_purchase_candidate_vehicles(p_city_id, p_pickup_lat, p_pickup_lng) c JOIN vehicles v ON v.id = c.vehicle_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION city_purchase_candidates(uuid, decimal, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION city_purchase_candidates(uuid, decimal, decimal) TO authenticated;
