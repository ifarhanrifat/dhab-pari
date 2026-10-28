-- Migration 765: fixes a real regression migration 764 just introduced.
--
-- Real bug hit live, 2026-10-28: a driver pressed "Complete Ride" and
-- got "ایک ضروری خانہ خالی ہے" (a required field is empty) — a raw
-- Postgres 23502 null-value-in-column error on `vouchers.from_account_id`.
--
-- Root cause: 764's complete_trip_booking was copied from the body read
-- earlier in this same session (migration 400, the ORIGINAL pre-multi-
-- tenancy version) — written against the now-defunct
-- system='donors_projects'/code='DP-4050' account, which the Phase 0
-- multi-tenancy migration (662) already replaced with a per-tenant
-- system='marketplace'/code='MKT-4050' account months ago. 709 then
-- further upgraded it to category-aware commission. 764's REPLACE
-- silently reverted ALL of that — the tenant-scoped booking lookup,
-- the correct account system/code, and the category-aware commission
-- calc — back to the stale 400-era version. DP-4050 genuinely doesn't
-- exist any more (confirmed live), so the voucher insert always failed
-- once commission_pct > 0. This is exactly the mistake flagged in
-- today's "check what's already built before implementing" note —
-- should have grepped for the CURRENT definition instead of reusing
-- what I'd already read once this session.
--
-- Fix: restore 709's real, current body exactly, with only the
-- 'in_progress' status addition (764's actual intended change) layered
-- on top — nothing else changes.

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
  IF b.status NOT IN ('confirmed', 'in_progress') THEN RAISE EXCEPTION 'This trip is not awaiting completion.' USING ERRCODE = 'P0001'; END IF;
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
    v_commission_pct := CASE WHEN v.category_id IS NOT NULL THEN vehicle_category_commission_pct(v.category_id, o.classification) ELSE vehicle_commission_pct(v.vehicle_type, o.classification) END;
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
