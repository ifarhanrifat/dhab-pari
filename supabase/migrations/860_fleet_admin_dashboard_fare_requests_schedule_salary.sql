-- Migration 860: backend for the fleet admin/staff dashboard redesign.
-- The owner dashboard was crammed onto one page (my-vehicle/fleet/
-- page.tsx) and fleet owners/staff with no personal vehicle were
-- wrongly shown the single-driver my-vehicle shell — this migration
-- adds the four genuinely new backend pieces the redesigned, tabbed
-- /portal/fleet/* UI needs; everything else (P&L, expenses, counters/
-- cash, staff, invites) already exists from 854/855 and is only being
-- reorganized in the frontend, not touched here.
--
-- 1. Fare-readjustment requests — fare has only ever been settable once,
--    at route creation (create_vehicle_route_self, 672); there is no
--    edit path today. Copies commercial_ilans'/677's "owner proposes,
--    committee approves" shape line-for-line.
-- 2. Fleet staff salary tracking — fleet_staff (854) has zero salary
--    columns; the only salary schema anywhere is the unrelated
--    admin-side employees_hr system. Plain tables, no ledger posting,
--    same discipline as vehicle_expenses/fleet_counter_remittances.
-- 3. fleet_vehicle_schedule — the one fleet-wide aggregating RPC that
--    was missing: joins vehicles -> vehicle_routes -> today's latest
--    route_runs (direction/outbound_arrived_at/ended_at, 719/724/727)
--    -> today's route_run_substitutions (819) into one per-vehicle
--    turnaround-cycle card. All the underlying timing/direction/
--    substitution primitives already existed; this just aggregates them.
-- 4. fleet_commission_settlements — strictly read-only against
--    ledger_entries for each vehicle's own account (ensure_vehicle_
--    account, 388/394). A vehicle's own account is only ever debited by
--    the committee drawing commission/settlement (vehicle_expenses and
--    fleet_counter_remittances deliberately never post there, per this
--    whole session's standing rule) — so SUM(debit) by month on that
--    one account is exactly "commission settled," no new posting logic
--    needed, no risk to vehicle_bookable()'s wallet gate.

-- ═════════════════════════════════════════════════════════════════════
-- 1. Fare-readjustment requests
-- ═════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS route_fare_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES vehicle_routes(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  requested_by_portal_user_id uuid NOT NULL REFERENCES portal_users(id),
  current_fare_per_seat_pkr decimal NOT NULL,
  requested_fare_per_seat_pkr decimal NOT NULL CHECK (requested_fare_per_seat_pkr > 0),
  reason text,
  status varchar NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval', 'approved', 'rejected')),
  reviewed_by uuid REFERENCES admin_users(id),
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS route_fare_change_requests_route_id_idx ON route_fare_change_requests(route_id);
CREATE INDEX IF NOT EXISTS route_fare_change_requests_tenant_status_idx ON route_fare_change_requests(tenant_id, status);
ALTER TABLE route_fare_change_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fare_requests_read" ON route_fare_change_requests FOR SELECT TO authenticated
  USING (
    requested_by_portal_user_id = current_portal_user_id()
    OR EXISTS (SELECT 1 FROM vehicle_routes vr WHERE vr.id = route_id AND can_manage_vehicle(vr.vehicle_id))
    OR (tenant_id = my_tenant_id() AND can_access_system('marketplace'))
  );
-- No direct INSERT/UPDATE policy — SECURITY DEFINER RPCs only.

CREATE OR REPLACE FUNCTION request_route_fare_change(p_route_id uuid, p_requested_fare_per_seat_pkr decimal, p_reason text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_route vehicle_routes%ROWTYPE; v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_route FROM vehicle_routes WHERE id = p_route_id;
  IF v_route.id IS NULL OR NOT can_manage_vehicle(v_route.vehicle_id) THEN
    RAISE EXCEPTION 'You do not manage this route.' USING ERRCODE = 'P0001';
  END IF;
  IF p_requested_fare_per_seat_pkr IS NULL OR p_requested_fare_per_seat_pkr <= 0 THEN
    RAISE EXCEPTION 'Enter a real fare amount.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM route_fare_change_requests WHERE route_id = p_route_id AND status = 'pending_approval') THEN
    RAISE EXCEPTION 'A fare request for this route is already pending committee review.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO route_fare_change_requests (route_id, tenant_id, requested_by_portal_user_id, current_fare_per_seat_pkr, requested_fare_per_seat_pkr, reason)
  VALUES (p_route_id, v_route.tenant_id, v_portal_user_id, v_route.fare_per_seat_pkr, p_requested_fare_per_seat_pkr, nullif(trim(coalesce(p_reason, '')), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION request_route_fare_change(uuid, decimal, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION request_route_fare_change(uuid, decimal, text) TO authenticated;

-- One owner-facing list: every request for every route they manage.
CREATE OR REPLACE FUNCTION my_fare_change_requests() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', q.id, 'route_id', q.route_id, 'origin', vr.origin, 'destination', vr.destination,
    'current_fare_per_seat_pkr', q.current_fare_per_seat_pkr, 'requested_fare_per_seat_pkr', q.requested_fare_per_seat_pkr,
    'reason', q.reason, 'status', q.status, 'rejection_reason', q.rejection_reason, 'created_at', q.created_at
  ) ORDER BY q.created_at DESC), '[]'::jsonb)
  FROM route_fare_change_requests q JOIN vehicle_routes vr ON vr.id = q.route_id
  WHERE can_manage_vehicle(vr.vehicle_id);
$$;
REVOKE ALL ON FUNCTION my_fare_change_requests() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_fare_change_requests() TO authenticated;

CREATE OR REPLACE FUNCTION committee_approve_fare_change(p_request_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE req route_fare_change_requests%ROWTYPE; v_admin_id uuid := current_admin_user_id();
BEGIN
  IF v_admin_id IS NULL OR NOT can_access_system('marketplace') OR NOT COALESCE(current_admin_permission('manage_parties'), false) THEN
    RAISE EXCEPTION 'You do not have permission to approve fare changes.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO req FROM route_fare_change_requests WHERE id = p_request_id AND tenant_id = my_tenant_id() AND status = 'pending_approval' FOR UPDATE;
  IF req.id IS NULL THEN RAISE EXCEPTION 'Request not found or already reviewed.' USING ERRCODE = 'P0001'; END IF;

  UPDATE vehicle_routes SET fare_per_seat_pkr = req.requested_fare_per_seat_pkr WHERE id = req.route_id;
  UPDATE route_fare_change_requests SET status = 'approved', reviewed_by = v_admin_id, reviewed_at = now() WHERE id = p_request_id;
END;
$$;
REVOKE ALL ON FUNCTION committee_approve_fare_change(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION committee_approve_fare_change(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION committee_reject_fare_change(p_request_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_admin_id uuid := current_admin_user_id();
BEGIN
  IF v_admin_id IS NULL OR NOT can_access_system('marketplace') OR NOT COALESCE(current_admin_permission('manage_parties'), false) THEN
    RAISE EXCEPTION 'You do not have permission to reject fare changes.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE route_fare_change_requests SET status = 'rejected', reviewed_by = v_admin_id, reviewed_at = now(),
    rejection_reason = nullif(trim(coalesce(p_reason, '')), '')
  WHERE id = p_request_id AND tenant_id = my_tenant_id() AND status = 'pending_approval';
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found or already reviewed.' USING ERRCODE = 'P0001'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION committee_reject_fare_change(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION committee_reject_fare_change(uuid, text) TO authenticated;

-- Sidebar badge count for the new "Fare Change Requests" admin menu item
-- (admin_sidebar_badges, 603 — latest body, extended with one more key).
CREATE OR REPLACE FUNCTION public.admin_sidebar_badges() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_admin uuid;
  v_role varchar;
  v_tenant uuid;
BEGIN
  SELECT id, role, tenant_id INTO v_admin, v_role, v_tenant
    FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true;
  IF v_admin IS NULL THEN RETURN '{}'::jsonb; END IF;

  RETURN jsonb_build_object(
    'blood_requests', (SELECT count(*) FROM blood_requests WHERE status = 'pending_approval' AND tenant_id = v_tenant),
    'approvals',      (SELECT count(*) FROM approval_requests WHERE status = 'pending' AND tenant_id = v_tenant),
    'alerts',         (SELECT count(*) FROM notifications WHERE recipient_id = v_admin AND is_read = false),
    'suggestions',    (SELECT count(*) FROM suggestions WHERE status = 'new' AND tenant_id = v_tenant),
    'complaints',     (SELECT count(*) FROM complaints WHERE status IN ('open', 'awaiting_verification') AND tenant_id = v_tenant),
    'party_complaints', (SELECT count(*) FROM party_complaints WHERE status = 'open' AND tenant_id = v_tenant),
    'volunteers',     (SELECT count(*) FROM volunteers WHERE status = 'offered' AND tenant_id = v_tenant),
    'connections',    (SELECT count(*) FROM connection_requests WHERE status = 'pending_payment' AND tenant_id = v_tenant),
    'payment_claims', (SELECT count(*) FROM bill_payment_claims WHERE status = 'pending' AND tenant_id = v_tenant),
    'donors',         (SELECT count(*) FROM donors WHERE payment_status = 'pledged' AND is_verified = false AND tenant_id = v_tenant),
    'portal-accounts', (SELECT count(*) FROM portal_users WHERE mentor_status = 'pending' AND tenant_id = v_tenant),
    'fare_requests',  (SELECT count(*) FROM route_fare_change_requests WHERE status = 'pending_approval' AND tenant_id = v_tenant)
  );
END;
$$;

-- Admin-side list of every pending request for the committee's own tenant.
CREATE OR REPLACE FUNCTION admin_pending_fare_change_requests() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', q.id, 'route_id', q.route_id, 'origin', vr.origin, 'destination', vr.destination,
    'vehicle_owner_name', v.owner_name, 'current_fare_per_seat_pkr', q.current_fare_per_seat_pkr,
    'requested_fare_per_seat_pkr', q.requested_fare_per_seat_pkr, 'reason', q.reason, 'created_at', q.created_at
  ) ORDER BY q.created_at), '[]'::jsonb)
  FROM route_fare_change_requests q
  JOIN vehicle_routes vr ON vr.id = q.route_id
  JOIN vehicles v ON v.id = vr.vehicle_id
  WHERE q.tenant_id = my_tenant_id() AND q.status = 'pending_approval'
    AND current_admin_user_id() IS NOT NULL AND can_access_system('marketplace') AND COALESCE(current_admin_permission('manage_parties'), false);
$$;
REVOKE ALL ON FUNCTION admin_pending_fare_change_requests() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_pending_fare_change_requests() TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 2. Fleet staff salary tracking — plain tables, no ledger posting.
-- ═════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS fleet_staff_salaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_staff_id uuid NOT NULL REFERENCES fleet_staff(id) ON DELETE CASCADE,
  monthly_salary_pkr decimal NOT NULL CHECK (monthly_salary_pkr >= 0),
  effective_from date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Karachi')::date,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fleet_staff_salaries_staff_id_idx ON fleet_staff_salaries(fleet_staff_id, effective_from DESC);
ALTER TABLE fleet_staff_salaries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_staff_salaries_manager_read" ON fleet_staff_salaries FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM fleet_staff fs JOIN fleets f ON f.id = fs.fleet_id
    WHERE fs.id = fleet_staff_id AND (f.owning_portal_user_id = current_portal_user_id() OR fs.portal_user_id = current_portal_user_id())
  ) OR current_admin_permission('manage_parties'));

CREATE TABLE IF NOT EXISTS fleet_staff_salary_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_staff_id uuid NOT NULL REFERENCES fleet_staff(id) ON DELETE CASCADE,
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  paid_on date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Karachi')::date,
  note text,
  recorded_by uuid REFERENCES portal_users(id),
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fleet_staff_salary_payments_staff_id_idx ON fleet_staff_salary_payments(fleet_staff_id, paid_on DESC);
ALTER TABLE fleet_staff_salary_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_staff_salary_payments_manager_read" ON fleet_staff_salary_payments FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM fleet_staff fs JOIN fleets f ON f.id = fs.fleet_id
    WHERE fs.id = fleet_staff_id AND (f.owning_portal_user_id = current_portal_user_id() OR fs.portal_user_id = current_portal_user_id())
  ) OR current_admin_permission('manage_parties'));

CREATE OR REPLACE FUNCTION set_fleet_staff_salary(p_fleet_staff_id uuid, p_monthly_salary_pkr decimal) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM fleet_staff fs JOIN fleets f ON f.id = fs.fleet_id
    WHERE fs.id = p_fleet_staff_id AND f.owning_portal_user_id = current_portal_user_id()
  ) THEN RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001'; END IF;
  IF p_monthly_salary_pkr IS NULL OR p_monthly_salary_pkr < 0 THEN RAISE EXCEPTION 'Enter a real salary amount.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO fleet_staff_salaries (fleet_staff_id, monthly_salary_pkr) VALUES (p_fleet_staff_id, p_monthly_salary_pkr) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION set_fleet_staff_salary(uuid, decimal) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_fleet_staff_salary(uuid, decimal) TO authenticated;

CREATE OR REPLACE FUNCTION record_staff_salary_payment(p_fleet_staff_id uuid, p_amount_pkr decimal, p_note text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM fleet_staff fs JOIN fleets f ON f.id = fs.fleet_id
    WHERE fs.id = p_fleet_staff_id AND f.owning_portal_user_id = v_portal_user_id
  ) THEN RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001'; END IF;
  IF p_amount_pkr IS NULL OR p_amount_pkr <= 0 THEN RAISE EXCEPTION 'Enter a real amount.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO fleet_staff_salary_payments (fleet_staff_id, amount_pkr, note, recorded_by)
  VALUES (p_fleet_staff_id, p_amount_pkr, nullif(trim(coalesce(p_note, '')), ''), v_portal_user_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION record_staff_salary_payment(uuid, decimal, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_staff_salary_payment(uuid, decimal, text) TO authenticated;

-- Reports-tab read: per staff member, current salary + this month's
-- payments + last payment date. Owner-only (same gate my_fleet_staff uses).
CREATE OR REPLACE FUNCTION fleet_staff_salary_report(p_fleet_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'fleet_staff_id', fs.id, 'full_name', pu.full_name,
    'monthly_salary_pkr', sal.monthly_salary_pkr,
    'paid_this_month_pkr', COALESCE(paid.month_total, 0),
    'last_payment_date', paid.last_date
  ) ORDER BY pu.full_name), '[]'::jsonb)
  FROM fleet_staff fs
  JOIN portal_users pu ON pu.id = fs.portal_user_id
  LEFT JOIN LATERAL (
    SELECT monthly_salary_pkr FROM fleet_staff_salaries WHERE fleet_staff_id = fs.id ORDER BY effective_from DESC LIMIT 1
  ) sal ON true
  LEFT JOIN LATERAL (
    SELECT SUM(amount_pkr) FILTER (WHERE date_trunc('month', paid_on) = date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)) AS month_total,
           MAX(paid_on) AS last_date
    FROM fleet_staff_salary_payments WHERE fleet_staff_id = fs.id
  ) paid ON true
  WHERE fs.fleet_id = p_fleet_id
    AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id());
$$;
REVOKE ALL ON FUNCTION fleet_staff_salary_report(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_staff_salary_report(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 3. fleet_vehicle_schedule — one card per vehicle: its route, the
--    outbound/return timing already on vehicle_routes, today's actual
--    run state from route_runs, and who's covering it right now
--    (own driver, or today's active substitution).
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fleet_vehicle_schedule(p_fleet_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_dow int := extract(dow FROM (now() AT TIME ZONE 'Asia/Karachi'))::int;
  v_result jsonb;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'origin'), '[]'::jsonb) INTO v_result FROM (
    SELECT jsonb_build_object(
      'vehicle_id', v.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
      'route_id', vr.id, 'origin', vr.origin, 'destination', vr.destination,
      'departure_time', vr.departure_time, 'return_departure_time', vr.return_departure_time,
      'return_wait_minutes', vr.return_wait_minutes, 'is_two_way', vr.is_two_way,
      'runs_today', v_dow = ANY(vr.days_of_week),
      'state', CASE
        WHEN NOT (v_dow = ANY(vr.days_of_week)) THEN 'not_scheduled_today'
        WHEN last_run.id IS NULL THEN 'not_started'
        WHEN last_run.direction = 'outbound' AND last_run.ended_at IS NULL THEN 'outbound_in_progress'
        WHEN last_run.direction = 'outbound' AND last_run.ended_at IS NOT NULL THEN 'waiting_at_destination'
        WHEN last_run.direction = 'return' AND last_run.ended_at IS NULL THEN 'return_in_progress'
        ELSE 'completed_today'
      END,
      'current_driver_name', COALESCE(sub_v.owner_name, v.owner_name),
      'covered_by_substitute', sub.id IS NOT NULL,
      'last_run_started_at', last_run.started_at, 'last_run_outbound_arrived_at', last_run.outbound_arrived_at
    ) AS row
    FROM vehicles v
    JOIN vehicle_routes vr ON vr.vehicle_id = v.id AND vr.is_active
    LEFT JOIN LATERAL (
      SELECT id, direction, started_at, ended_at, outbound_arrived_at
      FROM route_runs WHERE route_id = vr.id AND started_at::date = v_today
      ORDER BY started_at DESC LIMIT 1
    ) last_run ON true
    LEFT JOIN route_run_substitutions sub ON sub.route_id = vr.id AND sub.run_date = v_today AND sub.status = 'active'
    LEFT JOIN vehicles sub_v ON sub_v.id = sub.substitute_vehicle_id
    WHERE v.fleet_id = p_fleet_id AND v.is_active
  ) rows;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION fleet_vehicle_schedule(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_vehicle_schedule(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 4. fleet_commission_settlements — read-only against ledger_entries.
--    A vehicle's own account is only ever debited by the committee
--    drawing commission/settlement (confirmed: vehicle_expenses and
--    fleet_counter_remittances never post there) — SUM(debit) by month
--    is exactly the commission settled against that vehicle, no new
--    posting logic, no write access to the ledger from this function.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fleet_commission_settlements(p_fleet_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'owner_name', row->>'month' DESC), '[]'::jsonb) INTO v_result FROM (
    SELECT jsonb_build_object(
      'vehicle_id', v.id, 'owner_name', v.owner_name,
      'month', to_char(date_trunc('month', le.entry_date), 'YYYY-MM'),
      'commission_settled_pkr', SUM(le.debit), 'topped_up_pkr', SUM(le.credit)
    ) AS row
    FROM vehicles v
    JOIN ledger_entries le ON le.account_id = ensure_vehicle_account(v.id)
    WHERE v.fleet_id = p_fleet_id AND v.is_active
    GROUP BY v.id, v.owner_name, date_trunc('month', le.entry_date)
  ) rows;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION fleet_commission_settlements(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_commission_settlements(uuid) TO authenticated;
