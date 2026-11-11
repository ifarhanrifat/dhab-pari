-- Migration 854: fleet accounting, Phase 1 — Fleet Staff (full
-- operational parity with the owner, mirroring shop_staff's confirmed
-- "full equal access, not tiered" design, 458/459), vehicle expense
-- logging (mirrors shop_purchases, 434 — plain table, no ledger
-- posting, never touching the commission wallet), a fleet-wide P&L
-- aggregator built on vehicle_dashboard_summary's existing earnings
-- math, and a fleet-scoped live map (query shape copied from
-- admin_fleet_locations, 486, but can_manage_vehicle()-gated and
-- fleet-scoped instead of platform-wide/admin-only).
--
-- "Fleet Staff" not "fleet booker" deliberately — "booker" already
-- means the customer placing a booking throughout this codebase
-- (shadi_events, equipment_bookings, their i18n strings); reusing it
-- for the new owner-delegated operator role would collide.

-- ═════════════════════════════════════════════════════════════════════
-- 1. fleet_staff — full equal access once added, same shape as
--    shop_staff: a membership row, no permission columns. Only the
--    fleet's own owning_portal_user_id can add/remove, same reasoning
--    shop_staff_owner_write/_delete already uses (avoids a multi-staff
--    deadlock over who can remove whom).
-- ═════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS fleet_staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id uuid NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,
  portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  added_at timestamptz DEFAULT now(),
  UNIQUE (fleet_id, portal_user_id)
);
CREATE INDEX IF NOT EXISTS fleet_staff_fleet_id_idx ON fleet_staff(fleet_id);
CREATE INDEX IF NOT EXISTS fleet_staff_portal_user_id_idx ON fleet_staff(portal_user_id);
ALTER TABLE fleet_staff ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_staff_owner_read" ON fleet_staff FOR SELECT TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM fleets f WHERE f.id = fleet_id AND f.owning_portal_user_id = current_portal_user_id())
    OR portal_user_id = current_portal_user_id()
  );
CREATE POLICY "fleet_staff_owner_write" ON fleet_staff FOR INSERT TO authenticated
  WITH CHECK (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM fleets f WHERE f.id = fleet_id AND f.owning_portal_user_id = current_portal_user_id())
  );
CREATE POLICY "fleet_staff_owner_delete" ON fleet_staff FOR DELETE TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM fleets f WHERE f.id = fleet_id AND f.owning_portal_user_id = current_portal_user_id())
  );

-- Staff need to read their own fleet's row too (name, for display) —
-- the original 844 policy only let the owner (or admin) see it.
DROP POLICY IF EXISTS "fleets_owner_read" ON fleets;
CREATE POLICY "fleets_owner_read" ON fleets FOR SELECT TO authenticated
  USING (
    owning_portal_user_id = current_portal_user_id()
    OR current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = id AND fs.portal_user_id = current_portal_user_id())
  );

-- ═════════════════════════════════════════════════════════════════════
-- can_manage_vehicle — the one change that threads staff authorization
-- through every existing fleet-aware RPC (route booking accept/
-- decline/confirm/cancel/start/complete, every equipment RPC from 852)
-- with zero other edits, same leverage point 844 used for fleet owners.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION can_manage_vehicle(p_vehicle_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id()
  ) OR EXISTS (
    SELECT 1 FROM vehicles v JOIN fleets f ON f.id = v.fleet_id
    WHERE v.id = p_vehicle_id AND f.owning_portal_user_id = current_portal_user_id()
  ) OR EXISTS (
    SELECT 1 FROM vehicles v JOIN fleet_staff fs ON fs.fleet_id = v.fleet_id
    WHERE v.id = p_vehicle_id AND fs.portal_user_id = current_portal_user_id()
  );
