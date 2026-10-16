-- Migration 688: real bug the user caught live in their own account
-- statement -- "why is a trip I never marked as return showing up as
-- a return trip?" complete_trip_booking()'s commission voucher
-- particular hardcoded the literal words "return trip" for every
-- single trip booking regardless of its actual trip_type -- confirmed
-- live: voucher DP-INC-V-0753 read "... dfd return trip ..." for a
-- trip posted with trip_type = 'oneway'. Reversed that one live
-- voucher separately (DP-INC-V-0754, reverse_voucher) since it was
-- test data, not a real booking; this migration fixes the function so
-- every booking from now on says the right thing.

CREATE OR REPLACE FUNCTION public.complete_trip_booking(p_trip_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  b vehicle_trip_bookings%ROWTYPE; v vehicles%ROWTYPE; o vehicle_trip_offers%ROWTYPE;
  v_vehicle_account uuid; v_commission_account uuid; v_commission_pct decimal; v_commission_amount decimal := 0;
  v_commission_voucher_id uuid; v_trip_label text;
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

  v_trip_label := CASE WHEN o.trip_type = 'return' THEN 'return trip' ELSE 'trip' END;

  IF v.commission_mode = 'per_order' THEN
    v_vehicle_account := ensure_vehicle_account(v.id);
    SELECT id INTO v_commission_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-4050' AND tenant_id = my_tenant_id();
    v_commission_pct := vehicle_commission_pct(v.vehicle_type, o.classification);
    v_commission_amount := round(b.total_amount_pkr * v_commission_pct / 100, 2);
    IF v_commission_amount > 0 THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id, party_name)
      VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Marketplace commission — ' || o.origin || ' → ' || o.destination || ' ' || v_trip_label || ' (paid directly to driver)', v_commission_amount, v_commission_account, v_vehicle_account, v.owner_name)
      RETURNING id INTO v_commission_voucher_id;
      UPDATE vehicle_trip_bookings SET commission_voucher_id = v_commission_voucher_id WHERE id = p_trip_booking_id;
    END IF;
    PERFORM check_seller_balance_notify('vehicle', v.id);
  END IF;

  RETURN jsonb_build_object('amount', b.total_amount_pkr, 'commission', v_commission_amount);
END;
$function$;
