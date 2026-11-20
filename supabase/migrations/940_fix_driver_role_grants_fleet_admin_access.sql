-- Migration 940: CRITICAL real bug, confirmed live on a real device —
-- a plain driver account (QA Driver Rawalpindi One, role='driver' in
-- fleet_staff) had full access to the entire fleet owner admin console
-- at /portal/fleet (Routes, Booking Counters, Fleet Staff, Bookings,
-- Departure Chalan, Expenses, Cash Settlement, Fleet P&L, Invite
-- Driver — everything), via the sidebar nav AND a direct URL hit.
--
-- Root cause: my_managed_fleet() (854) grants fleet-manager access to
-- anyone with ANY fleet_staff row for that fleet, with no role filter.
-- That was correct when written — 'driver' wasn't even a valid
-- fleet_staff role yet (883's CHECK only allowed staff/booking_officer/
-- terminal_manager/accountant/other). Migration 888 later made
-- 'driver' a real, intentional fleet_staff role (so an owner could
-- assign a driver directly, not just via the invite flow) and 897
-- backfilled every existing vehicle's driver into fleet_staff with
-- that role for an unrelated, legitimate reason (fleet_vehicle_cash_
-- positions, 864, needed drivers to have a fleet_staff row) — but
-- nobody went back and excluded that role from my_managed_fleet()'s own
-- check, so every driver has had full admin-console access ever since
-- 888 shipped.
--
-- Fix: exclude role='driver' from the "is fleet staff" branch only in
-- my_managed_fleet() — the one function every /portal/fleet/* page and
-- PortalSidebar's nav-visibility check already calls to scope "my
-- fleet," so this single fix closes the hole everywhere at once. The
-- owner branch is untouched, and fleet_vehicle_cash_positions (864) and
-- every other fleet_staff check in this codebase does its own
-- independent EXISTS query — not through my_managed_fleet() — so a
-- driver's legitimate, narrower access (their own vehicle's cash
-- position, /portal/drive itself, closing their own route's stops)
-- is completely unaffected. Body otherwise copied verbatim from 854.
CREATE OR REPLACE FUNCTION my_managed_fleet() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('fleet_id', f.id, 'name', f.name, 'is_owner', f.owning_portal_user_id = current_portal_user_id())
  FROM fleets f
  WHERE f.owning_portal_user_id = current_portal_user_id()
     OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = f.id AND fs.portal_user_id = current_portal_user_id() AND fs.role != 'driver')
  ORDER BY (f.owning_portal_user_id = current_portal_user_id()) DESC
  LIMIT 1;
$$;
