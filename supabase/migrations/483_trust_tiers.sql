-- Trust tiers, ported from the v2 design handoff (§2.2): the driver's
-- real gap was judging *who is asking* — a request arrived with a name
-- and a number and nothing else. Same rule now reused on the
-- shopkeeper's order cards, per the handoff's own note that both
-- surfaces should judge by the identical rule.
--
-- Score: +30 CNIC verified, +15 phone verified, +20 village resident,
-- +1/completed order capped at 25, -5/cancellation. Tier: verified >=80,
-- partial 40-79, outsider <40.
--
-- Honest gap, not silently faked: this app has no real phone-OTP
-- verification and no no-show tracking anywhere today, so
-- phone_verified defaults false (not true) until staff actually
-- confirm it, and the no-show component of the score is omitted
-- entirely rather than invented from a heuristic. Both are staff-set
-- via the new /admin/user-verification screen, same announce-then-
-- confirm spirit as every other verification flow in this app.
-- "Completed orders" is counted live across shop_orders (delivered),
-- hourly_bookings (completed), ride_bookings (confirmed), and accepted
-- shadi_vehicle_requests — not a stored counter, so it can never drift.
-- "Cancellations" likewise counted live across ride_bookings and
-- hourly_bookings.

ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS cnic_number varchar;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS cnic_verified boolean NOT NULL DEFAULT false;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS phone_verified boolean NOT NULL DEFAULT false;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS is_village_resident boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION portal_user_trust(p_portal_user_id uuid) RETURNS jsonb AS $$
DECLARE
  pu portal_users%ROWTYPE;
  v_completed int;
  v_cancellations int;
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

  v_score := (CASE WHEN pu.cnic_verified THEN 30 ELSE 0 END)
    + (CASE WHEN pu.phone_verified THEN 15 ELSE 0 END)
    + (CASE WHEN pu.is_village_resident THEN 20 ELSE 0 END)
    + least(v_completed, 25)
    - (v_cancellations * 5);
  v_score := greatest(0, least(100, v_score));

  v_tier := CASE WHEN v_score >= 80 THEN 'verified' WHEN v_score >= 40 THEN 'partial' ELSE 'outsider' END;

  RETURN jsonb_build_object(
    'tier', v_tier, 'score', v_score,
    'flags', jsonb_build_array(
      jsonb_build_object('label', 'CNIC', 'ok', pu.cnic_verified),
      jsonb_build_object('label', 'Phone', 'ok', pu.phone_verified),
      jsonb_build_object('label', 'Resident', 'ok', pu.is_village_resident),
      jsonb_build_object('label', 'Orders', 'ok', v_completed > 0, 'value', v_completed)
    )
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
-- Deliberately readable by any authenticated caller (a driver/shopkeeper
-- needs the REQUESTER's trust info, not their own) — nothing it returns
-- is sensitive (no CNIC number, no mobile), only a computed tier/score/
-- flag summary.
GRANT EXECUTE ON FUNCTION portal_user_trust(uuid) TO authenticated;

-- Admin verification screen's own list + toggle.
CREATE OR REPLACE FUNCTION admin_set_portal_user_verification(p_portal_user_id uuid, p_cnic_verified boolean, p_phone_verified boolean, p_is_village_resident boolean) RETURNS void AS $$
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  UPDATE portal_users SET cnic_verified = p_cnic_verified, phone_verified = p_phone_verified, is_village_resident = p_is_village_resident
  WHERE id = p_portal_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION admin_set_portal_user_verification(uuid, boolean, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_set_portal_user_verification(uuid, boolean, boolean, boolean) TO authenticated;

-- Trust alongside each incoming request, for the two highest-value
-- direct-money bookings this session built (hourly, shadi) and the
-- shopkeeper's own order cards — the three surfaces the handoff calls
-- out as the actual gap. Trip-fare-offer and dispatch-invite trust
-- badges are a known remaining item, not done in this pass.
CREATE OR REPLACE FUNCTION vehicle_hourly_bookings(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
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
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION vehicle_shadi_requests(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
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
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Admin's own list for the verification screen — every portal user with
-- their current tier/score, so staff can find who to verify.
CREATE OR REPLACE FUNCTION admin_portal_users_with_trust(p_query text DEFAULT NULL) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', pu.id, 'full_name', pu.full_name, 'mobile', pu.mobile,
    'cnic_verified', pu.cnic_verified, 'phone_verified', pu.phone_verified, 'is_village_resident', pu.is_village_resident,
    'trust', portal_user_trust(pu.id)
  )), '[]'::jsonb) INTO v_result
  FROM (
    SELECT * FROM portal_users pu
    WHERE p_query IS NULL OR trim(p_query) = '' OR pu.full_name ILIKE '%' || p_query || '%' OR pu.mobile ILIKE '%' || p_query || '%'
    ORDER BY pu.full_name LIMIT 100
  ) pu;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION admin_portal_users_with_trust(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_portal_users_with_trust(text) TO authenticated;