$$;
REVOKE ALL ON FUNCTION can_manage_vehicle(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION can_manage_vehicle(uuid) TO authenticated;

-- Resolves "my fleet" whether the caller owns one or is staff on one —
-- the fleet page needs this single call instead of juggling my_fleets()
-- (owner-only) and a separate staff lookup itself.
CREATE OR REPLACE FUNCTION my_managed_fleet() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('fleet_id', f.id, 'name', f.name, 'is_owner', f.owning_portal_user_id = current_portal_user_id())
  FROM fleets f
  WHERE f.owning_portal_user_id = current_portal_user_id()
     OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = f.id AND fs.portal_user_id = current_portal_user_id())
  ORDER BY (f.owning_portal_user_id = current_portal_user_id()) DESC
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION my_managed_fleet() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_managed_fleet() TO authenticated;

-- my_fleet_vehicles (844) only ever matched fleet OWNERS — a staff
-- member calling it got nothing back, even though can_manage_vehicle()
-- now recognizes them. Extended to match either.
CREATE OR REPLACE FUNCTION my_fleet_vehicles() RETURNS TABLE(id uuid, owner_name varchar, vehicle_type varchar, vehicle_number varchar)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.id, v.owner_name, v.vehicle_type, v.vehicle_number
  FROM vehicles v JOIN fleets f ON f.id = v.fleet_id
  WHERE v.is_active AND (
    f.owning_portal_user_id = current_portal_user_id()
    OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = f.id AND fs.portal_user_id = current_portal_user_id())
  );
$$;
REVOKE ALL ON FUNCTION my_fleet_vehicles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_fleet_vehicles() TO authenticated;

CREATE OR REPLACE FUNCTION my_fleet_staff(p_fleet_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', fs.id, 'portal_user_id', fs.portal_user_id, 'full_name', pu.full_name, 'added_at', fs.added_at) ORDER BY fs.added_at), '[]'::jsonb)
  FROM fleet_staff fs JOIN portal_users pu ON pu.id = fs.portal_user_id
  WHERE fs.fleet_id = p_fleet_id AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id());
