-- Real ask, 2026-10-27: "where in the driver wallet and account I can
-- see that deposited payment? Where it has been recorded?" Traced the
-- real gap: /portal/my-vehicle/earnings already shows a live balance
-- number (correct, already reflects every voucher), but the only
-- itemized list on that page — vehicle_today_ledger (656) — is scoped
-- to TODAY's completed jobs only, and only earnings, never a top-up or
-- a commission charge. A driver has no way anywhere in the app to see
-- *why* their balance is what it is, or to find a specific past
-- top-up again once the day it happened has passed.
--
-- A vehicle's own ledger account already has a complete, correct
-- history in `vouchers` (every top-up, every per-order commission,
-- every route-run/trip-post stake — all of this session's own new
-- charges already post through this same table) — this just reads it
-- back instead of inventing a new log. Direction follows the same
-- convention seller_account_balance itself uses: the vehicle account
-- as `to_account_id` is a debit (reduces balance — a charge); as
-- `from_account_id` is a credit (increases balance — a top-up or
-- payout).

CREATE OR REPLACE FUNCTION vehicle_wallet_statement(p_vehicle_id uuid, p_limit int DEFAULT 100) RETURNS jsonb AS $$
DECLARE v_account_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_vehicle_id AND portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not manage this vehicle.' USING ERRCODE = 'P0001';
  END IF;
  v_account_id := ensure_vehicle_account(p_vehicle_id);

  RETURN COALESCE((
    SELECT jsonb_agg(row) FROM (
      SELECT jsonb_build_object(
        'id', v.id, 'voucher_no', v.voucher_no, 'date', v.voucher_date, 'particular', v.particular,
        'amount_pkr', v.amount_pkr,
        'direction', CASE WHEN v.to_account_id = v_account_id THEN 'debit' ELSE 'credit' END,
        'created_at', v.created_at
      ) AS row
      FROM vouchers v
      WHERE v.to_account_id = v_account_id OR v.from_account_id = v_account_id
      ORDER BY v.created_at DESC
      LIMIT p_limit
    ) t
  ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_wallet_statement(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_wallet_statement(uuid, int) TO authenticated;
