-- Reframes the shadi advance per the user's own correction: the
-- committee earns nothing from it — the advance is 100% the accepted
-- vehicle's own money, collected upfront purely so the vehicle isn't
-- stood up empty-handed on the wedding day, and held by the committee
-- only until the wedding date has actually passed.
--
-- Previously confirm_shadi_advance credited DP-4051 (income) for the
-- full amount, treating it as committee revenue. Now it credits a new
-- liability account instead (money owed BY the committee TO the
-- vehicles), and a separate sweep later moves each vehicle's own share
-- out of that liability and into their own account once the wedding
-- date has passed — deliberately automatic (not an admin button), since
-- by the time the advance was confirmed the exact per-vehicle amount
-- was already locked in; there's nothing left to double-check, only a
-- date to wait out. Matches this app's existing "client-polled sweep,
-- no server cron" convention (start_shop_delivery_ring's own timeout
-- sweep is the precedent) — sweep_due_shadi_advances() is called
-- incidentally whenever a relevant page loads (driver's my-vehicle/
-- shadi, the admin shadi-bookings queue), not on any schedule.
--
-- DP-4051 (Marketplace Commission Income) itself is left in place —
-- unused by shadi now, but harmless, and renaming/dropping it isn't
-- worth the churn for a same-session correction.

INSERT INTO accounts (code, name, name_ur, type, system, description, is_protected) VALUES
  ('DP-5004', 'Shadi Advances Payable to Vehicles', 'شادی گاڑی ایڈوانس واجب الادا', 'liability', 'donors_projects',
   'Wedding-booking advances collected from customers, held until the wedding date passes, then released to the accepted vehicle', true)
ON CONFLICT (code, system) DO NOTHING;

ALTER TABLE shadi_vehicle_requests ADD COLUMN IF NOT EXISTS payout_voucher_id uuid REFERENCES vouchers(id);
ALTER TABLE shadi_vehicle_requests ADD COLUMN IF NOT EXISTS paid_out_at timestamptz;

CREATE OR REPLACE FUNCTION confirm_shadi_advance(p_event_id uuid) RETURNS jsonb AS $$
DECLARE
  e shadi_events%ROWTYPE; booker portal_users%ROWTYPE;
  v_liability_account uuid; v_cash_account uuid; v_voucher_id uuid; v_voucher_no varchar;
  r RECORD;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO e FROM shadi_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'P0001'; END IF;
  IF e.status <> 'advance_announced' THEN RAISE EXCEPTION 'This advance is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO booker FROM portal_users WHERE id = e.portal_user_id;

  SELECT id INTO v_liability_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-5004';
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects' AND code = (CASE WHEN e.advance_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  -- Balance-sheet only — cash received, matched by a liability to the
  -- vehicles it's collected on behalf of. No income is recognised here.
  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'contra', (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Shadi vehicle booking advance held — ' || booker.full_name || ' (' || to_char(e.event_date, 'DD Mon YYYY') || ')', e.advance_amount_pkr, v_liability_account, v_cash_account, booker.full_name)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE shadi_events SET status = 'confirmed', advance_confirmed_at = now(), advance_confirmed_by = current_admin_user_id(), advance_voucher_id = v_voucher_id
  WHERE id = p_event_id;

  UPDATE shadi_vehicle_requests SET advance_share_pkr = round(full_day_rate_pkr * e.advance_pct / 100, 2)
  WHERE event_id = p_event_id AND status = 'accepted';

  FOR r IN SELECT sr.vehicle_id, sr.status, v.portal_user_id, sr.advance_share_pkr, sr.full_day_rate_pkr
           FROM shadi_vehicle_requests sr JOIN vehicles v ON v.id = sr.vehicle_id WHERE sr.event_id = p_event_id LOOP
    IF r.status = 'accepted' AND r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (r.portal_user_id, 'shadi_advance_confirmed', 'Wedding booking confirmed',
        'Confirmed for ' || to_char(e.event_date, 'DD Mon YYYY') || '. Rs ' || round(r.advance_share_pkr) || ' advance is held for you and will be released after the wedding date — collect the remaining Rs ' || round(r.full_day_rate_pkr - r.advance_share_pkr) || ' from the customer on the day.',
        '/portal/my-vehicle/shadi');
    END IF;
  END LOOP;

  UPDATE shadi_vehicle_requests SET status = 'cancelled' WHERE event_id = p_event_id AND status = 'requested';
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT v.portal_user_id, 'shadi_request_auto_cancelled', 'Wedding request closed', 'This booking has been finalized with other vehicles.', '/portal/my-vehicle/shadi'
  FROM shadi_vehicle_requests sr JOIN vehicles v ON v.id = sr.vehicle_id
  WHERE sr.event_id = p_event_id AND sr.status = 'cancelled' AND sr.responded_at IS NULL AND v.portal_user_id IS NOT NULL;

  IF e.portal_user_id IS NOT NULL THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    VALUES (e.portal_user_id, 'shadi_advance_confirmed', 'Advance confirmed', 'Your wedding booking is confirmed.', '/portal/marketplace/shadi/' || e.id);
  END IF;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', e.advance_amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Deterministic, no discretion involved (the amount and recipient were
-- both fixed the moment the advance was confirmed) — safe for any
-- authenticated user to trigger incidentally, same reasoning as the
-- existing ring/board "advance_*" sweep functions. A no-op when nothing
-- is due.
CREATE OR REPLACE FUNCTION sweep_due_shadi_advances() RETURNS int AS $$
DECLARE
  v_liability_account uuid;
  r RECORD;
  v_vehicle_account uuid;
  v_voucher_id uuid;
  v_count int := 0;
