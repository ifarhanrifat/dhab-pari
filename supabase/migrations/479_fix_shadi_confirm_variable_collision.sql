-- Real bug caught by live disposable-account testing (478 was never
-- actually exercised end-to-end before this): confirm_shadi_advance
-- declares a PL/pgSQL loop variable named `r`, then its own embedded
-- SQL aliases the shadi_vehicle_requests table as `r` too (twice — once
-- in the FOR loop's SELECT, once in the later INSERT...SELECT). PL/pgSQL
-- variable names silently shadow SQL aliases of the same name inside a
-- function body, so `r.status` etc. resolved to the not-yet-assigned
-- loop variable instead of the query row, raising "record \"r\" is not
-- assigned yet" the moment this ever actually ran. Fixed by renaming
-- every shadi_vehicle_requests alias in this function to `sr`, leaving
-- the loop variable name `r` alone.
CREATE OR REPLACE FUNCTION confirm_shadi_advance(p_event_id uuid) RETURNS jsonb AS $$
DECLARE
  e shadi_events%ROWTYPE; booker portal_users%ROWTYPE;
  v_income_account uuid; v_cash_account uuid; v_voucher_id uuid; v_voucher_no varchar;
  r RECORD;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO e FROM shadi_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'P0001'; END IF;
  IF e.status <> 'advance_announced' THEN RAISE EXCEPTION 'This advance is not awaiting confirmation.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO booker FROM portal_users WHERE id = e.portal_user_id;

  SELECT id INTO v_income_account FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4051';
  SELECT id INTO v_cash_account FROM accounts WHERE system = 'donors_projects' AND code = (CASE WHEN e.advance_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
  VALUES ('donors_projects', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Shadi vehicle booking advance — ' || booker.full_name || ' (' || to_char(e.event_date, 'DD Mon YYYY') || ')', e.advance_amount_pkr, v_income_account, v_cash_account, booker.full_name)
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE shadi_events SET status = 'confirmed', advance_confirmed_at = now(), advance_confirmed_by = current_admin_user_id(), advance_voucher_id = v_voucher_id
  WHERE id = p_event_id;

  -- Split the combined advance back out per accepted vehicle, and lock
  -- in that as its own record so a driver can see their exact balance
  -- due (full_day_rate_pkr - advance_share_pkr) without doing the maths.
  UPDATE shadi_vehicle_requests SET advance_share_pkr = round(full_day_rate_pkr * e.advance_pct / 100, 2)
  WHERE event_id = p_event_id AND status = 'accepted';

  FOR r IN SELECT sr.vehicle_id, sr.status, v.portal_user_id, sr.advance_share_pkr, sr.full_day_rate_pkr
           FROM shadi_vehicle_requests sr JOIN vehicles v ON v.id = sr.vehicle_id WHERE sr.event_id = p_event_id LOOP
    IF r.status = 'accepted' AND r.portal_user_id IS NOT NULL THEN
      INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
      VALUES (r.portal_user_id, 'shadi_advance_confirmed', 'Wedding booking confirmed',
        'Confirmed for ' || to_char(e.event_date, 'DD Mon YYYY') || '. Collect Rs ' || round(r.full_day_rate_pkr - r.advance_share_pkr) || ' from the customer on the day.',
        '/portal/my-vehicle/shadi');
    END IF;
  END LOOP;

  -- Anyone who never got a chance to respond is now moot — the booker's
  -- accepted set is locked in.
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