$$;
REVOKE ALL ON FUNCTION my_fleet_staff(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_fleet_staff(uuid) TO authenticated;

-- find_portal_user_by_mobile (462) already exists and is exactly what
-- shop_staff's own add-flow uses — reused verbatim, no new lookup RPC.
CREATE OR REPLACE FUNCTION add_fleet_staff(p_fleet_id uuid, p_phone text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_found record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id AND owning_portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_found FROM find_portal_user_by_mobile(trim(p_phone));
  IF v_found.id IS NULL THEN
    RAISE EXCEPTION 'No account found with that phone number — they need to sign up first.' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO fleet_staff (fleet_id, portal_user_id) VALUES (p_fleet_id, v_found.id)
    ON CONFLICT (fleet_id, portal_user_id) DO NOTHING;
  RETURN jsonb_build_object('portal_user_id', v_found.id, 'full_name', v_found.full_name);
END;
$$;
REVOKE ALL ON FUNCTION add_fleet_staff(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION add_fleet_staff(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION remove_fleet_staff(p_fleet_id uuid, p_portal_user_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id AND owning_portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM fleet_staff WHERE fleet_id = p_fleet_id AND portal_user_id = p_portal_user_id;
END;
$$;
REVOKE ALL ON FUNCTION remove_fleet_staff(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION remove_fleet_staff(uuid, uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 2. vehicle_expenses — mirrors shop_purchases exactly: plain table,
--    no ledger/accounts/vouchers posting at all, so the commission
--    wallet (seller_account_balance/vehicle_bookable) can never be
--    affected by expense entries.
-- ═════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vehicle_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  category varchar NOT NULL CHECK (category IN ('fuel', 'maintenance', 'toll', 'other')),
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  note text,
  expense_date date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Karachi')::date,
  recorded_by_portal_user_id uuid REFERENCES portal_users(id),
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicle_expenses_vehicle_id_idx ON vehicle_expenses(vehicle_id);
ALTER TABLE vehicle_expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vehicle_expenses_manager_read" ON vehicle_expenses FOR SELECT TO authenticated
  USING (can_manage_vehicle(vehicle_id) OR current_admin_permission('manage_parties'));
-- No INSERT/UPDATE/DELETE policy — SECURITY DEFINER RPC only.

CREATE OR REPLACE FUNCTION record_vehicle_expense(p_vehicle_id uuid, p_category varchar, p_amount_pkr decimal, p_note text DEFAULT NULL, p_expense_date date DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(p_vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  IF p_category NOT IN ('fuel', 'maintenance', 'toll', 'other') THEN RAISE EXCEPTION 'Invalid expense category.' USING ERRCODE = 'P0001'; END IF;
  IF p_amount_pkr IS NULL OR p_amount_pkr <= 0 THEN RAISE EXCEPTION 'Enter a real amount.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO vehicle_expenses (vehicle_id, category, amount_pkr, note, expense_date, recorded_by_portal_user_id)
  VALUES (p_vehicle_id, p_category, p_amount_pkr, nullif(trim(coalesce(p_note, '')), ''), coalesce(p_expense_date, (now() AT TIME ZONE 'Asia/Karachi')::date), v_portal_user_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION record_vehicle_expense(uuid, varchar, decimal, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_vehicle_expense(uuid, varchar, decimal, text, date) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 3. vehicle_dashboard_summary — same body as 783 (the latest), only
--    the ownership check changes: can_manage_vehicle() instead of raw
--    portal_user_id equality, so a fleet owner/staff can call this for
--    any vehicle they manage, not just their own registered one.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION vehicle_dashboard_summary(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_vehicle vehicles%ROWTYPE;
  v_balance decimal := 0;
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_today_earnings decimal := 0; v_month_earnings decimal := 0;
  v_today_jobs int := 0; v_month_jobs int := 0;
  v_pending_bookings int;
  v_last_settle RECORD;
  v_avg_rating decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in required.' USING ERRCODE = 'P0001'; END IF;
  IF NOT can_manage_vehicle(p_vehicle_id) THEN RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_vehicle FROM vehicles WHERE id = p_vehicle_id;

  v_balance := seller_account_balance(ensure_vehicle_account(p_vehicle_id));

  WITH jobs AS (
    SELECT b.total_amount_pkr AS amount, b.confirmed_at AT TIME ZONE 'Asia/Karachi' AS at
    FROM ride_bookings b JOIN vehicle_routes r ON r.id = b.route_id
    WHERE r.vehicle_id = p_vehicle_id AND b.status = 'confirmed'
    UNION ALL
    SELECT b.total_amount_pkr, b.completed_at AT TIME ZONE 'Asia/Karachi'
    FROM vehicle_trip_bookings b
    WHERE b.vehicle_id = p_vehicle_id AND b.status = 'completed' AND b.completed_at IS NOT NULL
    UNION ALL
    SELECT coalesce(b.total_amount_pkr, b.base_amount_pkr), b.ended_at AT TIME ZONE 'Asia/Karachi'
    FROM hourly_bookings b
    WHERE b.vehicle_id = p_vehicle_id AND b.status_confirmed AND b.ended_at IS NOT NULL
    UNION ALL
    SELECT sr.advance_share_pkr, sr.paid_out_at AT TIME ZONE 'Asia/Karachi'
    FROM shadi_vehicle_requests sr
    WHERE sr.vehicle_id = p_vehicle_id AND sr.payout_voucher_id IS NOT NULL AND sr.paid_out_at IS NOT NULL
    UNION ALL
    SELECT o.delivery_fee_pkr, o.delivered_at AT TIME ZONE 'Asia/Karachi'
    FROM shop_orders o
    WHERE o.delivery_vehicle_id = p_vehicle_id AND o.fulfillment_status = 'delivered' AND o.delivered_at IS NOT NULL
    UNION ALL
    SELECT GREATEST(0, coalesce(c.total_pkr, 0) - coalesce(c.goods_budget_pkr, 0)), c.completed_at AT TIME ZONE 'Asia/Karachi'
    FROM dispatch_calls c
    WHERE c.accepted_vehicle_id = p_vehicle_id AND c.status = 'completed' AND c.completed_at IS NOT NULL
    UNION ALL
    SELECT b.total_amount_pkr, b.ended_at AT TIME ZONE 'Asia/Karachi'
    FROM equipment_bookings b
    WHERE b.vehicle_id = p_vehicle_id AND b.status_confirmed AND b.ended_at IS NOT NULL
    UNION ALL
    SELECT b.total_amount_pkr, b.ended_at AT TIME ZONE 'Asia/Karachi'
    FROM rental_bookings b
    WHERE b.vehicle_id = p_vehicle_id AND b.status_confirmed AND b.ended_at IS NOT NULL
  )
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE at::date = v_today), 0),
    COALESCE(SUM(amount) FILTER (WHERE date_trunc('month', at) = date_trunc('month', v_today::timestamp)), 0),
    COUNT(*) FILTER (WHERE at::date = v_today),
    COUNT(*) FILTER (WHERE date_trunc('month', at) = date_trunc('month', v_today::timestamp))
  INTO v_today_earnings, v_month_earnings, v_today_jobs, v_month_jobs
  FROM jobs;

  SELECT count(*) INTO v_pending_bookings FROM ride_bookings b JOIN vehicle_routes r ON r.id = b.route_id
    WHERE r.vehicle_id = p_vehicle_id AND b.status = 'announced';

  SELECT settled_date, amount_pkr INTO v_last_settle FROM collector_settlements WHERE vehicle_id = p_vehicle_id ORDER BY settled_date DESC LIMIT 1;

  SELECT round(avg(r.stars)::numeric, 1) INTO v_avg_rating FROM ratings r WHERE r.target_party_type = 'vehicle' AND r.target_party_id = p_vehicle_id;

  RETURN jsonb_build_object(
    'balance_pkr', v_balance, 'commission_mode', v_vehicle.commission_mode, 'lumpsum_fee_pkr', v_vehicle.lumpsum_fee_pkr,
    'commission_pct', vehicle_commission_pct(v_vehicle.vehicle_type, 'intercity'),
    'today_earnings_pkr', v_today_earnings, 'month_earnings_pkr', v_month_earnings,
    'today_jobs_count', v_today_jobs, 'month_jobs_count', v_month_jobs,
    'pending_bookings_count', v_pending_bookings,
    'last_settlement_date', v_last_settle.settled_date, 'last_settlement_amount', v_last_settle.amount_pkr,
    'avg_rating', v_avg_rating
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════
-- 4. fleet_dashboard_summary — the genuinely new piece: sums vehicle_
--    dashboard_summary's earnings math and vehicle_expenses across
--    every vehicle the caller manages (own + fleet), today and month.
--    Wallet balance is reported per-vehicle, kept separate from profit
--    everywhere in this payload — never summed into a "fleet balance".
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fleet_dashboard_summary() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_vehicles jsonb := '[]'::jsonb;
  v_fleet_today_profit decimal := 0; v_fleet_month_profit decimal := 0;
  r record; v_summary jsonb; v_today_exp decimal; v_month_exp decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;

  FOR r IN
    SELECT v.id, v.owner_name, v.vehicle_type, v.vehicle_number FROM vehicles v WHERE v.portal_user_id = v_portal_user_id
    UNION
    SELECT v.id, v.owner_name, v.vehicle_type, v.vehicle_number FROM vehicles v JOIN fleets f ON f.id = v.fleet_id WHERE f.owning_portal_user_id = v_portal_user_id
    UNION
    SELECT v.id, v.owner_name, v.vehicle_type, v.vehicle_number FROM vehicles v JOIN fleet_staff fs ON fs.fleet_id = v.fleet_id WHERE fs.portal_user_id = v_portal_user_id
  LOOP
    v_summary := vehicle_dashboard_summary(r.id);

    SELECT COALESCE(SUM(amount_pkr) FILTER (WHERE expense_date = v_today), 0),
           COALESCE(SUM(amount_pkr) FILTER (WHERE date_trunc('month', expense_date) = date_trunc('month', v_today)), 0)
      INTO v_today_exp, v_month_exp FROM vehicle_expenses WHERE vehicle_id = r.id;

    v_vehicles := v_vehicles || jsonb_build_object(
      'vehicle_id', r.id, 'owner_name', r.owner_name, 'vehicle_type', r.vehicle_type, 'vehicle_number', r.vehicle_number,
      'today_earnings_pkr', v_summary->'today_earnings_pkr', 'today_expenses_pkr', v_today_exp,
      'today_profit_pkr', (v_summary->>'today_earnings_pkr')::decimal - v_today_exp,
      'month_earnings_pkr', v_summary->'month_earnings_pkr', 'month_expenses_pkr', v_month_exp,
      'month_profit_pkr', (v_summary->>'month_earnings_pkr')::decimal - v_month_exp,
      'wallet_balance_pkr', v_summary->'balance_pkr'
    );
    v_fleet_today_profit := v_fleet_today_profit + (v_summary->>'today_earnings_pkr')::decimal - v_today_exp;
    v_fleet_month_profit := v_fleet_month_profit + (v_summary->>'month_earnings_pkr')::decimal - v_month_exp;
  END LOOP;

  RETURN jsonb_build_object('vehicles', v_vehicles, 'fleet_today_profit_pkr', v_fleet_today_profit, 'fleet_month_profit_pkr', v_fleet_month_profit);
END;
$$;
REVOKE ALL ON FUNCTION fleet_dashboard_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_dashboard_summary() TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- 5. fleet_vehicle_locations — same union-and-filter shape as admin_
--    fleet_locations (486), filtered to one fleet's vehicles and
--    can_manage_vehicle()-gated instead of platform-wide/admin-only.
--    Adds a third source route_live_locations covers that the admin
--    version didn't need (scheduled route runs, the primary bus case).
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fleet_vehicle_locations(p_fleet_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM fleets f WHERE f.id = p_fleet_id AND f.owning_portal_user_id = current_portal_user_id())
      OR EXISTS (SELECT 1 FROM fleet_staff fs WHERE fs.fleet_id = p_fleet_id AND fs.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this fleet.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(row), '[]'::jsonb) INTO v_result FROM (
    SELECT jsonb_build_object(
      'source', 'trip', 'ref_id', o.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
      'context', o.origin || ' → ' || o.destination, 'lat', l.lat, 'lng', l.lng, 'updated_at', l.updated_at
    ) AS row
    FROM vehicle_trip_offers o JOIN vehicles v ON v.id = o.vehicle_id JOIN vehicle_trip_offer_locations l ON l.trip_offer_id = o.id
    WHERE v.fleet_id = p_fleet_id AND o.share_live_location AND l.updated_at > now() - interval '5 minutes'

    UNION ALL

    SELECT jsonb_build_object(
      'source', 'hourly', 'ref_id', b.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
      'context', b.pickup_address, 'lat', latest.lat, 'lng', latest.lng, 'updated_at', latest.recorded_at
    ) AS row
    FROM hourly_bookings b JOIN vehicles v ON v.id = b.vehicle_id
    JOIN LATERAL (SELECT lat, lng, recorded_at FROM hourly_booking_locations hl WHERE hl.booking_id = b.id ORDER BY hl.recorded_at DESC LIMIT 1) latest ON true
    WHERE v.fleet_id = p_fleet_id AND b.status = 'in_progress' AND latest.recorded_at > now() - interval '5 minutes'

    UNION ALL

    SELECT jsonb_build_object(
      'source', 'route', 'ref_id', vr.id, 'owner_name', v.owner_name, 'vehicle_type', v.vehicle_type, 'vehicle_number', v.vehicle_number,
      'context', vr.origin || ' → ' || vr.destination, 'lat', rl.lat, 'lng', rl.lng, 'updated_at', rl.updated_at
    ) AS row
    FROM route_runs run JOIN vehicle_routes vr ON vr.id = run.route_id JOIN vehicles v ON v.id = vr.vehicle_id
    JOIN route_live_locations rl ON rl.route_id = vr.id AND rl.portal_user_id = v.portal_user_id
    WHERE v.fleet_id = p_fleet_id AND run.ended_at IS NULL AND rl.updated_at > now() - interval '5 minutes'
  ) rows;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION fleet_vehicle_locations(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fleet_vehicle_locations(uuid) TO authenticated;
