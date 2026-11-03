-- Migration 785: real ask, 2026-11-03 — "your received cash is
-- showing 1159 what is it? where is the settlement with committee?
-- what is his dues or receivable or wallet balance? where is his
-- topup money?"
--
-- Real cause of the confusion: cm.balanceLabel ("Owed to you" / "آپ کو
-- ملنے والی رقم") is a generic key shared with the shop earnings
-- screen, written for a platform-collects-and-pays-out model. A
-- per_order VEHICLE's balance is the opposite shape — a prepaid wallet
-- the driver tops up in advance, with commission auto-drawn from it as
-- rides complete (confirmed by seller_account_balance/vouchers
-- direction: a top-up is a credit, to v_vehicle_account as
-- from_account_id; a commission charge is a debit, to v_vehicle_account
-- as to_account_id — already correctly driving mv.negativeBalanceNote's
-- "top up or new bookings pause" warning). A positive number there
-- means "you still have prepaid funds," never "the committee will pay
-- you this" — the generic label was actively telling a per-order
-- driver the wrong thing.
--
-- Also: nothing on the page ever showed the two real lifetime totals
-- that actually explain that number (statement is capped at the most
-- recent rows, no sum) — this is the direct, authoritative answer to
-- "where is his topup money."
CREATE OR REPLACE FUNCTION vehicle_wallet_lifetime_totals(p_vehicle_id uuid) RETURNS jsonb AS $$
DECLARE
  v_account_id uuid;
  v_topped_up decimal; v_commission_paid decimal;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  v_account_id := ensure_vehicle_account(p_vehicle_id);

  SELECT COALESCE(SUM(v.amount_pkr), 0) INTO v_topped_up
  FROM vouchers v WHERE v.from_account_id = v_account_id AND v.particular ILIKE '%wallet top-up%';

  SELECT COALESCE(SUM(v.amount_pkr), 0) INTO v_commission_paid
  FROM vouchers v WHERE v.to_account_id = v_account_id AND v.particular LIKE 'Marketplace commission — %';

  RETURN jsonb_build_object('total_topped_up_pkr', v_topped_up, 'total_commission_paid_pkr', v_commission_paid);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_wallet_lifetime_totals(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_wallet_lifetime_totals(uuid) TO authenticated;