BEGIN
  SELECT id INTO v_liability_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-5004';

  FOR r IN
    SELECT sr.id AS request_id, sr.vehicle_id, sr.advance_share_pkr, se.event_date, v.owner_name, v.portal_user_id
    FROM shadi_vehicle_requests sr
    JOIN shadi_events se ON se.id = sr.event_id
    JOIN vehicles v ON v.id = sr.vehicle_id
    WHERE sr.status = 'accepted' AND se.status = 'confirmed' AND se.event_date < (now() AT TIME ZONE 'Asia/Karachi')::date
      AND sr.payout_voucher_id IS NULL AND sr.advance_share_pkr IS NOT NULL AND sr.advance_share_pkr > 0
    FOR UPDATE OF sr SKIP LOCKED
  LOOP
    v_vehicle_account := ensure_vehicle_account(r.vehicle_id);

    INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
    VALUES ('donors_projects', 'contra', (now() AT TIME ZONE 'Asia/Karachi')::date,
      'Shadi advance released — ' || r.owner_name || ' (' || to_char(r.event_date, 'DD Mon YYYY') || ')', r.advance_share_pkr, v_vehicle_account, v_liability_account, r.owner_name)
    RETURNING id INTO v_voucher_id;

    UPDATE shadi_vehicle_requests SET payout_voucher_id = v_voucher_id, paid_out_at = now() WHERE id = r.request_id;
    v_count := v_count + 1;

    IF r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (r.portal_user_id, 'shadi_advance_released', 'Advance released',
        'Rs ' || round(r.advance_share_pkr) || ' advance for the ' || to_char(r.event_date, 'DD Mon YYYY') || ' wedding has been released to your account.', '/portal/my-vehicle/shadi');
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION sweep_due_shadi_advances() TO authenticated;

-- Both listing RPCs get the payout fields so the UI can show release status.
CREATE OR REPLACE FUNCTION my_shadi_events() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', e.id, 'event_date', e.event_date, 'venue_address', e.venue_address, 'distance_km', e.distance_km, 'notes', e.notes,
    'status', e.status, 'advance_pct', e.advance_pct, 'advance_amount_pkr', e.advance_amount_pkr, 'advance_rejected_reason', e.advance_rejected_reason,
    'created_at', e.created_at,
    'requests', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', r.id, 'vehicle_id', r.vehicle_id, 'owner_name', v.owner_name, 'owner_mobile', v.owner_mobile,
        'vehicle_type', v.vehicle_type, 'model', v.model, 'color', v.color,
        'full_day_rate_pkr', r.full_day_rate_pkr, 'status', r.status, 'decline_reason', r.decline_reason, 'advance_share_pkr', r.advance_share_pkr,
        'paid_out_at', r.paid_out_at
      ) ORDER BY r.created_at), '[]'::jsonb)
      FROM shadi_vehicle_requests r JOIN vehicles v ON v.id = r.vehicle_id WHERE r.event_id = e.id
    )
  ) ORDER BY e.event_date DESC), '[]'::jsonb)
  FROM shadi_events e WHERE e.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION vehicle_shadi_requests(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (COALESCE(current_admin_permission('manage_parties'), false) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = current_portal_user_id())) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'status', r.status, 'decline_reason', r.decline_reason, 'full_day_rate_pkr', r.full_day_rate_pkr, 'advance_share_pkr', r.advance_share_pkr,
    'paid_out_at', r.paid_out_at,
    'event_id', e.id, 'event_date', e.event_date, 'venue_address', e.venue_address, 'distance_km', e.distance_km, 'notes', e.notes, 'event_status', e.status,
    'customer_name', pu.full_name, 'customer_mobile', pu.mobile
  ) ORDER BY e.event_date), '[]'::jsonb) INTO v_result
  FROM shadi_vehicle_requests r JOIN shadi_events e ON e.id = r.event_id JOIN portal_users pu ON pu.id = e.portal_user_id
  WHERE r.vehicle_id = p_vehicle_id;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
