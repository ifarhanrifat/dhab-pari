-- Migration 949: real gap confirmed live, 2026-11-22 — "do we have the
-- cash confirmation procedure for the terminals or accountant side?"
-- Audit found two real problems:
--   1. /portal/fleet/cash is hard-gated to the literal fleet OWNER only
--      (frontend `if (!isOwner) return`), even though the 'cash'
--      permission module (885) already lets an owner delegate cash
--      actions to a role like 'accountant' — that delegation has never
--      actually been consumable by any page, because nothing exposes
--      the caller's own can_edit_cash flag to the frontend at all.
--   2. submit_route_driver_handover / confirm_route_driver_handover
--      (929) built a real two-step driver-submits / someone-confirms
--      flow, but confirm_route_driver_handover was never wired to any
--      UI button anywhere in the app, AND it was hardcoded to the
--      literal owner only — not even widened through the 'cash' module
--      like record_counter_remittance (155, true-replaced in 885) was.
--      Every driver-submitted handover has been permanently stuck
--      'pending' since 929 shipped, with the dashboard's own cash-float
--      math excluding it from "settled" because of exactly that.
--
-- Decision (asked directly): accountant role gets real access,
-- alongside the owner — gated the same way record_counter_remittance
-- already is, through fleet_staff_role_has_permission(..., 'cash'),
-- not a hardcoded role name, so it's the owner's own existing
-- Permissions tab toggle that actually controls this, for whichever
-- role(s) they choose to grant 'cash' to.

-- ═════════════════════════════════════════════════════════════════════
-- 1. my_managed_fleet (final body: 940) — true-replace, additive only.
-- Adds `role` (null for the owner) and `can_edit_cash` so a page can
-- finally tell whether the signed-in staff member was delegated cash
-- access, without every page re-deriving this itself.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION my_managed_fleet() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'fleet_id', f.id, 'name', f.name, 'is_owner', f.owning_portal_user_id = current_portal_user_id(),
    'role', (SELECT fs.role FROM fleet_staff fs WHERE fs.fleet_id = f.id AND fs.portal_user_id = current_portal_user_id() LIMIT 1),
    'can_edit_cash', f.owning_portal_user_id = current_portal_user_id()
      OR fleet_staff_role_has_permission(f.id, (SELECT fs.role FROM fleet_staff fs WHERE fs.fleet_id = f.id AND fs.portal_user_id = current_portal_user_id() LIMIT 1), 'cash')
  )
  FROM fleets f
  WHERE f.owning_portal_user_id = current_portal_user_id()
     OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = f.id AND fs.portal_user_id = current_portal_user_id() AND fs.role != 'driver')
  ORDER BY (f.owning_portal_user_id = current_portal_user_id()) DESC
  LIMIT 1;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 2. confirm_route_driver_handover (final body: 929) — true-replace.
-- Same widen record_counter_remittance already got in 885: owner OR a
-- role the owner granted 'cash' to. Also audit-logged now (it wasn't
-- before), matching 885's own discipline of logging every owner-only
-- write the moment it becomes delegable.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION confirm_route_driver_handover(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_route_id uuid; v_fleet_id uuid; v_portal_user_id uuid := current_portal_user_id();
BEGIN
  SELECT route_id INTO v_route_id FROM route_driver_cash_handovers WHERE id = p_id AND status = 'pending' FOR UPDATE;
  IF v_route_id IS NULL THEN RAISE EXCEPTION 'Handover not found or already confirmed.' USING ERRCODE = 'P0001'; END IF;

  SELECT v.fleet_id INTO v_fleet_id FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id WHERE vr.id = v_route_id;

  IF NOT (
    EXISTS (SELECT 1 FROM vehicle_routes vr JOIN vehicles v ON v.id = vr.vehicle_id JOIN fleets f ON f.id = v.fleet_id
      WHERE vr.id = v_route_id AND f.owning_portal_user_id = v_portal_user_id)
    OR (v_fleet_id IS NOT NULL AND fleet_staff_role_has_permission(v_fleet_id, (SELECT fs.role FROM fleet_staff fs WHERE fs.fleet_id = v_fleet_id AND fs.portal_user_id = v_portal_user_id), 'cash'))
  ) THEN
    RAISE EXCEPTION 'You do not have cash access on this route''s fleet.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE route_driver_cash_handovers SET status = 'confirmed', confirmed_by = v_portal_user_id, confirmed_at = now() WHERE id = p_id;
  IF v_fleet_id IS NOT NULL THEN
    PERFORM log_fleet_action(v_fleet_id, 'driver_handover_confirmed', jsonb_build_object('handover_id', p_id, 'route_id', v_route_id));
  END IF;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════
-- 3. A fleet-wide "pending handovers" queue — route_master_trip_challan
-- (929) only ever showed a handover scoped to one route/date/direction
-- the owner already had open; there was no single place to see every
-- driver's pending handover across the whole fleet to actually confirm
-- them from, which is the concrete reason confirm_route_driver_handover
-- never got wired to a button anywhere.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fleet_pending_driver_handovers(p_fleet_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', h.id, 'amount_pkr', h.amount_pkr, 'travel_date', h.travel_date, 'direction', h.direction, 'note', h.note, 'created_at', h.created_at,
    'route_label', vr.origin || ' → ' || vr.destination, 'vehicle_number', v.vehicle_number,
    'driver_name', pu.full_name, 'counter_label', fc.city
  ) ORDER BY h.created_at), '[]'::jsonb)
  FROM route_driver_cash_handovers h
  JOIN vehicle_routes vr ON vr.id = h.route_id
  JOIN vehicles v ON v.id = vr.vehicle_id
  LEFT JOIN portal_users pu ON pu.id = h.recorded_by
  LEFT JOIN fleet_counters fc ON fc.id = h.received_by_counter_id
  WHERE v.fleet_id = p_fleet_id AND h.status = 'pending'
    AND (
      EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR fleet_staff_role_has_permission(p_fleet_id, (SELECT fs.role FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id()), 'cash')
    );
$$;
REVOKE ALL ON FUNCTION fleet_pending_driver_handovers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_pending_driver_handovers(uuid) TO authenticated;
