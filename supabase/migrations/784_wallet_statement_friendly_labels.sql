-- Migration 784: real ask, 2026-11-03 — "note down the statement
-- which is showing in English, make it Urdu with better wording and
-- make it all the description of it readable when clicked on it."
--
-- vehicle_wallet_statement (739) just echoes vouchers.particular
-- verbatim — real, free-text accounting ledger entries written in
-- English across 40+ different call sites system-wide (donors, shop,
-- water supply, vehicle marketplace all share one `vouchers` table).
-- Rewriting every one of those call sites' stored text would touch
-- the general ledger every other admin screen and audit trail already
-- relies on — out of scope and risky for what's really a driver-facing
-- display problem, not an accounting data problem.
--
-- Real, bounded fix: detect the handful of real prefixes vehicle-
-- touching vouchers actually use (confirmed by reading every real
-- call site: 'Marketplace commission — ', the cancellation-reversal
-- wording from 436, the ilan-fee wording from 694, wallet top-ups,
-- settlements, route posting stakes) and tag each row with a `kind` —
-- the driver-facing list shows a short, correctly-worded Urdu/English
-- label (via the frontend's own i18n, same as the earnings breakdown
-- already does by kind) plus a cleaned detail with the noisy English
-- boilerplate prefix/suffix stripped, while the full original
-- `particular` is still returned unmodified for the "view full detail"
-- tap-through — nothing about the real ledger text is lost, only how
-- the short list row is worded.
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
        'kind', CASE
          WHEN v.particular LIKE 'Marketplace commission — %' THEN 'commission'
          WHEN v.particular LIKE 'Reversal of % ride booking cancelled:%' THEN 'cancellation_reversal'
          WHEN v.particular LIKE 'Ilan auto-approved%' THEN 'ilan_fee'
          WHEN v.particular ILIKE '%wallet top-up%' OR v.particular ILIKE '%wallet top up%' THEN 'topup'
          WHEN v.particular ILIKE '%settlement%' THEN 'settlement'
          WHEN v.particular ILIKE '%posting stake%' THEN 'posting_stake'
          ELSE 'other'
        END,
        'detail', trim(both ' —' from
          regexp_replace(
            regexp_replace(v.particular, '^Marketplace commission — ', ''),
            '^Reversal of \S+ — ride booking cancelled: ', ''
          )
        ),
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
