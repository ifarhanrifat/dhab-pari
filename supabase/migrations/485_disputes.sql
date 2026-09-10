-- Disputes queue, per the v2 design handoff (§2.5 item 4): "Your
-- mockups have five places where the two sides can disagree about
-- money (fare claimed vs agreed, damaged goods, no-show, shadi
-- withdrawal, hourly overage) and no screen where the committee
-- settles it." This is that screen plus the filing side of it.
--
-- Scope decision, made without the user (asleep, per their own
-- instruction) rather than left undone: rather than build five
-- bespoke dispute forms, one generic table + one filing RPC covers
-- all five kinds, keyed by (ref_type, ref_id) the same way
-- negotiation_threads already generalizes across kinds. Filing UI
-- is wired onto the one surface that most naturally needs it tonight
-- (shop order tracking, since "damaged goods" / "never arrived" is
-- exactly what that screen already shows state for) — hourly and
-- shadi's own pending/active screens are the obvious next places to
-- add the same <ReportProblemButton>, deliberately left for a
-- daylight decision on wording per surface rather than guessed here.

CREATE TABLE IF NOT EXISTS disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind varchar NOT NULL CHECK (kind IN ('fare_dispute', 'damaged_goods', 'no_show', 'shadi_withdrawal', 'hourly_overage')),
  ref_type varchar NOT NULL CHECK (ref_type IN ('shop_order', 'hourly_booking', 'shadi_request', 'trip_offer')),
  ref_id uuid NOT NULL,
  filed_by_portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  claimed_amount_pkr decimal CHECK (claimed_amount_pkr IS NULL OR claimed_amount_pkr >= 0),
  -- Best-effort, auto-derived from the ref at filing time (order total,
  -- hourly total, shadi advance share) — a reference point for the
  -- committee, not itself disputed.
  agreed_amount_pkr decimal,
  note text NOT NULL,
  status varchar NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  ruling varchar CHECK (ruling IN ('rider', 'driver')),
  resolution_note text,
  created_at timestamptz DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES admin_users(id)
);
CREATE INDEX IF NOT EXISTS disputes_status_idx ON disputes(status, created_at DESC);
CREATE INDEX IF NOT EXISTS disputes_ref_idx ON disputes(ref_type, ref_id);

ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "disputes_admin_read" ON disputes FOR SELECT TO authenticated
  USING (current_admin_permission('manage_parties') OR filed_by_portal_user_id = current_portal_user_id());
-- No client INSERT/UPDATE policy — filing goes through file_dispute()
-- (so authorization against the actual ref is checked server-side, not
-- trusted from the client), resolving through admin_resolve_dispute().

CREATE OR REPLACE FUNCTION file_dispute(
  p_kind varchar, p_ref_type varchar, p_ref_id uuid, p_claimed_amount_pkr decimal, p_note text
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_is_party boolean := false;
  v_agreed decimal;
  v_dispute_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  IF p_note IS NULL OR trim(p_note) = '' THEN RAISE EXCEPTION 'A note is required' USING ERRCODE = 'P0001'; END IF;

  IF p_ref_type = 'shop_order' THEN
    SELECT (o.portal_user_id = v_portal_user_id OR v.portal_user_id = v_portal_user_id), o.total_amount_pkr
      INTO v_is_party, v_agreed
      FROM shop_orders o LEFT JOIN vehicles v ON v.id = o.delivery_vehicle_id
      WHERE o.id = p_ref_id;
  ELSIF p_ref_type = 'hourly_booking' THEN
    SELECT (b.portal_user_id = v_portal_user_id OR v.portal_user_id = v_portal_user_id), coalesce(b.total_amount_pkr, b.base_amount_pkr)
      INTO v_is_party, v_agreed
      FROM hourly_bookings b JOIN vehicles v ON v.id = b.vehicle_id
      WHERE b.id = p_ref_id;
  ELSIF p_ref_type = 'shadi_request' THEN
    SELECT (e.portal_user_id = v_portal_user_id OR v.portal_user_id = v_portal_user_id), r.advance_share_pkr
      INTO v_is_party, v_agreed
      FROM shadi_vehicle_requests r JOIN shadi_events e ON e.id = r.event_id JOIN vehicles v ON v.id = r.vehicle_id
      WHERE r.id = p_ref_id;
  ELSIF p_ref_type = 'trip_offer' THEN
    SELECT (v.portal_user_id = v_portal_user_id OR EXISTS (SELECT 1 FROM vehicle_trip_fare_offers f WHERE f.trip_offer_id = o.id AND f.portal_user_id = v_portal_user_id)), o.listed_fare_per_seat_pkr
      INTO v_is_party, v_agreed
      FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id
      WHERE o.id = p_ref_id;
  END IF;

  IF NOT COALESCE(v_is_party, false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO disputes (kind, ref_type, ref_id, filed_by_portal_user_id, claimed_amount_pkr, agreed_amount_pkr, note)
  VALUES (p_kind, p_ref_type, p_ref_id, v_portal_user_id, p_claimed_amount_pkr, v_agreed, trim(p_note))
  RETURNING id INTO v_dispute_id;

  RETURN v_dispute_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION file_dispute(varchar, varchar, uuid, decimal, text) TO authenticated;

-- Admin listing — enough context per row (who filed, what for) without
-- a five-way join fan-out in the client; ref_type-specific display
-- fields are folded into one jsonb 'ref_summary' the admin screen reads
-- generically.
CREATE OR REPLACE FUNCTION admin_list_disputes(p_status varchar DEFAULT 'open') RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;

  SELECT coalesce(jsonb_agg(row ORDER BY (row->>'created_at') DESC), '[]'::jsonb) INTO v_result FROM (
    SELECT jsonb_build_object(
      'id', d.id, 'kind', d.kind, 'ref_type', d.ref_type, 'ref_id', d.ref_id,
      'claimed_amount_pkr', d.claimed_amount_pkr, 'agreed_amount_pkr', d.agreed_amount_pkr,
      'note', d.note, 'status', d.status, 'ruling', d.ruling, 'resolution_note', d.resolution_note,
      'created_at', d.created_at, 'resolved_at', d.resolved_at,
      'filed_by_name', pu.full_name, 'filed_by_mobile', pu.mobile,
      'ref_summary', CASE d.ref_type
        WHEN 'shop_order' THEN (SELECT jsonb_build_object('shop_name', s.name, 'vehicle_owner', v.owner_name) FROM shop_orders o LEFT JOIN shops s ON s.id = o.shop_id LEFT JOIN vehicles v ON v.id = o.delivery_vehicle_id WHERE o.id = d.ref_id)
        WHEN 'hourly_booking' THEN (SELECT jsonb_build_object('vehicle_owner', v.owner_name, 'hours', b.hours) FROM hourly_bookings b LEFT JOIN vehicles v ON v.id = b.vehicle_id WHERE b.id = d.ref_id)
        WHEN 'shadi_request' THEN (SELECT jsonb_build_object('vehicle_owner', v.owner_name, 'event_date', e.event_date) FROM shadi_vehicle_requests r LEFT JOIN vehicles v ON v.id = r.vehicle_id LEFT JOIN shadi_events e ON e.id = r.event_id WHERE r.id = d.ref_id)
        WHEN 'trip_offer' THEN (SELECT jsonb_build_object('vehicle_owner', v.owner_name, 'origin', o.origin, 'destination', o.destination) FROM vehicle_trip_offers o LEFT JOIN vehicles v ON v.id = o.vehicle_id WHERE o.id = d.ref_id)
        ELSE NULL
      END
    ) AS row
    FROM disputes d
    LEFT JOIN portal_users pu ON pu.id = d.filed_by_portal_user_id
    WHERE p_status IS NULL OR d.status = p_status
    LIMIT 200
  ) rows;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE;
GRANT EXECUTE ON FUNCTION admin_list_disputes(varchar) TO authenticated;

CREATE OR REPLACE FUNCTION admin_resolve_dispute(p_dispute_id uuid, p_ruling varchar, p_resolution_note text) RETURNS void AS $$
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  IF p_ruling NOT IN ('rider', 'driver') THEN RAISE EXCEPTION 'Invalid ruling' USING ERRCODE = 'P0001'; END IF;

  UPDATE disputes SET
    status = 'closed', ruling = p_ruling, resolution_note = p_resolution_note,
    resolved_at = now(), resolved_by = current_admin_user_id()
  WHERE id = p_dispute_id AND status = 'open';

  IF NOT FOUND THEN RAISE EXCEPTION 'Dispute not open' USING ERRCODE = 'P0001'; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION admin_resolve_dispute(uuid, varchar, text) TO authenticated;
